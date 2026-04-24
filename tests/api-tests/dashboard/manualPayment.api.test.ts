/*
  API tests for Manual Payment routes under
    POST /api/v1/dashboard/venues/:venueId/payments/manual
    GET  /api/v1/dashboard/venues/:venueId/payments/external-sources

  Goals:
  - Happy path: ADMIN posts {source: OTHER, externalSource: 'BUQ'}, amount equals
    order.total → 201; response.data.externalSource === 'BUQ'; service persists
    Payment with externalSource and updates Order.paymentStatus to 'PAID'.
  - CASHIER → 403 (payment:create-manual is NOT in CASHIER defaults).
  - Zod: missing externalSource when source = OTHER → 400 with Spanish message.
  - GET /external-sources: service aggregates by frequency; mocked groupBy
    simulates 3 'BUQ' + 1 'Clip' rows and the response is ordered with 'BUQ'
    first and contains 'Clip'.

  Pattern follows existing api-tests (creditPack/loyalty): Prisma is globally
  mocked via tests/__helpers__/setup.ts (prismaMock). This file does NOT mock
  the controller or service — we let the real controller + real service run
  against prismaMock so we can assert persistence-level behavior (source = PAID,
  externalSource persisted, groupBy args).
*/

import request from 'supertest'
import jwt from 'jsonwebtoken'
import type { Express } from 'express'
import { prismaMock } from '@tests/__helpers__/setup'

let app: Express
const TEST_SECRET = 'test-secret'
// Valid CUID-like IDs (the manual payment schema only requires orderId to be a
// non-empty string, but we use CUID-style ids for realism/consistency).
const VENUE_ID = 'cltestvenuemp012345678901'
const ORDER_ID = 'cltestordermp0123456789012'
const STAFF_ID = 'cltestuserid0123456789012'
const ORG_ID = 'cltestorgid01234567890123'
const PAYMENT_ID = 'cltestpaymentmp0123456789'

const BASE = `/api/v1/dashboard/venues/${VENUE_ID}/payments`

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
 * Generate JWT token matching AvoqadoJwtPayload shape. The token venueId
 * matches the URL param so checkPermission short-circuits to the token role
 * without hitting prisma.staffVenue.findUnique (see resolveUserRoleForVenue).
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
 * staffVenue.findFirst({ role: SUPERADMIN }) before evaluating role perms.
 * We default it to null in every test so only the token role drives access.
 */
beforeEach(() => {
  prismaMock.staffVenue.findFirst.mockResolvedValue(null)
  prismaMock.venueRolePermission.findUnique.mockResolvedValue(null)
})

// ==========================================================================
// POST /payments/manual
// ==========================================================================

