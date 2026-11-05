/**
 * Who may do what in the CRM — read from the database on every call, never from the token (spec 2026-10-30 §5.1).
 *
 * The token lives 24 h with whatever was true when it was issued; a key taken away has to stop working on the next
 * request, exactly like `rolVigente` does for venue roles. So `requireCrm` calls `getCrmAccess` on every request and
 * nothing here is cached.
 */
import { Prisma } from '@prisma/client'
import logger from '../../config/logger'
import type { CrmKey } from '../../lib/permissions'
import prisma from '../../utils/prismaClient'
import { esSuperadminReal } from '../access/rolVigente'

/** `propios` = the accounts I own plus the unowned ones (Odoo's «Personal Leads»); `todos` = every account. */
export type CrmScope = 'propios' | 'todos'

export interface CrmAccess {
  staffId: string
  isSuperadmin: boolean
  ver: CrmScope | null
  editar: CrmScope | null
  /** «Cerrar negocios»: ganar, perder y reabrir. Sólo con «Editar», y en su alcance (L1). */
  cerrar: boolean
  contactar: boolean
  exportar: boolean
  ventas: boolean
  /** «Bajas de correo». Va sola (L1). */
  bajas: boolean
  plantillas: boolean
  preparar: boolean
  mandar: boolean
  /** «Ver campañas». También la traen «Preparar campañas» y «Mandar campañas» (L1). */
  verCampanas: boolean
  equipo: boolean
  configurar: boolean
  /**
   * Espejo de L11 para la pantalla vieja: tiene las 4 de correo masivo. Sólo se lee para contestarle (`/me`, `/team`) y se
   * escribe en la columna vieja; ninguna ruta, servicio ni herramienta del MCP decide con él (lo vigilan
   * `tests/unit/architecture/crmEspejoDeLlaves.test.ts` y, para las rutas, `crm.team.routes.test.ts`).
   */
  readonly campanas: boolean
  /** Espejo de L11 para la pantalla vieja: tiene las 3 de administración Y las 4 de correo masivo. Igual: nunca autoriza nada. */
  readonly admin: boolean
}

/** A person's keys, without who holds them: las 13 que se dan, más el espejo `campanas`/`admin`. */
export type CrmKeys = Omit<CrmAccess, 'staffId' | 'isSuperadmin'>

/** The key columns of a `PlatformAccess` row. `campanas` y `admin` son el espejo para la versión vieja: no se leen aquí. */
export interface CrmKeyColumns {
  verScope: string | null
  editarScope: string | null
  contactar: boolean
  campanas: boolean
  exportar: boolean
  ventas: boolean
  admin: boolean
  plantillas: boolean
  preparar: boolean
  mandar: boolean
  verCampanas: boolean
  equipo: boolean
  configurar: boolean
  bajas: boolean
  cerrar: boolean
}

/** Las columnas de llaves que se leen de `PlatformAccess` (las 15, espejo incluido). */
export const CRM_KEY_SELECT = {
  verScope: true,
  editarScope: true,
  contactar: true,
  campanas: true,
  exportar: true,
  ventas: true,
  admin: true,
  plantillas: true,
  preparar: true,
  mandar: true,
  verCampanas: true,
  equipo: true,
  configurar: true,
  bajas: true,
  cerrar: true,
} as const satisfies Record<keyof CrmKeyColumns, true>

type LlavesSueltas = Pick<CrmKeys, 'plantillas' | 'preparar' | 'mandar' | 'verCampanas' | 'equipo' | 'configurar' | 'bajas'>

/**
 * El espejo de L11 para la versión vieja (columnas `campanas`/`admin`, y los campos del mismo nombre de `/crm/me` y
 * `/crm/team`). Falla cerrado: `campanas` sólo con las 4 de correo masivo; `admin` sólo con las 3 de administración Y las
 * 4 de correo, porque el `admin` viejo también entraba a campañas.
 */
export function legacyFlags(keys: LlavesSueltas): { campanas: boolean; admin: boolean } {
  const campanas = keys.plantillas && keys.preparar && keys.mandar && keys.verCampanas
  return { campanas, admin: campanas && keys.equipo && keys.configurar && keys.bajas }
}

/** A stored scope the code does not know counts as no key: fail closed. */
const asScope = (value: string | null): CrmScope | null => (value === 'propios' || value === 'todos' ? value : null)

/**
 * What a row really grants, like `getEffectiveRolePermissions` for venue roles (L1): `editar`, `contactar`, `exportar` and
 * `ventas` only count on top of `ver`, and `cerrar` on top of `editar`; `preparar` and `mandar` bring `verCampanas`; the rest
 * stand alone. Las columnas viejas `campanas`/`admin` no se leen: el espejo sale de las finas (sin reconciliar al leer,
 * L11). The guard, the scope filter, the console and the «who may give which key» check all read this one answer.
 */
