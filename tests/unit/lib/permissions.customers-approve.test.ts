import { hasPermission } from '@/lib/permissions'
import { StaffRole } from '@prisma/client'

/**
 * Fase 1 — quién puede aprobar a un cliente para que reserve en línea.
 *
 * Decisión del founder (2026-08-22): **sólo OWNER y ADMIN**. La gerente NO.
 * El razonamiento es el mismo por el que el alta de un empleado tampoco es suya: decidir
 * a quién se le deja entrar al negocio es una decisión de dueño, no de operación del turno.
 *
 * 🔴 El detalle que hace que esto NO sea gratis: MANAGER tenía `customers:*`, un comodín
 * que habría satisfecho `customers:approve` en silencio. Se cambia por sus cinco permisos
 * explícitos — que son exactamente los que la plataforma usa hoy, así que la gerente no
 * pierde nada de lo que ya hacía. Esta suite vigila las dos mitades: que gane el que debe
 * ganar, y que nadie pierda lo que tenía.
 */
describe('customers:approve — sólo OWNER y ADMIN', () => {
  it('🔴 OWNER puede aprobar', () => {
    expect(hasPermission(StaffRole.OWNER, [], 'customers:approve')).toBe(true)
  })

  it('🔴 ADMIN puede aprobar', () => {
    expect(hasPermission(StaffRole.ADMIN, [], 'customers:approve')).toBe(true)
  })

  it('🔴 MANAGER NO puede aprobar (su comodín `customers:*` no debe alcanzarlo)', () => {
    expect(hasPermission(StaffRole.MANAGER, [], 'customers:approve')).toBe(false)
  })

  it('🔴 CASHIER, WAITER y HOST tampoco', () => {
    for (const role of [StaffRole.CASHIER, StaffRole.WAITER, StaffRole.HOST] as const) {
      expect(hasPermission(role, [], 'customers:approve')).toBe(false)
    }
  })

  it('SUPERADMIN sí, por su comodín global', () => {
    expect(hasPermission(StaffRole.SUPERADMIN, [], 'customers:approve')).toBe(true)
  })

  // ---- Regresión: quitarle el comodín a MANAGER no le quita nada de lo que ya hacía ----
  it('🔴 regresión: MANAGER conserva sus cinco permisos de clientes', () => {
    for (const perm of ['customers:read', 'customers:create', 'customers:update', 'customers:delete', 'customers:settle-balance']) {
      expect(hasPermission(StaffRole.MANAGER, [], perm)).toBe(true)
    }
  })

  it('regresión: un venue que le concedió `customers:approve` a MANAGER a mano sí lo tiene', () => {
    // Los permisos personalizados por venue siguen mandando sobre el default del rol.
    expect(hasPermission(StaffRole.MANAGER, ['customers:approve'], 'customers:approve')).toBe(true)
  })
})
