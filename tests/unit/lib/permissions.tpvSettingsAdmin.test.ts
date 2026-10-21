import { StaffRole } from '@prisma/client'
import { DEFAULT_PERMISSIONS, hasPermission, INDIVIDUAL_PERMISSIONS_BY_RESOURCE, PERMISSION_DEPENDENCIES } from '@/lib/permissions'

/**
 * 🔴 Decisión del founder (15-oct-2026): el ADMINISTRADOR ve y edita los ajustes de CADA aparato
 * (`tpv-settings:read` / `tpv-settings:update`): los pasos del cobro (propina, estrellas, recibo) en la página
 * del dispositivo, la pestaña de configuración de la terminal y los ajustes que el POS cambia de su propia ficha.
 *
 * Antes era al revés de la jerarquía: el GERENTE sí podía (le llegaba por la dependencia de `scale:configure`) y
 * el ADMINISTRADOR no. El comentario que lo justificaba («OWNER only - org-level TPV config») estaba viejo: estas
 * rutas son de UNA terminal amarrada a su venue; la configuración de la organización va por otras puertas (dueño
 * de la organización), y el ADMIN ya podía cambiar los ajustes de TODAS las terminales del venue con
 * `venues:update` (PUT /venues/:venueId/settings/tpv).
 */
describe('ADMIN y los ajustes de cada aparato (tpv-settings)', () => {
  it.each(['tpv-settings:read', 'tpv-settings:update'])('🔴 el ADMIN trae %s de fábrica', permiso => {
    expect(DEFAULT_PERMISSIONS[StaffRole.ADMIN]).toContain(permiso)
    expect(hasPermission(StaffRole.ADMIN, null, permiso)).toBe(true)
  })

  it('un venue que personalizó al ADMIN también lo recibe (sus permisos se SUMAN a los de fábrica)', () => {
    expect(hasPermission(StaffRole.ADMIN, ['cfdi:view'], 'tpv-settings:update')).toBe(true)
  })

  it('el venue puede QUITÁRSELO: lo que se excluye no regresa por otro lado', () => {
    expect(hasPermission(StaffRole.ADMIN, null, 'tpv-settings:update', ['tpv-settings:update'])).toBe(false)
  })

  it('el borrado de fábrica sigue siendo SÓLO del dueño (destructivo)', () => {
    expect(hasPermission(StaffRole.ADMIN, null, 'tpv-factory-reset:execute')).toBe(false)
    expect(hasPermission(StaffRole.OWNER, null, 'tpv-factory-reset:execute')).toBe(true)
  })

  it('regresión: gerente y dueño lo siguen teniendo; los roles de piso no', () => {
    expect(hasPermission(StaffRole.MANAGER, null, 'tpv-settings:update')).toBe(true)
    expect(hasPermission(StaffRole.OWNER, null, 'tpv-settings:update')).toBe(true)
    for (const rol of [StaffRole.CASHIER, StaffRole.WAITER, StaffRole.KITCHEN, StaffRole.HOST, StaffRole.VIEWER]) {
      expect(hasPermission(rol, null, 'tpv-settings:read')).toBe(false)
    }
  })
})

/**
 * 🔴 «Quitar un permiso sólo puede quitar» — para TODO el catálogo, no sólo para el caso que lo destapó.
 *
 * Al excluir algo de un recurso con comodín (`scale:*`), el comodín se abre y las dependencias de cada acción se
 * vuelven a resolver. Si una de esas dependencias es un permiso que el rol NO tenía, la exclusión lo HABILITA. Así
 * pasaba hasta el 15-oct: un ADMIN al que el negocio le quitaba `scale:use` (o una acción de `area-tickets`) ganaba
 * `tpv-settings:*` en `checkPermission`, que sólo hace la lectura con exclusiones. El PIN de gerente ya exigía las
 * dos lecturas; esta prueba cuida que el catálogo no vuelva a tener un camino así para ningún rol.
 */
describe('invariante: excluir un permiso nunca habilita otro', () => {
  const roles = (Object.values(StaffRole) as StaffRole[]).filter(r => r !== StaffRole.SUPERADMIN)
  const catalogo = Array.from(
    new Set([
      ...Object.keys(PERMISSION_DEPENDENCIES),
      ...Object.values(PERMISSION_DEPENDENCIES).flat(),
      ...Object.values(INDIVIDUAL_PERMISSIONS_BY_RESOURCE).flat(),
    ]),
  ).filter(p => !p.includes('*'))

  it.each(roles)('%s: ninguna exclusión le da algo que sin ella no tenía', rol => {
    const noTiene = catalogo.filter(p => !hasPermission(rol, null, p))
    // Excluir algo que el rol no tiene no cambia nada; sólo se prueban las exclusiones que muerden.
    const loQueTiene = catalogo.filter(p => hasPermission(rol, null, p))
    const habilitados: string[] = []
    for (const excluido of loQueTiene) {
      for (const permiso of noTiene) {
        if (hasPermission(rol, null, permiso, [excluido])) habilitados.push(`excluir ${excluido} ⇒ ${permiso}`)
      }
    }
    expect(habilitados).toEqual([])
  })
})
