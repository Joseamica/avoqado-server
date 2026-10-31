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
  contactar: boolean
  campanas: boolean
  exportar: boolean
  ventas: boolean
  admin: boolean
}

/** A person's seven keys, without who holds them. */
export type CrmKeys = Omit<CrmAccess, 'staffId' | 'isSuperadmin'>

/** The key columns of a `PlatformAccess` row. */
export interface CrmKeyColumns {
  verScope: string | null
  editarScope: string | null
  contactar: boolean
  campanas: boolean
  exportar: boolean
  ventas: boolean
  admin: boolean
}

/** A stored scope the code does not know counts as no key: fail closed. */
const asScope = (value: string | null): CrmScope | null => (value === 'propios' || value === 'todos' ? value : null)

/**
 * What a row really grants, like `getEffectiveRolePermissions` for venue roles: `editar`, `contactar`, `exportar` and
 * `ventas` only count on top of `ver`, so a row with `contactar` and no `ver` comes back with `contactar: false`. The
 * guard, the scope filter, the console and the «who may give which key» check all read this one answer.
 */
export function effectiveKeys(row: CrmKeyColumns): CrmKeys {
  const ver = asScope(row.verScope)
  return {
    ver,
    editar: ver ? asScope(row.editarScope) : null,
    contactar: !!ver && row.contactar,
    campanas: row.campanas,
    exportar: !!ver && row.exportar,
    ventas: !!ver && row.ventas,
    admin: row.admin,
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
      contactar: true,
      campanas: true,
      exportar: true,
      ventas: true,
      admin: true,
    }
  }

  const row = await prisma.platformAccess.findUnique({
    // PlatformAccess.email is always stored lowercase; Staff.email may carry the capitals the person typed.
    where: { email: staff.email.toLowerCase(), active: true },
    select: {
      id: true,
      staffId: true,
      verScope: true,
      editarScope: true,
      contactar: true,
      campanas: true,
      exportar: true,
      ventas: true,
      admin: true,
    },
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
    // person's first two requests race.
    const { count } = await prisma.platformAccess.updateMany({
      where: { id: row.id, active: true, OR: [{ staffId: null }, { staffId }] },
      data: { staffId },
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

/** Whether `access` holds `key`. `access` already carries the dependency rule (see `getCrmAccess`). */
export function hasCrmKey(access: CrmAccess, key: CrmKey): boolean {
  switch (key) {
    case 'crm:ver':
      return access.ver !== null
    case 'crm:editar':
      return access.editar !== null
    case 'crm:contactar':
      return access.contactar
    case 'crm:campanas':
      return access.campanas
    case 'crm:exportar':
      return access.exportar
    case 'crm:ventas':
      return access.ventas
    case 'crm:admin':
      return access.admin
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
