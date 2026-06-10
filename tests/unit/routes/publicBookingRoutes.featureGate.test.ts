/**
 * Plan-tier gate on the PUBLIC booking surface — proves checkPublicVenueFeature('RESERVATIONS')
 * sits in the chain the way public.routes.ts / consumer.routes.ts mount it, and behaves per tier:
 *   - Free ACTIVE venue (no grant, no paid plan) → 403 PLAN_REQUIRED on CREATE-flow routes ONLY
 *   - PRO venue (tier blanket)                   → 200
 *   - GRANDFATHERED venue (seatCapExempt)        → 200
 *   - DEMO venue (status LIVE_DEMO / TRIAL)      → 200
 *   - Unknown slug                               → pass-through (controller's own 404 path, never 403)
 *   - Unexpected gate error                      → FAIL-OPEN (controller reached)
 *
 * GOLDEN RULE under test: manage-existing flows are NEVER gated — magic-link :cancelSecret
 * cancel/reschedule/view, customer portal/login/register, OTP request/verify, credit-pack
 * list + balance reads, and the consumer's own reservations/credits/deposit routes all reach
 * the controller even on a Free venue.
 *
 * Mounts the REAL public + consumer routers behind the REAL checkPublicVenueFeature middleware
 * at the REAL mount paths (app.ts: /api/v1/public · routes/index.ts: /api/v1/consumer).
 * Mocks only: prisma, logger, rate limiters, request validation (passthrough), the
 * customer/consumer auth middlewares (passthrough), and the controllers (200 {ok}).
 *
 * Also asserts (source-level) that public.routes.ts / consumer.routes.ts actually WIRE the
 * gates on the create surface and ONLY there — a regression guard so the middleware can't
 * silently fall off a route line or creep onto a manage-existing route.
 *
 * Mirrors tests/unit/routes/reservationRoutes.featureGate.test.ts.
 */

import fs from 'fs'
import path from 'path'
import express from 'express'
import request from 'supertest'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findFirst: jest.fn(), findUnique: jest.fn() },
    venueFeature: { findFirst: jest.fn(), findMany: jest.fn() },
  },
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

// Rate limiters are module-level singletons in the route files (5 writes/min/IP) — with the
// real ones, the gated/ungated POSTs in this suite would trip 429s. Not under test → passthrough.
jest.mock('express-rate-limit', () => ({
  __esModule: true,
  default: () => (_req: any, _res: any, next: any) => next(),
  rateLimit: () => (_req: any, _res: any, next: any) => next(),
}))

// Request validation is not under test — passthrough so the gate verdict (403 vs controller)
// is observable without crafting schema-valid bodies for every route.
jest.mock('@/middlewares/validation', () => ({
  validateRequest: () => (_req: any, _res: any, next: any) => next(),
}))

// Auth middlewares are not under test — passthrough that injects the expected context, so
// "NOT gated" assertions on portal/consumer routes prove the PLAN gate, not a missing token.
jest.mock('@/middlewares/customerAuth.middleware', () => ({
  authenticateCustomer: (req: any, _res: any, next: any) => {
    req.customerAuth = { customerId: 'cust_1', venueId: 'venue_pub_1' }
    next()
  },
}))
jest.mock('@/middlewares/consumerAuth.middleware', () => ({
  authenticateConsumer: (req: any, _res: any, next: any) => {
    req.consumerAuth = { consumerId: 'consumer_1' }
    next()
  },
}))