export function effectiveKeys(row: CrmKeyColumns): CrmKeys {
  const ver = asScope(row.verScope)
  const editar = ver ? asScope(row.editarScope) : null
  const sueltas: LlavesSueltas = {
    plantillas: row.plantillas,
    preparar: row.preparar,
    mandar: row.mandar,
    verCampanas: row.verCampanas || row.preparar || row.mandar,
    equipo: row.equipo,
    configurar: row.configurar,
    bajas: row.bajas,
  }
  return {
    ver,
    editar,
    cerrar: !!editar && row.cerrar,
    contactar: !!ver && row.contactar,
    exportar: !!ver && row.exportar,
    ventas: !!ver && row.ventas,
    ...sueltas,
    ...legacyFlags(sueltas),
  }
}

/**
 * The person's EFFECTIVE keys (see `effectiveKeys`), or null when they have no CRM access at all: inactive or unknown
 * person, no active row, or a row that belongs to someone else.
 */
export async function getCrmAccess(staffId: string): Promise<CrmAccess | null> {
  const staff = await prisma.staff.findUnique({ where: { id: staffId }, select: { email: true, active: true, emailVerified: true } })
  if (!staff?.active) return null

  if (await esSuperadminReal(staffId)) {
    return {
      staffId,
      isSuperadmin: true,
      ver: 'todos',
      editar: 'todos',
      cerrar: true,
      contactar: true,
      exportar: true,
      ventas: true,
      bajas: true,
      plantillas: true,
      preparar: true,
      mandar: true,
      verCampanas: true,
      equipo: true,
      configurar: true,
      campanas: true,
      admin: true,
    }
  }

  const row = await prisma.platformAccess.findUnique({
    // PlatformAccess.email is always stored lowercase; Staff.email may carry the capitals the person typed.
    where: { email: staff.email.toLowerCase(), active: true },
    select: { id: true, staffId: true, ...CRM_KEY_SELECT },
  })
  if (!row || !(await holdsRow(row, staffId, staff.emailVerified))) return null

  return { staffId, isSuperadmin: false, ...effectiveKeys(row) }
}

/**
 * A key row belongs to ONE person (rulings 10 and 11): whoever first uses it with a VERIFIED email claims it, and from
 * then on nobody else who comes to hold that email — a recycled or changed address — gets the keys. Once claimed, every
 * request stays a single read.
 */
async function holdsRow(row: { id: string; staffId: string | null }, staffId: string, emailVerified: boolean): Promise<boolean> {
  if (row.staffId !== null) return row.staffId === staffId
  // Someone who never proved the email (a Staff created elsewhere with those letters) claims nothing.
  if (!emailVerified) return false
  try {
    // Compare-and-set: two people can never both claim the row. Matching our own id too keeps it idempotent when the same
    // person's first two requests race. `llavesVersion` sube (L11): sin eso, el disparador de la base apagaría las finas,
    // como hace con el reclamo de la versión vieja. Las dos pestañas del mismo primer acceso la suben cada una.
    const { count } = await prisma.platformAccess.updateMany({
      where: { id: row.id, active: true, OR: [{ staffId: null }, { staffId }] },
      data: { staffId, llavesVersion: { increment: 1 } },
    })
    return count === 1
  } catch (error) {
    // P2002: this person already holds an older row (the email they had before). Closed, not a 500, until an admin takes
    // that row away from the «Equipo de ventas» screen.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      logger.warn('CRM: this person already holds another key row; access denied until it is removed', {
        staffId,
        platformAccessId: row.id,
      })
      return false
    }
    throw error
  }
}

/**
 * Whether `access` holds `key`. `access` already carries the dependency rule (see `getCrmAccess`). `crm:campanas` y
 * `crm:admin` ya no los pide ninguna ruta nueva, pero nunca se quitan: «cualquiera de las 4 de correo masivo» y «las 3 de
 * administración» (Global Constraints del plan 2026-11-04).
 */
export function hasCrmKey(access: CrmAccess, key: CrmKey): boolean {
  switch (key) {
    case 'crm:ver':
      return access.ver !== null
    case 'crm:editar':
      return access.editar !== null
    case 'crm:contactar':
      return access.contactar
    case 'crm:campanas':
      return access.plantillas || access.preparar || access.mandar || access.verCampanas
    case 'crm:exportar':
      return access.exportar
    case 'crm:ventas':
      return access.ventas
    case 'crm:admin':
      return access.equipo && access.configurar && access.bajas
    case 'crm:plantillas':
      return access.plantillas
    case 'crm:preparar':
      return access.preparar
    case 'crm:mandar':
      return access.mandar
    case 'crm:ver-campanas':
      return access.verCampanas
    case 'crm:equipo':
      return access.equipo
    case 'crm:configurar':
      return access.configurar
    case 'crm:bajas':
      return access.bajas
    case 'crm:cerrar':
      return access.cerrar
  }
}

/** The accounts `access` may read (`ver`) or change (`editar`), as a filter for `CrmAccount` queries. */
export function scopeWhere(access: CrmAccess, mode: 'ver' | 'editar'): Prisma.CrmAccountWhereInput {
  const scope = access[mode]
  if (scope === 'todos') return {}
  if (scope === 'propios') return { OR: [{ ownerStaffId: access.staffId }, { ownerStaffId: null }] }
  // No key for this mode: a filter no account can match, so a route that forgot `requireCrm` still shows nothing.
  return { id: { in: [] } }
}
