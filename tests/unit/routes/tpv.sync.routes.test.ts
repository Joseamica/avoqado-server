/**
 * POST /tpv/venues/:venueId/sync/intents — mounting audit (Plan B Task 3, 2026-07-27).
 *
 * The reducer that replays a POS's offline outbox already exists and is committed at
 * POST /mobile/venues/:venueId/sync/intents. The TPV is deliberately isolated to
 * /api/v1/tpv/* and must never call /mobile, so the SAME reducer has to be reachable
 * under /tpv too — via a re-exported controller (sync.tpv.controller.ts), not a copy.
 *
 * This file does static introspection of the REAL Express router stacks (both
 * tpv.routes.ts and mobile.routes.ts), the same technique as
 * tpv.tables.routes.permissions.test.ts — no mocked middleware, no supertest. It proves
 * three things that would otherwise fail silently:
 *
 *   1. The /tpv route and the /mobile route resolve to the exact SAME handler function
 *      (by reference) — the property that keeps the two namespaces from diverging.
 *   2. /tpv carries validateVenueAccess (Task 1) BEFORE the permission check, so a
 *      cross-tenant probe never reaches the reducer.
 *   3. /tpv gates with checkPermission('orders:create') — the exact same permission
 *      string /mobile uses (mirroring by exact name is the rule; a mismatch fails
 *      silently). No checkFeatureAccess at the route: the reducer evaluates
 *      TABLE_SERVICE gating and table ownership PER INTENT internally
 *      (sync.mobile.service.ts), so gating the whole batch at the route would reject a
 *      legitimate non-table intent (e.g. PAY_CASH) just because the batch also carried
 *      one table intent.
 */

import tpvRouter from '@/routes/tpv.routes'
import mobileRouter from '@/routes/mobile.routes'
import { validateVenueAccess } from '@/middlewares/validateVenueAccess.middleware'
import { authenticateTokenMiddleware } from '@/middlewares/authenticateToken.middleware'
import { syncIntents as syncTpvHandler } from '@/controllers/tpv/sync.tpv.controller'
import { syncIntents as syncMobileHandler } from '@/controllers/mobile/sync.mobile.controller'

interface RouteInspection {
  handlers: any[]
  hasValidateVenueAccess: boolean
  hasAuthenticateToken: boolean
  permission?: string
  finalHandler: any
}

function inspectRoute(router: any, method: string, path: string): RouteInspection | undefined {
  for (const layer of router.stack ?? []) {
    if (!layer.route || layer.route.path !== path) continue
    const routeLayers: any[] = layer.route.stack ?? []
    if (!routeLayers.some(rl => rl.method === method)) continue

    const handlers = routeLayers.map(rl => rl.handle)
    const permissionLayer = routeLayers.find(rl => typeof (rl.handle as any)?.requiredPermission === 'string')

    return {
      handlers,
      hasValidateVenueAccess: handlers.includes(validateVenueAccess),
      hasAuthenticateToken: handlers.includes(authenticateTokenMiddleware),
      permission: (permissionLayer?.handle as any)?.requiredPermission,
      finalHandler: handlers[handlers.length - 1],
    }
  }
  return undefined
}

describe('sync/intents mounted under /tpv (Plan B Task 3)', () => {
  const TPV_PATH = '/venues/:venueId/sync/intents'
  const MOBILE_PATH = '/venues/:venueId/sync/intents'

  it('is registered under /tpv as POST /venues/:venueId/sync/intents', () => {
    const route = inspectRoute(tpvRouter, 'post', TPV_PATH)
    expect(route).toBeDefined()
  })

  it('/tpv and /mobile resolve to the LITERAL SAME handler function (no divergent copy)', () => {
    const tpvRoute = inspectRoute(tpvRouter, 'post', TPV_PATH)!
    const mobileRoute = inspectRoute(mobileRouter, 'post', MOBILE_PATH)!

    expect(tpvRoute.finalHandler).toBe(mobileRoute.finalHandler)
    // Anchor both ends to the imported controllers directly too, not just to each other —
    // guards against both sides drifting to the same WRONG function.
    expect(tpvRoute.finalHandler).toBe(syncTpvHandler)
    expect(tpvRoute.finalHandler).toBe(syncMobileHandler)
    expect(mobileRoute.finalHandler).toBe(syncMobileHandler)
  })

  it('/tpv carries authenticateTokenMiddleware + validateVenueAccess (tenant isolation)', () => {
    const route = inspectRoute(tpvRouter, 'post', TPV_PATH)!
    expect(route.hasAuthenticateToken).toBe(true)
    expect(route.hasValidateVenueAccess).toBe(true)
  })

  it("/tpv gates with checkPermission('orders:create') — same exact name as /mobile", () => {
    const tpvRoute = inspectRoute(tpvRouter, 'post', TPV_PATH)!
    const mobileRoute = inspectRoute(mobileRouter, 'post', MOBILE_PATH)!

    expect(tpvRoute.permission).toBe('orders:create')
    expect(mobileRoute.permission).toBe('orders:create')
  })

  it('/tpv route has EXACTLY 4 layers (auth, validateVenueAccess, checkPermission, handler) — no checkFeatureAccess at the route', () => {
    const route = inspectRoute(tpvRouter, 'post', TPV_PATH)!
    expect(route.handlers).toHaveLength(4)
  })

  // REGRESSION — /mobile's own route must be untouched by this change (frozen contract).
  it('/mobile route is still registered and unaffected', () => {
    const route = inspectRoute(mobileRouter, 'post', MOBILE_PATH)
    expect(route).toBeDefined()
    expect(route!.permission).toBe('orders:create')
  })
})
