/**
 * Avoqado's sales team (spec 2026-10-30 §5.1): the internal venue a seller logs into, and the «Equipo de ventas» screen
 * that gives, changes and takes away CRM keys.
 *
 * A seller is a VIEWER of ONE internal venue, «Avoqado · Equipo de ventas», only so they can log in: the token always
 * carries a venue. What they can do in the CRM is their `PlatformAccess` keys, which `requireCrm` re-reads on every
 * request. The venue lives in the organization named by `CRM_TEAM_ORGANIZATION_ID` (in production, «Grupo Avoqado
 * Prime»), never found by a client's name.
 */
import { Prisma, StaffRole, VenueStatus, VerificationStatus } from '@prisma/client'
import { ForbiddenError, InternalServerError, NotFoundError, ValidationError } from '../../errors/AppError'
import { CRM_KEY_LABELS, type CrmKey } from '../../lib/permissions'
import type { CrmKeysInput } from '../../schemas/crm.schema'
import prisma from '../../utils/prismaClient'
import { logAction } from '../dashboard/activity-log.service'
import { inviteTeamMember } from '../dashboard/team.dashboard.service'
import { effectiveKeys, getCrmAccess, type CrmAccess, type CrmKeyColumns, type CrmKeys, type CrmScope } from './access.service'
import { moveOpenAccountsTx } from './ownership'

export const CRM_TEAM_VENUE_SLUG = 'avoqado-equipo-ventas'
const CRM_TEAM_VENUE_NAME = 'Avoqado · Equipo de ventas'
const MAX_PAGE_SIZE = 100

/**
 * The internal venue, created the first time it is needed and found by its slug afterwards.
 *
 * `seatCapExempt`: without it the third seller hits the Free plan's 2-user cap. `ACTIVE` + `VERIFIED`: it never shows up
 * in the KYC review queue.
 */
export async function ensureCrmTeamVenue(): Promise<{ venueId: string }> {
  const organizationId = process.env.CRM_TEAM_ORGANIZATION_ID
  if (!organizationId) throw new InternalServerError('Falta CRM_TEAM_ORGANIZATION_ID')

  const select = { id: true, organizationId: true } as const
  let venue = await prisma.venue.findUnique({ where: { slug: CRM_TEAM_VENUE_SLUG }, select })
  if (!venue) {
    try {
      venue = await prisma.venue.create({
        data: {
          organizationId,
          name: CRM_TEAM_VENUE_NAME,
          slug: CRM_TEAM_VENUE_SLUG,
          seatCapExempt: true,
          status: VenueStatus.ACTIVE,
          kycStatus: VerificationStatus.VERIFIED,
        },
        select,
      })
    } catch (error) {
      // Two first calls at once: the slug is unique, so the one that loses reads the winner's venue.
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error
      venue = await prisma.venue.findUnique({ where: { slug: CRM_TEAM_VENUE_SLUG }, select })
      if (!venue) throw error
    }
  }
  // A venue with our slug in another organization is never used: the sellers would become VIEWERs of someone else's venue.
  if (venue.organizationId !== organizationId) {
    throw new InternalServerError(`El venue ${CRM_TEAM_VENUE_SLUG} está en otra organización: muévelo a la de CRM_TEAM_ORGANIZATION_ID`)
  }
  return { venueId: venue.id }
}

/** One row of the «Equipo de ventas» screen. `staffId` is null while the person has no Avoqado account yet. */
export interface TeamMember {
  id: string
  email: string
  staffId: string | null
  firstName: string | null
  lastName: string | null
  keys: CrmKeys
  openAccounts: number
  createdAt: Date
}

