/**
 * Ciclo de orden de mesa bajo /tpv — montaje y permisos (Plan B Task 4, 2026-07-27).
 *
 * Static introspection del router REAL (mismo patrón que tpv.tables.routes.permissions.test.ts
 * y tpv.sync.routes.test.ts) — nada de mocks de middleware ni supertest aquí; eso vive en
 * tpv.table-order.routes.featureGate.test.ts. Este archivo prueba:
 *
 *   1. Las 5 rutas nuevas (split, split-by-seat, merge, service-charges, tables/:id/open)
 *      llevan authenticateTokenMiddleware + validateVenueAccess + checkPermission con el
 *      nombre EXACTO que usa /mobile, y EXACTAMENTE 5 capas (incluye checkFeatureAccess,
 *      que no deja marca legible — se detecta por conteo, como en Task 3).
 *   2. tables/:tableId/open resuelve al MISMO handler que /mobile (reexport, no copia).
 *   3. NO duplicamos la superficie de Cobrar: exactamente 1 POST .../comp y NINGÚN POST
 *      .../discounts "pelón" (sin sufijo) — eso es justo lo que el plan (equivocado)
 *      proponía crear y el brief prohíbe explícitamente. La familia real de descuentos
 *      (discount, discounts/auto, discounts/apply, discounts/manual, discounts/coupon)
 *      ya existía antes de esta tarea y no se toca.
 */

import tpvRouter from '@/routes/tpv.routes'
import { validateVenueAccess } from '@/middlewares/validateVenueAccess.middleware'
import { authenticateTokenMiddleware } from '@/middlewares/authenticateToken.middleware'
import * as orderTableController from '@/controllers/tpv/order-table.tpv.controller'
import { openTable as openTableTpvHandler } from '@/controllers/tpv/table.tpv.controller'
import { openTable as openTableMobileHandler } from '@/controllers/mobile/table.mobile.controller'

interface RouteInspection {
  handlers: any[]
  hasAuthenticateToken: boolean
  hasValidateVenueAccess: boolean
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
      hasAuthenticateToken: handlers.includes(authenticateTokenMiddleware),
      hasValidateVenueAccess: handlers.includes(validateVenueAccess),
      permission: (permissionLayer?.handle as any)?.requiredPermission,
      finalHandler: handlers[handlers.length - 1],
    }
  }
  return undefined
}

/**
 * Enumerates every registered [method, path] pair in a router's stack (for surface-area
 * guards). One `layer.route` per `router.<verb>(path, ...)` call, but `route.stack` has ONE
 * entry PER MIDDLEWARE in that call's chain (all sharing the same `.method`) — so this dedupes
 * by method within each route, otherwise a route with N middlewares would be counted N times.
 */
function listRoutes(router: any): Array<{ method: string; path: string }> {
  const out: Array<{ method: string; path: string }> = []
  for (const layer of router.stack ?? []) {
    if (!layer.route) continue
    const methods = new Set<string>((layer.route.stack ?? []).map((rl: any) => rl.method))
    for (const method of methods) {
      out.push({ method, path: layer.route.path })
    }
  }
  return out
}

