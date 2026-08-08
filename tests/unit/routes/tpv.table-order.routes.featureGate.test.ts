/**
 * TABLE_SERVICE plan gating on the 5 table-order-lifecycle routes mounted under
 * /tpv (Plan B Task 4, 2026-07-27): split, split-by-seat, merge, service-charges,
 * tables/:tableId/open.
 *
 * Same technique as tests/unit/routes/tpv-table-gating.test.ts (Task 2): mounts the
 * REAL tpv.routes.ts router with the REAL checkFeatureAccess middleware, mocking only
 * auth (context injector), checkPermission (passthrough — tpv.table-order.routes.test.ts
 * already covers the exact permission names), prisma, moduleService, and the two
 * controllers these routes call into.
 *
 * Unlike the generic order-mutation routes (items/guest — deliberately left ungated,
 * see task-2-report.md), these 5 routes ARE exclusively table-service capabilities
 * (split a check, merge checks, apply a service charge, open a table), so they DO
 * carry checkFeatureAccess('TABLE_SERVICE') — mirroring exactly how /mobile gates its
 * equivalent routes (mobile.routes.ts:1892-1998,1599).
 */

import express from 'express'
import type { Server } from 'http'
import request from 'supertest'

// 1. Auth: inject authContext from a test header (tpv.routes.ts references
//    authenticateTokenMiddleware inline per-route, no parent router.use).
jest.mock('@/middlewares/authenticateToken.middleware', () => ({
  authenticateTokenMiddleware: (req: any, _res: any, next: any) => {
    const ctx = req.headers['x-test-auth-context']
    if (ctx) req.authContext = JSON.parse(ctx as string)
    next()
  },
}))

// 2. checkPermission: passthrough — not under test here. tpv.table-order.routes.test.ts
//    already proves the exact permission name per route via static introspection.
jest.mock('@/middlewares/checkPermission.middleware', () => ({
  ...jest.requireActual('@/middlewares/checkPermission.middleware'),
  checkPermission: () => (_req: any, _res: any, next: any) => next(),
}))

// 3. prisma: only the models checkFeatureAccess touches, plus venueSettings —
//    the cancel route (below) is the only one in this file that also carries
//    checkTableOwnership('order'), which reads VenueSettings.enforceTableOwnership.
//    Mocked to `null` (the real default: the PRO ownership switch is OFF for
//    most venues) so checkTableOwnership no-ops for cancel exactly like it
//    does in prod for a venue that never turned the switch on.
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    staffVenue: { findFirst: jest.fn() }, // SUPERADMIN bypass (requestIsSuperAdmin)
    venue: { findUnique: jest.fn() }, // venueIsExemptFromPlanGating (grandfathered/demo)
    venueFeature: { findFirst: jest.fn(), findMany: jest.fn() }, // own grant + getVenueBaseTier
    venueSettings: { findUnique: jest.fn() }, // checkTableOwnership('order') — cancel route only
  },
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

// 4. moduleService: the WRONG resolver for TABLE_SERVICE (Feature, not Module — see
//    .claude/rules/feature-gating.md). Mocked so tests can assert it's NEVER consulted.
jest.mock('@/services/modules/module.service', () => {
  const actual = jest.requireActual('@/services/modules/module.service')
  return { ...actual, moduleService: { ...actual.moduleService, isModuleEnabled: jest.fn() } }
})

// 5. Controllers: not under test — any handler responds 200 + a marker.
const controllerProxy = () =>
  new Proxy({}, { get: (_t, prop) => (prop === '__esModule' ? true : (_req: any, res: any) => res.json({ handler: String(prop) })) })
jest.mock('@/controllers/tpv/order-table.tpv.controller', () => controllerProxy())
jest.mock('@/controllers/tpv/table.tpv.controller', () => controllerProxy())

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

const VENUE_ID = 'venue-tpv-order-1'
const OTHER_VENUE_ID = 'venue-tpv-order-OTHER'

function authHeader(ctx: object): Record<string, string> {
  return { 'x-test-auth-context': JSON.stringify(ctx) }
}

const waiterCtx = { userId: 'user-1', orgId: 'org-1', venueId: VENUE_ID, role: 'WAITER' }

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/tpv', tpvRouter)
  app.use((err: any, _req: any, res: any, _next: any) => res.status(err?.statusCode || 500).json({ error: err?.message || 'error' }))
  return app
}

