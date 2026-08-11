import { StaffRole } from '@prisma/client'
import { DEFAULT_PERMISSIONS, INDIVIDUAL_PERMISSIONS_BY_RESOURCE, hasPermission } from '@/lib/permissions'

describe('Permiso de confirmación de cobro externo', () => {
  const PERM = 'area-tickets:confirm-external'

  it('está en el catálogo, para que se pueda asignar desde el editor de roles', () => {
    const all = Object.values(INDIVIDUAL_PERMISSIONS_BY_RESOURCE).flat()
    expect(all.map((p: any) => (typeof p === 'string' ? p : p.key))).toContain(PERM)
  })

  it('MANAGER lo tiene por default — confirmar un cobro es trabajo de gerencia, no de superadmin', () => {
    expect(DEFAULT_PERMISSIONS.MANAGER).toContain(PERM)
  })

  it('CASHIER NO lo tiene: es una afirmación sobre dinero', () => {
    expect(DEFAULT_PERMISSIONS.CASHIER ?? []).not.toContain(PERM)
  })

  // Los dos casos de abajo van más allá del brief: verifican la decisión de AUTORIDAD vía
  // `hasPermission()` (el mismo resolutor que usa `npm run audit:permissions`), no solo
  // presencia literal en el array. ADMIN y OWNER NO llevan el string explícito — ya lo cubre
  // su wildcard preexistente 'area-tickets:*' — así que sin este test esa cobertura quedaría
  // verificada solo "a mano" y sin resguardo contra una regresión futura.
  it('ADMIN y OWNER lo satisfacen vía su wildcard area-tickets:* (sin duplicar el literal)', () => {
    expect(hasPermission(StaffRole.ADMIN, null, PERM)).toBe(true)
    expect(hasPermission(StaffRole.OWNER, null, PERM)).toBe(true)
  })

  it('WAITER NO lo tiene: emite y entrega vales, pero confirmar un cobro no es su rol', () => {
    expect(hasPermission(StaffRole.WAITER, null, PERM)).toBe(false)
  })
})
