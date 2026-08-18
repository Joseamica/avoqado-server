/**
 * "La caja liquida cualquier cheque" — caso #4 de la auditoría de permisos de piso.
 *
 * Con el switch `VenueSettings.enforceTableOwnership` encendido (PRO, opt-in), el CAJERO
 * no podía cobrar NINGUNA mesa que hubiera abierto un mesero: 403 "Solo Juan Pérez puede
 * modificar esta mesa". Cobrar es literalmente su trabajo. El único escape era
 * `tables:manage-all`, que le regalaría editar, descontar, cortesiar, cancelar, mover y
 * fusionar CUALQUIER mesa — o sea, apagar la propiedad de mesa por la puerta de atrás.
 *
 * Nace un override acotado, `tables:pay-any`: sólo exime del candado de propiedad a la
 * ruta de COBRO. Es lo que hacen Toast y Square — tienen dueño de mesa para editar el
 * cheque, pero dejan que la caja lo liquide.
 *
 * El espejo offline va en el MISMO cambio: `PAY_CASH` evalúa la misma regla en el
 * reducer, y dejarlo con el override viejo significaría que el cajero cobra con red y no
 * cobra sin ella.
 */

import { StaffRole } from '@prisma/client'
import mobileRouter from '@/routes/mobile.routes'
import { DEFAULT_PERMISSIONS, INDIVIDUAL_PERMISSIONS_BY_RESOURCE, hasPermission, resolvePermissions } from '@/lib/permissions'

/** Lee la lista de permisos-override con la que se montó `checkTableOwnership` en una ruta. */
function ownershipOverridesOf(router: any, method: string, path: string): string[] | undefined {
  for (const layer of router.stack ?? []) {
    if (!layer.route || layer.route.path !== path) continue
    const routeLayers: any[] = layer.route.stack ?? []
    if (!routeLayers.some(rl => rl.method === method)) continue
    const ownershipLayer = routeLayers.find(rl => Array.isArray((rl.handle as any)?.ownershipOverridePermissions))
    return (ownershipLayer?.handle as any)?.ownershipOverridePermissions
  }
  return undefined
}

const PAY = '/venues/:venueId/orders/:orderId/pay'

describe('Sólo la ruta de COBRO se exime del candado de propiedad de mesa', () => {
  it('POST …/orders/:orderId/pay acepta tables:pay-any además de tables:manage-all', () => {
    expect(ownershipOverridesOf(mobileRouter, 'post', PAY)).toEqual(['tables:manage-all', 'tables:pay-any'])
  })

  it.each([
    ['post', '/venues/:venueId/orders/:orderId/discounts'],
    ['post', '/venues/:venueId/orders/:orderId/comp'],
    ['post', '/venues/:venueId/orders/:orderId/split'],
    ['post', '/venues/:venueId/orders/:orderId/merge'],
    ['post', '/venues/:venueId/orders/:orderId/move'],
    ['delete', '/venues/:venueId/orders/:orderId'],
    ['post', '/venues/:venueId/orders/:orderId/items'],
  ])('🔴 %s %s NO se exime: editar la mesa ajena sigue prohibido', (method, path) => {
    expect(ownershipOverridesOf(mobileRouter, method, path)).toEqual(['tables:manage-all'])
  })
})

describe('Quién gana y quién no', () => {
  it('CASHIER puede liquidar un cheque ajeno', () => {
    expect(hasPermission(StaffRole.CASHIER, null, 'tables:pay-any')).toBe(true)
    expect(DEFAULT_PERMISSIONS[StaffRole.CASHIER]).toContain('tables:pay-any')
  })

  it('🔴 CASHIER sigue SIN tables:manage-all — no gana editar, cortesiar ni cancelar mesas ajenas', () => {
    expect(hasPermission(StaffRole.CASHIER, null, 'tables:manage-all')).toBe(false)
  })

  it.each([StaffRole.MANAGER, StaffRole.ADMIN, StaffRole.OWNER])('%s conserva el override por tables:manage-all', role => {
    expect(hasPermission(role, null, 'tables:manage-all')).toBe(true)
    expect(hasPermission(role, null, 'tables:pay-any')).toBe(true)
  })

  it('tables:manage-all implica tables:pay-any (quien puede todo, puede cobrar)', () => {
    expect(Array.from(resolvePermissions(['tables:manage-all']))).toContain('tables:pay-any')
  })

  it('🔴 pero no al revés: cobrar cualquier mesa no regala administrarlas', () => {
    const desdeCobro = Array.from(resolvePermissions(['tables:pay-any']))
    expect(desdeCobro).not.toContain('tables:manage-all')
    expect(desdeCobro).not.toContain('tables:update')
  })

  it('WAITER NO lo recibe: la propiedad de mesa existe justamente para separarlos entre sí', () => {
    expect(hasPermission(StaffRole.WAITER, null, 'tables:pay-any')).toBe(false)
  })

  it('KITCHEN, HOST y VIEWER tampoco', () => {
    for (const role of [StaffRole.KITCHEN, StaffRole.HOST, StaffRole.VIEWER]) {
      expect(hasPermission(role, null, 'tables:pay-any')).toBe(false)
    }
  })

  it('es asignable uno por uno desde el editor de roles', () => {
    expect(INDIVIDUAL_PERMISSIONS_BY_RESOURCE['tables']).toContain('tables:pay-any')
  })
})
