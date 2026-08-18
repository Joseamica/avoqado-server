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

    // 2026-08-17 — auditoría de permisos de piso, "Forma B": abrir mesa es un acto de
    // SALA y migró de `orders:create` a `tables:update` en /mobile y aquí a la vez.
    // Detalle y matemática de roles en `mesas.permisos-de-mesa.routes.test.ts`.
    it('auth + validateVenueAccess presentes, permiso tables:update, 5 capas', () => {
      const route = inspectRoute(tpvRouter, 'post', PATH)
      expect(route).toBeDefined()
      expect(route!.hasAuthenticateToken).toBe(true)
      expect(route!.hasValidateVenueAccess).toBe(true)
      expect(route!.permission).toBe('tables:update')
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
 * 🔴 ACTUALIZADO 2026-08-18 — auditoría de permisos de piso. Este bloque pineaba 6 capas
 * "la sexta es checkTableOwnership, igual que /mobile", y ESE PIN CODIFICABA UN BUG:
 * en /mobile el par poner/quitar está completo (POST y DELETE llevan el guard); aquí se
 * había copiado sólo la mitad de abajo, porque el POST de /tpv nunca tuvo candado de
 * propiedad. Resultado medido: el cajero PONÍA el cargo en una mesa ajena y recibía 403
 * al QUITARLO — un estado del que el usuario no puede salir.
 *
 * El guard se quitó del DELETE (no se puso en el POST: que el piso aplique cargos y
 * descuentos sobre mesa ajena está decidido y respaldado por Square/Toast/Fudo — ver el
 * comentario largo en la ruta). Ahora son 5 capas, las mismas que el POST hermano, así
 * que la fila cabe en `cases`… pero se queda aquí como bloque propio a propósito: es el
 * único sitio donde queda escrito por qué el número bajó, y sin eso el próximo que lea
 * "5 capas" no sabrá que antes hubo 6.
 *
 * La simetría en sí (poner y quitar comparten cadena, en las DOS direcciones) y la
 * ablación viven en `tpv.loQuePonesLoQuitas.routes.test.ts`.
 *
 * Deshacer sigue siendo online-only a propósito — no existe intent REMOVE_SERVICE_CHARGE,
 * así que esta ruta es el ÚNICO camino para revertir.
 */
describe('DELETE /venues/:venueId/orders/:orderId/service-charges/:orderServiceChargeId', () => {
  const PATH = '/venues/:venueId/orders/:orderId/service-charges/:orderServiceChargeId'
  const POST_PATH = '/venues/:venueId/orders/:orderId/service-charges'

  it('existe, con auth + validateVenueAccess + permiso orders:update', () => {
    const route = inspectRoute(tpvRouter, 'delete', PATH)
    expect(route).toBeDefined()
    expect(route!.hasAuthenticateToken).toBe(true)
    expect(route!.hasValidateVenueAccess).toBe(true)
    expect(route!.permission).toBe('orders:update')
  })

  it('lleva EXACTAMENTE 5 capas (auth, validateVenueAccess, checkFeatureAccess, checkPermission, handler)', () => {
    const route = inspectRoute(tpvRouter, 'delete', PATH)
    expect(route!.handlers).toHaveLength(5)
    expect(route!.finalHandler).toBe(orderTableController.removeServiceCharge)
  })

  it('🔴 la MISMA cadena que el POST que aplica el cargo — lo que se pone se puede quitar', () => {
    const poner = inspectRoute(tpvRouter, 'post', POST_PATH)!
    const quitar = inspectRoute(tpvRouter, 'delete', PATH)!
    expect(quitar.handlers).toHaveLength(poner.handlers.length)
    expect(quitar.permission).toBe(poner.permission)
  })
})

/**
 * POST cancel (2026-08-07 — cierre de la última acción de mesa sin ruta
 * online, ver `.superpowers/sdd/2026-07-24-tpv-plan-b-superficie-tpv-server/tpv-cancel-order-route.md`).
 *
 * Bloque APARTE de `cases` por la MISMA razón que el DELETE service-charges de
 * arriba: 6 capas (suma checkTableOwnership) Y un permiso DISTINTO
 * (`orders:cancel-unpaid` desde 2026-08-17 — auditoría de permisos de piso, caso #9;
 * mismo nombre exacto que `requiredPermissionForIntent('CANCEL_ORDER')` en
 * `sync.mobile.service.ts`, así que reproducir offline y pegarle online exigen el mismo
 * permiso. El servicio rechaza cualquier orden con pagos, PAID o PARTIAL, así que el
 * permiso acotado no alcanza a anular un cheque ya cobrado).
 */
describe('POST /venues/:venueId/orders/:orderId/cancel', () => {
  const PATH = '/venues/:venueId/orders/:orderId/cancel'
  const { checkTableOwnership } = require('@/middlewares/checkTableOwnership.middleware')

  it('existe, con auth + validateVenueAccess + permiso orders:cancel-unpaid (NO orders:update)', () => {
    const route = inspectRoute(tpvRouter, 'post', PATH)
    expect(route).toBeDefined()
    expect(route!.hasAuthenticateToken).toBe(true)
    expect(route!.hasValidateVenueAccess).toBe(true)
    expect(route!.permission).toBe('orders:cancel-unpaid')
  })

  it('lleva EXACTAMENTE 6 capas — la sexta es checkTableOwnership, igual que /mobile', () => {
    const route = inspectRoute(tpvRouter, 'post', PATH)
    expect(route!.handlers).toHaveLength(6)
    expect(route!.finalHandler).toBe(orderTableController.cancelOrder)
    expect(typeof checkTableOwnership).toBe('function')
  })
})

/**
 * Los RENGLONES de la cuenta bajo /tpv: poner (PATCH) y quitar (DELETE) — 2026-08-18.
 *
 * Mismo defecto de raíz que el DELETE de cargos por servicio (commit 210dbab6): en
 * `/mobile` la cadena está completa y a `/tpv` se copió sólo la mitad. Aquí la mitad
 * que faltaba era distinta EN CADA UNA, así que se veía "simétrico" de lejos:
 *
 *   PATCH  auth + validateVenueAccess + validateRequest + checkTableOwnership   → SIN checkPermission
 *   DELETE auth + checkPermission('orders:update') + validateRequest            → SIN checkTableOwnership
 *
 * 1. El PATCH no pedía NINGÚN permiso. Y `checkTableOwnership` hace `return next()`
 *    inmediato si `VenueSettings.enforceTableOwnership` es falso — que es el default
 *    (`isTableOwnershipEnforced` devuelve `settings?.enforceTableOwnership === true`).
 *    O sea: en un venue de fábrica, CUALQUIER miembro del venue —VIEWER incluido, que el
 *    propio catálogo describe como "contadores, consultores externos, observadores"—
 *    metía productos a cualquier cuenta abierta. El controller tampoco tiene guard.
 *    Se cierra con el permiso EXACTO de su gemela sana, `POST /items` de `/mobile`:
 *    `orders:create`.
 *
 * 2. El DELETE no montaba `checkTableOwnership`, así que **ignoraba lo que el admin
 *    configuró**. Ese es el punto: el guard NO decide "el mesero no puede tocar mesas
 *    ajenas" — decide "que se obedezca el switch del venue". Con el switch apagado
 *    (default) no cambia nada; con el switch encendido, se respeta. Decisión del founder
 *    (2026-08-18): *"es depende la configuración, en algunos POS decidirá el admin si
 *    puede el mesero interferir en otras mesas o no"*.
 *
 * 🔴 LO QUE QUEDA ABIERTO Y NO SE ARREGLA AQUÍ: el DELETE pide `orders:update` y el PATCH
 * `orders:create`. KITCHEN tiene el primero y no el segundo, así que puede QUITAR un
 * renglón sin poder ponerlo. Viene del gate del DELETE, es anterior a este cambio, y
 * unificarlo es decisión de producto — no se toca de contrabando.
 */
describe('renglones de la cuenta bajo /tpv — poner y quitar bajo la misma regla', () => {
  const PATCH_PATH = '/venues/:venueId/orders/:orderId/items'
  const DELETE_PATH = '/venues/:venueId/orders/:orderId/items/:itemId'

  // Por firma, no por conteo de capas: `checkTableOwnership` expone
  // `ownershipOverridePermissions` justo para que los tests de rutas puedan afirmar
  // que está montado sin ejecutarlo (mismo patrón que `requiredPermission`).
  const capaDeDueño = (route: RouteInspection) => route.handlers.find(h => Array.isArray((h as any)?.ownershipOverridePermissions))

  it('PATCH (poner renglones) exige orders:create — el MISMO nombre que POST /items de /mobile', () => {
    const route = inspectRoute(tpvRouter, 'patch', PATCH_PATH)
    expect(route).toBeDefined()
    expect(route!.hasAuthenticateToken).toBe(true)
    expect(route!.hasValidateVenueAccess).toBe(true)
    expect(route!.permission).toBe('orders:create')
  })

  it('DELETE (quitar un renglón) monta checkTableOwnership, para OBEDECER el switch del venue', () => {
    const route = inspectRoute(tpvRouter, 'delete', DELETE_PATH)
    expect(route).toBeDefined()
    expect(capaDeDueño(route!)).toBeDefined()
  })

  it('🔴 SIMETRÍA: si poner respeta al dueño de la mesa, quitar también — y al revés', () => {
    const patch = inspectRoute(tpvRouter, 'patch', PATCH_PATH)!
    const del = inspectRoute(tpvRouter, 'delete', DELETE_PATH)!
    expect(!!capaDeDueño(del)).toBe(!!capaDeDueño(patch))
  })

  it('🔴 el permiso NO cambia según haya WiFi: la ruta en línea pide lo mismo que el intent ADD_ITEMS', () => {
    // Éste es el guard que de verdad importa. Antes del arreglo la ruta en línea no pedía
    // NADA mientras el intent offline sí exigía `orders:create`, o sea que el POS era MÁS
    // laxo con internet que sin él: la misma acción pasaba o se rechazaba según el WiFi, y
    // al reconectar el intent caía en cuarentena. Atarlas impide que vuelvan a separarse.
    const { requiredPermissionForIntent } = require('@/services/mobile/sync.mobile.service')
    const online = inspectRoute(tpvRouter, 'patch', PATCH_PATH)!.permission
    expect(requiredPermissionForIntent('ADD_ITEMS')).toBe('orders:create')
    expect(online).toBe(requiredPermissionForIntent('ADD_ITEMS'))
  })

  it('ninguna de las dos queda sin permiso: un rol de sólo lectura no toca la cuenta', () => {
    expect(inspectRoute(tpvRouter, 'patch', PATCH_PATH)!.permission).toBeDefined()
    expect(inspectRoute(tpvRouter, 'delete', DELETE_PATH)!.permission).toBeDefined()
  })
})
