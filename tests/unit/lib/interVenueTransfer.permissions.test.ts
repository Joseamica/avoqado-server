import { StaffRole } from '@prisma/client'
import { expandWildcards, hasPermission, isValidPermission } from '@/lib/permissions'

const TRANSFER_PERMISSIONS = [
  'inventory-transfers:read',
  'inventory-transfers:request',
  'inventory-transfers:approve',
  'inventory-transfers:dispatch',
  'inventory-transfers:receive',
]

describe('permisos de traslados entre sucursales', () => {
  it.each(TRANSFER_PERMISSIONS)('registra %s en el catálogo', permission => {
    expect(isValidPermission(permission)).toBe(true)
  })

  it('OWNER, ADMIN y MANAGER pueden operar el flujo según su rol en cada sucursal', () => {
    for (const role of [StaffRole.OWNER, StaffRole.ADMIN, StaffRole.MANAGER]) {
      for (const permission of TRANSFER_PERMISSIONS) expect(hasPermission(role, null, permission)).toBe(true)
    }
  })

  it('el wildcard del recurso expande las cinco acciones sin colisionar con inventory:*', () => {
    expect(expandWildcards(['inventory-transfers:*'])).toEqual(expect.arrayContaining(TRANSFER_PERMISSIONS))
    expect(expandWildcards(['inventory:*'])).not.toContain('inventory-transfers:dispatch')
  })
})
