/**
 * TABLE_SERVICE plan gating on /api/v1/tpv table-service routes (Plan B Task 2, 2026-07-27).
 *
 * Only /mobile gated TABLE_SERVICE (mobile.routes.ts:1601,1616,1630); the identical capability
 * under /tpv was wide open — a FREE venue could open/clear tables from the terminal.
 *
 * Mounts the REAL tpv.routes.ts router with the REAL checkFeatureAccess middleware (mirrors
 * tests/unit/routes/inventoryRoutes.featureGate.test.ts / reportsRoutes.featureGate.test.ts),
 * mocking only: auth (context injector, since tpv.routes.ts references authenticateTokenMiddleware
 * inline per-route rather than via a parent router.use), checkPermission + validateRequest
 * (passthrough — not under test here; tpv.tables.routes.permissions.test.ts already covers those),
 * prisma, moduleService, and the table/floor-element controllers.
 *
 * TABLE_SERVICE resolver — determined, not assumed: MODULE_CODES (module.service.ts) lists only
 * SERIALIZED_INVENTORY / ATTENDANCE_TRACKING / WHITE_LABEL_DASHBOARD / COMMISSIONS — no
 * TABLE_SERVICE entry (isModuleEnabled's `moduleCode: ModuleCode` param wouldn't even accept it).
 * mobile.routes.ts already gates the identical mobile capability with
 * checkFeatureAccess('TABLE_SERVICE') / hasFeatureAccess(venueId, 'TABLE_SERVICE') — both from
 * checkFeatureAccess.middleware.ts, i.e. the Feature/VenueFeature tier system, never the Module
 * system. So this file mocks prisma.venueFeature (Feature system) and asserts
 * moduleService.isModuleEnabled is NEVER called — see the "wrong resolver" tests below.
 *
 * Scope decision — which routes got the gate (full reasoning in task-2-report.md):
 *   GATED   POST tables/assign, POST tables/:tableId/clear — these literally OPERATE table
 *           service (open/close the dine-in service loop on a table).
 *   NOT gated:
 *     - GET tables / GET floor-elements — floor-plan READ is core (must not 500 a venue without
 *       TABLE_SERVICE) and also feeds the RESERVATIONS table picker (mobile.routes.ts:1566) —
 *       a DIFFERENT Feature code, so it must never 403 for a TABLE_SERVICE-less venue.
 *     - Floor-plan CRUD (create/update/delete tables & floor-elements) — venue SETUP, not
 *       "service"; also shared with RESERVATIONS (same reason as GET); gated by ROLE only
 *       (tpv-tables:write/delete — Task 1), not by plan tier.
 *     - The pre-existing generic order-mutation routes under /tpv (add/remove items, guest info,
 *       comp, void, discounts) — unlike /mobile's check-panel routes (which ALWAYS require
 *       checkTableOwnership, i.e. are inherently table-bound), these operate on ANY OrderType
 *       (TAKEOUT/PICKUP/DELIVERY/MANUAL_ENTRY too — see OrderType enum, schema.prisma:6607), so
 *       gating them by TABLE_SERVICE would 403 a FREE retail/services venue's ordinary checkout —
 *       a severe regression against the platform's actual ICP (retail + services, not
 *       restaurants — see workspace CLAUDE.md).
 *
 * Middleware order: checkFeatureAccess runs AFTER validateVenueAccess (Task 1) so a cross-tenant
 * probe (URL venueId ≠ token venueId) 403s on tenant ownership BEFORE the feature gate ever runs
 * — otherwise the 403 body (featureCode/subscriptionRequired) would leak another venue's plan
 * state to a non-member. See the "cross-tenant probe" tests below, which assert the
 * checkFeatureAccess prisma calls never fire in that case.
 */

import express from 'express'
import request from 'supertest'

// 1. Auth: inject authContext from a test header. tpv.routes.ts calls authenticateTokenMiddleware
//    inline on every route (no parent router.use), so the real middleware must be replaced here.
jest.mock('@/middlewares/authenticateToken.middleware', () => ({
  authenticateTokenMiddleware: (req: any, _res: any, next: any) => {
    const ctx = req.headers['x-test-auth-context']
    if (ctx) req.authContext = JSON.parse(ctx as string)
    next()
  },
}))

// 2. checkPermission: passthrough — not under test. tpv.tables.routes.permissions.test.ts
//    already proves tables/assign and tables/:tableId/clear carry NO checkPermission today.
//    KEEP the real resolveRequestVenueId — checkFeatureAccess.middleware.ts imports it from here.
jest.mock('@/middlewares/checkPermission.middleware', () => ({
  ...jest.requireActual('@/middlewares/checkPermission.middleware'),
  checkPermission: () => (_req: any, _res: any, next: any) => next(),
}))

