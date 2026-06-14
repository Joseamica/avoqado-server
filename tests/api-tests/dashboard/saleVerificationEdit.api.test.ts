/*
  API tests for the org-scoped admin sale-edit route:
    PATCH /api/v1/dashboard/organizations/:orgId/sale-verifications/:id

  Fixes Isaac's ticket: a SIM sale rejected to FAILED ("Revisar") is stuck when
  the promoter left — an OWNER must be able to correct it (monto, forma de pago,
  tipo de venta, estado) with a mandatory reason + audit.

  Three assertions (regression):
   1. 403 without `sale-verifications:edit` (MANAGER has review but not edit).
   2. 200 as OWNER → Payment.amount/method updated, SaleVerification.status
      updated, and an ActivityLog row (action=SALE_VERIFICATION_EDIT) written.
   3. 400 when `reason` is too short (< 5 chars).

  Bootstrap mirrors tests/api-tests/dashboard/manualPayment.api.test.ts: Prisma is
  globally mocked via tests/__helpers__/setup.ts (prismaMock) and the real
  controller + real service run against the mock so we can assert persistence-level
  behavior (Payment/SaleVerification updates + audit row) through the mock calls.
  There is NO real test database in this harness.

  The org route has no `:venueId` param, so resolveRequestVenueId() falls back to
  the token's venueId; with tokenVenueId === targetVenueId the permission
  middleware resolves the token role directly (no staffVenue lookup), so the token
  role drives access. checkOrgAccess additionally requires token.orgId === :orgId.
*/

import request from 'supertest'
import jwt from 'jsonwebtoken'
import type { Express } from 'express'
import { prismaMock } from '@tests/__helpers__/setup'

let app: Express
const TEST_SECRET = 'test-secret'
// CUID-style ids for realism/consistency with the other api-tests.
const ORG_ID = 'cltestorgsve01234567890123'
const VENUE_ID = 'cltestvenuesve0123456789012'
const STAFF_ID = 'cltestuseridsve012345678901'
const SALE_ID = 'cltestsalevsve0123456789012'
const PAYMENT_ID = 'cltestpaymentsve0123456789'
const PROMOTER_ID = 'cltestpromotersve012345678'

const BASE = `/api/v1/dashboard/organizations/${ORG_ID}/sale-verifications`

beforeAll(async () => {
  process.env.NODE_ENV = process.env.NODE_ENV || 'test'
  process.env.ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || TEST_SECRET
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session'
  process.env.COOKIE_SECRET = process.env.COOKIE_SECRET || 'test-cookie'
  process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/testdb'

  jest.resetModules()

  // Bypass express-session middleware (not relevant to these routes).
  jest.mock('@/config/session', () => ({
    __esModule: true,
    default: (_req: any, _res: any, next: any) => next(),
  }))

  const mod = await import('@/app')
  app = mod.default
})

/**
 * Generate JWT token matching AvoqadoJwtPayload shape. The token venueId is used
 * by resolveRequestVenueId (route has no :venueId) and the token orgId is checked
 * by checkOrgAccess. With tokenVenueId === targetVenueId the permission middleware
 * resolves the token role without a staffVenue lookup.
 */
const makeToken = (role: string) =>
  jwt.sign(
    {
      sub: STAFF_ID,
      orgId: ORG_ID,
      venueId: VENUE_ID,
      role,
    },
    process.env.ACCESS_TOKEN_SECRET || TEST_SECRET,
  )

/**
 * Prevent accidental SUPERADMIN fallthrough: checkPermission probes
 * staffVenue.findFirst({ role: SUPERADMIN }) before evaluating role perms, and
 * venueRolePermission.findUnique for custom per-venue overrides. Default both to
 * null so only the token role drives access.
 */
beforeEach(() => {
  prismaMock.staffVenue.findFirst.mockResolvedValue(null)
  prismaMock.venueRolePermission.findUnique.mockResolvedValue(null)
})

/**
 * Seed the existing FAILED sale the service loads via
 * prisma.saleVerification.findUnique, plus the tx writes ($transaction calls back
 * with prismaMock per setup.ts, so payment.update / saleVerification.update /
 * activityLog.create resolve on the shared mock).
 */
