/**
 * Quitar un permiso nunca concede otro — también en `getUserAccess` y en el guard del MCP.
 *
 * ── El defecto (auditoría de Codex de la rama, 15-oct-2026, P1-3) ─────────────────────
 *
 * `getEffectiveRolePermissions` ya recortaba lo que sobrevive a las exclusiones a lo que la base
 * concedía (commit 617bf0250). Pero `getUserAccess` le volvía a pasar `resolvePermissions` a ESE
 * resultado, y la segunda vuelta de dependencias devolvía lo que el recorte había quitado:
 *
 *   VIEWER + permissions=["orders:*"]                            → inventory:read = false
 *   VIEWER + permissions=["orders:*"] + denied=["orders:print"]  → inventory:read = TRUE
 *
 * `getUserAccess` alimenta al dashboard (`can()`), a las apps y a la autorización del MCP
 * (`createGuard(...).requirePermission`), incluida la lectura de inventario y costos.
 *
 * ── La regla ──────────────────────────────────────────────────────────────────────────
 *
 * La lista de `getUserAccess` es EXACTAMENTE la que usa `checkPermission` para autorizar
 * (`resolveStaffVenuePermissions`): una sola regla, sin volver a expandir. Para los roles por
 * defecto sin personalizar, lo que concede es IDÉNTICO a lo de antes (prueba de regresión abajo).
 */
import { StaffRole } from '@prisma/client'

import { prismaMock } from '@tests/__helpers__/setup'

jest.mock('@/services/access/feature-metadata.service', () => ({
  getFeatureMetadataForVenue: jest.fn(async () => ({})),
}))

import { getUserAccess, hasPermission as accesoConcede, type UserAccess } from '@/services/access/access.service'
import { createGuard } from '@/mcp/guard'
import {
  INDIVIDUAL_PERMISSIONS_BY_RESOURCE,
  getAllValidPermissions,
  getEffectiveRolePermissions,
  permissionListGrants,
  resolvePermissions,
} from '@/lib/permissions'
import { resolveStaffVenuePermissions } from '@/lib/resolveEffectivePermissions'

const USUARIO = 'staff-1'
const VENUE = 'venue-1'
const ORG = 'org-1'
const CATALOGO = getAllValidPermissions().filter(p => !p.includes('*'))
const ROLES = Object.values(StaffRole).filter(r => r !== StaffRole.SUPERADMIN)
const RECURSOS = Object.keys(INDIVIDUAL_PERMISSIONS_BY_RESOURCE)

/** Lo que el venue personalizó para el rol de la persona (`VenueRolePermission`). */
let personalizacion: { permissions: string[]; deniedPermissions: string[] } | null = null
let rolEnLaSucursal: StaffRole = StaffRole.VIEWER
let conjuntoDePermisos: string[] | null = null

beforeEach(() => {
  personalizacion = null
  conjuntoDePermisos = null
  prismaMock.staffVenue.findFirst.mockResolvedValue(null) // no es superadmin
  prismaMock.staffVenue.findUnique.mockImplementation((() =>
    Promise.resolve({
      role: rolEnLaSucursal,
      active: true,
      permissionSetId: conjuntoDePermisos ? 'ps-1' : null,
      permissionSet: conjuntoDePermisos ? { id: 'ps-1', permissions: conjuntoDePermisos } : null,
      venue: { organizationId: ORG },
    })) as any)
  prismaMock.venue.findUnique.mockResolvedValue({ organizationId: ORG } as any)
  prismaMock.venueModule.findFirst.mockResolvedValue(null) // sin white-label: la lista no se filtra
  prismaMock.organizationModule.findFirst.mockResolvedValue(null)
  prismaMock.venueRolePermission.findMany.mockImplementation((() =>
    Promise.resolve(personalizacion ? [{ role: rolEnLaSucursal, ...personalizacion }] : [])) as any)
  prismaMock.staffOrganization.findMany.mockResolvedValue([])
  prismaMock.staff.findUnique.mockResolvedValue({ active: true } as any)
})

async function acceso(rol: StaffRole, permissions: string[] | null, deniedPermissions: string[] | null): Promise<UserAccess> {
  rolEnLaSucursal = rol
  personalizacion = permissions || deniedPermissions ? { permissions: permissions ?? [], deniedPermissions: deniedPermissions ?? [] } : null
  return getUserAccess(USUARIO, VENUE)
}

function guardDelMcp(access: UserAccess) {
  return createGuard({
    staffId: USUARIO,
    activeOrg: ORG,
    allowedVenueIds: [VENUE],
    perVenueAccess: new Map([[VENUE, access]]),
    scopes: ['mcp:read', 'mcp:write'],
  })
}

/** Lo que una lista con exclusiones concede de MÁS respecto de la misma sin exclusiones (debe ser vacío). */
function concedeDeMas(conExclusiones: UserAccess, sinExclusiones: UserAccess): string[] {
  return conExclusiones.corePermissions.filter(p => !accesoConcede(sinExclusiones, p))
}