// 3. validateRequest: passthrough — body/param shape is not under test.
jest.mock('@/middlewares/validation', () => ({
  ...jest.requireActual('@/middlewares/validation'),
  validateRequest: () => (_req: any, _res: any, next: any) => next(),
}))

// 4. prisma: the models checkFeatureAccess touches, PLUS venueSettings — the
//    regression test below now also passes through checkTableOwnership('order')
//    (open finding #2 fix), which queries venueSettings.enforceTableOwnership.
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    staffVenue: { findFirst: jest.fn() }, // SUPERADMIN bypass (requestIsSuperAdmin)
    venue: { findUnique: jest.fn() }, // venueIsExemptFromPlanGating (grandfathered/demo)
    venueFeature: { findFirst: jest.fn(), findMany: jest.fn() }, // own grant + getVenueBaseTier
    venueSettings: { findUnique: jest.fn() }, // isTableOwnershipEnforced (checkTableOwnership)
  },
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

// 5. moduleService: the WRONG resolver for TABLE_SERVICE (it is a Feature, not a Module — see
//    file header). Mocked so tests can assert it is NEVER consulted by these routes.
jest.mock('@/services/modules/module.service', () => {
  const actual = jest.requireActual('@/services/modules/module.service')
  return { ...actual, moduleService: { ...actual.moduleService, isModuleEnabled: jest.fn() } }
})

// 6. Table/floor-element/order controllers: not under test — any handler responds 200 + a marker.
//    order.tpv.controller is mocked only because one regression test below hits the generic
//    (deliberately ungated) orders/:orderId/items route.
const controllerProxy = () =>
  new Proxy({}, { get: (_t, prop) => (prop === '__esModule' ? true : (_req: any, res: any) => res.json({ handler: String(prop) })) })
jest.mock('@/controllers/tpv/table.tpv.controller', () => controllerProxy())
jest.mock('@/controllers/tpv/floor-element.tpv.controller', () => controllerProxy())
jest.mock('@/controllers/tpv/order.tpv.controller', () => controllerProxy())

// ─── Import router AFTER the mocks ─────────────────────────────────────────────
import prisma from '@/utils/prismaClient'
import tpvRouter from '@/routes/tpv.routes'
import { moduleService } from '@/services/modules/module.service'

const staffVenueFindFirst = (prisma as any).staffVenue.findFirst as jest.Mock
const venueFindUnique = (prisma as any).venue.findUnique as jest.Mock
const vfFindFirst = (prisma as any).venueFeature.findFirst as jest.Mock
const vfFindMany = (prisma as any).venueFeature.findMany as jest.Mock
const venueSettingsFindUnique = (prisma as any).venueSettings.findUnique as jest.Mock
const isModuleEnabledMock = moduleService.isModuleEnabled as jest.Mock

const VENUE_ID = 'venue-tpv-table-1'
const OTHER_VENUE_ID = 'venue-tpv-table-OTHER'

function authHeader(ctx: object): Record<string, string> {
  return { 'x-test-auth-context': JSON.stringify(ctx) }
}

const waiterCtx = { userId: 'user-1', orgId: 'org-1', venueId: VENUE_ID, role: 'WAITER' }

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/tpv', tpvRouter)
  // Safety net: turns any thrown error into JSON instead of an HTML stack trace.
  app.use((err: any, _req: any, res: any, _next: any) => res.status(err?.statusCode || 500).json({ error: err?.message || 'error' }))
  return app
}

const FREE_ACTIVE_VENUE = { seatCapExempt: false, status: 'ACTIVE' }
const GRANDFATHERED_VENUE = { seatCapExempt: true, status: 'ACTIVE' }
const DEMO_VENUE = { seatCapExempt: false, status: 'LIVE_DEMO' }

const PRO_PLAN_ROW = { active: true, suspendedAt: null, endDate: null, feature: { code: 'PLAN_PRO' } }
const PREMIUM_PLAN_ROW = { active: true, suspendedAt: null, endDate: null, feature: { code: 'PLAN_PREMIUM' } }

beforeEach(() => {
  jest.clearAllMocks()
  staffVenueFindFirst.mockResolvedValue(null) // not a platform superadmin
  venueFindUnique.mockResolvedValue(FREE_ACTIVE_VENUE)
  vfFindFirst.mockResolvedValue(null) // no explicit own TABLE_SERVICE grant
  vfFindMany.mockResolvedValue([]) // no active paid base plan → FREE
  venueSettingsFindUnique.mockResolvedValue({ enforceTableOwnership: false }) // switch off → checkTableOwnership no-ops
  isModuleEnabledMock.mockResolvedValue(false)
})

