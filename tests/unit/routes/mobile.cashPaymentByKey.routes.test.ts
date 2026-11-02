import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import prisma from '@/utils/prismaClient'
import mobileRouter from '@/routes/mobile.routes'
import { authenticateTokenMiddleware } from '@/middlewares/authenticateToken.middleware'
import { validateVenueAccess } from '@/middlewares/validateVenueAccess.middleware'
import { hasPermission } from '@/lib/permissions'
import { StaffRole } from '@prisma/client'

jest.mock('@/utils/passwordChangeGuard', () => ({
  ...jest.requireActual('@/utils/passwordChangeGuard'),
  motivoDeSesionInvalidada: jest.fn().mockResolvedValue(null),
}))

const venueId = 'c0000000000000000000000001'
const otherVenueId = 'c0000000000000000000000002'
const path = '/venues/:venueId/payments/by-key/:idempotencyKey'
const app = express()
app.use('/api/v1/mobile', mobileRouter)
app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(error.statusCode ?? error.status ?? 500).json({ success: false, message: error.message })
})
const token = () =>
  jwt.sign(
    { sub: 'c0000000000000000000000003', venueId, orgId: 'c0000000000000000000000004', role: 'CASHIER' },
    process.env.ACCESS_TOKEN_SECRET!,
    {
      expiresIn: '5m',
    },
  )
const get = (key = 'original-key', target = venueId) =>
  request(app).get(`/api/v1/mobile/venues/${target}/payments/by-key/${encodeURIComponent(key)}`)

describe('GET cash payment by exact key — real HTTP/router/auth/permission chain', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    process.env.AUTH_LEGACY_TOKEN_PHASE = '1'
    delete process.env.AUTH_LEGACY_TOKEN_CUTOFF_AT
    jest.mocked(prisma.staff.findUnique).mockResolvedValue({ active: true } as never)
    jest.mocked(prisma.staffVenue.findFirst).mockResolvedValue(null)
    jest.mocked(prisma.staffVenue.findUnique).mockResolvedValue({
      active: true,
      role: 'CASHIER',
      permissionSetId: 'test-permissions',
      permissionSet: { permissions: ['payments:read'] },
    } as never)
    jest.mocked(prisma.staffOrganization.findFirst).mockResolvedValue(null)
    jest.mocked(prisma.payment.findUnique).mockResolvedValue(null)
    jest
      .mocked(prisma.order.findUnique)
      .mockResolvedValue({ paymentStatus: 'PAID', total: 20, paidAmount: 20, remainingBalance: 0 } as never)
  })

  it('returns 200/null for an absent key (functional RED: route currently returns HTTP 404)', async () => {
    const response = await get().set('Authorization', `Bearer ${token()}`)
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ success: true, data: null })
    expect(response.headers['cache-control']).toContain('no-store')
  })

  it('returns canonical evidence through HTTP without changing money units or leaking private payment fields', async () => {
    const orderId = 'c0000000000000000000000005'
    jest.mocked(prisma.payment.findUnique).mockResolvedValue({
      id: 'c0000000000000000000000006',
      venueId,
      orderId,
      idempotencyKey: 'original-key',
      status: 'COMPLETED',
      type: 'REGULAR',
      method: 'CASH',
      fundsFlow: 'CASH_DRAWER',
      tenderTypeId: null,
      tenderRevision: null,
      splitType: 'FULLPAYMENT',
      amount: 19.99,
      tipAmount: 0.01,
      thirdPartyCashAmount: null,
      order: { id: orderId, venueId, externalId: null, thirdPartyCashDue: null },
    } as never)
    const response = await get().set('Authorization', `Bearer ${token()}`)
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      success: true,
      data: {
        venueId,
        orderId,
        idempotencyKey: 'original-key',
        amountCents: 1999,
        tipCents: 1,
        cashRetainedCents: 2000,
      },
    })
    expect(response.headers['cache-control']).toContain('no-store')
    for (const field of ['processorData', 'receiptAccessKey', 'changeCents', 'orderTotalCents', 'totalPaidCents']) {
      expect(response.body.data).not.toHaveProperty(field)
    }
    expect(prisma.payment.create).not.toHaveBeenCalled()
    expect(prisma.order.update).not.toHaveBeenCalled()
  })

  it('requires authentication before querying payment evidence', async () => {
    expect((await get()).status).toBe(401)
    expect(prisma.payment.findUnique).not.toHaveBeenCalled()
  })

  it('denies a different venue even when the staff could work there', async () => {
    expect((await get('original-key', otherVenueId).set('Authorization', `Bearer ${token()}`)).status).toBe(403)
    expect(prisma.payment.findUnique).not.toHaveBeenCalled()
  })

  it('uses effective read permission: a cashier whose permission set revoked read receives 403', async () => {
    jest.mocked(prisma.staffVenue.findUnique).mockResolvedValue({
      active: true,
      role: 'CASHIER',
      permissionSetId: 'revoked',
      permissionSet: { permissions: [] },
    } as never)
    expect((await get().set('Authorization', `Bearer ${token()}`)).status).toBe(403)
    expect(prisma.payment.findUnique).not.toHaveBeenCalled()
  })

  it.each([' ', 'x'.repeat(65)])('rejects an empty or oversized key without querying: %p', async key => {
    expect((await get(key).set('Authorization', `Bearer ${token()}`)).status).toBe(400)
    expect(prisma.payment.findUnique).not.toHaveBeenCalled()
  })

  it.each(['sync:legacy-key_1.2', 'x'.repeat(64)])('preserves historical key formats within the stored bound: %p', async key => {
    const response = await get(key).set('Authorization', `Bearer ${token()}`)
    expect(response.status).toBe(200)
    expect(prisma.payment.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { venueId_idempotencyKey: { venueId, idempotencyKey: key } },
      }),
    )
  })

  it('wires actual auth + venue access + payments:read, preserving existing create→read permission', () => {
    const route = (mobileRouter as any).stack.find((layer: any) => layer.route?.path === path && layer.route.methods.get)
    expect(route).toBeDefined()
    const handlers = route.route.stack.map((layer: any) => layer.handle)
    expect(handlers[0]).toBe(authenticateTokenMiddleware)
    expect(handlers).toContain(validateVenueAccess)
    expect(handlers.some((handler: any) => handler.requiredPermission === 'payments:read')).toBe(true)
    expect(hasPermission(StaffRole.CASHIER, ['payments:create'], 'payments:read')).toBe(true)
  })
})