const FREE_ACTIVE_VENUE = { seatCapExempt: false, status: 'ACTIVE' }
const PRO_PLAN_ROW = { active: true, suspendedAt: null, endDate: null, feature: { code: 'PLAN_PRO' } }

beforeEach(() => {
  jest.clearAllMocks()
  staffVenueFindFirst.mockResolvedValue(null) // not a platform superadmin
  venueFindUnique.mockResolvedValue(FREE_ACTIVE_VENUE)
  vfFindFirst.mockResolvedValue(null) // no explicit own TABLE_SERVICE grant
  vfFindMany.mockResolvedValue([]) // no active paid base plan → FREE
  isModuleEnabledMock.mockResolvedValue(false)
  venueSettingsFindUnique.mockResolvedValue(null) // table-ownership switch OFF (real default) — cancel route only
})

// UN server escuchando para todo el archivo, reusado por cada request.
//
// Por qué no pasarle la *app* a supertest: cuando recibe una app en vez de un server, llama
// `app.listen(0)` en CADA request y lo cierra al terminar la respuesta
// (supertest/lib/test.js:60). Eso es un ciclo de bind/close de un puerto efímero POR REQUEST,
// y ese churn es lo que dejaba estos archivos flaky — el rojo caía en un test al azar y con
// síntoma al azar. En ESTE archivo se manifestó como `expect(vfFindMany).toHaveBeenCalled()`
// con 0 llamadas: el request nunca llegó al middleware, así que el mock jamás corrió.
//
// Nada es específico de estas rutas: la app es idéntica en cada llamada y todo el estado por
// test vive en los mocks, que `beforeEach` resetea. Enlazar una vez elimina el churn.
let server: Server

beforeAll(() => {
  server = createApp().listen(0)
})

afterAll(done => {
  server.close(done)
})

// [method, path, expectedHandlerName]
const routes: Array<[string, string, string]> = [
  ['post', `/tpv/venues/${VENUE_ID}/orders/order-1/split`, 'splitOrder'],
  ['post', `/tpv/venues/${VENUE_ID}/orders/order-1/split-by-seat`, 'splitOrderBySeat'],
  ['post', `/tpv/venues/${VENUE_ID}/orders/order-1/merge`, 'mergeOrders'],
  ['post', `/tpv/venues/${VENUE_ID}/orders/order-1/cancel`, 'cancelOrder'],
  ['post', `/tpv/venues/${VENUE_ID}/orders/order-1/service-charges`, 'applyServiceCharge'],
  ['post', `/tpv/venues/${VENUE_ID}/tables/table-1/open`, 'openTable'],
]

describe.each(routes)('%s %s — TABLE_SERVICE gate', (method, path, handlerName) => {
  it('FREE venue → 403 TABLE_SERVICE, controller never reached', async () => {
    const res = await (request(server) as any)[method](path).set(authHeader(waiterCtx)).send({})

    expect(res.status).toBe(403)
    expect(res.body.featureCode).toBe('TABLE_SERVICE')
    expect(res.body.subscriptionRequired).toBe(true)
  })

  it('PRO venue → 200 (controller reached)', async () => {
    vfFindMany.mockResolvedValue([PRO_PLAN_ROW])

    const res = await (request(server) as any)[method](path).set(authHeader(waiterCtx)).send({})

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ handler: handlerName })
  })

  it('wrong-resolver guard: Module system NEVER consulted (TABLE_SERVICE is a Feature, not a Module)', async () => {
    await (request(server) as any)[method](path).set(authHeader(waiterCtx)).send({})

    expect(isModuleEnabledMock).not.toHaveBeenCalled()
    expect(vfFindMany).toHaveBeenCalled() // getVenueBaseTier (Feature system) actually ran
  })

  it('cross-tenant probe (URL venueId ≠ token venueId) → 403 from validateVenueAccess; checkFeatureAccess never runs (no plan leak)', async () => {
    const crossPath = path.replace(VENUE_ID, OTHER_VENUE_ID)
    const res = await (request(server) as any)[method](crossPath).set(authHeader(waiterCtx)).send({})

    expect(res.status).toBe(403)
    expect(res.body.message).toBe('No tienes acceso a este venue')
    expect(res.body.featureCode).toBeUndefined() // proves this is validateVenueAccess's 403, not checkFeatureAccess's
    expect(staffVenueFindFirst).not.toHaveBeenCalled()
    expect(venueFindUnique).not.toHaveBeenCalled()
    expect(vfFindFirst).not.toHaveBeenCalled()
    expect(vfFindMany).not.toHaveBeenCalled()
  })
})
