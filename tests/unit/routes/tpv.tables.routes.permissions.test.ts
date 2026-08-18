/**
 * Auditoría de permisos + aislamiento de tenant de las rutas de mesa y
 * floor-elements bajo `/tpv` (spec §4.4, 2026-07-24).
 *
 * Bug: las 10 rutas de escritura de mesas/floor-elements llevaban SOLO
 * `authenticateTokenMiddleware`. Sin `checkPermission`, un WAITER podía crear,
 * renombrar, reposicionar y borrar mesas. Y como nada validaba que el `:venueId`
 * de la URL perteneciera al `authContext` del token, un token del venue A podía
 * operar sobre el venue B (IDOR de escritura).
 *
 * Este archivo prueba el ROUTER real (introspección estática del stack de
 * Express), no un middleware mockeado — si alguien quita `validateVenueAccess`
 * o cambia el permiso de una ruta, estos tests fallan sin tocar la DB.
 *
 * `checkPermission('X')` marca la función devuelta con `.requiredPermission = X`
 * (ver `checkPermission.middleware.ts`), así que se puede leer directo del stack.
 * Mismo patrón que `inventory.routes.permissions.test.ts` / `deliveryChannels.routes.permissions.test.ts`.
 */

import { StaffRole } from '@prisma/client'
import tpvRouter from '@/routes/tpv.routes'
import { validateVenueAccess } from '@/middlewares/validateVenueAccess.middleware'
import { hasPermission } from '@/lib/permissions'

interface RouteInspection {
  hasValidateVenueAccess: boolean
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
      permission: (permissionLayer?.handle as any)?.requiredPermission,
    }
  }
  return undefined
}

describe('tpv.routes — mesas y floor-elements (spec §4.4)', () => {
  // [method, path, expectedPermission] — undefined = sólo validateVenueAccess.
  //
  // 🔴 2026-08-17 (auditoría de permisos de piso, "Forma B"): `assign` y `clear` SÍ
  // llevan candado desde hoy. Eran las dos únicas rutas OPERATIVAS de mesa sin ningún
  // `checkPermission`, así que cualquier miembro del venue abría y liberaba mesas desde
  // la TPV. Llevan `tables:update` —el permiso de SALA— igual que sus gemelas de
  // /mobile; el detalle y la matemática de roles están en
  // `mesas.permisos-de-mesa.routes.test.ts`. `GET /tables` se queda sin candado aquí a
  // propósito (ya lo tiene `/mobile` con `tables:read`).
  const cases: Array<[string, string, string | undefined]> = [
    ['get', '/venues/:venueId/tables', undefined],
    ['post', '/venues/:venueId/tables/assign', 'tables:update'],
    ['post', '/venues/:venueId/tables', 'tpv-tables:write'],
    ['put', '/venues/:venueId/tables/:tableId/position', 'tpv-tables:write'],
    ['put', '/venues/:venueId/tables/:tableId', 'tpv-tables:write'],
    ['delete', '/venues/:venueId/tables/:tableId', 'tpv-tables:delete'],
    ['post', '/venues/:venueId/tables/:tableId/clear', 'tables:update'],
    ['get', '/venues/:venueId/floor-elements', undefined],
    ['post', '/venues/:venueId/floor-elements', 'tpv-floor-elements:write'],
    ['put', '/venues/:venueId/floor-elements/:elementId', 'tpv-floor-elements:write'],
    ['delete', '/venues/:venueId/floor-elements/:elementId', 'tpv-floor-elements:delete'],
  ]

  it.each(cases)('%s %s → validateVenueAccess presente', (method, path) => {
    const route = inspectRoute(tpvRouter, method, path)
    expect(route).toBeDefined()
    expect(route!.hasValidateVenueAccess).toBe(true)
  })

  it.each(cases)('%s %s → exige permiso %s', (method, path, expectedPermission) => {
    const route = inspectRoute(tpvRouter, method, path)
    expect(route).toBeDefined()
    expect(route!.permission).toBe(expectedPermission)
  })

  // La defensa real: qué rol puede realmente satisfacer el permiso, contra el
  // catálogo de verdad (DEFAULT_PERMISSIONS), sin mocks.
  it.each(['tpv-tables:write', 'tpv-tables:delete', 'tpv-floor-elements:write', 'tpv-floor-elements:delete'])(
    'WAITER NO puede satisfacer %s (el defecto que se tapa)',
    perm => {
      expect(hasPermission(StaffRole.WAITER, null, perm)).toBe(false)
    },
  )

  it.each(['tpv-tables:write', 'tpv-tables:delete', 'tpv-floor-elements:write', 'tpv-floor-elements:delete'])(
    'CASHIER NO puede satisfacer %s',
    perm => {
      expect(hasPermission(StaffRole.CASHIER, null, perm)).toBe(false)
    },
  )

  it.each(['tpv-tables:write', 'tpv-tables:delete', 'tpv-floor-elements:write', 'tpv-floor-elements:delete'])(
    'MANAGER SÍ puede satisfacer %s',
    perm => {
      expect(hasPermission(StaffRole.MANAGER, null, perm)).toBe(true)
    },
  )
})
