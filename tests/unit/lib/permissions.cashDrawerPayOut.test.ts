import { StaffRole } from '@prisma/client'
import { INDIVIDUAL_PERMISSIONS_BY_RESOURCE, hasPermission, resolvePermissions } from '@/lib/permissions'

const P = 'cash-drawer:pay-out'

describe('permiso cash-drawer:pay-out (retiro de caja con gerente)', () => {
  it.each(['MANAGER', 'ADMIN', 'OWNER', 'SUPERADMIN'])('%s retira de fábrica', role => {
    expect(hasPermission(role as StaffRole, null, P)).toBe(true)
  })

  it.each(['CASHIER', 'WAITER', 'HOST', 'KITCHEN', 'VIEWER'])('%s no retira de fábrica', role => {
    expect(hasPermission(role as StaffRole, null, P)).toBe(false)
  })

  it('un ADMIN con lista propia lo conserva (sus defaults suman)', () => {
    expect(hasPermission('ADMIN' as StaffRole, ['payments:create', 'orders:read'], P)).toBe(true)
    expect(hasPermission('OWNER' as StaffRole, ['payments:create', 'orders:read'], P)).toBe(true)
  })

  it('un negocio se lo puede dar al cajero', () => {
    expect(hasPermission('CASHIER' as StaffRole, [P], P)).toBe(true)
  })

  it('un negocio se lo puede quitar al gerente y nada lo devuelve', () => {
    expect(hasPermission('MANAGER' as StaffRole, null, P, [P])).toBe(false)
  })

  it('payments:create no lo implica', () => {
    expect(resolvePermissions(['payments:create'])).not.toContain(P)
  })

  it('está en el catálogo de la caja', () => {
    expect(INDIVIDUAL_PERMISSIONS_BY_RESOURCE['cash-drawer']).toEqual(expect.arrayContaining(['cash-drawer:view-expected', P]))
  })
})
