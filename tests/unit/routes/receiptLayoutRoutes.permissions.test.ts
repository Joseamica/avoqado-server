import { hasPermission, INDIVIDUAL_PERMISSIONS_BY_RESOURCE, PERMISSION_DEPENDENCIES } from '@/lib/permissions'
import { StaffRole } from '@prisma/client'

const puede = (rol: StaffRole, permiso: string) => hasPermission(rol, null, permiso)

describe('permiso receipt-layout — cableado en las TRES estructuras', () => {
  it('está en el catálogo por recurso (si no, no se puede asignar individualmente)', () => {
    expect(INDIVIDUAL_PERMISSIONS_BY_RESOURCE['receipt-layout']).toEqual(['receipt-layout:read', 'receipt-layout:manage'])
  })

  it('manage implica read (quien puede diseñar puede ver lo que diseña)', () => {
    expect(PERMISSION_DEPENDENCIES['receipt-layout:manage']).toContain('receipt-layout:read')
    expect(PERMISSION_DEPENDENCIES['receipt-layout:read']).toContain('receipt-layout:read')
  })

  // Se prueba la CAPACIDAD por el resolvedor real, no la representación: ADMIN y OWNER usan
  // comodín por recurso ('printers:*') y un día podrían cambiar de estilo. Lo que no puede
  // cambiar es quién puede diseñar el ticket.
  it('🔴 OWNER y ADMIN pueden diseñar el ticket', () => {
    for (const rol of [StaffRole.OWNER, StaffRole.ADMIN]) {
      expect(puede(rol, 'receipt-layout:read')).toBe(true)
      expect(puede(rol, 'receipt-layout:manage')).toBe(true)
    }
  })

  it('🔴 MANAGER NO puede — aunque sí tenga printers:manage, que es el precedente que NO se copia', () => {
    expect(puede(StaffRole.MANAGER, 'printers:manage')).toBe(true)
    expect(puede(StaffRole.MANAGER, 'receipt-layout:manage')).toBe(false)
    expect(puede(StaffRole.MANAGER, 'receipt-layout:read')).toBe(false)
  })

  it('🔴 ningún rol de piso puede, ni leer ni escribir', () => {
    for (const rol of [StaffRole.CASHIER, StaffRole.WAITER, StaffRole.KITCHEN, StaffRole.HOST, StaffRole.VIEWER]) {
      expect(puede(rol, 'receipt-layout:read')).toBe(false)
      expect(puede(rol, 'receipt-layout:manage')).toBe(false)
    }
  })
})
