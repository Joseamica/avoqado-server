/**
 * Quitarle un permiso a un rol NUNCA puede DARLE otro.
 *
 * ── El defecto (auditoría de Codex, 14-oct-2026, hallazgo 3) ───────────────────────
 *
 * Para que una exclusión muerda contra un comodín, `getEffectiveRolePermissions` ABRE el
 * comodín del recurso tocado (`scale:*` → `scale:use`, `scale:configure`, …) y vuelve a
 * resolver dependencias. El comodín compacto nunca arrastraba dependencias; sus piezas
 * sueltas sí. Resultado medido:
 *
 *   VIEWER + permissions=["scale:*"]                         → tpv-settings:update = false
 *   VIEWER + permissions=["scale:*"] + denied=["scale:use"]  → tpv-settings:update = TRUE
 *
 * (`scale:configure` implica `tpv-settings:update`.) Igual con `area-tickets:*` al excluir
 * `area-tickets:issue`. Y el editor de roles del dashboard manda como «excluidos» los
 * comodines de fábrica del rol, así que cualquier guardado del editor abría esa puerta.
 *
 * ── La regla ───────────────────────────────────────────────────────────────────────
 *
 * Lo efectivo CON exclusiones es un SUBCONJUNTO de lo que la base concede SIN ellas,
 * medido con la misma regla de comodines con la que se autoriza (`permissionListGrants`,
 * la de `hasPermission`). La decisión del founder del 18-ago sigue en pie: lo implicado por
 * un permiso que el rol CONSERVA vuelve — pero sólo si la base ya lo concedía.
 *
 * ── Por qué SUPERADMIN queda fuera del invariante ──────────────────────────────────
 *
 * Su resolución devuelve SIEMPRE `['*:*']` e ignora personalizaciones y exclusiones
 * (anti-lockout): el invariante se cumple por construcción y recorrerlo no prueba nada.
 * Abajo queda fijado con una aserción directa.
 */
import { StaffRole } from '@prisma/client'
import {
  INDIVIDUAL_PERMISSIONS_BY_RESOURCE,
  getAllValidPermissions,
  getEffectiveRolePermissions,
  hasPermission,
  permissionListGrants,
} from '@/lib/permissions'

/** El catálogo COMPLETO, sin comodines: incluye lo que sólo vive en los defaults (p. ej. `attendance:org-manage`). */
const CATALOGO = getAllValidPermissions().filter(p => !p.includes('*'))
const ROLES = Object.values(StaffRole).filter(r => r !== StaffRole.SUPERADMIN)
const RECURSOS = Object.keys(INDIVIDUAL_PERMISSIONS_BY_RESOURCE)

/** Qué permisos del catálogo concede una lista ya resuelta, con la vara de `hasPermission`. */
function concedidos(lista: string[]): Set<string> {
  const conjunto = new Set(lista)
  return new Set(CATALOGO.filter(p => permissionListGrants(conjunto, p)))
}

/** Lo que una exclusión concede de MÁS respecto de la base sin exclusiones (debe ser siempre vacío). */
function concedeDeMas(rol: StaffRole, base: string[] | null, excluidos: string[], concedeLaBase: Set<string>): string[] {
  return [...concedidos(getEffectiveRolePermissions(rol, base, excluidos))].filter(p => !concedeLaBase.has(p))
}

