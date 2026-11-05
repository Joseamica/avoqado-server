/**
 * Avoqado's sales team (spec 2026-10-30 §5.1, ruling 14): the internal venue a seller logs into, and the «Equipo de
 * ventas» screen that gives, changes and takes away CRM keys.
 *
 * A seller is a VIEWER of ONE internal venue, «Avoqado · Equipo de ventas», only so they can log in: the token always
 * carries a venue. What they can do in the CRM is their `PlatformAccess` keys, which `requireCrm` re-reads on every
 * request. The venue lives in an organization of its OWN, empty on purpose: as members of any other organization (Prime,
 * the founder's test one), the sellers could read its organization screens. `CrmTeam` says which ones they are.
 */
import { InvitationStatus, Prisma, StaffRole, VenueStatus, VerificationStatus } from '@prisma/client'
import { ConflictError, ForbiddenError, InternalServerError, NotFoundError, ValidationError } from '../../errors/AppError'
import { CRM_KEY_LABELS, type CrmKey } from '../../lib/permissions'
import type { CrmKeysInput } from '../../schemas/crm.schema'
import prisma from '../../utils/prismaClient'
import { logAction } from '../dashboard/activity-log.service'
import { inviteTeamMember } from '../dashboard/team.dashboard.service'
import {
  CRM_KEY_SELECT,
  effectiveKeys,
  getCrmAccess,
  legacyFlags,
  type CrmAccess,
  type CrmKeyColumns,
  type CrmKeys,
  type CrmScope,
} from './access.service'
import { moveOpenAccountsTx } from './ownership'

export const CRM_TEAM_VENUE_SLUG = 'avoqado-equipo-ventas'
const CRM_TEAM_NAME = 'Avoqado · Equipo de ventas'
const CRM_TEAM_LOCK = 'crm:team'
const MAX_PAGE_SIZE = 100

/**
 * The team's organization and venue, created together the first time they are needed and read from `CrmTeam` afterwards.
 *
 * `seatCapExempt`: without it the third seller hits the Free plan's 2-user cap. `ACTIVE` + `VERIFIED`: it never shows up
 * in the KYC review queue.
 */
export async function ensureCrmTeamVenue(): Promise<{ venueId: string; organizationId: string }> {
  const select = { venueId: true, organizationId: true } as const
  const team = await prisma.crmTeam.findUnique({ where: { key: 'default' }, select })
  if (team) return team

  return prisma.$transaction(async tx => {
    // Two first calls at once: the second waits here and then finds the team the first one made.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${CRM_TEAM_LOCK}))::text`
    const made = await tx.crmTeam.findUnique({ where: { key: 'default' }, select })
    if (made) return made

    const organization = await tx.organization.create({
      // `onboardingCompletedAt`: with it unfinished, login takes whoever has this email and no working venue for an OWNER
      // in onboarding and sends them to the wizard, where they could open real venues in this empty organization.
      data: { name: CRM_TEAM_NAME, email: 'hola@avoqado.io', phone: '+525667976805', onboardingCompletedAt: new Date() },
      select: { id: true },
    })
    let venueId: string
    try {
      venueId = (
        await tx.venue.create({
          data: {
            organizationId: organization.id,
            name: CRM_TEAM_NAME,
            slug: CRM_TEAM_VENUE_SLUG,
            seatCapExempt: true,
            status: VenueStatus.ACTIVE,
            kycStatus: VerificationStatus.VERIFIED,
          },
          select: { id: true },
        })
      ).id
    } catch (error) {
      // Another venue already has the slug: it is never adopted (the sellers would become its VIEWERs).
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new InternalServerError(`Ya hay un venue «${CRM_TEAM_VENUE_SLUG}» que no es del equipo de ventas: cámbiale el slug`)
      }
      throw error
    }
    await tx.crmTeam.create({ data: { key: 'default', organizationId: organization.id, venueId } })
    return { venueId, organizationId: organization.id }
  })
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
    people.find(person => (row.staffId ? person.id === row.staffId : person.email === row.email))
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
 * The ficha's owner selector (ruling 13): every active member who can own accounts, by name — exactly the people
 * `reassign` accepts (M-4), the ones `getCrmAccess` gives «Ver negocios» to. Only for whoever can reassign («Editar:
 * todos» or «Equipo y llaves», L6); anyone else gets `[]`, so a «propios» seller does not even learn the names of the team.
 *
 * ponytail: one page of 100 members; a team that grows past it needs a search box instead of a selector.
 */
