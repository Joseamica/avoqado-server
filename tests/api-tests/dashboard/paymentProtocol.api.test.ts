/**
 * Codex R12-5 (pasada exhaustiva, checkpoint 1 del webhook): desde la RUTA AUTORIZADA (ADMIN/OWNER por `payments:*`), editar
 * o borrar un cobro del protocolo de costo contesta 409 con `PAYMENT_PROTECTED_BY_COST_PROTOCOL` y no escribe; un no-op
 * legítimo contesta 200. Express real (authenticateToken → checkPermission → controlador → servicio), Prisma doblado.
 * La verdad contra Postgres (cada campo, DELETE, carrera con la convergencia) vive en
 * `tests/integration/payments/paymentDashboard.protocolo.integration.test.ts`.
 */
import request from 'supertest'
import jwt from 'jsonwebtoken'
import type { Express } from 'express'
import { prismaMock } from '@tests/__helpers__/setup'
import { mirrorTokenRoleOnStaffVenue } from '@tests/__helpers__/venueRoleMock'

let app: Express
const TEST_SECRET = 'test-secret'
const VENUE_ID = 'cltestvenuepp012345678901'
const STAFF_ID = 'cltestuserpp0123456789012'
const ORG_ID = 'cltestorgpp01234567890123'
const PAYMENT_ID = 'cltestpaymentpp0123456789'
const BASE = `/api/v1/dashboard/venues/${VENUE_ID}/payments/${PAYMENT_ID}`

beforeAll(async () => {
  process.env.NODE_ENV = process.env.NODE_ENV || 'test'
  process.env.ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || TEST_SECRET
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session'
  process.env.COOKIE_SECRET = process.env.COOKIE_SECRET || 'test-cookie'
  process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/testdb'
  jest.resetModules()
  jest.mock('@/config/session', () => ({ __esModule: true, default: (_req: any, _res: any, next: any) => next() }))
  const mod = await import('@/app')
  app = mod.default
})

const makeToken = (role: string) => {
  mirrorTokenRoleOnStaffVenue(role, VENUE_ID)
  return jwt.sign({ sub: STAFF_ID, orgId: ORG_ID, venueId: VENUE_ID, role }, process.env.ACCESS_TOKEN_SECRET || TEST_SECRET)
}

const cobroDelProtocolo = {
  id: PAYMENT_ID,
  venueId: VENUE_ID,
  status: 'COMPLETED',
  method: 'CREDIT_CARD',
  cardBrand: 'VISA',
  amount: 100,
  tipAmount: 0,
  authorizationNumber: 'A1',
  referenceNumber: 'R1',
  maskedPan: null,
  entryMode: null,
  processorData: { pricing: { slot: 'PRIMARY' }, costPending: true },
  transactionCost: null,
}

beforeEach(() => {
  prismaMock.staffVenue.findFirst.mockResolvedValue(null)
  prismaMock.venueRolePermission.findUnique.mockResolvedValue(null)
  prismaMock.payment.findFirst.mockResolvedValue(cobroDelProtocolo as any)
  prismaMock.payment.findUniqueOrThrow.mockResolvedValue(cobroDelProtocolo as any)
  // Bajo el mutex: `cobrosDelProtocolo` (SQL sobre "Payment" p) dice que SÍ es del protocolo; el candado no devuelve filas útiles.
  prismaMock.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) =>
    strings.join('?').includes('FROM "Payment" p') ? [{ id: PAYMENT_ID }] : [],
  )
})

describe('PUT/DELETE /api/v1/dashboard/venues/:venueId/payments/:paymentId — cobro del protocolo de costo', () => {
  it.each(['ADMIN', 'OWNER'])('%s: PUT que cambia el importe ⇒ 409 PAYMENT_PROTECTED_BY_COST_PROTOCOL y no escribe', async role => {
    const res = await request(app)
      .put(BASE)
      .set('Authorization', `Bearer ${makeToken(role)}`)
      .send({ amount: 120 })
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ code: 'PAYMENT_PROTECTED_BY_COST_PROTOCOL' })
    expect(prismaMock.payment.update).not.toHaveBeenCalled()
  })

  it('PUT que cambia el estado a FAILED ⇒ 409, no escribe', async () => {
    const res = await request(app)
      .put(BASE)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({ status: 'FAILED' })
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ code: 'PAYMENT_PROTECTED_BY_COST_PROTOCOL', details: expect.objectContaining({ fields: ['status'] }) })
    expect(prismaMock.payment.update).not.toHaveBeenCalled()
  })

  it('PUT no-op (los mismos valores) ⇒ 200 sin escribir', async () => {
    const res = await request(app)
      .put(BASE)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({ amount: 100, status: 'COMPLETED', referenceNumber: 'R1' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ id: PAYMENT_ID })
    expect(prismaMock.payment.update).not.toHaveBeenCalled()
  })

  it('DELETE ⇒ 409 PAYMENT_PROTECTED_BY_COST_PROTOCOL; nada se borra', async () => {
    const res = await request(app)
      .delete(BASE)
      .set('Authorization', `Bearer ${makeToken('OWNER')}`)
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ code: 'PAYMENT_PROTECTED_BY_COST_PROTOCOL' })
    expect(prismaMock.payment.delete).not.toHaveBeenCalled()
    expect(prismaMock.transactionCost.delete).not.toHaveBeenCalled()
  })

  it('un rol de piso sigue sin poder editar (403 antes de llegar al servicio)', async () => {
    const res = await request(app)
      .put(BASE)
      .set('Authorization', `Bearer ${makeToken('CASHIER')}`)
      .send({ amount: 120 })
    expect(res.status).toBe(403)
  })
})