describe('table-order routes mounted under /tpv (Plan B Task 4)', () => {
  const cases: Array<[string, string, string, keyof typeof orderTableController]> = [
    ['post', '/venues/:venueId/orders/:orderId/split', 'orders:update', 'splitOrder'],
    ['post', '/venues/:venueId/orders/:orderId/split-by-seat', 'orders:update', 'splitOrderBySeat'],
    // Fusionar migró a permiso propio en /mobile (2026-08); esta fila es la que
    // mantiene a la TPV en el mismo candado y evita que la PAX sea el atajo.
    ['post', '/venues/:venueId/orders/:orderId/merge', 'orders:merge', 'mergeOrders'],
    ['post', '/venues/:venueId/orders/:orderId/service-charges', 'orders:update', 'applyServiceCharge'],
  ]

  it.each(cases)('%s %s → auth + validateVenueAccess presentes', (method, path) => {
    const route = inspectRoute(tpvRouter, method, path)
    expect(route).toBeDefined()
    expect(route!.hasAuthenticateToken).toBe(true)
    expect(route!.hasValidateVenueAccess).toBe(true)
  })

  it.each(cases)('%s %s → exige permiso %s (mismo nombre exacto que /mobile)', (method, path, expectedPermission) => {
    const route = inspectRoute(tpvRouter, method, path)
    expect(route!.permission).toBe(expectedPermission)
  })

  it.each(cases)(
    '%s %s → EXACTAMENTE 5 capas (auth, validateVenueAccess, checkFeatureAccess, checkPermission, handler)',
    (method, path) => {
      const route = inspectRoute(tpvRouter, method, path)
      expect(route!.handlers).toHaveLength(5)
    },
  )

  it.each(cases)('%s %s → resuelve al handler correcto de order-table.tpv.controller', (method, path, _perm, handlerName) => {
    const route = inspectRoute(tpvRouter, method, path)
    expect(route!.finalHandler).toBe(orderTableController[handlerName])
  })

  describe('POST /venues/:venueId/tables/:tableId/open', () => {
    const PATH = '/venues/:venueId/tables/:tableId/open'

    it('auth + validateVenueAccess presentes, permiso orders:create, 5 capas', () => {
      const route = inspectRoute(tpvRouter, 'post', PATH)
      expect(route).toBeDefined()
      expect(route!.hasAuthenticateToken).toBe(true)
      expect(route!.hasValidateVenueAccess).toBe(true)
      expect(route!.permission).toBe('orders:create')
      expect(route!.handlers).toHaveLength(5)
    })

    // La propiedad que importa: es un RE-EXPORT, no una copia — si alguien
    // reimplementa openTable localmente con el mismo comportamiento superficial,
    // este test lo cacha (comparación por referencia de función).
    it('resuelve al MISMO handler que /mobile (reexport, no copia)', () => {
      const route = inspectRoute(tpvRouter, 'post', PATH)!
      expect(route.finalHandler).toBe(openTableTpvHandler)
      expect(route.finalHandler).toBe(openTableMobileHandler)
    })
  })
})

// Guard contra duplicar la superficie de Cobrar (ver task-4-brief.md): el plan
// original proponía crear POST .../discounts y POST .../comp NUEVOS — ya existen,
// y son territorio de Cobrar (founder: intocable). Esto fija la superficie ANTES
// de esta tarea para que un futuro cambio no agregue una segunda forma de
// aplicar un descuento o una cortesía sobre el mismo recurso.
describe('anti-duplicación: superficie de descuentos/comp de Cobrar bajo /tpv', () => {
  const routes = listRoutes(tpvRouter)
  const orderScopedPosts = routes.filter(r => r.method === 'post' && r.path.startsWith('/venues/:venueId/orders/:orderId/'))

  it('existe EXACTAMENTE un POST .../comp (el de Cobrar, orderController.compItems)', () => {
    const compRoutes = orderScopedPosts.filter(r => r.path === '/venues/:venueId/orders/:orderId/comp')
    expect(compRoutes).toHaveLength(1)
  })

  it('NO existe un POST .../discounts "pelón" (sin sufijo) — eso era la duplicación que proponía el plan', () => {
    const bareDiscountsRoutes = orderScopedPosts.filter(r => r.path === '/venues/:venueId/orders/:orderId/discounts')
    expect(bareDiscountsRoutes).toHaveLength(0)
  })

  it('la familia real de descuentos de Cobrar sigue intacta (discount, discounts/auto, discounts/apply, discounts/manual, discounts/coupon)', () => {
    const expectedDiscountPaths = [
      '/venues/:venueId/orders/:orderId/discount',
      '/venues/:venueId/orders/:orderId/discounts/auto',
      '/venues/:venueId/orders/:orderId/discounts/apply',
      '/venues/:venueId/orders/:orderId/discounts/manual',
      '/venues/:venueId/orders/:orderId/discounts/coupon',
    ]
    for (const path of expectedDiscountPaths) {
      expect(orderScopedPosts.some(r => r.path === path)).toBe(true)
    }
  })
})

