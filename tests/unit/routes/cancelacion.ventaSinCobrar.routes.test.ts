/**
 * Deshacer la venta que el propio POS acaba de crear — caso #9 de la auditoría de
 * permisos de piso.
 *
 * El POS crea la orden ANTES de cobrar. Si el cliente se arrepiente o falla la terminal,
 * el cajero no podía deshacerla: la cancelación pedía `orders:cancel`, que es MANAGER+.
 * Quedaba una orden abierta y cobrable ensuciando el corte, y en la pantalla de error el
 * cajero se quedaba atrapado porque las dos salidas fallaban.
 *
 * 🔴 El atajo malo era dar `orders:cancel` a CASHIER y WAITER: eso permite ANULAR
 * cheques ajenos ya en servicio, con líneas enviadas a cocina. Por eso nace el permiso
 * acotado `orders:cancel-unpaid`, exactamente como propuso el informe.
 *
 * Para que "acotado" sea verdad y no un nombre bonito, la ruta tiene que ser incapaz de
 * cancelar una orden con dinero encima. Ya rechazaba las PAID; ahora también las PARTIAL
 * —una cuenta a medio pagar que se cancelaba se llevaba el registro del dinero ya
 * cobrado—. Eso aplica a TODOS, MANAGER+ incluido: con pagos hechos, el camino correcto
 * es reembolsar y después cancelar, que es como lo resuelve Square.
 */

import { StaffRole } from '@prisma/client'
import mobileRouter from '@/routes/mobile.routes'
import tpvRouter from '@/routes/tpv.routes'
import { DEFAULT_PERMISSIONS, INDIVIDUAL_PERMISSIONS_BY_RESOURCE, hasPermission, resolvePermissions } from '@/lib/permissions'
import { requiredPermissionForIntent } from '@/services/mobile/sync.mobile.service'

function permissionOf(router: any, method: string, path: string): string | undefined {
  for (const layer of router.stack ?? []) {
    if (!layer.route || layer.route.path !== path) continue
    const routeLayers: any[] = layer.route.stack ?? []
    if (!routeLayers.some(rl => rl.method === method)) continue
    const permissionLayer = routeLayers.find(rl => typeof (rl.handle as any)?.requiredPermission === 'string')
    return (permissionLayer?.handle as any)?.requiredPermission
  }
  return undefined
}

const MOSTRADOR = [StaffRole.CASHIER, StaffRole.WAITER]
const JEFES = [StaffRole.MANAGER, StaffRole.ADMIN, StaffRole.OWNER]

describe('Cancelar una venta sin cobrar tiene permiso propio', () => {
  it('DELETE /mobile/venues/:venueId/orders/:orderId exige orders:cancel-unpaid', () => {
    expect(permissionOf(mobileRouter, 'delete', '/venues/:venueId/orders/:orderId')).toBe('orders:cancel-unpaid')
  })

  it('POST /tpv/venues/:venueId/orders/:orderId/cancel exige lo mismo (misma acción, mismo servicio)', () => {
    expect(permissionOf(tpvRouter, 'post', '/venues/:venueId/orders/:orderId/cancel')).toBe('orders:cancel-unpaid')
  })

  it('el intent offline CANCEL_ORDER espeja la ruta online', () => {
    expect(requiredPermissionForIntent('CANCEL_ORDER')).toBe('orders:cancel-unpaid')
  })
})

describe('Quién gana, quién no pierde y qué NO se abre', () => {
  it.each(MOSTRADOR)('%s ya puede deshacer la venta que acaba de arrancar', role => {
    expect(hasPermission(role, null, 'orders:cancel-unpaid')).toBe(true)
    expect(DEFAULT_PERMISSIONS[role]).toContain('orders:cancel-unpaid')
  })

  it.each(JEFES)('%s no pierde nada: orders:cancel implica el permiso acotado', role => {
    expect(hasPermission(role, null, 'orders:cancel-unpaid')).toBe(true)
  })

  it('orders:cancel implica orders:cancel-unpaid (el puente)', () => {
    expect(Array.from(resolvePermissions(['orders:cancel']))).toContain('orders:cancel-unpaid')
  })

  it('🔴 el puente NO va al revés: el mostrador NO gana orders:cancel', () => {
    expect(Array.from(resolvePermissions(['orders:cancel-unpaid']))).not.toContain('orders:cancel')
    for (const role of MOSTRADOR) {
      expect(hasPermission(role, null, 'orders:cancel')).toBe(false)
    }
  })

  it('🔴 tampoco gana anular ni cortesiar líneas ya enviadas', () => {
    for (const role of MOSTRADOR) {
      expect(hasPermission(role, null, 'orders:void')).toBe(false)
      expect(hasPermission(role, null, 'orders:comp')).toBe(false)
    }
  })

  it('KITCHEN, HOST y VIEWER siguen sin cancelar nada', () => {
    for (const role of [StaffRole.KITCHEN, StaffRole.HOST, StaffRole.VIEWER]) {
      expect(hasPermission(role, null, 'orders:cancel-unpaid')).toBe(false)
    }
  })

  it('es asignable uno por uno desde el editor de roles', () => {
    expect(INDIVIDUAL_PERMISSIONS_BY_RESOURCE['orders']).toContain('orders:cancel-unpaid')
  })

  it('el permiso acotado arrastra sólo lectura de la orden, nada de escritura', () => {
    const desde = Array.from(resolvePermissions(['orders:cancel-unpaid']))
    expect(desde).toContain('orders:read')
    expect(desde).not.toContain('orders:update')
    expect(desde).not.toContain('orders:create')
  })
})
