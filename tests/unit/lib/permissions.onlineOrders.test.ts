import { StaffRole } from '@prisma/client'
import {
  DEFAULT_PERMISSIONS,
  INDIVIDUAL_PERMISSIONS_BY_RESOURCE,
  PERMISSION_DEPENDENCIES,
  hasPermission,
  ungrantablePermissions,
} from '@/lib/permissions'

const PISO = [StaffRole.WAITER, StaffRole.CASHIER, StaffRole.KITCHEN, StaffRole.HOST, StaffRole.VIEWER]
const GERENTE_PARA_ARRIBA = [StaffRole.MANAGER, StaffRole.ADMIN, StaffRole.OWNER]

describe('permiso online-orders:manage', () => {
  it('lo tienen MANAGER, ADMIN y OWNER; no los roles de piso', () => {
    for (const role of GERENTE_PARA_ARRIBA) {
      expect(DEFAULT_PERMISSIONS[role]).toContain('online-orders:manage')
    }
    for (const role of PISO) {
      expect(DEFAULT_PERMISSIONS[role]).not.toContain('online-orders:manage')
    }
  })

  it('arrastra lo que hace falta para operar y está en el catálogo individual', () => {
    expect(PERMISSION_DEPENDENCIES['online-orders:manage']).toEqual(
      expect.arrayContaining(['online-orders:manage', 'orders:read', 'products:read']),
    )
    expect(INDIVIDUAL_PERMISSIONS_BY_RESOURCE['online-orders']).toEqual(['online-orders:manage', 'online-orders:pause'])
  })

  it('M-6: administrar la tienda en línea NO implica modificar cuentas del POS (`orders:update`): contestar pedidos se da aparte', () => {
    expect(PERMISSION_DEPENDENCIES['online-orders:manage']).not.toContain('orders:update')
    // Un rol a la medida al que sólo le dan la tienda en línea no puede tocar cualquier cuenta del POS…
    expect(hasPermission(StaffRole.VIEWER, ['online-orders:manage'], 'orders:update')).toBe(false)
    expect(hasPermission(StaffRole.VIEWER, ['online-orders:manage'], 'online-orders:pause')).toBe(true)
    // …y a los roles por default no les cambia nada: ya traen `orders:update` por su cuenta.
    for (const role of GERENTE_PARA_ARRIBA) expect(hasPermission(role, null, 'orders:update')).toBe(true)
  })

  it('aceptar usa orders:update, que cocina y caja ya tienen (F3); cancelar pide orders:cancel-unpaid (R15)', () => {
    expect(DEFAULT_PERMISSIONS[StaffRole.KITCHEN]).toContain('orders:update')
    expect(DEFAULT_PERMISSIONS[StaffRole.CASHIER]).toEqual(expect.arrayContaining(['orders:update', 'orders:cancel-unpaid']))
    expect(DEFAULT_PERMISSIONS[StaffRole.KITCHEN]).not.toContain('orders:cancel-unpaid')
  })
})

describe('permiso online-orders:pause (decisión del founder, 16-oct: pausar desde el piso es de gerente para arriba)', () => {
  it('lo tienen MANAGER, ADMIN y OWNER por default; ningún rol de piso', () => {
    for (const role of GERENTE_PARA_ARRIBA) {
      expect(DEFAULT_PERMISSIONS[role]).toContain('online-orders:pause')
      expect(hasPermission(role, null, 'online-orders:pause')).toBe(true)
    }
    for (const role of PISO) {
      expect(DEFAULT_PERMISSIONS[role]).not.toContain('online-orders:pause')
      expect(hasPermission(role, null, 'online-orders:pause')).toBe(false)
    }
  })

  it('OWNER y ADMIN con permisos personalizados lo conservan (sus listas son explícitas: modo suma, no reemplazo)', () => {
    for (const role of [StaffRole.OWNER, StaffRole.ADMIN]) {
      expect(DEFAULT_PERMISSIONS[role]).not.toContain('*:*')
      expect(hasPermission(role, ['menu:read'], 'online-orders:pause')).toBe(true)
    }
  })

  it('se puede dar a cualquier rol por permisos personalizados, y un gerente puede otorgarlo', () => {
    expect(INDIVIDUAL_PERMISSIONS_BY_RESOURCE['online-orders']).toContain('online-orders:pause')
    expect(hasPermission(StaffRole.CASHIER, ['online-orders:pause'], 'online-orders:pause')).toBe(true)
    for (const role of GERENTE_PARA_ARRIBA) expect(ungrantablePermissions(role, ['online-orders:pause'])).toEqual([])
  })

  it('quien administra la tienda también puede frenarla; pausar sólo arrastra ver los pedidos', () => {
    expect(PERMISSION_DEPENDENCIES['online-orders:manage']).toContain('online-orders:pause')
    expect(PERMISSION_DEPENDENCIES['online-orders:pause']).toEqual(['online-orders:pause', 'orders:read'])
  })
})