function seedFailedSale() {
  prismaMock.saleVerification.findUnique.mockResolvedValue({
    id: SALE_ID,
    venueId: VENUE_ID,
    staffId: PROMOTER_ID,
    paymentId: PAYMENT_ID,
    status: 'FAILED',
    isPortabilidad: false,
    payment: { id: PAYMENT_ID, amount: '0', method: 'OTHER' },
    venue: { organizationId: ORG_ID },
  })
  prismaMock.payment.update.mockResolvedValue({ id: PAYMENT_ID, amount: '100', method: 'CASH' })
  prismaMock.saleVerification.update.mockImplementation(async (args: any) => ({
    id: SALE_ID,
    paymentId: PAYMENT_ID,
    status: args.data.status,
    isPortabilidad: args.data.isPortabilidad ?? false,
    reviewedAt: args.data.reviewedAt ?? null,
    reviewNotes: args.data.reviewNotes ?? null,
    rejectionReasons: args.data.rejectionReasons ?? [],
    reviewedBy: null,
    staff: { id: PROMOTER_ID, firstName: 'Ignacio', lastName: 'Mitre', email: null, photoUrl: null },
    payment: { id: PAYMENT_ID, amount: '100', method: 'CASH', status: 'COMPLETED', createdAt: new Date() },
  }))
  prismaMock.activityLog.create.mockResolvedValue({ id: 'log-1' })
}

describe('PATCH /api/v1/dashboard/organizations/:orgId/sale-verifications/:id (edit)', () => {
  it('403 without sale-verifications:edit (MANAGER)', async () => {
    seedFailedSale()
    const token = makeToken('MANAGER')
    const res = await request(app)
      .patch(`${BASE}/${SALE_ID}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ amount: 100, paymentForm: 'CASH', status: 'COMPLETED', reason: 'corrección de monto' })

    expect(res.status).toBe(403)
    // Permission blocked the request before the service ran.
    expect(prismaMock.saleVerification.update).not.toHaveBeenCalled()
    expect(prismaMock.payment.update).not.toHaveBeenCalled()
    expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
  })

  it('OWNER edits monto + forma de pago + estado and writes an ActivityLog', async () => {
    seedFailedSale()
    const token = makeToken('OWNER')
    const res = await request(app)
      .patch(`${BASE}/${SALE_ID}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ amount: 100, paymentForm: 'CASH', status: 'COMPLETED', reason: 'era un ESIM $100, no gratis' })

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)

    // Payment updated: monto = 100 and method mapped CASH → CASH.
    expect(prismaMock.payment.update).toHaveBeenCalledTimes(1)
    const paymentUpdateArgs = prismaMock.payment.update.mock.calls[0][0]
    expect(paymentUpdateArgs.where).toEqual({ id: PAYMENT_ID })
    expect(paymentUpdateArgs.data.amount).toBe(100)
    expect(paymentUpdateArgs.data.method).toBe('CASH')

    // SaleVerification flipped to COMPLETED.
    expect(prismaMock.saleVerification.update).toHaveBeenCalledTimes(1)
    const svUpdateArgs = prismaMock.saleVerification.update.mock.calls[0][0]
    expect(svUpdateArgs.where).toEqual({ id: SALE_ID })
    expect(svUpdateArgs.data.status).toBe('COMPLETED')

    // Audit row written with the reason + before/after.
    expect(prismaMock.activityLog.create).toHaveBeenCalledTimes(1)
    const logArgs = prismaMock.activityLog.create.mock.calls[0][0]
    expect(logArgs.data.action).toBe('SALE_VERIFICATION_EDIT')
    expect(logArgs.data.entity).toBe('SaleVerification')
    expect(logArgs.data.entityId).toBe(SALE_ID)
    expect(logArgs.data.data.reason).toBe('era un ESIM $100, no gratis')
    expect(logArgs.data.data.before.amount).toBe(0)
    expect(logArgs.data.data.after.amount).toBe(100)
  })

  it('400 when reason is too short', async () => {
    seedFailedSale()
    const token = makeToken('OWNER')
    const res = await request(app).patch(`${BASE}/${SALE_ID}`).set('Authorization', `Bearer ${token}`).send({ amount: 50, reason: 'x' })

    expect(res.status).toBe(400)
    // Validation failed before any write happened.
    expect(prismaMock.payment.update).not.toHaveBeenCalled()
    expect(prismaMock.saleVerification.update).not.toHaveBeenCalled()
    expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
  })
})