// Controllers behind the routers are not under test — any handler returns 200 {ok}.
// (Inlined per factory: jest.mock hoisting forbids out-of-scope helpers here.)
/* eslint-disable max-len */
jest.mock('@/controllers/public/receipt.public.controller', () => new Proxy({}, { get: () => (_req: any, res: any) => res.json({ ok: true }) }))
jest.mock('@/controllers/public/cfdi.public.controller', () => new Proxy({}, { get: () => (_req: any, res: any) => res.json({ ok: true }) }))
jest.mock('@/controllers/public/receiptReview.public.controller', () => new Proxy({}, { get: () => (_req: any, res: any) => res.json({ ok: true }) }))
jest.mock('@/controllers/public/reservation.public.controller', () => new Proxy({}, { get: () => (_req: any, res: any) => res.json({ ok: true }) }))
jest.mock('@/controllers/public/creditPack.public.controller', () => new Proxy({}, { get: () => (_req: any, res: any) => res.json({ ok: true }) }))
jest.mock('@/controllers/public/customerPortal.public.controller', () => new Proxy({}, { get: () => (_req: any, res: any) => res.json({ ok: true }) }))
jest.mock('@/controllers/public/otpAuth.public.controller', () => new Proxy({}, { get: () => (_req: any, res: any) => res.json({ ok: true }) }))
jest.mock('@/controllers/public/paymentLink.public.controller', () => new Proxy({}, { get: () => (_req: any, res: any) => res.json({ ok: true }) }))
jest.mock('@/controllers/public/venueCheckout.public.controller', () => new Proxy({}, { get: () => (_req: any, res: any) => res.json({ ok: true }) }))
jest.mock('@/controllers/public/landing.public.controller', () => new Proxy({}, { get: () => (_req: any, res: any) => res.json({ ok: true }) }))
jest.mock('@/controllers/public/venueChat.public.controller', () => new Proxy({}, { get: () => (_req: any, res: any) => res.json({ ok: true }) }))
jest.mock('@/controllers/public/tpvOrder.public.controller', () => new Proxy({}, { get: () => (_req: any, res: any) => res.json({ ok: true }) }))
jest.mock('@/controllers/consumer/auth.consumer.controller', () => new Proxy({}, { get: () => (_req: any, res: any) => res.json({ ok: true }) }))
jest.mock('@/controllers/consumer/venue.consumer.controller', () => new Proxy({}, { get: () => (_req: any, res: any) => res.json({ ok: true }) }))
jest.mock('@/controllers/consumer/reservation.consumer.controller', () => new Proxy({}, { get: () => (_req: any, res: any) => res.json({ ok: true }) }))
jest.mock('@/controllers/consumer/credit.consumer.controller', () => new Proxy({}, { get: () => (_req: any, res: any) => res.json({ ok: true }) }))
/* eslint-enable max-len */

import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import publicRoutes from '@/routes/public.routes'
import consumerRoutes from '@/routes/consumer.routes'

const venueFindFirst = (prisma as any).venue.findFirst as jest.Mock // slug → venue (the gate's lookup)
const venueFindUnique = (prisma as any).venue.findUnique as jest.Mock // id → exemption (seatCapExempt + status)
const vfFindFirst = (prisma as any).venueFeature.findFirst as jest.Mock
const vfFindMany = (prisma as any).venueFeature.findMany as jest.Mock

const VENUE_ID = 'venue_pub_1'
const SLUG = 'la-trattoria'
const EXPECTED_403_MESSAGE = 'Este negocio no tiene reservaciones en línea disponibles por el momento.'

function createApp() {
  const app = express()
  app.use(express.json())
  // EXACT mount shapes: app.ts → /api/v1/public · routes/index.ts → /api/v1/consumer
  app.use('/api/v1/public', publicRoutes)
  app.use('/api/v1/consumer', consumerRoutes)
  return app
}

const P = `/api/v1/public/venues/${SLUG}`
const C = `/api/v1/consumer`

beforeEach(() => {
  jest.clearAllMocks()
  venueFindFirst.mockResolvedValue({ id: VENUE_ID }) // known, active slug by default
  venueFindUnique.mockResolvedValue({ seatCapExempt: false, status: 'ACTIVE' }) // not exempt
  vfFindFirst.mockResolvedValue(null) // no own VenueFeature grant by default
  vfFindMany.mockResolvedValue([]) // no paid base plan by default
})

describe('public booking surface — plan-tier gate (RESERVATIONS, Free venue → 403 PLAN_REQUIRED)', () => {
  it.each([
    ['GET', `${P}/availability`],
    ['POST', `${P}/reservations`],
    ['POST', `${P}/reservations/hold`],
    ['DELETE', `${P}/reservations/hold/hold_1`],
    ['POST', `${P}/credit-packs/pack_1/checkout`],
  ])('%s %s → 403 PLAN_REQUIRED with customer-facing Spanish message', async (method, url) => {
    const res = await (request(createApp()) as any)[method.toLowerCase()](url)

    expect(res.status).toBe(403)
    expect(res.body).toEqual({
      error: 'Feature not available',
      code: 'PLAN_REQUIRED',
      message: EXPECTED_403_MESSAGE,
    })
    // Customer-facing wording: it's the VENUE's plan — never mention plans/upgrades to the customer.
    expect(res.body.message).not.toMatch(/plan|upgrade|suscripci/i)
  })
})

