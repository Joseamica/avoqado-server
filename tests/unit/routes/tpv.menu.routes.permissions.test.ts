/**
 * Auditoría de middleware de las 3 rutas de menú/productos/categorías bajo `/tpv`
 * (Plan B Task 5, 2026-07-27) — GET products, GET categories, GET menus.
 *
 * Introspección ESTÁTICA del router real (mismo patrón que
 * tpv.tables.routes.permissions.test.ts) — no supertest, no DB: si alguien quita
 * `validateVenueAccess` o cambia el permiso, estos tests fallan sin levantar nada.
 *
 * Por qué SIN checkFeatureAccess (a diferencia de las rutas de Task 4): el menú es
 * capacidad core — gatearlo por plan dejaría sin catálogo a un venue FREE de
 * retail/servicios, el ICP real de la plataforma (ver task-5-brief.md).
 */

import { StaffRole } from '@prisma/client'
import tpvRouter from '@/routes/tpv.routes'
import { validateVenueAccess } from '@/middlewares/validateVenueAccess.middleware'
import { hasPermission } from '@/lib/permissions'

interface RouteInspection {
  hasValidateVenueAccess: boolean
  middlewareCount: number
  permission?: string
}

function inspectRoute(router: any, method: string, path: string): RouteInspection | undefined {
  for (const layer of router.stack ?? []) {
    if (!layer.route || layer.route.path !== path) continue
    const routeLayers: any[] = layer.route.stack ?? []
    if (!routeLayers.some(rl => rl.method === method)) continue

    const hasValidateVenueAccess = routeLayers.some(rl => rl.handle === validateVenueAccess)
    const permissionLayer = routeLayers.find(rl => typeof (rl.handle as any)?.requiredPermission === 'string')

    return {
      hasValidateVenueAccess,
      middlewareCount: routeLayers.length,
      permission: (permissionLayer?.handle as any)?.requiredPermission,
    }
  }
  return undefined
}

describe('tpv.routes — menú / productos / categorías (Plan B Task 5)', () => {
  const cases: Array<[string, string]> = [
    ['get', '/venues/:venueId/products'],
    ['get', '/venues/:venueId/categories'],
    ['get', '/venues/:venueId/menus'],
  ]

  it.each(cases)('%s %s → existe y lleva validateVenueAccess', (method, path) => {
    const route = inspectRoute(tpvRouter, method, path)
    expect(route).toBeDefined()
    expect(route!.hasValidateVenueAccess).toBe(true)
  })

  it.each(cases)('%s %s → exige el permiso menu:read (string EXACTO)', (method, path) => {
    const route = inspectRoute(tpvRouter, method, path)
    expect(route!.permission).toBe('menu:read')
  })

  it.each(cases)(
    '%s %s → EXACTAMENTE 4 capas (authenticateToken, validateVenueAccess, checkPermission, handler) — SIN checkFeatureAccess',
    (method, path) => {
      const route = inspectRoute(tpvRouter, method, path)
      // Task 4's TABLE_SERVICE routes carry a 5th layer (checkFeatureAccess) between
      // validateVenueAccess and checkPermission. These 3 routes must NOT — the menu is core
      // capacity; gating it by plan would 403 a FREE retail/services venue's catalog (the
      // platform's actual ICP). A 5th layer here is the regression this test catches.
      expect(route!.middlewareCount).toBe(4)
    },
  )

  // La defensa real: qué rol puede satisfacer menu:read contra el catálogo de verdad
  // (DEFAULT_PERMISSIONS), sin mocks — prueba que el gate no es phantom para el rol
  // mínimo que opera una TPV.
  it('WAITER SÍ puede satisfacer menu:read (necesita ver el catálogo para vender)', () => {
    expect(hasPermission(StaffRole.WAITER, null, 'menu:read')).toBe(true)
  })

  it('CASHIER SÍ puede satisfacer menu:read', () => {
    expect(hasPermission(StaffRole.CASHIER, null, 'menu:read')).toBe(true)
  })
})
