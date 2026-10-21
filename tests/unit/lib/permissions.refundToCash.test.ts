/**
 * `payments:refund-to-cash` — devolver en EFECTIVO un cobro que no fue en efectivo (founder, 1-oct-2026).
 *
 * Gerencia sí (MANAGER, ADMIN, OWNER; SUPERADMIN por comodín); de CASHIER para abajo no. Sin el permiso no se
 * bloquea: el servidor da el 403 de siempre y el POS pide el código de un encargado.
 */
import { StaffRole } from '@prisma/client'
import {
  DEFAULT_PERMISSIONS,
  getEffectiveRolePermissions,
  hasPermission,
  INDIVIDUAL_PERMISSIONS_BY_RESOURCE,
  PERMISSION_DEPENDENCIES,
} from '@/lib/permissions'

const REFUND_TO_CASH = 'payments:refund-to-cash'

describe('payments:refund-to-cash', () => {
  it('MANAGER lo trae de fábrica, escrito en su lista', () => {
    expect(DEFAULT_PERMISSIONS[StaffRole.MANAGER]).toContain(REFUND_TO_CASH)
  })

  it('MANAGER, ADMIN, OWNER y SUPERADMIN lo tienen', () => {
    for (const rol of [StaffRole.MANAGER, StaffRole.ADMIN, StaffRole.OWNER, StaffRole.SUPERADMIN]) {
      expect(hasPermission(rol, null, REFUND_TO_CASH)).toBe(true)
    }
  })

  it('🔴 de CASHIER para abajo NO — aunque el cajero sí reembolsa', () => {
    for (const rol of [StaffRole.CASHIER, StaffRole.WAITER, StaffRole.KITCHEN, StaffRole.HOST, StaffRole.VIEWER]) {
      expect(hasPermission(rol, null, REFUND_TO_CASH)).toBe(false)
    }
    expect(hasPermission(StaffRole.CASHIER, null, 'payments:refund')).toBe(true)
  })

  it('aparece en el catálogo individual, junto a payments:refund', () => {
    expect(INDIVIDUAL_PERMISSIONS_BY_RESOURCE.payments).toContain(REFUND_TO_CASH)
  })

  it('dárselo a un rol arrastra payments:refund (sin reembolsar no se devuelve nada)', () => {
    expect(PERMISSION_DEPENDENCIES[REFUND_TO_CASH]).toEqual(expect.arrayContaining([REFUND_TO_CASH, 'payments:refund']))
    expect(getEffectiveRolePermissions(StaffRole.WAITER, [REFUND_TO_CASH])).toEqual(
      expect.arrayContaining([REFUND_TO_CASH, 'payments:refund']),
    )
  })

  it('el dueño puede quitárselo al gerente', () => {
    expect(hasPermission(StaffRole.MANAGER, null, REFUND_TO_CASH, [REFUND_TO_CASH])).toBe(false)
  })
})
