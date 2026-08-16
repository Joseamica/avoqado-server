/**
 * Decisiones del founder (2026-08-16) sobre la auditoría de permisos de piso
 * (`docs/superpowers/specs/2026-08-16-auditoria-permisos-piso.md`, casos #5, #6, #7 y #8).
 *
 * El patrón que se corrige: a la gente de piso se le exigía un permiso de ADMINISTRAR
 * un recurso para poder OPERAR con él.
 *
 * DECISIÓN 1 — CLIENTES: CASHIER, WAITER y HOST pueden CREAR un cliente desde el cobro.
 *   Sin esto la venta queda anónima: sin historial, sin lealtad y sin a quién facturar.
 *   Editar y borrar el directorio SE QUEDA ARRIBA (MANAGER+).
 *
 * DECISIÓN 2 — PAQUETES Y MEMBRESÍAS: el mostrador puede VENDER un paquete y CANJEAR
 *   una sesión, SIN poder editar el catálogo. En el ICP activo (gyms, estéticas, spas)
 *   el paquete ES la venta principal.
 *   🔴 `creditPacks:update` NO se le da: permite editar precio y número de sesiones del
 *   catálogo. Y `creditPacks:create` tampoco: en el dashboard esa misma llave crea un
 *   paquete NUEVO en el catálogo (`POST /dashboard/venues/:venueId/credit-packs`), con
 *   su precio y sus sesiones — exactamente lo que el founder excluyó.
 *   Por eso nacen dos permisos acotados, espejo de `coupons:redeem` (que estos roles YA
 *   tienen): `creditPacks:sell` y `creditPacks:redeem`.
 *
 * Sin mocks y sin DB: se ejecuta el resolvedor real contra el catálogo real.
 */

import { StaffRole } from '@prisma/client'
import { DEFAULT_PERMISSIONS, INDIVIDUAL_PERMISSIONS_BY_RESOURCE, hasPermission, resolvePermissions } from '@/lib/permissions'

/** Los tres roles de piso que tocan al cliente en el cobro. */
const PISO = [StaffRole.CASHIER, StaffRole.WAITER, StaffRole.HOST]
/** Los dos que además COBRAN (tienen `payments:create`): el mostrador. */
const MOSTRADOR = [StaffRole.CASHIER, StaffRole.WAITER]
const JEFES = [StaffRole.MANAGER, StaffRole.ADMIN, StaffRole.OWNER]

describe('Decisión 1 — clientes: el piso CREA, no administra el directorio', () => {
  it.each(PISO)('%s puede guardar un cliente nuevo desde el cobro', role => {
    expect(hasPermission(role, null, 'customers:create')).toBe(true)
  })

  it.each(PISO)('%s lo trae explícito en sus defaults (no por un wildcard heredado)', role => {
    expect(DEFAULT_PERMISSIONS[role]).toContain('customers:create')
  })

  it.each(PISO)('🔴 %s NO puede editar el directorio de clientes', role => {
    expect(hasPermission(role, null, 'customers:update')).toBe(false)
  })

  it.each(PISO)('🔴 %s NO puede borrar clientes', role => {
    expect(hasPermission(role, null, 'customers:delete')).toBe(false)
  })

  it.each(PISO)('🔴 %s NO puede liquidar el saldo de un cliente (toca dinero)', role => {
    expect(hasPermission(role, null, 'customers:settle-balance')).toBe(false)
  })

  it.each(JEFES)('%s conserva editar y borrar (vía customers:*)', role => {
    expect(hasPermission(role, null, 'customers:update')).toBe(true)
    expect(hasPermission(role, null, 'customers:delete')).toBe(true)
  })

  it('KITCHEN y VIEWER siguen sin poder crear clientes', () => {
    expect(hasPermission(StaffRole.KITCHEN, null, 'customers:create')).toBe(false)
    expect(hasPermission(StaffRole.VIEWER, null, 'customers:create')).toBe(false)
  })
})

