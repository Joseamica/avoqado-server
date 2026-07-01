/**
 * Plan-tier gating on /api/v1/dashboard/commissions — mounts the REAL commission router with
 * the REAL namespace plan gate (venueHasCommissionsAccess → checkFeatureAccess fallback),
 * mocking only auth (context injector), checkPermission (passthrough), moduleService, prisma
 * and the commission controllers.
 *
 * COMMISSIONS is the DUAL-GRANTED premium differentiator:
 *   - COMMISSIONS Module enabled (VenueModule/OrganizationModule — legacy + white-label orgs) → 200
 *   - PLAN_PREMIUM tier → 200
 *   - explicit own VenueFeature COMMISSIONS grant → 200
 *   - grandfathered / demo venue → 200
 *   - platform superadmin → 200 (middleware bypass)
 *   - PLAN_PRO (premium-only differentiator) → 403 { featureCode: 'COMMISSIONS', subscriptionRequired }
 *   - Free venue → 403
 */

import express from 'express'
import request from 'supertest'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    // staffVenue powers the SUPERADMIN bypass in checkFeatureAccess (requestIsSuperAdmin).
    staffVenue: { findFirst: jest.fn() },
    venue: { findUnique: jest.fn() },
    venueFeature: { findFirst: jest.fn(), findMany: jest.fn() },
  },
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

// Module resolver mocked directly — the dual-grant's module side is a boolean per test case.
jest.mock('@/services/modules/module.service', () => ({
  __esModule: true,
  MODULE_CODES: {
    SERIALIZED_INVENTORY: 'SERIALIZED_INVENTORY',
    ATTENDANCE_TRACKING: 'ATTENDANCE_TRACKING',
    WHITE_LABEL_DASHBOARD: 'WHITE_LABEL_DASHBOARD',
    COMMISSIONS: 'COMMISSIONS',
  },
  moduleService: { isModuleEnabled: jest.fn() },
}))

// Permission gate is not under test — passthrough, but KEEP the real resolveRequestVenueId
// (used by checkFeatureAccess).
jest.mock('@/middlewares/checkPermission.middleware', () => ({
  ...jest.requireActual('@/middlewares/checkPermission.middleware'),
  checkPermission: () => (_req: any, _res: any, next: any) => next(),
}))

// Commission controllers/services are not under test — every handler returns 200 with a marker.
jest.mock(
  '@/controllers/dashboard/commission.dashboard.controller',
  () => new Proxy({}, { get: (_t, prop) => (prop === '__esModule' ? true : (_req: any, res: any) => res.json({ handler: String(prop) })) }),
)
jest.mock(
  '@/services/dashboard/commission/commission-resolution.service',
  () => new Proxy({}, { get: (_t, prop) => (prop === '__esModule' ? true : jest.fn().mockResolvedValue([])) }),
)
jest.mock(
  '@/services/dashboard/commission/payout-resolution.service',
  () => new Proxy({}, { get: (_t, prop) => (prop === '__esModule' ? true : jest.fn().mockResolvedValue(null)) }),
)

import prisma from '@/utils/prismaClient'
import { moduleService } from '@/services/modules/module.service'
import commissionRoutes from '@/routes/dashboard/commission.routes'

const staffVenueFindFirst = (prisma as any).staffVenue.findFirst as jest.Mock
const venueFindUnique = (prisma as any).venue.findUnique as jest.Mock
const vfFindFirst = (prisma as any).venueFeature.findFirst as jest.Mock
const vfFindMany = (prisma as any).venueFeature.findMany as jest.Mock
const isModuleEnabled = (moduleService as any).isModuleEnabled as jest.Mock

const VENUE_ID = 'venue_comm_1'

function createApp() {
  const app = express()
  // Stand-in for authenticateTokenMiddleware (dashboard.routes.ts mounts it before commissionRoutes).
  app.use((req: any, _res, next) => {
    req.authContext = { userId: 'user_1', venueId: VENUE_ID, orgId: 'org_1', role: 'OWNER' }
    next()
  })
  app.use('/api/v1/dashboard/commissions', commissionRoutes)
  return app
}

const FREE_ACTIVE_VENUE = { seatCapExempt: false, status: 'ACTIVE' }
const GRANDFATHERED_VENUE = { seatCapExempt: true, status: 'ACTIVE' }
const DEMO_VENUE = { seatCapExempt: false, status: 'LIVE_DEMO' }

