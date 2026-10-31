/**
 * Who may do what in the CRM — read from the database on every call, never from the token (spec 2026-10-30 §5.1).
 *
 * The token lives 24 h with whatever was true when it was issued; a key taken away has to stop working on the next
 * request, exactly like `rolVigente` does for venue roles. So `requireCrm` calls `getCrmAccess` on every request and
 * nothing here is cached.
 */
import { Prisma } from '@prisma/client'
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

/** A stored scope the code does not know counts as no key: fail closed. */
const asScope = (value: string | null): CrmScope | null => (value === 'propios' || value === 'todos' ? value : null)

/**
 * The person's EFFECTIVE keys, or null when they have no CRM access at all (inactive or unknown person, no active row).
 *
 * Effective, like `getEffectiveRolePermissions` for venue roles: `editar`, `contactar`, `exportar` and `ventas` only
 * count on top of `ver`, so a row with `contactar` and no `ver` comes back with `contactar: false`. The guard, the
 * scope filter and the console then read one answer and cannot disagree.
 */
export async function getCrmAccess(staffId: string): Promise<CrmAccess | null> {
  const staff = await prisma.staff.findUnique({ where: { id: staffId }, select: { email: true, active: true } })
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
    select: { verScope: true, editarScope: true, contactar: true, campanas: true, exportar: true, ventas: true, admin: true },
  })
  if (!row) return null

  const ver = asScope(row.verScope)
  return {
    staffId,
    isSuperadmin: false,
    ver,
    editar: ver ? asScope(row.editarScope) : null,
    contactar: !!ver && row.contactar,
    campanas: row.campanas,
    exportar: !!ver && row.exportar,
    ventas: !!ver && row.ventas,
    admin: row.admin,
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