/** Active team members, newest first, a page at a time: the server caps the page at 100 and always says the total. */
export async function listTeamMembers(opts: { page?: number; pageSize?: number } = {}) {
  const pageSize = Math.min(Math.max(opts.pageSize ?? 50, 1), MAX_PAGE_SIZE)
  const page = Math.max(opts.page ?? 1, 1)
  const where = { active: true }
  const [rows, total] = await Promise.all([
    prisma.platformAccess.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.platformAccess.count({ where }),
  ])

  // Names and open accounts for THIS page in two queries, never one per member. A claimed row shows the person who
  // claimed it; an unclaimed one, whoever holds the email today (the one who will claim it).
  const claimed = rows.flatMap(row => (row.staffId ? [row.staffId] : []))
  const unclaimed = rows.filter(row => !row.staffId).map(row => row.email)
  const people = rows.length
    ? await prisma.staff.findMany({
        where: { OR: [{ id: { in: claimed } }, { email: { in: unclaimed } }] },
        select: { id: true, email: true, firstName: true, lastName: true },
        take: rows.length,
      })
    : []
  const personOf = (row: { staffId: string | null; email: string }) =>
    people.find(person => (row.staffId ? person.id === row.staffId : person.email.toLowerCase() === row.email))
  const staffIds = rows.flatMap(row => personOf(row)?.id ?? [])
  const open = staffIds.length
    ? await prisma.crmAccount.groupBy({
        by: ['ownerStaffId'],
        where: { ownerStaffId: { in: staffIds }, stage: { kind: 'ABIERTA' } },
        _count: { _all: true },
      })
    : []

  const data: TeamMember[] = rows.map(row => {
    const person = personOf(row)
    return {
      id: row.id,
      email: row.email,
      staffId: person?.id ?? null,
      firstName: person?.firstName ?? null,
      lastName: person?.lastName ?? null,
      keys: effectiveKeys(row),
      openAccounts: open.find(group => group.ownerStaffId === person?.id)?._count._all ?? 0,
      createdAt: row.createdAt,
    }
  })
  return { data, meta: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) } }
}

/**
 * Gives keys to a person by email. Someone who already has an Avoqado account gets a VIEWER seat in the internal venue
 * right away; anyone else, the normal team invitation to it.
 */
export async function addTeamMember(actor: CrmAccess, input: { email: string; firstName: string; lastName: string; keys: CrmKeysInput }) {
  const email = input.email.trim().toLowerCase()
  assertKeysGoTogether(input.keys)
  const existing = await prisma.platformAccess.findUnique({ where: { email } })
  // Keys of a row that was taken away are not "already given": giving them back is giving them.
  assertCanGive(actor, existing?.active ? existing : null, input.keys)
  const { venueId } = await ensureCrmTeamVenue()

  const row = await prisma.platformAccess.upsert({
    where: { email },
    create: { email, ...keyColumns(input.keys), createdById: actor.staffId },
    // `staffId: null`: the keys go to whoever holds this email NOW; the next verified person to use them claims them.
    update: { ...keyColumns(input.keys), active: true, staffId: null },
  })

  const staff = await prisma.staff.findUnique({ where: { email }, select: { id: true } })
  if (staff) {
    // No seat check: the venue is exempt from the cap by construction (`ensureCrmTeamVenue`).
    await prisma.staffVenue.upsert({
      where: { staffId_venueId: { staffId: staff.id, venueId } },
      // An existing seat keeps its role: this venue only opens the login.
      update: { active: true, endDate: null },
      create: { staffId: staff.id, venueId, role: StaffRole.VIEWER, active: true },
    })
  } else {
    await inviteTeamMember(venueId, actor.staffId, { role: StaffRole.VIEWER, email, firstName: input.firstName, lastName: input.lastName })
  }

  void logAction({
    staffId: actor.staffId,
    venueId: null,
    action: 'CRM_TEAM_MEMBER_ADDED',
    entity: 'PlatformAccess',
    entityId: row.id,
    data: { email, keys: { ...input.keys }, invited: !staff },
  })
  return { id: row.id, email, keys: effectiveKeys(row), invited: !staff }
}

/** Changes the keys of someone on the team. */
export async function updateTeamMember(actor: CrmAccess, id: string, keys: CrmKeysInput) {
  const row = await prisma.platformAccess.findFirst({ where: { id, active: true } })
  if (!row) throw new NotFoundError('Esa persona no está en el equipo de ventas', 'CRM_TEAM_MEMBER_NOT_FOUND')
  assertKeysGoTogether(keys)
  assertCanGive(actor, row, keys)

  const updated = await prisma.platformAccess.update({ where: { id }, data: keyColumns(keys) })
  void logAction({
    staffId: actor.staffId,
    venueId: null,
    action: 'CRM_TEAM_MEMBER_KEYS_UPDATED',
    entity: 'PlatformAccess',
    entityId: id,
    data: { email: row.email, before: { ...effectiveKeys(row) }, after: { ...keys } },
  })
  return { id, email: updated.email, keys: effectiveKeys(updated) }
}

/**
 * Takes someone off the team. In ONE transaction: the keys stop working, the internal venue's seat closes, and their
 * open accounts go to `reasignarA` or stay «Sin dueño», each with its OWNER_CHANGE event.
 */