describe('POST /tpv/venues/:venueId/tables/assign — TABLE_SERVICE gate', () => {
  // NEW FEATURE TESTS
  it('FREE venue → 403 TABLE_SERVICE, controller never reached', async () => {
    const res = await request(createApp())
      .post(`/tpv/venues/${VENUE_ID}/tables/assign`)
      .set(authHeader(waiterCtx))
      .send({ tableId: 'table-1', staffId: 'user-1', covers: 2 })

    expect(res.status).toBe(403)
    expect(res.body.featureCode).toBe('TABLE_SERVICE')
    expect(res.body.subscriptionRequired).toBe(true)
  })

  it('PRO venue → 200 (controller reached)', async () => {
    vfFindMany.mockResolvedValue([PRO_PLAN_ROW])

    const res = await request(createApp())
      .post(`/tpv/venues/${VENUE_ID}/tables/assign`)
      .set(authHeader(waiterCtx))
      .send({ tableId: 'table-1' })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ handler: 'assignTable' })
  })

  it('PREMIUM venue → 200', async () => {
    vfFindMany.mockResolvedValue([PREMIUM_PLAN_ROW])

    const res = await request(createApp())
      .post(`/tpv/venues/${VENUE_ID}/tables/assign`)
      .set(authHeader(waiterCtx))
      .send({ tableId: 'table-1' })

    expect(res.status).toBe(200)
  })

  it('GRANDFATHERED venue → 200 (exempt from plan gating)', async () => {
    venueFindUnique.mockResolvedValue(GRANDFATHERED_VENUE)

    const res = await request(createApp())
      .post(`/tpv/venues/${VENUE_ID}/tables/assign`)
      .set(authHeader(waiterCtx))
      .send({ tableId: 'table-1' })

    expect(res.status).toBe(200)
  })

  it('DEMO venue (LIVE_DEMO) → 200 (demos showcase everything)', async () => {
    venueFindUnique.mockResolvedValue(DEMO_VENUE)

    const res = await request(createApp())
      .post(`/tpv/venues/${VENUE_ID}/tables/assign`)
      .set(authHeader(waiterCtx))
      .send({ tableId: 'table-1' })

    expect(res.status).toBe(200)
  })

  it('explicit own VenueFeature TABLE_SERVICE grant → 200 even on a technically-FREE venue', async () => {
    vfFindFirst.mockResolvedValue({
      id: 'vf_1',
      active: true,
      endDate: null,
      suspendedAt: null,
      stripeSubscriptionId: null,
      feature: { code: 'TABLE_SERVICE', name: 'Servicio de mesa' },
    })

    const res = await request(createApp())
      .post(`/tpv/venues/${VENUE_ID}/tables/assign`)
      .set(authHeader(waiterCtx))
      .send({ tableId: 'table-1' })

    expect(res.status).toBe(200)
  })

  it('platform SUPERADMIN → 200 even on a FREE venue (middleware bypass)', async () => {
    staffVenueFindFirst.mockResolvedValue({ id: 'sv_super' })

    const res = await request(createApp())
      .post(`/tpv/venues/${VENUE_ID}/tables/assign`)
      .set(authHeader(waiterCtx))
      .send({ tableId: 'table-1' })

    expect(res.status).toBe(200)
  })

  // "WRONG RESOLVER" GUARD — the exact silent-failure class from .claude/rules/feature-gating.md
  // (the MCP once gated SERIALIZED_INVENTORY with the Feature resolver instead of the Module
  // one; here the risk runs the other way). If someone swaps this gate to
  // moduleService.isModuleEnabled(venueId, 'TABLE_SERVICE'), isModuleEnabledMock WOULD be
  // called and vfFindMany/vfFindFirst would NOT — either assertion below catches it.
  it('wrong-resolver guard: FREE denial goes through the Feature system, Module system never consulted', async () => {
    await request(createApp()).post(`/tpv/venues/${VENUE_ID}/tables/assign`).set(authHeader(waiterCtx)).send({ tableId: 'table-1' })

    expect(isModuleEnabledMock).not.toHaveBeenCalled()
    expect(vfFindMany).toHaveBeenCalled() // getVenueBaseTier (Feature system) actually ran
  })

  it('wrong-resolver guard: PRO grant (200) also never touches the Module system', async () => {
    vfFindMany.mockResolvedValue([PRO_PLAN_ROW])

    await request(createApp()).post(`/tpv/venues/${VENUE_ID}/tables/assign`).set(authHeader(waiterCtx)).send({ tableId: 'table-1' })

    expect(isModuleEnabledMock).not.toHaveBeenCalled()
  })

  // Middleware order: validateVenueAccess (Task 1) BEFORE checkFeatureAccess — a cross-tenant
  // probe must be rejected on tenant ownership before the plan-gate reveals anything.
  it('cross-tenant probe (URL venueId ≠ token venueId) → 403 from validateVenueAccess; checkFeatureAccess never runs (no plan leak)', async () => {
    const res = await request(createApp())
      .post(`/tpv/venues/${OTHER_VENUE_ID}/tables/assign`)
      .set(authHeader(waiterCtx)) // token is scoped to VENUE_ID, not OTHER_VENUE_ID
      .send({ tableId: 'table-1' })

    expect(res.status).toBe(403)
    expect(res.body.message).toBe('No tienes acceso a este venue')
    expect(res.body.featureCode).toBeUndefined() // proves this is validateVenueAccess's 403, not checkFeatureAccess's
    // requestIsSuperAdmin (prisma.staffVenue.findFirst) is checkFeatureAccess's FIRST call —
    // uncalled means the feature gate never started.
    expect(staffVenueFindFirst).not.toHaveBeenCalled()
    expect(venueFindUnique).not.toHaveBeenCalled()
    expect(vfFindFirst).not.toHaveBeenCalled()
    expect(vfFindMany).not.toHaveBeenCalled()
  })
})

