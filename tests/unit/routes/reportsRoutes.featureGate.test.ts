/**
 * Plan-tier gating on /api/v1/dashboard/reports — mounts the REAL reports router with the
 * REAL checkFeatureAccess middleware and REAL clampSalesSummaryRangeToToday, mocking only
 * auth (context injector), checkPermission (passthrough), prisma, and the report controllers.
 *
 * Coverage:
 *   - sales-by-item: fully Pro-gated (ADVANCED_REPORTS) → Free 403 / Pro 200.
 *   - refunds: fully Pro-gated → Free 403.
 *   - sales-summary: NOT 403'd for Free — clamped to "today" in venue timezone:
 *       Free + multi-day range  → 403 code PLAN_LIMIT_RANGE (Spanish message)
 *       Free + today            → 200 (controller reached)
 *       Pro / grandfathered / demo + multi-day → 200 (any range)
 *   - pay-later-aging: deliberately ungated → Free 200.
 */

import express from 'express'
import request from 'supertest'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findUnique: jest.fn() },
    venueFeature: { findFirst: jest.fn(), findMany: jest.fn() },
  },
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

// Permission gate is not under test — passthrough, but KEEP the real resolveRequestVenueId
// (used by both checkFeatureAccess and the clamp middleware).
jest.mock('@/middlewares/checkPermission.middleware', () => ({
  ...jest.requireActual('@/middlewares/checkPermission.middleware'),
  checkPermission: () => (_req: any, _res: any, next: any) => next(),
}))

// Report controllers are not under test — each returns 200 with a marker.
jest.mock('@/controllers/dashboard/reports.dashboard.controller', () => ({
  payLaterAgingReport: (_req: any, res: any) => res.json({ report: 'pay-later-aging' }),
}))
jest.mock('@/controllers/dashboard/sales-summary.dashboard.controller', () => ({
  salesSummaryReport: (_req: any, res: any) => res.json({ report: 'sales-summary' }),
}))
jest.mock('@/controllers/dashboard/sales-by-item.dashboard.controller', () => ({
  salesByItemReport: (_req: any, res: any) => res.json({ report: 'sales-by-item' }),
}))
jest.mock('@/controllers/dashboard/refunds.dashboard.controller', () => ({
  refundsReport: (_req: any, res: any) => res.json({ report: 'refunds' }),
}))

import prisma from '@/utils/prismaClient'
import reportsRoutes from '@/routes/dashboard/reports.routes'

const venueFindUnique = (prisma as any).venue.findUnique as jest.Mock
const vfFindFirst = (prisma as any).venueFeature.findFirst as jest.Mock
const vfFindMany = (prisma as any).venueFeature.findMany as jest.Mock

const VENUE_ID = 'venue_rep_1'
const TZ = 'America/Mexico_City'

function createApp() {
  const app = express()
  // Stand-in for authenticateTokenMiddleware (dashboard.routes.ts mounts it before reportsRoutes).
  app.use((req: any, _res, next) => {
    req.authContext = { userId: 'user_1', venueId: VENUE_ID, orgId: 'org_1', role: 'OWNER' }
    next()
  })
  app.use('/api/v1/dashboard/reports', reportsRoutes)
  return app
}

/** Venue mock rows — the same findUnique serves the exemption check (seatCapExempt+status) and the timezone fetch. */
const FREE_ACTIVE_VENUE = { seatCapExempt: false, status: 'ACTIVE', timezone: TZ }
const GRANDFATHERED_VENUE = { seatCapExempt: true, status: 'ACTIVE', timezone: TZ }
const DEMO_VENUE = { seatCapExempt: false, status: 'LIVE_DEMO', timezone: TZ }

const PRO_PLAN_ROW = { active: true, suspendedAt: null, endDate: null, feature: { code: 'PLAN_PRO' } }

const now = () => new Date().toISOString()
const daysAgo = (d: number) => new Date(Date.now() - d * 86400000).toISOString()