describe('GOLDEN RULE — manage-existing flows are NOT gated on the same Free venue', () => {
  it.each([
    ['GET', `${P}/info`, 'venue info'],
    ['GET', `${P}/reservations/secret123`, 'magic-link view (:cancelSecret)'],
    ['POST', `${P}/reservations/secret123/cancel`, 'magic-link cancel'],
    ['GET', `${P}/reservations/secret123/reschedule/availability`, 'reschedule availability'],
    ['POST', `${P}/reservations/secret123/reschedule/hold`, 'reschedule hold'],
    ['POST', `${P}/reservations/secret123/reschedule`, 'reschedule'],
    ['GET', `${P}/credit-packs`, 'credit-pack list'],
    ['GET', `${P}/credit-packs/balance`, 'credit balance read'],
    ['POST', `${P}/customer/register`, 'customer register'],
    ['POST', `${P}/customer/login`, 'customer login'],
    ['GET', `${P}/customer/portal`, 'customer portal'],
    ['PATCH', `${P}/customer/profile`, 'customer profile'],
    ['POST', `${P}/auth/otp/request`, 'OTP request'],
    ['POST', `${P}/auth/otp/verify`, 'OTP verify'],
  ])('%s %s (%s) reaches the controller → 200', async (method, url) => {
    const res = await (request(createApp()) as any)[method.toLowerCase()](url)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })
})

describe('public booking surface — entitled venues pass the gate', () => {
  it('PRO venue (tier blanket grant) → 200, controller reached', async () => {
    vfFindMany.mockResolvedValue([{ active: true, suspendedAt: null, endDate: null, feature: { code: 'PLAN_PRO' } }])

    const res = await request(createApp()).post(`${P}/reservations`)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })

  it('GRANDFATHERED venue (seatCapExempt) → 200 with no grant and no plan', async () => {
    venueFindUnique.mockResolvedValue({ seatCapExempt: true, status: 'ACTIVE' })

    const res = await request(createApp()).post(`${P}/reservations`)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })

  it.each([['LIVE_DEMO'], ['TRIAL']])('DEMO venue (status %s) → 200 with no grant and no plan', async status => {
    venueFindUnique.mockResolvedValue({ seatCapExempt: false, status })

    const res = await request(createApp()).post(`${P}/reservations`)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })
})

describe('public booking surface — pass-through and fail-open', () => {
  it('unknown slug → middleware passes through to the controller (its 404 path), never 403', async () => {
    venueFindFirst.mockResolvedValue(null) // slug does not resolve

    // With the real controller this is its existing 404 ('Negocio no encontrado');
    // here the mocked controller answers 200, proving the gate stepped aside.
    const res = await request(createApp()).post(`${P}/reservations`)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })

  it('unexpected gate error (DB down) → FAIL-OPEN: logged, controller reached', async () => {
    venueFindFirst.mockRejectedValue(new Error('connection refused'))

    const res = await request(createApp()).post(`${P}/reservations`)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    expect((logger as any).error).toHaveBeenCalledWith(
      expect.stringContaining('failing open'),
      expect.objectContaining({ featureCode: 'RESERVATIONS' }),
    )
  })
})

describe('consumer app routes — create gated, manage-existing not', () => {
  it('POST /venues/:venueSlug/reservations (create) on a Free venue → 403 PLAN_REQUIRED', async () => {
    const res = await request(createApp()).post(`${C}/venues/${SLUG}/reservations`)

    expect(res.status).toBe(403)
    expect(res.body.code).toBe('PLAN_REQUIRED')
    expect(res.body.message).toBe(EXPECTED_403_MESSAGE)
  })

  it('POST /venues/:venueSlug/credit-packs/:packId/checkout on a Free venue → 403 PLAN_REQUIRED', async () => {
    const res = await request(createApp()).post(`${C}/venues/${SLUG}/credit-packs/pack_1/checkout`)

    expect(res.status).toBe(403)
    expect(res.body.code).toBe('PLAN_REQUIRED')
  })

  it.each([
    ['GET', `${C}/me`, 'auth/me'],
    ['GET', `${C}/venues`, 'venue discovery'],
    ['GET', `${C}/venues/${SLUG}`, 'venue detail'],
    ['GET', `${C}/reservations`, 'my reservations list'],
    ['GET', `${C}/credits`, 'my credits'],
    ['POST', `${C}/venues/${SLUG}/reservations/secret123/payment`, 'deposit payment for EXISTING reservation'],
    ['POST', `${C}/reservations/deposit/finalize`, 'deposit finalize'],
    ['POST', `${C}/credits/checkout/finalize`, 'credit checkout finalize'],
  ])('%s %s (%s) is NOT gated on a Free venue → 200', async (method, url) => {
    const res = await (request(createApp()) as any)[method.toLowerCase()](url)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })

  it('PRO venue → consumer create passes the gate → 200', async () => {
    vfFindMany.mockResolvedValue([{ active: true, suspendedAt: null, endDate: null, feature: { code: 'PLAN_PRO' } }])

    const res = await request(createApp()).post(`${C}/venues/${SLUG}/reservations`)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })
})

