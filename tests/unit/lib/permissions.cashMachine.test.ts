/**
 * Máquina de efectivo (fase 1a, R5#10 y R4-4): `cash-machine:configure` (habilitar la PC que le habla a la máquina) y
 * `cash-machine:resolve` (resolver un cobro de la máquina en duda). Gerencia de fábrica; el negocio los da o los quita por rol.
 */
import { StaffRole } from '@prisma/client'
import { INDIVIDUAL_PERMISSIONS_BY_RESOURCE, hasPermission, resolvePermissions } from '@/lib/permissions'

const CONFIGURAR = 'cash-machine:configure'
const RESOLVER = 'cash-machine:resolve'

describe('permisos de la máquina de efectivo', () => {
  it.each(['MANAGER', 'ADMIN', 'OWNER', 'SUPERADMIN'])('%s configura y resuelve de fábrica', role => {
    expect(hasPermission(role as StaffRole, null, CONFIGURAR)).toBe(true)
    expect(hasPermission(role as StaffRole, null, RESOLVER)).toBe(true)
  })

  it.each(['CASHIER', 'WAITER', 'HOST', 'KITCHEN', 'VIEWER'])('%s no configura ni resuelve de fábrica', role => {
    expect(hasPermission(role as StaffRole, null, CONFIGURAR)).toBe(false)
    expect(hasPermission(role as StaffRole, null, RESOLVER)).toBe(false)
  })

  it('un negocio se los puede dar al cajero, y quitárselos al gerente', () => {
    expect(hasPermission('CASHIER' as StaffRole, [CONFIGURAR], CONFIGURAR)).toBe(true)
    expect(hasPermission('MANAGER' as StaffRole, null, CONFIGURAR, [CONFIGURAR])).toBe(false)
  })

  it('cobrar no implica configurar ni resolver; resolver implica ver los cobros', () => {
    const de = (perms: string[]) => [...resolvePermissions(perms)]
    expect(de(['payments:create'])).not.toContain(CONFIGURAR)
    expect(de(['payments:create'])).not.toContain(RESOLVER)
    expect(de([RESOLVER]).sort()).toEqual([RESOLVER, 'payments:read'].sort())
    expect(de([CONFIGURAR])).toEqual([CONFIGURAR])
  })

  it('están en el catálogo del editor de roles («Máquina de efectivo»)', () => {
    expect(INDIVIDUAL_PERMISSIONS_BY_RESOURCE['cash-machine']).toEqual([CONFIGURAR, RESOLVER])
  })
})
