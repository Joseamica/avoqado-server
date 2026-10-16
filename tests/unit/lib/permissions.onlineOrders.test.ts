import { StaffRole } from '@prisma/client'
import { DEFAULT_PERMISSIONS, INDIVIDUAL_PERMISSIONS_BY_RESOURCE, PERMISSION_DEPENDENCIES } from '@/lib/permissions'

describe('permiso online-orders:manage', () => {
  it('lo tienen MANAGER, ADMIN y OWNER; no los roles de piso', () => {
    for (const role of [StaffRole.MANAGER, StaffRole.ADMIN, StaffRole.OWNER]) {
      expect(DEFAULT_PERMISSIONS[role]).toContain('online-orders:manage')
    }
    for (const role of [StaffRole.WAITER, StaffRole.CASHIER, StaffRole.KITCHEN, StaffRole.HOST, StaffRole.VIEWER]) {
      expect(DEFAULT_PERMISSIONS[role]).not.toContain('online-orders:manage')
    }
  })

  it('arrastra lo que hace falta para operar y está en el catálogo individual', () => {
    expect(PERMISSION_DEPENDENCIES['online-orders:manage']).toEqual(
      expect.arrayContaining(['online-orders:manage', 'orders:read', 'orders:update', 'products:read']),
    )
    expect(INDIVIDUAL_PERMISSIONS_BY_RESOURCE['online-orders']).toEqual(['online-orders:manage'])
  })

  it('aceptar y pausar usan orders:update, que cocina y caja ya tienen (F3); cancelar pide orders:cancel-unpaid (R15)', () => {
    expect(DEFAULT_PERMISSIONS[StaffRole.KITCHEN]).toContain('orders:update')
    expect(DEFAULT_PERMISSIONS[StaffRole.CASHIER]).toEqual(expect.arrayContaining(['orders:update', 'orders:cancel-unpaid']))
    expect(DEFAULT_PERMISSIONS[StaffRole.KITCHEN]).not.toContain('orders:cancel-unpaid')
  })
})
