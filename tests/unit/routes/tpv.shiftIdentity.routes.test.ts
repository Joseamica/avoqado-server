/**
 * D24 (Testarudo, 22-nov-2026): la N86 se quedó en la caja de ayer porque quien entró era de Cocina, sin `shifts:read`, y la
 * única forma de saber cuál caja del negocio está abierta era GET /tpv/venues/:id/shift, que exige `shifts:read` y trae cifras.
 *
 * Esta prueba fija, leyendo el router REAL (mismo patrón que tpv.table-order.routes.test.ts):
 *   1. La ruta nueva sin cifras exige el permiso de COBRAR (`payments:create`), no `shifts:read`.
 *   2. GET /shift no cambia: mismo permiso y mismo handler (las TPV viejas dependen de él).
 */

import tpvRouter from '@/routes/tpv.routes'
import { authenticateTokenMiddleware } from '@/middlewares/authenticateToken.middleware'
import * as shiftController from '@/controllers/tpv/shift.tpv.controller'

function inspectRoute(router: any, method: string, path: string) {
  for (const layer of router.stack ?? []) {
    if (!layer.route || layer.route.path !== path) continue
    const routeLayers: any[] = layer.route.stack ?? []
    if (!routeLayers.some(rl => rl.method === method)) continue
    const handlers = routeLayers.map(rl => rl.handle)
    const permissionLayer = routeLayers.find(rl => typeof (rl.handle as any)?.requiredPermission === 'string')
    return {
      handlers,
      hasAuthenticateToken: handlers.includes(authenticateTokenMiddleware),
      permission: (permissionLayer?.handle as any)?.requiredPermission as string | undefined,
      finalHandler: handlers[handlers.length - 1],
    }
  }
  return undefined
}

describe('D24 · cuál caja del negocio está abierta, sin cifras', () => {
  it('GET /venues/:venueId/shift/identity exige payments:create (el permiso de cobrar), no shifts:read', () => {
    const route = inspectRoute(tpvRouter, 'get', '/venues/:venueId/shift/identity')
    expect(route).toBeDefined()
    expect(route!.hasAuthenticateToken).toBe(true)
    expect(route!.permission).toBe('payments:create')
    expect(route!.finalHandler).toBe(shiftController.getShiftIdentity)
  })

  it('GET /venues/:venueId/shift sigue igual: shifts:read y el mismo handler', () => {
    const route = inspectRoute(tpvRouter, 'get', '/venues/:venueId/shift')
    expect(route).toBeDefined()
    expect(route!.hasAuthenticateToken).toBe(true)
    expect(route!.permission).toBe('shifts:read')
    expect(route!.finalHandler).toBe(shiftController.getCurrentShift)
  })
})
