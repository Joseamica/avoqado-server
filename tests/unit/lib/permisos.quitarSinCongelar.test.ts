/**
 * Quitarle un permiso a un rol desde el dashboard — y que siga llegando lo nuevo.
 *
 * ── El problema ───────────────────────────────────────────────────────────────────
 *
 * `VenueRolePermission.permissions` estaba haciendo dos trabajos incompatibles a la vez:
 *
 *   · "lo EXTRA que este venue da"  → aditivo. Permite que, cuando la plataforma le suma
 *     permisos nuevos a un rol, los venues que ya habían personalizado también los
 *     reciban. Eso lo defiende un test vivo desde `a3625d37`
 *     ("keeps new OWNER defaults when a venue has an older custom permission list").
 *   · "TODO lo que el rol tiene"   → reemplazo. Permite QUITAR, pero congela al venue en
 *     la lista del día que la guardó.
 *
 * El dashboard promete lo segundo (manda el set completo de casillas), el backend hacía
 * lo primero, y por eso QUITAR un permiso nunca surtía efecto — sólo agregar. Lo destapó
 * la auditoría con Codex del 2026-08-18.
 *
 * ── La solución ───────────────────────────────────────────────────────────────────
 *
 * Un campo aparte, `deniedPermissions`. Cada campo hace UN trabajo y los dos funcionan.
 *
 * ── La regla, y el porqué del orden ───────────────────────────────────────────────
 *
 *   efectivos = resolver( resolver(base) − excluidos )
 *
 * Se resuelve, se resta, y se vuelve a resolver. Ese último paso es la decisión del
 * founder (2026-08-18): si un permiso que el rol CONSERVA implica al excluido, el
 * excluido VUELVE — porque sin él el otro no funciona. No se quita por separado, pero el
 * dashboard lo muestra como "viene incluido en X" en vez de fingir que se quitó.
 *
 * Resolver ANTES de restar también es lo que hace que funcione contra comodines: un
 * `orders:*` en los defaults se expande primero, así que excluir `orders:create` muerde.
 */

import { StaffRole } from '@prisma/client'
import { getEffectiveRolePermissions, hasPermission } from '@/lib/permissions'

describe('quitar un permiso desde el dashboard', () => {
  it('🔴 quitar un permiso SUELTO sí lo quita', () => {
    const conEl = getEffectiveRolePermissions(StaffRole.WAITER, null)
    expect(conEl).toContain('area-tickets:issue')

    const sinEl = getEffectiveRolePermissions(StaffRole.WAITER, null, ['area-tickets:issue'])
    expect(sinEl).not.toContain('area-tickets:issue')
    expect(hasPermission(StaffRole.WAITER, null, 'area-tickets:issue', ['area-tickets:issue'])).toBe(false)
  })

  it('quitar NO desarma el resto del rol', () => {
    const completo = getEffectiveRolePermissions(StaffRole.WAITER, null)
    const recortado = getEffectiveRolePermissions(StaffRole.WAITER, null, ['area-tickets:issue'])
    // Exactamente uno de menos, no una lista distinta.
    expect(recortado.length).toBe(completo.length - 1)
  })

  it('🔴 lo que viene INCLUIDO en otro que el rol conserva, vuelve (decisión del founder)', () => {
    // `tpv-payments:pay-later` implica `orders:create`: sin poder crear la orden no se
    // puede cobrar después. Excluirlo a mano no lo quita — y el dashboard debe mostrarlo
    // como incluido, no fingir que se fue.
    const r = getEffectiveRolePermissions(StaffRole.WAITER, null, ['orders:create'])
    expect(r).toContain('tpv-payments:pay-later')
    expect(r).toContain('orders:create')
  })

  it('…pero si TAMBIÉN se quita el que lo implica, entonces sí se va', () => {
    const r = getEffectiveRolePermissions(StaffRole.WAITER, null, ['orders:create', 'tpv-payments:pay-later'])
    expect(r).not.toContain('tpv-payments:pay-later')
    expect(r).not.toContain('orders:create')
  })

  it('🔴 muerde contra un COMODÍN — el caso que un test flojo tapaba', () => {
    // ADMIN no tiene `orders:print` en su lista: tiene `orders:*`. Si la exclusión sólo
    // restara la cadena exacta, quitaría algo que nunca estuvo, el comodín sobreviviría y
    // `hasPermission` lo concedería igual: un placebo. Se afirma sobre `hasPermission`,
    // que es lo que de verdad decide, y no sobre si una cadena está en un arreglo.
    expect(getEffectiveRolePermissions(StaffRole.ADMIN, null)).toContain('orders:*')
    expect(hasPermission(StaffRole.ADMIN, null, 'orders:print')).toBe(true)

    expect(hasPermission(StaffRole.ADMIN, null, 'orders:print', ['orders:print'])).toBe(false)
    // Y el resto del recurso NO se cae con él.
    expect(hasPermission(StaffRole.ADMIN, null, 'orders:read', ['orders:print'])).toBe(true)
  })

  it('un comodín que NINGUNA exclusión toca se queda compacto (sigue recibiendo lo nuevo)', () => {
    // `scale:*` intacto debe seguir concediendo lo que la plataforma agregue mañana bajo
    // `scale:`. Sólo el recurso recortado pierde esa propiedad, y eso es inevitable.
    const r = getEffectiveRolePermissions(StaffRole.ADMIN, null, ['orders:print'])
    expect(r).toContain('scale:*')
    expect(r).not.toContain('orders:*')
  })
})

describe('lo que NO se debe romper', () => {
  it('sin exclusiones, el resultado es idéntico al de siempre', () => {
    for (const rol of [StaffRole.WAITER, StaffRole.CASHIER, StaffRole.MANAGER, StaffRole.ADMIN, StaffRole.OWNER]) {
      expect(getEffectiveRolePermissions(rol, null, [])).toEqual(getEffectiveRolePermissions(rol, null))
      expect(getEffectiveRolePermissions(rol, null, undefined)).toEqual(getEffectiveRolePermissions(rol, null))
    }
  })

  it('🔴 el venue con lista vieja SIGUE recibiendo los permisos nuevos (a3625d37 no se rompe)', () => {
    // Éste es el invariante que hace que el campo `permissions` deba seguir siendo
    // ADITIVO. Si algún día alguien lo convierte en "la lista completa", este test cae.
    const permisos = getEffectiveRolePermissions(StaffRole.OWNER, ['menu:read'])
    expect(permisos).toContain('menu:read')
    expect(permisos).toContain('area-tickets:*')
    expect(permisos).toContain('scale:*')
  })

  it('y lo sigue recibiendo aunque el venue tenga exclusiones de otra cosa', () => {
    const permisos = getEffectiveRolePermissions(StaffRole.OWNER, ['menu:read'], ['reviews:respond'])
    expect(permisos).toContain('area-tickets:*')
    expect(permisos).toContain('scale:*')
    expect(permisos).not.toContain('reviews:respond')
  })

  it('a SUPERADMIN no se le puede recortar (anti-lockout)', () => {
    const r = getEffectiveRolePermissions(StaffRole.SUPERADMIN, null, ['orders:create', 'payments:create'])
    expect(r).toEqual(['*:*'])
    expect(hasPermission(StaffRole.SUPERADMIN, null, 'orders:create', ['orders:create'])).toBe(true)
  })
})
