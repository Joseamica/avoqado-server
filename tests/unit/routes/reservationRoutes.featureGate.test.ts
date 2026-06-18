/**
 * Plan-tier gate on the reservations route group — proves checkFeatureAccess('RESERVATIONS')
 * sits in the chain the way dashboard.routes.ts mounts it, and behaves per tier:
 *   - Free ACTIVE venue (no grant, no paid plan) → 403 with featureCode RESERVATIONS
 *   - PRO venue (tier blanket)                   → 200
 *   - GRANDFATHERED venue (seatCapExempt)        → 200
 *   - DEMO venue (status LIVE_DEMO / TRIAL)      → 200
 *
 * Mounts the REAL reservation sub-router behind the REAL checkFeatureAccess middleware in the
 * exact shape of the dashboard.routes.ts mount (auth → feature gate → router). Mocks only:
 * auth (context injector), checkPermission (passthrough), prisma, and the controller/services.
 *
 * Also asserts (source-level) that dashboard.routes.ts / reports.routes.ts actually WIRE the
 * gates — a regression guard so the middleware can't silently fall off a mount line.
 *
 * Mirrors tests/unit/routes/superadminPlanAdmin.routes.test.ts.
 */

import fs from 'fs'
import path from 'path'
import express from 'express'
import request from 'supertest'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    // staffVenue powers the SUPERADMIN bypass in checkFeatureAccess (requestIsSuperAdmin).
    // Without it, prisma.staffVenue is undefined → the gate throws → catch returns 500.
    staffVenue: { findFirst: jest.fn() },
    venue: { findUnique: jest.fn() },
    venueFeature: { findFirst: jest.fn(), findMany: jest.fn() },
  },
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

// Permission gate is not under test — passthrough (keep the REAL resolveRequestVenueId,
// which checkFeatureAccess imports from the same module).
jest.mock('@/middlewares/checkPermission.middleware', () => ({
  ...jest.requireActual('@/middlewares/checkPermission.middleware'),
  checkPermission: () => (_req: any, _res: any, next: any) => next(),
}))

// Controller + services behind the router are not under test — any handler returns 200 {ok}.
jest.mock(
  '@/controllers/dashboard/reservation.dashboard.controller',
  () => new Proxy({}, { get: () => (_req: any, res: any) => res.json({ ok: true }) }),
)
jest.mock('@/services/dashboard/reservationWaitlist.service', () => new Proxy({}, { get: () => jest.fn() }))
jest.mock('@/services/dashboard/reservationSettings.service', () => new Proxy({}, { get: () => jest.fn() }))

import prisma from '@/utils/prismaClient'
import { checkFeatureAccess } from '@/middlewares/checkFeatureAccess.middleware'
import reservationRoutes from '@/routes/dashboard/reservation.routes'

const staffVenueFindFirst = (prisma as any).staffVenue.findFirst as jest.Mock
const venueFindUnique = (prisma as any).venue.findUnique as jest.Mock
const vfFindFirst = (prisma as any).venueFeature.findFirst as jest.Mock
const vfFindMany = (prisma as any).venueFeature.findMany as jest.Mock

const VENUE_ID = 'venue_res_1'

function createApp() {
  const app = express()
  app.use(express.json())
  // Stand-in for authenticateTokenMiddleware: inject authContext (gate needs userId + venue).
  app.use((req: any, _res, next) => {
    req.authContext = { userId: 'user_1', venueId: VENUE_ID, orgId: 'org_1', role: 'OWNER' }
    next()
  })
  // EXACT mount shape from dashboard.routes.ts (auth above → feature gate → sub-router).
  app.use('/api/v1/dashboard/venues/:venueId/reservations', checkFeatureAccess('RESERVATIONS'), reservationRoutes)
  return app
}

/** GET /settings — a real route in the sub-router with no request validation in the way. */
const SETTINGS_URL = `/api/v1/dashboard/venues/${VENUE_ID}/reservations/settings`

beforeEach(() => {
  jest.clearAllMocks()
  staffVenueFindFirst.mockResolvedValue(null) // requester is NOT a platform superadmin
  vfFindFirst.mockResolvedValue(null) // no own VenueFeature grant by default
  vfFindMany.mockResolvedValue([]) // no paid base plan by default
})