beforeEach(() => {
  jest.clearAllMocks()
  venueFindUnique.mockResolvedValue(FREE_ACTIVE_VENUE)
  vfFindFirst.mockResolvedValue(null) // no own VenueFeature grant
  vfFindMany.mockResolvedValue([]) // no paid base plan (Free)
})

describe('GET /reports/sales-by-item — fully Pro-gated (ADVANCED_REPORTS)', () => {
  it('Free venue → 403 ADVANCED_REPORTS', async () => {
    const res = await request(createApp()).get('/api/v1/dashboard/reports/sales-by-item').query({ startDate: now(), endDate: now() })

    expect(res.status).toBe(403)
    expect(res.body.featureCode).toBe('ADVANCED_REPORTS')
    expect(res.body.subscriptionRequired).toBe(true)
  })

  it('PRO venue → 200 (controller reached)', async () => {
    vfFindMany.mockResolvedValue([PRO_PLAN_ROW])

    const res = await request(createApp()).get('/api/v1/dashboard/reports/sales-by-item').query({ startDate: now(), endDate: now() })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ report: 'sales-by-item' })
  })
})

describe('GET /reports/refunds — fully Pro-gated (ADVANCED_REPORTS)', () => {
  it('Free venue → 403 ADVANCED_REPORTS', async () => {
    const res = await request(createApp()).get('/api/v1/dashboard/reports/refunds').query({ startDate: now(), endDate: now() })

    expect(res.status).toBe(403)
    expect(res.body.featureCode).toBe('ADVANCED_REPORTS')
  })
})

describe('GET /reports/sales-summary — Free gets TODAY only (range clamp, never a blanket 403)', () => {
  it('Free venue + multi-day range → 403 PLAN_LIMIT_RANGE with Spanish message', async () => {
    const res = await request(createApp())
      .get('/api/v1/dashboard/reports/sales-summary')
      .query({ startDate: daysAgo(7), endDate: now() })

    expect(res.status).toBe(403)
    expect(res.body.code).toBe('PLAN_LIMIT_RANGE')
    expect(res.body.featureCode).toBe('ADVANCED_REPORTS')
    expect(res.body.message).toContain('plan Pro')
  })

  it('Free venue + today range → 200 (basic today-only summary is included in Free)', async () => {
    const res = await request(createApp()).get('/api/v1/dashboard/reports/sales-summary').query({ startDate: now(), endDate: now() })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ report: 'sales-summary' })
  })

  it('PRO venue + multi-day range → 200 (any range)', async () => {
    vfFindMany.mockResolvedValue([PRO_PLAN_ROW])

    const res = await request(createApp())
      .get('/api/v1/dashboard/reports/sales-summary')
      .query({ startDate: daysAgo(30), endDate: now() })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ report: 'sales-summary' })
  })

  it('GRANDFATHERED venue + multi-day range → 200 (exempt)', async () => {
    venueFindUnique.mockResolvedValue(GRANDFATHERED_VENUE)

    const res = await request(createApp())
      .get('/api/v1/dashboard/reports/sales-summary')
      .query({ startDate: daysAgo(30), endDate: now() })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ report: 'sales-summary' })
  })

  it('DEMO venue (LIVE_DEMO) + multi-day range → 200 (demos showcase everything)', async () => {
    venueFindUnique.mockResolvedValue(DEMO_VENUE)

    const res = await request(createApp())
      .get('/api/v1/dashboard/reports/sales-summary')
      .query({ startDate: daysAgo(30), endDate: now() })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ report: 'sales-summary' })
  })

  it('Free venue + missing dates → falls through to controller (which owns the 400)', async () => {
    const res = await request(createApp()).get('/api/v1/dashboard/reports/sales-summary')

    // Controller mock answers 200 here; the point is the clamp does NOT 403 on missing dates.
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ report: 'sales-summary' })
  })
})

describe('GET /reports/pay-later-aging — deliberately ungated (own permission, not ADVANCED_REPORTS)', () => {
  it('Free venue → 200', async () => {
    const res = await request(createApp()).get('/api/v1/dashboard/reports/pay-later-aging')

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ report: 'pay-later-aging' })
  })
})