describe('wiring — the gates are actually present in the route files (source regression guard)', () => {
  const publicRoutesSrc = fs.readFileSync(path.resolve(__dirname, '../../../src/routes/public.routes.ts'), 'utf8')
  const consumerRoutesSrc = fs.readFileSync(path.resolve(__dirname, '../../../src/routes/consumer.routes.ts'), 'utf8')

  it.each([
    [/'\/venues\/:venueSlug\/availability',\s*readLimit,\s*requireReservationsPlan,/, 'availability GET'],
    [/'\/venues\/:venueSlug\/reservations',\s*writeLimit,\s*requireReservationsPlan,/, 'create POST'],
    [/'\/venues\/:venueSlug\/reservations\/hold',\s*writeLimit,\s*requireReservationsPlan,/, 'hold POST'],
    [/'\/venues\/:venueSlug\/reservations\/hold\/:holdId',\s*cancelLimit,\s*requireReservationsPlan,/, 'hold DELETE'],
    [/'\/venues\/:venueSlug\/credit-packs\/:packId\/checkout',\s*writeLimit,\s*requireReservationsPlan,/, 'pack checkout POST'],
  ])('public.routes.ts gates the create surface: %s (%s)', fragment => {
    expect(publicRoutesSrc).toMatch(fragment)
  })

  it('public.routes.ts wires the gate on EXACTLY the 5 create-surface routes (no creep onto manage-existing)', () => {
    expect((publicRoutesSrc.match(/^\s*requireReservationsPlan,$/gm) || []).length).toBe(5)
    // Manage-existing routes keep their original ungated chains.
    expect(publicRoutesSrc).toMatch(/'\/venues\/:venueSlug\/reservations\/:cancelSecret\/cancel',\s*cancelLimit,\s*validateRequest/)
    expect(publicRoutesSrc).toMatch(/'\/venues\/:venueSlug\/reservations\/:cancelSecret',\s*readLimit,\s*validateRequest/)
    expect(publicRoutesSrc).toMatch(/'\/venues\/:venueSlug\/credit-packs\/balance',\s*readLimit,\s*validateRequest/)
    expect(publicRoutesSrc).toMatch(/'\/venues\/:venueSlug\/info',\s*readLimit,\s*validateRequest/)
  })

  it('consumer.routes.ts wires the gate on EXACTLY the 2 create-surface routes', () => {
    expect((consumerRoutesSrc.match(/^\s*requireReservationsPlan,$/gm) || []).length).toBe(2)
    expect(consumerRoutesSrc).toMatch(/'\/venues\/:venueSlug\/reservations',\s*writeLimit,\s*authenticateConsumer,\s*requireReservationsPlan,/)
    expect(consumerRoutesSrc).toMatch(
      /'\/venues\/:venueSlug\/credit-packs\/:packId\/checkout',\s*writeLimit,\s*authenticateConsumer,\s*requireReservationsPlan,/,
    )
    // Deposit payment for an EXISTING reservation stays ungated.
    expect(consumerRoutesSrc).toMatch(
      /'\/venues\/:venueSlug\/reservations\/:cancelSecret\/payment',\s*writeLimit,\s*authenticateConsumer,\s*validateRequest/,
    )
  })

  it('mobile.routes.ts is untouched by the public plan gate (deliberate phased rollout)', () => {
    const mobileRoutesSrc = fs.readFileSync(path.resolve(__dirname, '../../../src/routes/mobile.routes.ts'), 'utf8')
    expect(mobileRoutesSrc).not.toContain('checkPublicVenueFeature')
  })
})