describe('Decisión 2 — paquetes: vender y canjear SIN tocar el catálogo', () => {
  // ── El permiso nuevo existe y es asignable desde el editor de roles ──
  it('creditPacks:redeem está en el catálogo del recurso (el dashboard lo puede mostrar)', () => {
    expect(INDIVIDUAL_PERMISSIONS_BY_RESOURCE.creditPacks).toContain('creditPacks:redeem')
  })

  it('creditPacks:sell está en el catálogo del recurso', () => {
    expect(INDIVIDUAL_PERMISSIONS_BY_RESOURCE.creditPacks).toContain('creditPacks:sell')
  })

  it('el catálogo de creditPacks conserva las 4 llaves de administración', () => {
    expect(INDIVIDUAL_PERMISSIONS_BY_RESOURCE.creditPacks).toEqual(
      expect.arrayContaining(['creditPacks:read', 'creditPacks:create', 'creditPacks:update', 'creditPacks:delete']),
    )
  })

  // ── Dependencias implícitas (PERMISSION_DEPENDENCIES no se exporta; el efecto observable es resolvePermissions) ──
  it('creditPacks:sell arrastra leer el catálogo de paquetes y al cliente', () => {
    expect([...resolvePermissions(['creditPacks:sell'])]).toEqual(
      expect.arrayContaining(['creditPacks:sell', 'creditPacks:read', 'customers:read']),
    )
  })

  it('creditPacks:redeem arrastra leer el catálogo de paquetes y al cliente', () => {
    expect([...resolvePermissions(['creditPacks:redeem'])]).toEqual(
      expect.arrayContaining(['creditPacks:redeem', 'creditPacks:read', 'customers:read']),
    )
  })

  // ── Puentes: nadie que YA podía hacerlo lo pierde al mover la ruta al permiso nuevo ──
  it('quien tiene creditPacks:create sigue pudiendo VENDER (puente, no rename a ciegas)', () => {
    expect([...resolvePermissions(['creditPacks:create'])]).toContain('creditPacks:sell')
  })

  it('quien tiene creditPacks:update sigue pudiendo CANJEAR (puente)', () => {
    expect([...resolvePermissions(['creditPacks:update'])]).toContain('creditPacks:redeem')
  })

  // ── Lo que el mostrador SÍ puede ──
  it.each(MOSTRADOR)('%s puede leer los paquetes del venue (la tarjeta de créditos deja de mentir)', role => {
    expect(hasPermission(role, null, 'creditPacks:read')).toBe(true)
  })

  it.each(MOSTRADOR)('%s puede VENDER un paquete', role => {
    expect(hasPermission(role, null, 'creditPacks:sell')).toBe(true)
  })

  it.each(MOSTRADOR)('%s puede CANJEAR una sesión', role => {
    expect(hasPermission(role, null, 'creditPacks:redeem')).toBe(true)
  })

  // ── 🔴 Lo que el mostrador NO puede: el catálogo ──
  it.each(MOSTRADOR)('🔴 %s NO puede editar el catálogo (precio, número de sesiones)', role => {
    expect(hasPermission(role, null, 'creditPacks:update')).toBe(false)
  })

  it.each(MOSTRADOR)('🔴 %s NO puede borrar/desactivar un paquete ni reembolsar una compra', role => {
    expect(hasPermission(role, null, 'creditPacks:delete')).toBe(false)
  })

  it.each(MOSTRADOR)('🔴 %s NO puede crear un paquete nuevo en el catálogo', role => {
    expect(hasPermission(role, null, 'creditPacks:create')).toBe(false)
  })

  // ── Arriba y abajo del mostrador ──
  it.each(JEFES)('%s puede todo lo de paquetes por el wildcard creditPacks:*', role => {
    for (const perm of ['creditPacks:read', 'creditPacks:sell', 'creditPacks:redeem', 'creditPacks:update', 'creditPacks:delete']) {
      expect(hasPermission(role, null, perm)).toBe(true)
    }
  })

  it('SUPERADMIN pasa por *:*', () => {
    expect(hasPermission(StaffRole.SUPERADMIN, null, 'creditPacks:sell')).toBe(true)
    expect(hasPermission(StaffRole.SUPERADMIN, null, 'creditPacks:redeem')).toBe(true)
  })

  it('HOST queda FUERA de paquetes — no cobra (no tiene payments:create), no vende', () => {
    expect(hasPermission(StaffRole.HOST, null, 'payments:create')).toBe(false)
    expect(hasPermission(StaffRole.HOST, null, 'creditPacks:sell')).toBe(false)
    expect(hasPermission(StaffRole.HOST, null, 'creditPacks:redeem')).toBe(false)
  })

  it('KITCHEN y VIEWER siguen fuera', () => {
    for (const role of [StaffRole.KITCHEN, StaffRole.VIEWER]) {
      expect(hasPermission(role, null, 'creditPacks:sell')).toBe(false)
      expect(hasPermission(role, null, 'creditPacks:redeem')).toBe(false)
      expect(hasPermission(role, null, 'creditPacks:read')).toBe(false)
    }
  })

  // ── Regresión: el permiso que sirvió de molde sigue intacto ──
  it('coupons:redeem —el espejo que se copió— sigue en CASHIER y WAITER', () => {
    expect(hasPermission(StaffRole.CASHIER, null, 'coupons:redeem')).toBe(true)
    expect(hasPermission(StaffRole.WAITER, null, 'coupons:redeem')).toBe(true)
  })
})