describe('el caso de Codex: VIEWER + orders:*, excluyendo orders:print', () => {
  it('🔴 getUserAccess NO devuelve inventory:read (sin la exclusión tampoco lo tenía)', async () => {
    const sin = await acceso(StaffRole.VIEWER, ['orders:*'], null)
    const con = await acceso(StaffRole.VIEWER, ['orders:*'], ['orders:print'])

    expect(accesoConcede(sin, 'inventory:read')).toBe(false)
    expect(accesoConcede(con, 'inventory:read')).toBe(false)
    expect(concedeDeMas(con, sin)).toEqual([])
  })

  it('🔴 el guard del MCP niega inventory:read (requirePermission lanza, tienePermiso dice que no)', async () => {
    const con = await acceso(StaffRole.VIEWER, ['orders:*'], ['orders:print'])
    const guard = guardDelMcp(con)

    expect(guard.tienePermiso('inventory:read', VENUE)).toBe(false)
    expect(() => guard.requirePermission('inventory:read', VENUE)).toThrow(/Missing permission inventory:read/)
    // …y la exclusión sí muerde: lo que conserva sigue pasando, lo excluido no.
    expect(guard.tienePermiso('orders:read', VENUE)).toBe(true)
    expect(guard.tienePermiso('orders:print', VENUE)).toBe(false)
  })
})

describe('una sola regla: la lista de getUserAccess ES la que usa checkPermission', () => {
  it.each(ROLES)('%s, defaults, con una base de comodín y con exclusiones', async rol => {
    const casos: Array<[string[] | null, string[] | null]> = [
      [null, null],
      [['orders:*'], ['orders:print']],
      [['area-tickets:*'], ['area-tickets:issue']],
      [['scale:*'], ['scale:use']],
      [['area-tickets:cancel'], null], // personalizado SIN exclusiones: tampoco hay segunda vuelta
    ]
    for (const [permissions, denied] of casos) {
      const access = await acceso(rol, permissions, denied)
      const loQueAutorizaCheckPermission = resolveStaffVenuePermissions(
        { role: rol },
        permissions || denied ? { permissions, deniedPermissions: denied } : null,
      )
      expect([...access.corePermissions].sort()).toEqual([...loQueAutorizaCheckPermission].sort())
    }
  })

  it('con un Conjunto de Permisos asignado, mandan sus permisos resueltos una vez (como antes)', async () => {
    conjuntoDePermisos = ['orders:read', 'orders:create']
    const access = await acceso(StaffRole.CASHIER, null, null)

    expect([...access.corePermissions].sort()).toEqual(Array.from(resolvePermissions(conjuntoDePermisos)).sort())
  })
})

describe('invariante: quitar nunca concede, en getUserAccess y en el guard del MCP', () => {
  it.each(ROLES)('%s con los defaults: ninguna exclusión del catálogo concede algo nuevo', async rol => {
    const sin = await acceso(rol, null, null)
    const violaciones: string[] = []
    for (const excluido of CATALOGO) {
      const con = await acceso(rol, null, [excluido])
      const guardSin = guardDelMcp(sin)
      const guardCon = guardDelMcp(con)
      for (const p of concedeDeMas(con, sin)) violaciones.push(`${excluido} → ${p}`)
      for (const p of con.corePermissions)
        if (guardCon.tienePermiso(p, VENUE) && !guardSin.tienePermiso(p, VENUE)) violaciones.push(`mcp ${excluido} → ${p}`)
    }
    expect(violaciones).toEqual([])
  })

  it.each(ROLES)('%s con un comodín personalizado por recurso: excluir una de sus piezas no concede nada nuevo', async rol => {
    const violaciones: string[] = []
    for (const recurso of RECURSOS) {
      const base = [`${recurso}:*`]
      const sin = await acceso(rol, base, null)
      for (const excluido of INDIVIDUAL_PERMISSIONS_BY_RESOURCE[recurso]) {
        const con = await acceso(rol, base, [excluido])
        for (const p of concedeDeMas(con, sin)) violaciones.push(`${recurso}:* − ${excluido} → ${p}`)
      }
    }
    expect(violaciones).toEqual([])
  })
})

describe('regresión: roles por defecto SIN exclusiones conceden lo mismo que antes', () => {
  /**
   * «Antes» = la fórmula vieja de getUserAccess: `resolvePermissions(getEffectiveRolePermissions(...))`,
   * o sea dos vueltas de dependencias. Para los defaults sólo difería en una cadena redundante
   * (`features:write` en ADMIN y OWNER, que ya la conceden por su `features:*`).
   */
  it.each(ROLES)('%s: mismo veredicto para cada permiso del catálogo, y la lista sólo pierde cadenas redundantes', async rol => {
    const ahora = await acceso(rol, null, null)
    const antes: UserAccess = { ...ahora, corePermissions: Array.from(resolvePermissions(getEffectiveRolePermissions(rol, null, null))) }

    const distintos = CATALOGO.filter(p => accesoConcede(ahora, p) !== accesoConcede(antes, p))
    expect(distintos).toEqual([])

    const perdidas = antes.corePermissions.filter(p => !ahora.corePermissions.includes(p))
    expect(perdidas.filter(p => !permissionListGrants(ahora.corePermissions, p))).toEqual([])
    expect(ahora.corePermissions.filter(p => !antes.corePermissions.includes(p))).toEqual([])
  })
})