const PRO_PLAN_ROW = { active: true, suspendedAt: null, endDate: null, feature: { code: 'PLAN_PRO' } }
const PREMIUM_PLAN_ROW = { active: true, suspendedAt: null, endDate: null, feature: { code: 'PLAN_PREMIUM' } }

const CONFIGS_URL = `/api/v1/dashboard/commissions/venues/${VENUE_ID}/configs`

beforeEach(() => {
  jest.clearAllMocks()
  staffVenueFindFirst.mockResolvedValue(null) // requester is NOT a platform superadmin
  venueFindUnique.mockResolvedValue(FREE_ACTIVE_VENUE)
  vfFindFirst.mockResolvedValue(null) // no own VenueFeature grant
  vfFindMany.mockResolvedValue([]) // no paid base plan (Free)
  isModuleEnabled.mockResolvedValue(false) // no COMMISSIONS module grant
})

describe('commission namespace plan gate — dual grant (module OR tier)', () => {
  // NEW FEATURE TESTS
  it('Free venue, no module → 403 COMMISSIONS subscriptionRequired', async () => {
    const res = await request(createApp()).get(CONFIGS_URL)

    expect(res.status).toBe(403)
    expect(res.body.featureCode).toBe('COMMISSIONS')
    expect(res.body.subscriptionRequired).toBe(true)
  })

  it('PRO venue (premium-only differentiator) → 403', async () => {
    vfFindMany.mockResolvedValue([PRO_PLAN_ROW])

    const res = await request(createApp()).get(CONFIGS_URL)

    expect(res.status).toBe(403)
    expect(res.body.featureCode).toBe('COMMISSIONS')
  })

  it('PREMIUM venue → 200 (controller reached)', async () => {
    vfFindMany.mockResolvedValue([PREMIUM_PLAN_ROW])

    const res = await request(createApp()).get(CONFIGS_URL)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ handler: 'getConfigs' })
  })

  it('COMMISSIONS module enabled (VenueModule/OrgModule, e.g. white-label org) → 200 even on Free', async () => {
    isModuleEnabled.mockResolvedValue(true)

    const res = await request(createApp()).get(CONFIGS_URL)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ handler: 'getConfigs' })
    expect(isModuleEnabled).toHaveBeenCalledWith(VENUE_ID, 'COMMISSIONS')
  })

  it('explicit own VenueFeature COMMISSIONS grant (à-la-carte legacy) → 200 even on Free', async () => {
    vfFindFirst.mockResolvedValue({ active: true, endDate: null, suspendedAt: null, feature: { code: 'COMMISSIONS', name: 'Comisiones' } })

    const res = await request(createApp()).get(CONFIGS_URL)

    expect(res.status).toBe(200)
  })

  // REGRESSION TESTS — exemptions and bypasses that must keep working
  it('GRANDFATHERED venue → 200 (exempt from plan gating)', async () => {
    venueFindUnique.mockResolvedValue(GRANDFATHERED_VENUE)

    const res = await request(createApp()).get(CONFIGS_URL)

    expect(res.status).toBe(200)
  })

  it('DEMO venue (LIVE_DEMO) → 200 (demos showcase everything)', async () => {
    venueFindUnique.mockResolvedValue(DEMO_VENUE)

    const res = await request(createApp()).get(CONFIGS_URL)

    expect(res.status).toBe(200)
  })

  it('platform SUPERADMIN → 200 even on a Free venue (middleware bypass)', async () => {
    staffVenueFindFirst.mockResolvedValue({ id: 'sv_super' })

    const res = await request(createApp()).get(CONFIGS_URL)

    expect(res.status).toBe(200)
  })

  it('gate covers deep routes too (payouts) → 403 on Free', async () => {
    const res = await request(createApp()).get(`/api/v1/dashboard/commissions/venues/${VENUE_ID}/payouts`)

    expect(res.status).toBe(403)
    expect(res.body.featureCode).toBe('COMMISSIONS')
  })

  it('module resolver error falls through to the tier gate (PREMIUM still 200)', async () => {
    isModuleEnabled.mockRejectedValue(new Error('db hiccup'))
    vfFindMany.mockResolvedValue([PREMIUM_PLAN_ROW])

    const res = await request(createApp()).get(CONFIGS_URL)

    expect(res.status).toBe(200)
  })
})
