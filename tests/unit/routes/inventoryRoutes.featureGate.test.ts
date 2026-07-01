/**
 * Plan-tier gating on /api/v1/dashboard/venues/:venueId/inventory — mounts the REAL inventory
 * router with the REAL namespace-wide checkFeatureAccess('INVENTORY_TRACKING') gate, mocking
 * only auth (context injector), checkPermission + validateRequest (passthrough), prisma and
 * the inventory controllers.
 *
 * INVENTORY_TRACKING is a PREMIUM-only differentiator (PREMIUM_ONLY_CODES):
 *   - PLAN_PREMIUM tier → 200
 *   - explicit own VenueFeature INVENTORY_TRACKING grant (à-la-carte legacy) → 200
 *   - grandfathered / demo venue → 200
 *   - platform superadmin → 200 (middleware bypass)
 *   - PLAN_PRO → 403 { featureCode: 'INVENTORY_TRACKING', subscriptionRequired }
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

// Permission gate is not under test — passthrough, but KEEP the real resolveRequestVenueId.
jest.mock('@/middlewares/checkPermission.middleware', () => ({
  ...jest.requireActual('@/middlewares/checkPermission.middleware'),
  checkPermission: () => (_req: any, _res: any, next: any) => next(),
}))

// Body/param validation is not under test — passthrough.
jest.mock('@/middlewares/validation', () => ({
  ...jest.requireActual('@/middlewares/validation'),
  validateRequest: () => (_req: any, _res: any, next: any) => next(),
}))

// Inventory controllers are not under test — every handler returns 200 with a marker.
const controllerProxy = () =>
  new Proxy({}, { get: (_t, prop) => (prop === '__esModule' ? true : (_req: any, res: any) => res.json({ handler: String(prop) })) })

jest.mock('@/controllers/dashboard/auto-reorder.controller', () => controllerProxy())
jest.mock('@/controllers/dashboard/inventory/rawMaterial.controller', () => controllerProxy())
jest.mock('@/controllers/dashboard/inventory/recipe.controller', () => controllerProxy())
jest.mock('@/controllers/dashboard/inventory/pricing.controller', () => controllerProxy())
jest.mock('@/controllers/dashboard/inventory/supplier.controller', () => controllerProxy())
jest.mock('@/controllers/dashboard/inventory/purchaseOrder.controller', () => controllerProxy())
jest.mock('@/controllers/dashboard/inventory/alert.controller', () => controllerProxy())
jest.mock('@/controllers/dashboard/inventory/report.controller', () => controllerProxy())
jest.mock('@/controllers/dashboard/inventory/productWizard.controller', () => controllerProxy())
jest.mock('@/controllers/dashboard/productInventory.controller', () => controllerProxy())
jest.mock('@/controllers/dashboard/inventory/productLabel.controller', () => controllerProxy())
jest.mock('@/controllers/dashboard/inventory/stockCount.controller', () => controllerProxy())
jest.mock('@/controllers/dashboard/inventory/inventoryTransfer.controller', () => controllerProxy())

import prisma from '@/utils/prismaClient'
import inventoryRoutes from '@/routes/dashboard/inventory.routes'

const staffVenueFindFirst = (prisma as any).staffVenue.findFirst as jest.Mock
const venueFindUnique = (prisma as any).venue.findUnique as jest.Mock
const vfFindFirst = (prisma as any).venueFeature.findFirst as jest.Mock
const vfFindMany = (prisma as any).venueFeature.findMany as jest.Mock

const VENUE_ID = 'venue_inv_1'

function createApp() {
  const app = express()
  // Stand-in for authenticateTokenMiddleware (dashboard.routes.ts mounts it before inventoryRoutes).
  app.use((req: any, _res, next) => {
    req.authContext = { userId: 'user_1', venueId: VENUE_ID, orgId: 'org_1', role: 'OWNER' }
    next()
  })
  // Same mount shape as dashboard.routes.ts:3970 (router has mergeParams: true).
  app.use('/api/v1/dashboard/venues/:venueId/inventory', inventoryRoutes)
  return app
}

const FREE_ACTIVE_VENUE = { seatCapExempt: false, status: 'ACTIVE' }
const GRANDFATHERED_VENUE = { seatCapExempt: true, status: 'ACTIVE' }
const DEMO_VENUE = { seatCapExempt: false, status: 'TRIAL' }

const PRO_PLAN_ROW = { active: true, suspendedAt: null, endDate: null, feature: { code: 'PLAN_PRO' } }
const PREMIUM_PLAN_ROW = { active: true, suspendedAt: null, endDate: null, feature: { code: 'PLAN_PREMIUM' } }

const RAW_MATERIALS_URL = `/api/v1/dashboard/venues/${VENUE_ID}/inventory/raw-materials`

beforeEach(() => {
  jest.clearAllMocks()
  staffVenueFindFirst.mockResolvedValue(null) // requester is NOT a platform superadmin
  venueFindUnique.mockResolvedValue(FREE_ACTIVE_VENUE)
  vfFindFirst.mockResolvedValue(null) // no own VenueFeature grant
  vfFindMany.mockResolvedValue([]) // no paid base plan (Free)
})

describe('inventory namespace plan gate — INVENTORY_TRACKING (PREMIUM)', () => {
  // NEW FEATURE TESTS
  it('Free venue → 403 INVENTORY_TRACKING subscriptionRequired', async () => {
    const res = await request(createApp()).get(RAW_MATERIALS_URL)

    expect(res.status).toBe(403)
    expect(res.body.featureCode).toBe('INVENTORY_TRACKING')
    expect(res.body.subscriptionRequired).toBe(true)
  })

  it('PRO venue (premium-only differentiator) → 403', async () => {
    vfFindMany.mockResolvedValue([PRO_PLAN_ROW])

    const res = await request(createApp()).get(RAW_MATERIALS_URL)

    expect(res.status).toBe(403)
    expect(res.body.featureCode).toBe('INVENTORY_TRACKING')
  })

  it('PREMIUM venue → 200 (controller reached)', async () => {
    vfFindMany.mockResolvedValue([PREMIUM_PLAN_ROW])

    const res = await request(createApp()).get(RAW_MATERIALS_URL)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ handler: 'getRawMaterials' })
  })

  it('explicit own VenueFeature INVENTORY_TRACKING grant (à-la-carte legacy) → 200 even on Free', async () => {
    vfFindFirst.mockResolvedValue({
      id: 'vf_1',
      active: true,
      endDate: null,
      suspendedAt: null,
      stripeSubscriptionId: null,
      feature: { code: 'INVENTORY_TRACKING', name: 'Inventario' },
    })

    const res = await request(createApp()).get(RAW_MATERIALS_URL)

    expect(res.status).toBe(200)
  })

  it('gate covers deep routes too (suppliers) → 403 on Free', async () => {
    const res = await request(createApp()).get(`/api/v1/dashboard/venues/${VENUE_ID}/inventory/suppliers`)

    expect(res.status).toBe(403)
    expect(res.body.featureCode).toBe('INVENTORY_TRACKING')
  })

  // REGRESSION TESTS — exemptions and bypasses that must keep working
  it('GRANDFATHERED venue → 200 (exempt from plan gating)', async () => {
    venueFindUnique.mockResolvedValue(GRANDFATHERED_VENUE)

    const res = await request(createApp()).get(RAW_MATERIALS_URL)

    expect(res.status).toBe(200)
  })

  it('DEMO venue (TRIAL) → 200 (demos showcase everything)', async () => {
    venueFindUnique.mockResolvedValue(DEMO_VENUE)

    const res = await request(createApp()).get(RAW_MATERIALS_URL)

    expect(res.status).toBe(200)
  })

  it('platform SUPERADMIN → 200 even on a Free venue (middleware bypass)', async () => {
    staffVenueFindFirst.mockResolvedValue({ id: 'sv_super' })

    const res = await request(createApp()).get(RAW_MATERIALS_URL)

    expect(res.status).toBe(200)
  })

  it('auto-reorder still ALSO requires AUTO_REORDER (its own premium code) on top of the namespace gate', async () => {
    // PREMIUM tier blanket-grants both codes → both gates pass and the controller is reached.
    vfFindMany.mockResolvedValue([PREMIUM_PLAN_ROW])

    const res = await request(createApp()).get(`/api/v1/dashboard/venues/${VENUE_ID}/inventory/auto-reorder`)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ handler: 'getSettings' })
  })
})