/** PRNG determinista (mulberry32): la muestra de combinaciones es la misma en cada corrida. */
function generador(semilla: number): () => number {
  let a = semilla >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('quitar un permiso nunca concede otro — los casos de la auditoría (roles personalizados)', () => {
  it('🔴 VIEWER + scale:* : excluir scale:use NO le da tpv-settings:update', () => {
    expect(hasPermission(StaffRole.VIEWER, ['scale:*'], 'tpv-settings:update')).toBe(false)
    expect(hasPermission(StaffRole.VIEWER, ['scale:*'], 'tpv-settings:update', ['scale:use'])).toBe(false)
  })

  it('🔴 VIEWER + area-tickets:* : excluir area-tickets:issue NO le da tpv-settings:update', () => {
    expect(hasPermission(StaffRole.VIEWER, ['area-tickets:*'], 'tpv-settings:update')).toBe(false)
    expect(hasPermission(StaffRole.VIEWER, ['area-tickets:*'], 'tpv-settings:update', ['area-tickets:issue'])).toBe(false)
  })

  it('…y la exclusión sí sigue mordiendo: scale:configure se va, el resto de scale se queda', () => {
    expect(hasPermission(StaffRole.VIEWER, ['scale:*'], 'scale:configure', ['scale:configure'])).toBe(false)
    expect(hasPermission(StaffRole.VIEWER, ['scale:*'], 'scale:use', ['scale:configure'])).toBe(true)
    expect(hasPermission(StaffRole.VIEWER, ['scale:*'], 'tpv-settings:update', ['scale:configure'])).toBe(false)
  })

  it('…y excluir scale:use no lo quita mientras el rol conserve scale:configure, que lo implica (18-ago)', () => {
    // La base (`scale:*`) ya concedía `scale:use`; `scale:configure` lo implica, así que vuelve.
    expect(hasPermission(StaffRole.VIEWER, ['scale:*'], 'scale:use', ['scale:use'])).toBe(true)
  })

  it('🔴 el editor de roles manda los COMODINES de fábrica como «excluidos»: eso tampoco concede nada', () => {
    // `PermissionEditorModal` calcula `deniedToSave` contra los defaults SIN expandir, así que un
    // ADMIN guardado desde la pantalla trae `scale:*`, `area-tickets:*`, … en `deniedPermissions`.
    for (const rol of ROLES) {
      const comodines = getEffectiveRolePermissions(rol, null).filter(p => p.endsWith(':*'))
      if (comodines.length === 0) continue
      const base = concedidos(getEffectiveRolePermissions(rol, null))
      expect({ rol, deMas: concedeDeMas(rol, null, comodines, base) }).toEqual({ rol, deMas: [] })
    }
  })

  it('una exclusión de algo que el rol no tiene no cambia NADA de lo que concede', () => {
    // Guardia, no reproducción (pasaba también antes del arreglo con los defaults de hoy):
    // CUALQUIER exclusión dispara una segunda vuelta de dependencias —las de las
    // dependencias— que la base sin exclusiones nunca resuelve. Si mañana una dependencia
    // tiene a su vez dependencias, esto es lo que la delataría.
    for (const rol of ROLES) {
      const base = concedidos(getEffectiveRolePermissions(rol, null))
      const fantasma = CATALOGO.find(p => !base.has(p))
      if (!fantasma) continue
      expect({ rol, concede: [...concedidos(getEffectiveRolePermissions(rol, null, [fantasma]))].sort() }).toEqual({
        rol,
        concede: [...base].sort(),
      })
    }
  })
})

describe('la decisión del founder del 18-ago sigue en pie', () => {
  it('lo implicado por un permiso que el rol CONSERVA vuelve, porque la base ya lo concedía', () => {
    // `tpv-payments:pay-later` implica `orders:create`.
    expect(hasPermission(StaffRole.WAITER, null, 'orders:create')).toBe(true)
    expect(hasPermission(StaffRole.WAITER, null, 'orders:create', ['orders:create'])).toBe(true)
  })

  it('…y si se quitan los dos, entonces sí se va', () => {
    expect(hasPermission(StaffRole.WAITER, null, 'orders:create', ['orders:create', 'tpv-payments:pay-later'])).toBe(false)
  })

  it('a SUPERADMIN ninguna exclusión le toca nada (por eso queda fuera del invariante)', () => {
    for (const excluido of ['orders:create', 'tpv-factory-reset:execute', 'system:manage']) {
      expect(getEffectiveRolePermissions(StaffRole.SUPERADMIN, ['scale:*'], [excluido])).toEqual(['*:*'])
    }
  })
})

describe('🔴 invariante permanente: con exclusiones ⊆ sin exclusiones, sobre TODO el catálogo', () => {
  it('el catálogo del invariante incluye lo que sólo vive en los defaults', () => {
    expect(CATALOGO).toContain('attendance:org-manage')
    expect(CATALOGO).toContain('tpv-factory-reset:execute')
    expect(CATALOGO.some(p => p.includes('*'))).toBe(false)
  })

  it('la vara del invariante es la de hasPermission (no una copia)', () => {
    const azar = generador(20261015)
    for (let i = 0; i < 300; i++) {
      const rol = ROLES[Math.floor(azar() * ROLES.length)]
      const recurso = RECURSOS[Math.floor(azar() * RECURSOS.length)]
      const excluido = CATALOGO[Math.floor(azar() * CATALOGO.length)]
      const pedido = CATALOGO[Math.floor(azar() * CATALOGO.length)]
      const efectivos = getEffectiveRolePermissions(rol, [`${recurso}:*`], [excluido])
      expect(hasPermission(rol, [`${recurso}:*`], pedido, [excluido])).toBe(permissionListGrants(efectivos, pedido))
    }
  })

  it.each(ROLES)('%s con sus defaults: ninguna exclusión de UN permiso del catálogo concede algo nuevo', rol => {
    const base = concedidos(getEffectiveRolePermissions(rol, null))
    const violaciones: string[] = []
    for (const excluido of CATALOGO) {
      for (const p of concedeDeMas(rol, null, [excluido], base)) violaciones.push(`excluir ${excluido} ⇒ concede ${p}`)
    }
    expect(violaciones).toEqual([])
  })

  /**
   * Rol personalizado `['<recurso>:*']` (se SUMA a los defaults: los roles de negocio no tienen
   * `*:*`). Respecto de los defaults, lo único que cambia es ese comodín, y una exclusión sólo lo
   * abre si toca su recurso — ahí vivía el defecto. Por eso se recorren las exclusiones de ESE
   * recurso, más una «fantasma» (algo que la base no concede) que dispara la segunda vuelta de
   * dependencias. Las exclusiones de los demás recursos ya las cubre el caso de los defaults:
   * el producto cruzado completo (8 roles × 76 recursos × 259 exclusiones × 259 permisos,
   * medido el 15-oct) tarda ~30 s, contra ~0.5 s de esta selección, sin cubrir un camino más.
   */
  it.each(ROLES)('%s con un rol personalizado de un comodín por recurso: excluir dentro del recurso no concede nada nuevo', rol => {
    const violaciones: string[] = []
    for (const recurso of RECURSOS) {
      const personalizado = [`${recurso}:*`]
      const base = concedidos(getEffectiveRolePermissions(rol, personalizado))
      const fantasma = CATALOGO.find(p => !base.has(p))
      const exclusiones = [...INDIVIDUAL_PERMISSIONS_BY_RESOURCE[recurso], ...(fantasma ? [fantasma] : [])]
      for (const excluido of exclusiones) {
        for (const p of concedeDeMas(rol, personalizado, [excluido], base)) {
          violaciones.push(`[${recurso}:*] excluir ${excluido} ⇒ concede ${p}`)
        }
      }
    }
    expect(violaciones).toEqual([])
  })

  it.each(ROLES)('%s: combinaciones de 2 y 3 exclusiones (muestra fija) tampoco conceden nada nuevo', rol => {
    const azar = generador(rol.length * 7919)
    const violaciones: string[] = []
    for (let i = 0; i < 150; i++) {
      const recurso = RECURSOS[Math.floor(azar() * RECURSOS.length)]
      const personalizado = azar() < 0.5 ? null : [`${recurso}:*`]
      const base = concedidos(getEffectiveRolePermissions(rol, personalizado))
      const candidatas = [...base, ...INDIVIDUAL_PERMISSIONS_BY_RESOURCE[recurso]]
      const excluidos = Array.from({ length: 2 + Math.floor(azar() * 2) }, () => candidatas[Math.floor(azar() * candidatas.length)])
      for (const p of concedeDeMas(rol, personalizado, excluidos, base)) {
        violaciones.push(`${JSON.stringify(personalizado)} excluir ${excluidos.join('+')} ⇒ concede ${p}`)
      }
    }
    expect(violaciones).toEqual([])
  })
})