describe('POST /tpv/venues/:venueId/tables/:tableId/clear — TABLE_SERVICE gate', () => {
  it('FREE venue → 403 TABLE_SERVICE', async () => {
    const res = await request(createApp()).post(`/tpv/venues/${VENUE_ID}/tables/table-1/clear`).set(authHeader(waiterCtx)).send({})

    expect(res.status).toBe(403)
    expect(res.body.featureCode).toBe('TABLE_SERVICE')
    expect(res.body.subscriptionRequired).toBe(true)
  })

  it('PRO venue → 200 (controller reached)', async () => {
    vfFindMany.mockResolvedValue([PRO_PLAN_ROW])

    const res = await request(createApp()).post(`/tpv/venues/${VENUE_ID}/tables/table-1/clear`).set(authHeader(waiterCtx)).send({})

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ handler: 'clearTable' })
  })

  it('wrong-resolver guard: Module system never consulted', async () => {
    await request(createApp()).post(`/tpv/venues/${VENUE_ID}/tables/table-1/clear`).set(authHeader(waiterCtx)).send({})

    expect(isModuleEnabledMock).not.toHaveBeenCalled()
    expect(vfFindMany).toHaveBeenCalled()
  })

  it('cross-tenant probe → 403 from validateVenueAccess, checkFeatureAccess never runs', async () => {
    const res = await request(createApp()).post(`/tpv/venues/${OTHER_VENUE_ID}/tables/table-1/clear`).set(authHeader(waiterCtx)).send({})

    expect(res.status).toBe(403)
    expect(res.body.message).toBe('No tienes acceso a este venue')
    expect(staffVenueFindFirst).not.toHaveBeenCalled()
    expect(vfFindMany).not.toHaveBeenCalled()
  })
})

// REGRESSION TESTS — the routes deliberately left ungated (see file header for the reasoning).
describe('regression: floor-plan reads and floor-plan CRUD stay ungated by TABLE_SERVICE', () => {
  it('GET tables → 200 on a FREE venue (floor-plan read is core; also feeds the RESERVATIONS table picker)', async () => {
    const res = await request(createApp()).get(`/tpv/venues/${VENUE_ID}/tables`).set(authHeader(waiterCtx))

    expect(res.status).toBe(200)
  })

  it('GET floor-elements → 200 on a FREE venue', async () => {
    const res = await request(createApp()).get(`/tpv/venues/${VENUE_ID}/floor-elements`).set(authHeader(waiterCtx))

    expect(res.status).toBe(200)
  })

  it('POST tables (create table, floor-plan setup) → 200 on a FREE venue — role-gated only (Task 1), not plan-gated', async () => {
    const res = await request(createApp())
      .post(`/tpv/venues/${VENUE_ID}/tables`)
      .set(authHeader(waiterCtx))
      .send({ number: '5', capacity: 4 })

    expect(res.status).toBe(200)
  })

  it('DELETE tables/:tableId → 200 on a FREE venue', async () => {
    const res = await request(createApp()).delete(`/tpv/venues/${VENUE_ID}/tables/table-1`).set(authHeader(waiterCtx))

    expect(res.status).toBe(200)
  })

  it('PATCH orders/:orderId/items (generic order add-items, any OrderType) → 200 on a FREE venue — NOT table-exclusive', async () => {
    const res = await request(createApp())
      .patch(`/tpv/venues/${VENUE_ID}/orders/order-1/items`)
      .set(authHeader(waiterCtx))
      .send({ items: [], version: 1 })

    expect(res.status).toBe(200)
  })
})