export async function listTeamOptions(actor: CrmAccess): Promise<Array<{ staffId: string; name: string }>> {
  if (!(actor.equipo || actor.editar === 'todos')) return []
  const rows = await prisma.platformAccess.findMany({
    // Whoever `reassign` accepts: «Editar» on top of «Ver» (m-3).
    where: { active: true, verScope: { in: ['propios', 'todos'] }, editarScope: { in: ['propios', 'todos'] } },
    select: { staffId: true, email: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: MAX_PAGE_SIZE,
  })
  if (!rows.length) return []
  // The same person `getCrmAccess` would give the keys to. A claimed row: whoever claimed it, while their email still leads
  // to this row (it is looked up by the person's email). An unclaimed one: whoever holds the email today, with it verified —
  // nobody else ever claims it — unless they already hold another row: `staffId` is unique, so the claim would fail (P2002).
  const claimed = rows.flatMap(row => (row.staffId ? [row.staffId] : []))
  const unclaimed = rows.flatMap(row => (row.staffId ? [] : [row.email]))
  const people = await prisma.staff.findMany({
    where: { active: true, OR: [{ id: { in: claimed } }, { email: { in: unclaimed }, emailVerified: true }] },
    select: { id: true, email: true, emailVerified: true, firstName: true, lastName: true },
    take: rows.length,
  })
  return rows.flatMap(row => {
    const person = row.staffId
      ? people.find(candidate => candidate.id === row.staffId && candidate.email.toLowerCase() === row.email)
      : people.find(candidate => candidate.email === row.email && candidate.emailVerified && !claimed.includes(candidate.id))
    return person ? [{ staffId: person.id, name: `${person.firstName} ${person.lastName}`.trim() }] : []
  })
}

/**
 * Who a test email can go to: every active member whose keys somebody claimed, whose Staff is still active and whose email
 * still leads to that row (the same «still the same person» rule as `listTeamOptions`). The test's destination is validated
 * against THIS list on the server, never trusted from the screen.
 *
 * ponytail: one page of 100 members; a team that grows past it needs a search box.
 */
export async function miembrosConCorreo(): Promise<Array<{ staffId: string; name: string; email: string }>> {
  const rows = await prisma.platformAccess.findMany({
    where: { active: true, staffId: { not: null } },
    select: { staffId: true, email: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: MAX_PAGE_SIZE,
  })
  if (!rows.length) return []
  const people = await prisma.staff.findMany({
    where: { active: true, id: { in: rows.flatMap(row => (row.staffId ? [row.staffId] : [])) } },
    select: { id: true, email: true, firstName: true, lastName: true },
    take: MAX_PAGE_SIZE,
  })
  return rows.flatMap(row => {
    const person = people.find(candidate => candidate.id === row.staffId && candidate.email.toLowerCase() === row.email)
    return person ? [{ staffId: person.id, name: `${person.firstName} ${person.lastName}`.trim(), email: row.email }] : []
  })
}

/** La lista de «¿a quién le mando la prueba?»: los mismos que valida el servidor, sólo nombres. `tu` = quien la pide. */
export async function listarDestinosDePrueba(actor: CrmAccess): Promise<Array<{ staffId: string; name: string; tu: boolean }>> {
  return (await miembrosConCorreo()).map(({ staffId, name }) => ({ staffId, name, tu: staffId === actor.staffId }))
}

/**
 * A Staff by the exact lowercase email: the same rule as login, password reset, Google and invitation acceptance (ruling
 * 16). An account stored with capitals can never log in, so it must not count as "already has an account".
 */
const staffByEmail = (email: string) => prisma.staff.findUnique({ where: { email }, select: { id: true, active: true } })

/**
 * Gives keys to a person by email. Someone with a working Avoqado account gets a VIEWER seat in the internal venue right
 * away; anyone else, the team invitation to it.
 */
export async function addTeamMember(actor: CrmAccess, input: { email: string; firstName: string; lastName: string; keys: CrmKeysInput }) {
  const email = input.email.trim().toLowerCase()
  assertKeysGoTogether(input.keys)
  const existing = await prisma.platformAccess.findUnique({ where: { email } })
  // Adding again cuts the tie (`staffId: null` below), so the keys of a row someone already claimed go to whoever holds
  // the email NOW: the whole grant is checked. Same for a row that was taken away: giving keys back is giving them. Only
  // an active row nobody claimed yet stays promised to the same email, so there only what changes counts.
  assertCanGive(actor, existing?.active && !existing.staffId ? existing : null, input.keys)
  const { venueId } = await ensureCrmTeamVenue()

  const row = await prisma.platformAccess.upsert({
    where: { email },
    // Un INSERT no pasa por el disparador de L11: no hay versión que subir.
    create: { email, ...keyColumns(input.keys), createdById: actor.staffId },
    // `staffId: null`: the keys go to whoever holds this email NOW; the next verified person to use them claims them.
    update: { ...keyColumns(input.keys), ...SUBE_VERSION, active: true, staffId: null },
  })

  // A provisional account (made by an earlier invitation that was never accepted) cannot log in: it gets invited again.
  const staff = await staffByEmail(email)
  const invited = !staff?.active
  // On record as soon as the keys are on: if the invitation below fails, the grant is still audited.
  void logAction({
    staffId: actor.staffId,
    venueId: null,
    action: 'CRM_TEAM_MEMBER_ADDED',
    entity: 'PlatformAccess',
    entityId: row.id,
    data: { email, keys: { ...input.keys }, invited },
  })

  if (staff && !invited) {
    // No seat check: the venue is exempt from the cap by construction (`ensureCrmTeamVenue`).
    await prisma.staffVenue.upsert({
      where: { staffId_venueId: { staffId: staff.id, venueId } },
      // An existing seat keeps its role: this venue only opens the login.
      update: { active: true, endDate: null },
      create: { staffId: staff.id, venueId, role: StaffRole.VIEWER, active: true },
    })
    return { id: row.id, email, keys: effectiveKeys(row), invited }
  }

  // A new invitation every time: an expired one leaves no way in, and «it never arrived» is why people add again.
  await prisma.invitation.updateMany({
    where: { email, venueId, status: InvitationStatus.PENDING },
    data: { status: InvitationStatus.REVOKED },
  })
  const sent = await inviteTeamMember(venueId, actor.staffId, {
    role: StaffRole.VIEWER,
    email,
    firstName: input.firstName,
    lastName: input.lastName,
  })
  if (sent.emailSent) return { id: row.id, email, keys: effectiveKeys(row), invited, invitationEmailSent: true }

  // The email did not go out and the old link is already revoked: the admin gets the link to send it by hand. The audit
  // trail says so, without the link (it opens the invitation).
  void logAction({
    staffId: actor.staffId,
    venueId: null,
    action: 'CRM_TEAM_INVITATION_EMAIL_NOT_SENT',
    entity: 'PlatformAccess',
    entityId: row.id,
    data: { email },
  })
  return { id: row.id, email, keys: effectiveKeys(row), invited, invitationEmailSent: false, inviteLink: sent.inviteLink }
}

const keysChanged = () => new ConflictError('Alguien más cambió sus llaves', 'CRM_LLAVES_CAMBIARON')

/**
 * Changes the keys of someone on the team. `expectedKeys` (ruling 60) are the keys the screen saw: if her EFFECTIVE keys
 * are not those any more, or change between this read and the write (the UPDATE is a compare-and-set on the columns as
 * read), nothing is written and the 409 says so. Without them, as before.
 */
export async function updateTeamMember(actor: CrmAccess, id: string, keys: CrmKeysInput, expectedKeys?: CrmKeysInput) {
  const row = await prisma.platformAccess.findFirst({ where: { id, active: true } })
  if (!row) throw new NotFoundError('Esa persona no está en el equipo de ventas', 'CRM_TEAM_MEMBER_NOT_FOUND')
  const current = effectiveKeys(row)
  // Las 13 que se dan (L10): el espejo `campanas`/`admin` no se compara, la pantalla nueva no lo manda.
  if (expectedKeys && (Object.keys(KEY_OF) as Array<keyof CrmKeysInput>).some(field => current[field] !== expectedKeys[field]))
    throw keysChanged()
  assertKeysGoTogether(keys)
  assertCanGive(actor, row, keys)

  const updated = expectedKeys
    ? (
        await prisma.platformAccess.updateManyAndReturn({
          // Las 15 columnas de llaves tal como se leyeron: también una escritura de la versión vieja de en medio (que no
          // sube la versión pero cambia el espejo o apaga las finas) hace fallar el CAS.
          where: { id, active: true, ...columnasLeidas(row) },
          data: { ...keyColumns(keys), ...SUBE_VERSION },
        })
      )[0]
    : await prisma.platformAccess.update({ where: { id }, data: { ...keyColumns(keys), ...SUBE_VERSION } })
  if (!updated) throw keysChanged()
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
 * Takes someone off the team. In ONE transaction: the keys stop working, a pending invitation to the team is revoked, the
 * internal venue's seat and the team organization's membership close, and their open accounts go to `reasignarA` or stay
 * «Sin dueño», each with its OWNER_CHANGE event.
 */
export async function removeTeamMember(actor: CrmAccess, id: string, opts: { reasignarA?: string | null }) {
  const row = await prisma.platformAccess.findFirst({ where: { id, active: true } })
  if (!row) throw new NotFoundError('Esa persona no está en el equipo de ventas', 'CRM_TEAM_MEMBER_NOT_FOUND')
  const memberStaffId = row.staffId ?? (await staffByEmail(row.email))?.id ?? null
  const toStaffId = opts.reasignarA ?? null
  if (toStaffId) {
    if (toStaffId === memberStaffId) {
      throw new ValidationError('No le puedes pasar sus negocios a la misma persona que das de baja', 'CRM_REASSIGN_TARGET_INVALID')
    }
    // Able to EDIT them, like `reassign` (m-3): with only «Ver» the accounts would freeze in their hands.
    if (!(await getCrmAccess(toStaffId))?.editar) {
      throw new ValidationError(
        'A quien le pasas los negocios tiene que estar en el equipo de ventas y poder editar negocios',
        'CRM_REASSIGN_TARGET_INVALID',
      )
    }
  }
  const { venueId, organizationId } = await ensureCrmTeamVenue()

  const released = await prisma.$transaction(async tx => {
    // `staffId: null` too, so this person can claim a row again if an admin ever gives them keys back.
    await tx.platformAccess.update({ where: { id }, data: { active: false, staffId: null } })
    // Accepting a pending invitation would bring them back into the team's venue and organization.
    await tx.invitation.updateMany({
      where: { email: row.email, venueId, status: InvitationStatus.PENDING },
      data: { status: InvitationStatus.REVOKED },
    })
    if (!memberStaffId) return 0
    const now = new Date()
    // pin: null — the PIN goes back to the venue; a retained PIN blocks reuse via @@unique([venueId, pin]).
    await tx.staffVenue.updateMany({
      where: { staffId: memberStaffId, venueId, active: true },
      data: { active: false, endDate: now, pin: null },
    })
    // The team's organization holds only this venue, so leaving the venue is leaving the organization.
    await tx.staffOrganization.updateMany({
      where: { staffId: memberStaffId, organizationId, isActive: true },
      data: { isActive: false, leftAt: now },
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

const KEY_OF: Record<keyof CrmKeysInput, CrmKey> = {
  ver: 'crm:ver',
  editar: 'crm:editar',
  cerrar: 'crm:cerrar',
  contactar: 'crm:contactar',
  exportar: 'crm:exportar',
  ventas: 'crm:ventas',
  bajas: 'crm:bajas',
  plantillas: 'crm:plantillas',
  preparar: 'crm:preparar',
  mandar: 'crm:mandar',
  verCampanas: 'crm:ver-campanas',
  equipo: 'crm:equipo',
  configurar: 'crm:configurar',
}
const label = (field: keyof CrmKeysInput) => `«${CRM_KEY_LABELS[KEY_OF[field]]}»`

/**
 * L10: sólo la pantalla VIEJA del SUPERADMIN manda `campanas` o `admin` al escribir llaves (en `keys` o en
 * `expectedKeys`, de 7 campos o con los 15 que copió de la respuesta); la nueva nunca. No se traduce: se le pide recargar y
 * no se escribe nada. Va ANTES del esquema, que pide las 13 y le contestaría un 400 sin decir qué hacer.
 */
export function assertFormaNuevaDeLlaves(body: unknown): void {
  const partes =
    body && typeof body === 'object' ? [(body as Record<string, unknown>).keys, (body as Record<string, unknown>).expectedKeys] : []
  const vieja = partes.some(parte => !!parte && typeof parte === 'object' && ('campanas' in parte || 'admin' in parte))
  if (vieja) throw new ConflictError('El editor de llaves cambió. Recarga la página y vuelve a intentarlo.', 'CRM_LLAVES_PANTALLA_VIEJA')
}

/**
 * Ruling 9 and L1: «Editar», «Mandar correo», «Exportar» and «Ver ventas» only work on top of «Ver negocios», and nobody
 * edits what they cannot see; «Cerrar negocios» only on top of «Editar». The mail and admin keys stand alone («Bajas de
 * correo» too). Saved anyway, they would be keys that do nothing — or a PATCH on accounts the person does not see.
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
  if (keys.cerrar && !keys.editar) {
    throw new ValidationError(`Sin «Editar» no se puede dar: ${label('cerrar')}`, 'CRM_KEY_NEEDS_EDITAR')
  }
}

const rank = (scope: CrmScope | null) => (scope === 'todos' ? 2 : scope === 'propios' ? 1 : 0)

/** Lo que cuenta como alcance de cada llave con alcance. «Cerrar negocios» trabaja en el de «Editar» (L12). */
type ConAlcance = { ver: CrmScope | null; editar: CrmScope | null; cerrar: boolean }
const ALCANCE = {
  ver: (keys: ConAlcance) => keys.ver,
  editar: (keys: ConAlcance) => keys.editar,
  cerrar: (keys: ConAlcance) => (keys.cerrar ? keys.editar : null),
} as const
const SIN_ALCANCE = [
  'contactar',
  'exportar',
  'ventas',
  'bajas',
  'plantillas',
  'preparar',
  'mandar',
  'verCampanas',
  'equipo',
  'configurar',
] as const

/**
 * Nobody gives a key they do not hold (spec §5.1, like the venue role editor; L12 for the 8 new ones). Only what the change
 * TURNS ON or WIDENS counts: keeping a key the person already had is not giving it, so an admin can still edit someone with
 * more keys. A key stored without the key it needs never worked, so waking it up counts as giving it (`effectiveKeys`).
 * Widening only «Editar» of someone who already closes widens «Cerrar negocios» too, and counts as giving it.
 */
function assertCanGive(actor: CrmAccess, current: CrmKeyColumns | null, next: CrmKeysInput) {
  const had = current ? effectiveKeys(current) : null
  const given: string[] = []
  for (const field of Object.keys(ALCANCE) as Array<keyof typeof ALCANCE>) {
    const scope = ALCANCE[field](next)
    if (rank(scope) > rank(had ? ALCANCE[field](had) : null) && rank(scope) > rank(ALCANCE[field](actor)))
      given.push(`${label(field)} en ${scope}`)
  }
  for (const field of SIN_ALCANCE) {
    if (next[field] && !had?.[field] && !actor[field]) given.push(label(field))
  }
  if (given.length) throw new ForbiddenError(`No puedes dar llaves que tú no tienes: ${given.join(', ')}`, 'CRM_KEY_ESCALATION')
}

/**
 * L11: el código nuevo sube `llavesVersion` en cada escritura que debe conservar las finas; el disparador de la base apaga
 * las 8 en todo UPDATE que no la sube (lo que escribe la versión vieja).
 */
const SUBE_VERSION = { llavesVersion: { increment: 1 } } as const

/** Las 15 columnas de llaves de una fila tal como se leyó, para el compare-and-set. */
const columnasLeidas = (row: CrmKeyColumns): CrmKeyColumns => {
  const columnas = {} as Record<keyof CrmKeyColumns, CrmKeyColumns[keyof CrmKeyColumns]>
  for (const columna of Object.keys(CRM_KEY_SELECT) as Array<keyof CrmKeyColumns>) columnas[columna] = row[columna]
  return columnas as CrmKeyColumns
}

/** Las 13 tal como llegaron, más el espejo `campanas`/`admin` de L11 (falla cerrado) para la versión vieja. */
const keyColumns = (keys: CrmKeysInput): CrmKeyColumns => {
  const columns = {
    verScope: keys.ver,
    editarScope: keys.editar,
    cerrar: keys.cerrar,
    contactar: keys.contactar,
    exportar: keys.exportar,
    ventas: keys.ventas,
    bajas: keys.bajas,
    plantillas: keys.plantillas,
    preparar: keys.preparar,
    mandar: keys.mandar,
    verCampanas: keys.verCampanas,
    equipo: keys.equipo,
    configurar: keys.configurar,
  }
  return { ...columns, ...legacyFlags(effectiveKeys({ ...columns, campanas: false, admin: false })) }
}
