/**
 * Cortesía en el POS de mesas: pide el permiso de CORTESÍA, no el genérico de orden
 * (decisión del founder «A», 21-oct-2026; deuda `docs/audit/deuda-encontrada.md`, fila 21-oct).
 *
 * Antes: `POST /mobile/.../orders/:orderId/comp` y `.../items/:itemId/comp` pedían `orders:update`
 * (lo traen WAITER, CASHIER y KITCHEN), mientras la MISMA cortesía pedía `orders:comp` por la TPV y
 * por la cola sin red («ASIMETRÍA DECLARADA» del 17-ago). Ahora las cuatro puertas piden lo mismo,
 * y el MCP (`comp_table_check`) también.
 *
 * Quien tenga el permiso de cortesía en su rol (de fábrica MANAGER+, o el dueño se lo da desde el
 * panel con `tpv-orders:comp`) regala; quien no, recibe el 403 de `checkPermission`, que las apps
 * convierten en el teclado del PIN de gerente cuando el negocio lo tiene encendido.
 *
 * Medido en producción antes de cerrar (25-oct, sólo lectura): 0 cortesías por estas rutas en toda
 * la historia (ni `ORDER_COMPED` ni `ORDER_ITEM_COMPED`); las 12 cortesías existentes son de la TPV.
 */

import { StaffRole } from '@prisma/client'
import mobileRouter from '@/routes/mobile.routes'
import tpvRouter from '@/routes/tpv.routes'
import { authenticateTokenMiddleware } from '@/middlewares/authenticateToken.middleware'
import { hasPermission } from '@/lib/permissions'
import { requiredPermissionForIntent } from '@/services/mobile/sync.mobile.service'

function permissionOf(router: any, method: string, path: string): { auth: boolean; permission?: string } | undefined {
  for (const layer of router.stack ?? []) {
    if (!layer.route || layer.route.path !== path) continue
    const routeLayers: any[] = layer.route.stack ?? []
    if (!routeLayers.some(rl => rl.method === method)) continue
    const handlers = routeLayers.map(rl => rl.handle)
    const permissionLayer = routeLayers.find(rl => typeof (rl.handle as any)?.requiredPermission === 'string')
    return { auth: handlers.includes(authenticateTokenMiddleware), permission: (permissionLayer?.handle as any)?.requiredPermission }
  }
  return undefined
}

const CORTESIA_MOBILE: Array<[string, string]> = [
  ['post', '/venues/:venueId/orders/:orderId/comp'],
  ['post', '/venues/:venueId/orders/:orderId/items/:itemId/comp'],
]

describe('Cortesía en el POS de mesas pide orders:comp', () => {
  it.each(CORTESIA_MOBILE)('%s %s exige orders:comp', (method, path) => {
    const route = permissionOf(mobileRouter, method, path)
    expect(route).toBeDefined()
    expect(route!.auth).toBe(true)
    expect(route!.permission).toBe('orders:comp')
  })

  it('es el mismo candado que la TPV y que la cola sin red (ya no hay puerta floja)', () => {
    expect(permissionOf(tpvRouter, 'post', '/venues/:venueId/orders/:orderId/comp')!.permission).toBe('orders:comp')
    expect(requiredPermissionForIntent('COMP_ORDER' as any)).toBe('orders:comp')
  })

  it('de fábrica: mesero, cajero y cocina ya no regalan; gerente para arriba sí', () => {
    for (const role of [StaffRole.WAITER, StaffRole.CASHIER, StaffRole.KITCHEN, StaffRole.HOST]) {
      expect(hasPermission(role, null, 'orders:comp')).toBe(false)
    }
    for (const role of [StaffRole.MANAGER, StaffRole.ADMIN, StaffRole.OWNER]) {
      expect(hasPermission(role, null, 'orders:comp')).toBe(true)
    }
  })

  it('el dueño se lo puede dar a un mesero desde el panel (tpv-orders:comp implica orders:comp)', () => {
    expect(hasPermission(StaffRole.WAITER, ['tpv-orders:comp'], 'orders:comp')).toBe(true)
  })

  it('regresión: el resto de la cuenta del mesero sigue en orders:update', () => {
    expect(permissionOf(mobileRouter, 'post', '/venues/:venueId/orders/:orderId/details')!.permission).toBe('orders:update')
    expect(hasPermission(StaffRole.WAITER, null, 'orders:update')).toBe(true)
  })
})