describe('POST /api/v1/dashboard/venues/:venueId/payments/manual', () => {
  const validBody = {
    orderId: ORDER_ID,
    amount: '100.00',
    tipAmount: '0',
    method: 'CASH',
    source: 'OTHER',
    externalSource: 'BUQ',
  }

  it('201: ADMIN posts source=OTHER + externalSource=BUQ with amount = order.total → persists payment and marks order PAID', async () => {
    // Service uses prisma.$transaction(cb => cb(prismaMock)) from setup.ts, so
    // the inner tx === prismaMock. Wire up order lookup, payment.create, and
    // order.update on the shared mock.
    prismaMock.order.findFirst.mockResolvedValue({
      id: ORDER_ID,
      venueId: VENUE_ID,
      total: '100.00', // Decimal constructor accepts string
      payments: [], // nothing paid yet
    })
    prismaMock.payment.create.mockImplementation(async (args: any) => ({
      id: PAYMENT_ID,
      ...args.data,
    }))
    prismaMock.order.update.mockResolvedValue({ id: ORDER_ID, paymentStatus: 'PAID' })

    const token = makeToken('ADMIN')
    const res = await request(app).post(`${BASE}/manual`).set('Authorization', `Bearer ${token}`).send(validBody)

    expect(res.status).toBe(201)
    expect(res.body.success).toBe(true)
    expect(res.body.data.externalSource).toBe('BUQ')
    expect(res.body.data.id).toBe(PAYMENT_ID)

    // Persistence assertions — the service wrote the payment with externalSource
    // and marked the order PAID.
    expect(prismaMock.payment.create).toHaveBeenCalledTimes(1)
    const paymentCreateArgs = prismaMock.payment.create.mock.calls[0][0]
    expect(paymentCreateArgs.data.externalSource).toBe('BUQ')
    expect(paymentCreateArgs.data.venueId).toBe(VENUE_ID)
    expect(paymentCreateArgs.data.orderId).toBe(ORDER_ID)
    expect(paymentCreateArgs.data.source).toBe('OTHER')
    expect(paymentCreateArgs.data.status).toBe('COMPLETED')

    expect(prismaMock.order.update).toHaveBeenCalledTimes(1)
    const orderUpdateArgs = prismaMock.order.update.mock.calls[0][0]
    expect(orderUpdateArgs.where).toEqual({ id: ORDER_ID })
    expect(orderUpdateArgs.data.paymentStatus).toBe('PAID')
    expect(orderUpdateArgs.data).toHaveProperty('completedAt')
  })

  it('403: CASHIER cannot create a manual payment (lacks payment:create-manual)', async () => {
    const token = makeToken('CASHIER')
    const res = await request(app).post(`${BASE}/manual`).set('Authorization', `Bearer ${token}`).send(validBody)

    expect(res.status).toBe(403)
    expect(res.body).toHaveProperty('error', 'Forbidden')
    // Service must never have been invoked if permissions blocked the request.
    expect(prismaMock.order.findFirst).not.toHaveBeenCalled()
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
  })

  it('400: missing externalSource when source=OTHER → Zod error mentions proveedor externo', async () => {
    const token = makeToken('ADMIN')
    const res = await request(app).post(`${BASE}/manual`).set('Authorization', `Bearer ${token}`).send({
      orderId: ORDER_ID,
      amount: '50.00',
      tipAmount: '0',
      method: 'CASH',
      source: 'OTHER',
      // externalSource intentionally omitted
    })

    expect(res.status).toBe(400)
    expect(res.body).toHaveProperty('message')
    expect(res.body.message).toMatch(/externalSource|proveedor externo/i)
    // Validation fails before any DB work happens.
    expect(prismaMock.order.findFirst).not.toHaveBeenCalled()
  })
})

// ==========================================================================
// GET /payments/external-sources
// ==========================================================================

describe('GET /api/v1/dashboard/venues/:venueId/payments/external-sources', () => {
  it('200: returns distinct externalSource values ordered by frequency (BUQ first, Clip present)', async () => {
    // Simulate Prisma's groupBy response: three BUQ payments, one Clip payment.
    // The service orders by _count desc so BUQ (3) lands ahead of Clip (1).
    prismaMock.payment.groupBy.mockResolvedValue([
      { externalSource: 'BUQ', _count: { _all: 3 } },
      { externalSource: 'Clip', _count: { _all: 1 } },
    ])

    const token = makeToken('ADMIN')
    const res = await request(app).get(`${BASE}/external-sources`).set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(Array.isArray(res.body.data)).toBe(true)
    expect(res.body.data[0]).toBe('BUQ')
    expect(res.body.data).toContain('Clip')

    // The service must scope to this venue and exclude null externalSources,
    // ordered by _count externalSource desc.
    expect(prismaMock.payment.groupBy).toHaveBeenCalledTimes(1)
    const groupByArgs = prismaMock.payment.groupBy.mock.calls[0][0]
    expect(groupByArgs.by).toEqual(['externalSource'])
    expect(groupByArgs.where.venueId).toBe(VENUE_ID)
    expect(groupByArgs.where.externalSource).toEqual({ not: null })
    expect(groupByArgs.orderBy).toEqual({ _count: { externalSource: 'desc' } })
  })
})