describe('reservations route group — plan-tier gate (RESERVATIONS)', () => {
  it('Free ACTIVE venue (no grant, no plan) → 403 RESERVATIONS', async () => {
    venueFindUnique.mockResolvedValue({ seatCapExempt: false, status: 'ACTIVE' })

    const res = await request(createApp()).get(SETTINGS_URL)

    expect(res.status).toBe(403)
    expect(res.body.featureCode).toBe('RESERVATIONS')
    expect(res.body.subscriptionRequired).toBe(true)
  })

  it('PRO venue (tier blanket grant) → 200, route handler reached', async () => {
    venueFindUnique.mockResolvedValue({ seatCapExempt: false, status: 'ACTIVE' })
    vfFindMany.mockResolvedValue([{ active: true, suspendedAt: null, endDate: null, feature: { code: 'PLAN_PRO' } }])

    const res = await request(createApp()).get(SETTINGS_URL)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })

  it('GRANDFATHERED venue → 200 with no grant and no plan', async () => {
    venueFindUnique.mockResolvedValue({ seatCapExempt: true, status: 'ACTIVE' })

    const res = await request(createApp()).get(SETTINGS_URL)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })

  it.each([['LIVE_DEMO'], ['TRIAL']])('DEMO venue (status %s) → 200 with no grant and no plan', async status => {
    venueFindUnique.mockResolvedValue({ seatCapExempt: false, status })

    const res = await request(createApp()).get(SETTINGS_URL)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })
})

describe('wiring — the gates are actually present in the route files (source regression guard)', () => {
  const dashboardRoutesSrc = fs.readFileSync(path.resolve(__dirname, '../../../src/routes/dashboard.routes.ts'), 'utf8')
  const reportsRoutesSrc = fs.readFileSync(path.resolve(__dirname, '../../../src/routes/dashboard/reports.routes.ts'), 'utf8')

  it.each([
    ["/venues/:venueId/reservations', authenticateTokenMiddleware, checkFeatureAccess('RESERVATIONS')", 'reservations mount'],
    ["/venues/:venueId/class-sessions', authenticateTokenMiddleware, checkFeatureAccess('RESERVATIONS')", 'class-sessions mount'],
    ["/venues/:venueId/referrals', authenticateTokenMiddleware, checkFeatureAccess('REFERRAL_PROGRAM')", 'referrals mount'],
    ["/venues/:venueId/loyalty', authenticateTokenMiddleware, checkFeatureAccess('LOYALTY_PROGRAM')", 'loyalty prefix gate'],
    [
      "/venues/:venueId/customers/:customerId/loyalty', authenticateTokenMiddleware, checkFeatureAccess('LOYALTY_PROGRAM')",
      'customer loyalty prefix gate',
    ],
    ["/venues/:venueId/discounts', authenticateTokenMiddleware, checkFeatureAccess('PROMOTIONS')", 'discounts prefix gate'],
    [
      "/venues/:venueId/customers/:customerId/discounts', authenticateTokenMiddleware, checkFeatureAccess('PROMOTIONS')",
      'customer discounts prefix gate',
    ],
    ["/venues/:venueId/coupons', authenticateTokenMiddleware, checkFeatureAccess('PROMOTIONS')", 'coupons prefix gate'],
  ])('dashboard.routes.ts contains gate: %s (%s)', fragment => {
    expect(dashboardRoutesSrc).toContain(fragment)
  })

  it('reports.routes.ts gates sales-by-item + refunds with ADVANCED_REPORTS and clamps sales-summary', () => {
    expect(reportsRoutesSrc).toContain("router.get('/sales-by-item', checkFeatureAccess('ADVANCED_REPORTS')")
    expect(reportsRoutesSrc).toContain("router.get('/refunds', checkFeatureAccess('ADVANCED_REPORTS')")
    expect(reportsRoutesSrc).toContain("router.get('/sales-summary', checkPermission('reports:read'), clampSalesSummaryRangeToToday")
    // pay-later-aging deliberately ungated (own permission, not part of ADVANCED_REPORTS)
    expect(reportsRoutesSrc).toContain("router.get('/pay-later-aging', checkPermission('tpv-reports:pay-later-aging')")
  })
})