export async function removeTeamMember(actor: CrmAccess, id: string, opts: { reasignarA?: string | null }) {
  const row = await prisma.platformAccess.findFirst({ where: { id, active: true } })
  if (!row) throw new NotFoundError('Esa persona no está en el equipo de ventas', 'CRM_TEAM_MEMBER_NOT_FOUND')
  const memberStaffId = row.staffId ?? (await prisma.staff.findUnique({ where: { email: row.email }, select: { id: true } }))?.id ?? null
  const toStaffId = opts.reasignarA ?? null
  if (toStaffId) {
    if (toStaffId === memberStaffId) {
      throw new ValidationError('No le puedes pasar sus negocios a la misma persona que das de baja', 'CRM_REASSIGN_TARGET_INVALID')
    }
    if (!(await getCrmAccess(toStaffId))?.ver) {
      throw new ValidationError('A quien le pasas los negocios tiene que estar en el equipo de ventas', 'CRM_REASSIGN_TARGET_INVALID')
    }
  }
  const { venueId } = await ensureCrmTeamVenue()

  const released = await prisma.$transaction(async tx => {
    // `staffId: null` too, so this person can claim a row again if an admin ever gives them keys back.
    await tx.platformAccess.update({ where: { id }, data: { active: false, staffId: null } })
    if (!memberStaffId) return 0
    await tx.staffVenue.updateMany({
      where: { staffId: memberStaffId, venueId, active: true },
      data: { active: false, endDate: new Date() },
    })
    return moveOpenAccountsTx(tx, { fromStaffId: memberStaffId, toStaffId, actorStaffId: actor.staffId, reason: 'TEAM_MEMBER_REMOVED' })
  })

  void logAction({
    staffId: actor.staffId,
    venueId: null,
    action: 'CRM_TEAM_MEMBER_REMOVED',
    entity: 'PlatformAccess',
    entityId: id,
    data: { email: row.email, reasignarA: toStaffId, released },
  })
  return { id, released }
}

const KEY_OF: Record<keyof CrmKeys, CrmKey> = {
  ver: 'crm:ver',
  editar: 'crm:editar',
  contactar: 'crm:contactar',
  campanas: 'crm:campanas',
  exportar: 'crm:exportar',
  ventas: 'crm:ventas',
  admin: 'crm:admin',
}
const label = (field: keyof CrmKeys) => `«${CRM_KEY_LABELS[KEY_OF[field]]}»`

/**
 * Ruling 9: «Editar», «Mandar correo», «Exportar» and «Ver ventas» only work on top of «Ver negocios», and nobody edits
 * what they cannot see. Saved anyway, they would be keys that do nothing — or a PATCH on accounts the person does not see.
 */
function assertKeysGoTogether(keys: CrmKeysInput) {
  if (!keys.ver) {
    const orphans = (['editar', 'contactar', 'exportar', 'ventas'] as const).filter(field => keys[field])
    if (orphans.length) {
      throw new ValidationError(`Sin «Ver negocios» no se puede dar: ${orphans.map(label).join(', ')}`, 'CRM_KEY_NEEDS_VER')
    }
  }
  if (keys.editar === 'todos' && keys.ver === 'propios') {
    throw new ValidationError('«Editar» en todos necesita «Ver negocios» en todos', 'CRM_EDIT_WIDER_THAN_VIEW')
  }
}

const rank = (scope: CrmScope | null) => (scope === 'todos' ? 2 : scope === 'propios' ? 1 : 0)

/**
 * Nobody gives a key they do not hold (spec §5.1, like the venue role editor). Only what the change TURNS ON or WIDENS
 * counts: keeping a key the person already had is not giving it, so an admin can still edit someone with more keys. A
 * key stored without «Ver negocios» never worked, so waking it up counts as giving it (`effectiveKeys`).
 */
function assertCanGive(actor: CrmAccess, current: CrmKeyColumns | null, next: CrmKeysInput) {
  const had = current ? effectiveKeys(current) : null
  const given: string[] = []
  for (const field of ['ver', 'editar'] as const) {
    if (rank(next[field]) > rank(had?.[field] ?? null) && rank(next[field]) > rank(actor[field]))
      given.push(`${label(field)} en ${next[field]}`)
  }
  for (const field of ['contactar', 'campanas', 'exportar', 'ventas', 'admin'] as const) {
    if (next[field] && !had?.[field] && !actor[field]) given.push(label(field))
  }
  if (given.length) throw new ForbiddenError(`No puedes dar llaves que tú no tienes: ${given.join(', ')}`, 'CRM_KEY_ESCALATION')
}

const keyColumns = (keys: CrmKeysInput): CrmKeyColumns => ({
  verScope: keys.ver,
  editarScope: keys.editar,
  contactar: keys.contactar,
  campanas: keys.campanas,
  exportar: keys.exportar,
  ventas: keys.ventas,
  admin: keys.admin,
})