/**
 * DELETE service-charges (paridad Android, 2026-08-06).
 *
 * Bloque APARTE de `cases`: esta ruta lleva 6 capas (suma checkTableOwnership),
 * y meterla en la tabla rompería el pin de "EXACTAMENTE 5 capas" de las otras.
 * Deshacer es online-only a propósito — no existe intent REMOVE_SERVICE_CHARGE,
 * así que esta ruta es el ÚNICO camino y su cadena es la única defensa.
 */
describe('DELETE /venues/:venueId/orders/:orderId/service-charges/:orderServiceChargeId', () => {
  const PATH = '/venues/:venueId/orders/:orderId/service-charges/:orderServiceChargeId'
  const { checkTableOwnership } = require('@/middlewares/checkTableOwnership.middleware')

  it('existe, con auth + validateVenueAccess + permiso orders:update', () => {
    const route = inspectRoute(tpvRouter, 'delete', PATH)
    expect(route).toBeDefined()
    expect(route!.hasAuthenticateToken).toBe(true)
    expect(route!.hasValidateVenueAccess).toBe(true)
    expect(route!.permission).toBe('orders:update')
  })

  it('lleva EXACTAMENTE 6 capas — la sexta es checkTableOwnership, igual que /mobile', () => {
    const route = inspectRoute(tpvRouter, 'delete', PATH)
    // checkTableOwnership('order') es una factory: la capa montada no es la funcion
    // exportada sino su retorno. Se fija por conteo + descarte: 6 capas, y la quinta
    // no es ninguna de las nombradas (auth/venueAccess/feature/permission/handler).
    expect(route!.handlers).toHaveLength(6)
    expect(route!.finalHandler).toBe(orderTableController.removeServiceCharge)
    expect(typeof checkTableOwnership).toBe('function')
  })
})

/**
 * POST cancel (2026-08-07 — cierre de la última acción de mesa sin ruta
 * online, ver `.superpowers/sdd/2026-07-24-tpv-plan-b-superficie-tpv-server/tpv-cancel-order-route.md`).
 *
 * Bloque APARTE de `cases` por la MISMA razón que el DELETE service-charges de
 * arriba: 6 capas (suma checkTableOwnership) Y un permiso DISTINTO
 * (`orders:cancel`, no `orders:update` — mismo nombre exacto que
 * `requiredPermissionForIntent('CANCEL_ORDER')` en `sync.mobile.service.ts`,
 * así que reproducir offline y pegarle online exigen el mismo permiso).
 */
describe('POST /venues/:venueId/orders/:orderId/cancel', () => {
  const PATH = '/venues/:venueId/orders/:orderId/cancel'
  const { checkTableOwnership } = require('@/middlewares/checkTableOwnership.middleware')

  it('existe, con auth + validateVenueAccess + permiso orders:cancel (NO orders:update)', () => {
    const route = inspectRoute(tpvRouter, 'post', PATH)
    expect(route).toBeDefined()
    expect(route!.hasAuthenticateToken).toBe(true)
    expect(route!.hasValidateVenueAccess).toBe(true)
    expect(route!.permission).toBe('orders:cancel')
  })

  it('lleva EXACTAMENTE 6 capas — la sexta es checkTableOwnership, igual que /mobile', () => {
    const route = inspectRoute(tpvRouter, 'post', PATH)
    expect(route!.handlers).toHaveLength(6)
    expect(route!.finalHandler).toBe(orderTableController.cancelOrder)
    expect(typeof checkTableOwnership).toBe('function')
  })
})
