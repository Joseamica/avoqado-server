import { StaffRole } from '@prisma/client'
import { DEFAULT_PERMISSIONS, INDIVIDUAL_PERMISSIONS_BY_RESOURCE, hasPermission, resolvePermissions } from '@/lib/permissions'

describe("permiso 'orders:merge'", () => {
  // 1. NUEVO
  it('está en el catálogo del recurso orders (asignable desde el editor de roles)', () => {
    expect(INDIVIDUAL_PERMISSIONS_BY_RESOURCE.orders).toContain('orders:merge')
  })

  // PERMISSION_DEPENDENCIES no se exporta; su efecto observable es resolvePermissions.
  it('declara sus dependencias implícitas', () => {
    const resolved = resolvePermissions(['orders:merge'])
    expect([...resolved]).toEqual(expect.arrayContaining(['orders:read', 'orders:update', 'orders:merge', 'tables:read']))
  })

  it('MANAGER lo trae por default, explícito', () => {
    expect(DEFAULT_PERMISSIONS[StaffRole.MANAGER]).toContain('orders:merge')
    expect(hasPermission(StaffRole.MANAGER, null, 'orders:merge')).toBe(true)
  })

  it('ADMIN y OWNER lo traen por el wildcard orders:*', () => {
    expect(hasPermission(StaffRole.ADMIN, null, 'orders:merge')).toBe(true)
    expect(hasPermission(StaffRole.OWNER, null, 'orders:merge')).toBe(true)
  })

  it('SUPERADMIN lo trae por *:*', () => {
    expect(hasPermission(StaffRole.SUPERADMIN, null, 'orders:merge')).toBe(true)
  })

  it('🔴 WAITER y CASHIER NO lo traen — restringido desde el día uno', () => {
    expect(hasPermission(StaffRole.WAITER, null, 'orders:merge')).toBe(false)
    expect(hasPermission(StaffRole.CASHIER, null, 'orders:merge')).toBe(false)
  })

  it('HOST, KITCHEN y VIEWER tampoco', () => {
    expect(hasPermission(StaffRole.HOST, null, 'orders:merge')).toBe(false)
    expect(hasPermission(StaffRole.KITCHEN, null, 'orders:merge')).toBe(false)
    expect(hasPermission(StaffRole.VIEWER, null, 'orders:merge')).toBe(false)
  })

  // 2. REGRESIÓN: las otras 9 acciones de orders:update NO se movieron
  it('WAITER conserva orders:update — sólo merge se separó en v1', () => {
    expect(hasPermission(StaffRole.WAITER, null, 'orders:update')).toBe(true)
  })

  it('el resto del catálogo de orders sigue completo', () => {
    expect(INDIVIDUAL_PERMISSIONS_BY_RESOURCE.orders).toEqual(
      expect.arrayContaining(['orders:read', 'orders:create', 'orders:update', 'orders:cancel', 'orders:comp', 'orders:void']),
    )
  })
})
