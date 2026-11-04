/**
 * Avoqado's internal sales team and the «Equipo de ventas» screen (spec 2026-10-30 §5.1, plan task 3, ruling 14).
 *
 * A seller logs in as a VIEWER of one internal venue, «Avoqado · Equipo de ventas», which lives in its OWN empty
 * organization (never Prime: its members can read Prime's organization screens). The `CrmTeam` row says which ones they
 * are. What a seller can do in the CRM is their `PlatformAccess` keys. The venue must never hit the Free seat cap nor the
 * KYC queue, an admin never hands out a key they do not hold, and taking someone off the team moves their open accounts —
 * and takes back their invitation and membership — in the same transaction that takes their keys away.
 */
import { InvitationStatus, Prisma, StaffRole, VenueStatus, VerificationStatus } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'
import { logAction } from '@/services/dashboard/activity-log.service'

jest.mock('@/services/email.service', () => ({
  __esModule: true,
  // D3: invitar al equipo de ventas manda el correo del CRM (`sendCrmTeamInvitation`).
  default: { sendTeamInvitation: jest.fn().mockResolvedValue(true), sendCrmTeamInvitation: jest.fn().mockResolvedValue(true) },
}))
jest.mock('@/services/dashboard/venueRoleConfig.dashboard.service', () => ({
  getRoleDisplayName: jest.fn().mockResolvedValue('Visor'),
}))

import * as teamDashboard from '@/services/dashboard/team.dashboard.service'
import { getVenueSeatCap } from '@/services/access/seatCap.service'
import { addTeamMemberSchema, removeTeamMemberSchema, updateTeamMemberSchema } from '@/schemas/crm.schema'
import type { CrmAccess } from '@/services/crm/access.service'
import {
  addTeamMember,
  ensureCrmTeamVenue,
  listTeamMembers,
  listTeamOptions,
  removeTeamMember,
  updateTeamMember,
} from '@/services/crm/teamVenue.service'

const ORG_ID = 'corgteam00000000000000001'
const VENUE_ID = 'cvenuecrm0000000000000001'
const ADMIN_ID = 'cstaffadm0000000000000001'
const SELLER_ID = 'cstaffsel0000000000000001'
const OTHER_ID = 'cstaffoth0000000000000001'
const ROW_ID = 'caccessrw0000000000000001'
const ROW2_ID = 'caccessrw0000000000000002'
const ACCOUNT_A = 'caccounta0000000000000001'
const ACCOUNT_B = 'caccountb0000000000000001'

const realInviteTeamMember = teamDashboard.inviteTeamMember

/** The actor's EFFECTIVE keys, as `requireCrm` leaves them in `req.crmAccess`. Default: an admin with every key. */
const actor = (over: Partial<CrmAccess> = {}): CrmAccess => ({
  staffId: ADMIN_ID,
  isSuperadmin: false,
  ver: 'todos',
  editar: 'todos',
  contactar: true,
  campanas: true,
  exportar: true,
  ventas: true,
  admin: true,
  ...over,
})

/** The keys the screen sends. Default: what the spec gives a new seller (see and edit their own, email one to one). */
const keys = (over: Record<string, unknown> = {}) =>
  ({ ver: 'propios', editar: 'propios', contactar: true, campanas: false, exportar: false, ventas: false, admin: false, ...over }) as any

const newMember = (over: Record<string, unknown> = {}) =>
  ({ email: 'ana@avoqado.io', firstName: 'Ana', lastName: 'López', keys: keys(), ...over }) as any

/** A PlatformAccess row as stored: a default seller, already claimed by that seller's Staff. */
const storedRow = (over: Record<string, unknown> = {}) => ({
  id: ROW_ID,
  email: 'carla@avoqado.io',
  staffId: SELLER_ID,
  verScope: 'propios',
  editarScope: 'propios',
  contactar: true,
  campanas: false,
  exportar: false,
  ventas: false,
  admin: false,
  active: true,
  createdById: ADMIN_ID,
  createdAt: new Date('2026-10-30T12:00:00Z'),
  updatedAt: new Date('2026-10-30T12:00:00Z'),
  ...over,
})

const uniqueViolation = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`slug`)', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target: ['slug'] },
  })

/**
 * The team's tables, faked in memory. `ensureCrmTeamVenue` writes through `teamTx` — its one transaction — and what it
 * creates is exactly what every later read sees, the seat cap included. The team's organization is NOT grandfathered, so
 * only the venue's own flag can lift the cap.
 */
let teamRow: { organizationId: string; venueId: string } | null
let venueRow: Record<string, unknown> | null
let teamTx: any
function fakeTeamTables() {
  teamRow = null
  venueRow = null
  const readTeam = async () => teamRow
  prismaMock.crmTeam.findUnique.mockImplementation(readTeam)
  prismaMock.venue.findUnique.mockImplementation(async () =>
    venueRow ? { ...venueRow, organization: { id: ORG_ID, name: 'Avoqado · Equipo de ventas', seatCapExempt: false } } : null,
  )
  teamTx = {
    $queryRaw: jest.fn().mockResolvedValue([{ pg_advisory_xact_lock: '' }]),
    crmTeam: {
      findUnique: jest.fn(readTeam),
      create: jest.fn(async ({ data }: any) => (teamRow = { organizationId: data.organizationId, venueId: data.venueId })),
    },
    organization: { create: jest.fn(async ({ data }: any) => ({ id: ORG_ID, ...data })) },
    venue: { create: jest.fn(async ({ data }: any) => (venueRow = { id: VENUE_ID, ...data })) },
  }
  prismaMock.$transaction.mockImplementation((callback: any) => callback(teamTx))
}

/** The team already exists — the usual case once the first person was added. */
function teamExists() {
  teamRow = { organizationId: ORG_ID, venueId: VENUE_ID }
  venueRow = {
    id: VENUE_ID,
    organizationId: ORG_ID,
    name: 'Avoqado · Equipo de ventas',
    slug: 'avoqado-equipo-ventas',
    seatCapExempt: true,
  }
}

const configured = () => [
  prismaMock.crmTeam.findUnique,
  prismaMock.venue.findUnique,
  prismaMock.venue.create,
  prismaMock.organization.create,
  prismaMock.platformAccess.findUnique,
  prismaMock.platformAccess.findFirst,
  prismaMock.platformAccess.findMany,
  prismaMock.platformAccess.count,
  prismaMock.platformAccess.upsert,
  prismaMock.platformAccess.update,
  prismaMock.platformAccess.updateManyAndReturn,
  prismaMock.staff.findUnique,
  prismaMock.staff.findFirst,
  prismaMock.staff.findMany,
  prismaMock.staff.create,
  prismaMock.staffVenue.upsert,
  prismaMock.staffVenue.updateMany,
  prismaMock.staffVenue.count,
  prismaMock.staffVenue.findFirst,
  prismaMock.staffVenue.findUnique,
  prismaMock.staffOrganization.create,
  prismaMock.staffOrganization.updateMany,
  prismaMock.invitation.findFirst,
  prismaMock.invitation.count,
  prismaMock.invitation.create,
  prismaMock.invitation.updateMany,
  prismaMock.venueFeature.findMany,
  prismaMock.crmAccount.groupBy,
  prismaMock.crmAccount.updateManyAndReturn,
  prismaMock.crmTimelineEvent.createMany,
  prismaMock.$transaction,
]

let invite: jest.SpyInstance

beforeEach(() => {
  for (const fn of configured()) fn.mockReset()
  fakeTeamTables()
  prismaMock.platformAccess.findUnique.mockResolvedValue(null)
  prismaMock.platformAccess.upsert.mockImplementation(async ({ create }: any) => storedRow({ ...create, staffId: null }))
  // By id: the admin who invites. By email: nobody has an account yet.
  prismaMock.staff.findUnique.mockImplementation(async ({ where }: any) =>
    where.id === ADMIN_ID ? { id: ADMIN_ID, firstName: 'Founder', lastName: 'Avoqado' } : null,
  )
  invite = jest.spyOn(teamDashboard, 'inviteTeamMember').mockResolvedValue({ emailSent: true, isTPVOnly: false, invitation: {} })
})

afterEach(() => invite.mockRestore())

describe('ensureCrmTeamVenue', () => {
  it('crea_venue_interno_exento_y_fuera_de_kyc', async () => {
    const { venueId } = await ensureCrmTeamVenue()

    expect(venueId).toBe(VENUE_ID)
    expect(teamTx.venue.create).toHaveBeenCalledTimes(1)
    const { data } = teamTx.venue.create.mock.calls[0][0]
    expect(data).toEqual(
      expect.objectContaining({
        organizationId: ORG_ID,
        name: 'Avoqado · Equipo de ventas',
        slug: 'avoqado-equipo-ventas',
        seatCapExempt: true,
        status: VenueStatus.ACTIVE,
        kycStatus: VerificationStatus.VERIFIED,
      }),
    )
    // The KYC review queue lists PENDING_REVIEW and IN_REVIEW: this venue is never one of them.
    expect([VerificationStatus.PENDING_REVIEW, VerificationStatus.IN_REVIEW]).not.toContain(data.kycStatus)
    // The seat cap reads the venue exactly as it was created: unlimited.
    await expect(getVenueSeatCap(venueId)).resolves.toBeNull()
  })

  it('equipo_en_org_propia_no_en_prime', async () => {
    // Ruling 14: as members of Prime (the founder's test organization) the sellers could read ~20 of its organization
    // screens. The team gets its OWN empty organization, made in the same transaction as its venue and its CrmTeam row,
    // and the venue goes in THAT organization — never in one that already exists.
    await expect(ensureCrmTeamVenue()).resolves.toEqual({ venueId: VENUE_ID, organizationId: ORG_ID })

    const org = teamTx.organization.create.mock.calls[0][0].data
    expect(org).toEqual(expect.objectContaining({ name: 'Avoqado · Equipo de ventas', email: 'hola@avoqado.io', phone: '+525667976805' }))
    expect(org).not.toHaveProperty('slug')
    expect(teamTx.organization.create.mock.invocationCallOrder[0]).toBeLessThan(teamTx.venue.create.mock.invocationCallOrder[0])
    expect(teamTx.venue.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ organizationId: ORG_ID }) }))
    expect(teamTx.crmTeam.create).toHaveBeenCalledWith({ data: { key: 'default', organizationId: ORG_ID, venueId: VENUE_ID } })
    // Under the advisory lock, before any write: two first calls at once never make two teams.
    const [sql, lockKey] = teamTx.$queryRaw.mock.calls[0]
    expect(sql.join('?')).toContain('pg_advisory_xact_lock(hashtext(?))::text')
    expect(lockKey).toBe('crm:team')
    expect(teamTx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(teamTx.organization.create.mock.invocationCallOrder[0])
    // Nothing of it written outside that transaction.
    expect(prismaMock.organization.create).not.toHaveBeenCalled()
    expect(prismaMock.venue.create).not.toHaveBeenCalled()
  })

  it('organizacion_del_equipo_nace_con_alta_terminada', async () => {
    // N-3: login treats as an OWNER in onboarding whoever has their organization's email and no working venue while the
    // organization's onboarding is unfinished — and the dashboard sends them to the wizard, where they could create real
    // venues inside the team's empty organization. It is born with its onboarding done.
    await ensureCrmTeamVenue()

    expect(teamTx.organization.create.mock.calls[0][0].data.onboardingCompletedAt).toBeInstanceOf(Date)
  })

  it('idempotente_dos_veces_un_venue', async () => {
    const first = await ensureCrmTeamVenue()
    const second = await ensureCrmTeamVenue()

    expect(second).toEqual(first)
    expect(teamTx.organization.create).toHaveBeenCalledTimes(1)
    expect(teamTx.venue.create).toHaveBeenCalledTimes(1)
    // Once it exists, finding it is a single read: no transaction, no lock.
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
    expect(prismaMock.crmTeam.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { key: 'default' } }))

    // Two first calls at once: the one that waited on the lock finds the team the other one just made.
    prismaMock.crmTeam.findUnique.mockResolvedValueOnce(null)
    await expect(ensureCrmTeamVenue()).resolves.toEqual(first)
    expect(teamTx.organization.create).toHaveBeenCalledTimes(1)
  })

  it('slug_ocupado_no_se_adopta', async () => {
    // A venue that is not the team's already has the slug: it is never adopted (the sellers would become its VIEWERs),
    // and the team row is not written, so the transaction leaves nothing half-made.
    teamTx.venue.create.mockRejectedValueOnce(uniqueViolation())

    await expect(ensureCrmTeamVenue()).rejects.toMatchObject({ statusCode: 500 })
    expect(teamTx.crmTeam.create).not.toHaveBeenCalled()
    expect(teamRow).toBeNull()
  })
})

describe('addTeamMember', () => {
  it('tres_altas_completas_sin_tope', async () => {
    // The real invitation runs, seat cap included. Seats it counts: active StaffVenues + pending invitations.
    invite.mockImplementation(realInviteTeamMember)
    let activeSeats = 0
    let pendingInvites = 0
    prismaMock.staffVenue.count.mockImplementation(async () => activeSeats)
    prismaMock.invitation.count.mockImplementation(async () => pendingInvites)
    prismaMock.staffVenue.upsert.mockImplementation(async () => {
      activeSeats += 1
      return {}
    })
    prismaMock.invitation.findFirst.mockResolvedValue(null)
    prismaMock.invitation.create.mockImplementation(async ({ data }: any) => {
      pendingInvites += 1
      return { id: `cinvitati000000000000000${pendingInvites}`, token: 'token', status: 'PENDING', createdAt: new Date(), ...data }
    })
    prismaMock.staff.create.mockImplementation(async ({ data }: any) => ({ id: 'cstaffnew0000000000000001', ...data }))
    prismaMock.staffOrganization.create.mockResolvedValue({})
    prismaMock.venueFeature.findMany.mockResolvedValue([]) // no paid plan: a venue that is not exempt would be Free, capped at 2
    // Carla already has a working Avoqado account; Ana and Beto do not. (By id: the admin who invites.)
    prismaMock.staff.findUnique.mockImplementation(async ({ where }: any) =>
      where.id === ADMIN_ID
        ? { id: ADMIN_ID, firstName: 'Founder', lastName: 'Avoqado' }
        : where.email === 'carla@avoqado.io'
          ? { id: SELLER_ID, active: true }
          : null,
    )

    await addTeamMember(actor(), newMember({ email: 'carla@avoqado.io', firstName: 'Carla', lastName: 'Ruiz' }))
    await addTeamMember(actor(), newMember())
    // A Free venue would already be full here (Carla's seat + Ana's pending invitation): the third one gets through anyway.
    await addTeamMember(actor(), newMember({ email: 'beto@avoqado.io', firstName: 'Beto', lastName: 'Díaz' }))

    expect(invite).toHaveBeenCalledTimes(2)
    expect(invite).toHaveBeenNthCalledWith(1, VENUE_ID, ADMIN_ID, {
      role: StaffRole.VIEWER,
      email: 'ana@avoqado.io',
      firstName: 'Ana',
      lastName: 'López',
    })
    expect(invite).toHaveBeenNthCalledWith(2, VENUE_ID, ADMIN_ID, {
      role: StaffRole.VIEWER,
      email: 'beto@avoqado.io',
      firstName: 'Beto',
      lastName: 'Díaz',
    })
    // Carla already had an account: a VIEWER seat in the internal venue, no invitation.
    expect(prismaMock.staffVenue.upsert).toHaveBeenCalledTimes(1)
    expect(prismaMock.staffVenue.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { staffId_venueId: { staffId: SELLER_ID, venueId: VENUE_ID } },
        create: expect.objectContaining({ staffId: SELLER_ID, venueId: VENUE_ID, role: StaffRole.VIEWER, active: true }),
      }),
    )
    expect(prismaMock.platformAccess.upsert).toHaveBeenCalledTimes(3)
    await expect(getVenueSeatCap(VENUE_ID)).resolves.toBeNull()
    // Every change of keys is audited at platform level (no venue).
    expect(logAction).toHaveBeenCalledTimes(3)
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'CRM_TEAM_MEMBER_ADDED',
        entity: 'PlatformAccess',
        entityId: ROW_ID,
        staffId: ADMIN_ID,
        venueId: null,
      }),
    )
  })

  it('readd_con_invitacion_vencida_reinvita', async () => {
    // I-1: Ana was invited and never accepted. The invitation made her PROVISIONAL account (inactive, no password) and has
    // now expired. Adding her again must invite her again: a bare seat would leave her with no way to log in.
    invite.mockImplementation(realInviteTeamMember)
    teamExists()
    const provisional = { id: 'cstaffprv0000000000000001', email: 'ana@avoqado.io', active: false, emailVerified: false, password: null }
    prismaMock.platformAccess.findUnique.mockResolvedValue(storedRow({ email: 'ana@avoqado.io', staffId: null, active: false }))
    prismaMock.staff.findUnique.mockImplementation(async ({ where }: any) =>
      where.id === ADMIN_ID
        ? { id: ADMIN_ID, firstName: 'Founder', lastName: 'Avoqado' }
        : where.email === 'ana@avoqado.io'
          ? provisional
          : null,
    )
    prismaMock.staffVenue.findUnique.mockResolvedValue(null)
    prismaMock.invitation.findFirst.mockResolvedValue(null) // the old one expired: no live invitation
    prismaMock.invitation.count.mockResolvedValue(0)
    prismaMock.staffVenue.count.mockResolvedValue(0)
    prismaMock.invitation.create.mockImplementation(async ({ data }: any) => ({
      id: 'cinvitati0000000000000009',
      token: 'nuevo',
      status: 'PENDING',
      createdAt: new Date(),
      ...data,
    }))

    await expect(addTeamMember(actor(), newMember())).resolves.toEqual(expect.objectContaining({ invited: true }))

    expect(invite).toHaveBeenCalledWith(VENUE_ID, ADMIN_ID, expect.objectContaining({ email: 'ana@avoqado.io', role: StaffRole.VIEWER }))
    expect(prismaMock.invitation.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ email: 'ana@avoqado.io', venueId: VENUE_ID, role: StaffRole.VIEWER }) }),
    )
    // Her provisional account is reused (no second one) and no seat is handed out before she accepts.
    expect(prismaMock.staff.create).not.toHaveBeenCalled()
    expect(prismaMock.staffVenue.upsert).not.toHaveBeenCalled()
    // An invitation still alive is replaced, so «it never arrived» gets a fresh link too.
    expect(prismaMock.invitation.updateMany).toHaveBeenCalledWith({
      where: { email: 'ana@avoqado.io', venueId: VENUE_ID, status: InvitationStatus.PENDING },
      data: { status: InvitationStatus.REVOKED },
    })
  })

  it('cuenta_con_mayusculas_recibe_invitacion', async () => {
    // Ruling 16 (N-1): the account is looked up EXACTLY like login, reset, Google and invitation acceptance do — the exact
    // lowercase email. An active account stored with capitals (typed into the superadmin) can never log in, so a seat would
    // leave Ana with no way in. She gets an invitation instead: accepting it makes the lowercase account she CAN log in with.
    const capitalized = { id: SELLER_ID, email: 'Ana.Lopez@avoqado.io', active: true }
    prismaMock.staff.findUnique.mockImplementation(async ({ where }: any) =>
      where.id === ADMIN_ID
        ? { id: ADMIN_ID, firstName: 'Founder', lastName: 'Avoqado' }
        : where.email === capitalized.email
          ? capitalized
          : null,
    )
    // A case-insensitive lookup WOULD find that account — the trap this test guards against.
    prismaMock.staff.findFirst.mockImplementation(async ({ where }: any) =>
      where.email?.mode === 'insensitive' && String(where.email.equals).toLowerCase() === 'ana.lopez@avoqado.io' ? capitalized : null,
    )

    await expect(addTeamMember(actor(), newMember({ email: 'Ana.Lopez@avoqado.io' }))).resolves.toEqual(
      expect.objectContaining({ invited: true }),
    )
    expect(prismaMock.staff.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { email: 'ana.lopez@avoqado.io' } }))
    expect(prismaMock.staffVenue.upsert).not.toHaveBeenCalled()
    expect(invite).toHaveBeenCalledWith(VENUE_ID, ADMIN_ID, expect.objectContaining({ email: 'ana.lopez@avoqado.io' }))
  })

  it('invitacion_sin_correo_devuelve_liga', async () => {
    // N-4: the new invitation's email did not go out — and the old link was already revoked. The admin gets the link to
    // send it by hand, and the ActivityLog says it was not sent (without the link: it opens the invitation).
    const link = 'https://dashboard.avoqado.io/invite/tok-no-enviado'
    invite.mockResolvedValue({ emailSent: false, isTPVOnly: false, invitation: {}, inviteLink: link })

    await expect(addTeamMember(actor(), newMember())).resolves.toEqual(
      expect.objectContaining({ invited: true, invitationEmailSent: false, inviteLink: link }),
    )
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'CRM_TEAM_INVITATION_EMAIL_NOT_SENT',
        entity: 'PlatformAccess',
        entityId: ROW_ID,
        staffId: ADMIN_ID,
        venueId: null,
      }),
    )
    expect(JSON.stringify(jest.mocked(logAction).mock.calls)).not.toContain('tok-no-enviado')

    // When the email does go out, the link stays out of the response.
    jest.mocked(logAction).mockClear()
    invite.mockResolvedValue({ emailSent: true, isTPVOnly: false, invitation: {}, inviteLink: `${link}-2` })
    const sent = await addTeamMember(actor(), newMember())
    expect(sent).toEqual(expect.objectContaining({ invited: true, invitationEmailSent: true }))
    expect((sent as { inviteLink?: string }).inviteLink).toBeUndefined()
    expect(logAction).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'CRM_TEAM_INVITATION_EMAIL_NOT_SENT' }))
  })

  it('si_la_invitacion_falla_queda_en_bitacora', async () => {
    // M-2: the keys are on as soon as the row is saved. If the invitation then fails, the grant is still on record.
    invite.mockRejectedValue(new Error('invitation failed'))

    await expect(addTeamMember(actor(), newMember())).rejects.toThrow('invitation failed')
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'CRM_TEAM_MEMBER_ADDED', entity: 'PlatformAccess', entityId: ROW_ID, venueId: null }),
    )
  })

  it('correo_en_minusculas', async () => {
    // The schema normalizes it...
    const parsed = addTeamMemberSchema.parse({ body: newMember({ email: '  Ana.Lopez@Avoqado.IO ' }) })
    expect(parsed.body.email).toBe('ana.lopez@avoqado.io')

    // ...and so does the service: a caller that skips the schema still stores and invites in lowercase.
    await addTeamMember(actor(), newMember({ email: '  Ana.Lopez@Avoqado.IO ' }))
    expect(prismaMock.platformAccess.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { email: 'ana.lopez@avoqado.io' },
        create: expect.objectContaining({ email: 'ana.lopez@avoqado.io', createdById: ADMIN_ID }),
      }),
    )
    expect(prismaMock.staff.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { email: 'ana.lopez@avoqado.io' } }))
    expect(invite).toHaveBeenCalledWith(VENUE_ID, ADMIN_ID, expect.objectContaining({ email: 'ana.lopez@avoqado.io' }))
  })

  it('volver_a_dar_llaves_suelta_el_amarre', async () => {
    // Giving keys to an email again hands them to whoever holds that email NOW (ruling 10): the old tie is cut, and the
    // next verified person who uses the row claims it. It is how an admin fixes a legitimate change of email.
    prismaMock.platformAccess.findUnique.mockResolvedValue(storedRow({ email: 'ana@avoqado.io', active: false }))

    await addTeamMember(actor(), newMember())

    expect(prismaMock.platformAccess.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ active: true, staffId: null, verScope: 'propios' }) }),
    )
  })
})

describe('who may give which key', () => {
  it('nadie_da_mas_llaves_de_las_que_tiene', async () => {
    const withoutVentas = actor({ ventas: false })

    await expect(addTeamMember(withoutVentas, newMember({ keys: keys({ ventas: true }) }))).rejects.toMatchObject({
      statusCode: 403,
      code: 'CRM_KEY_ESCALATION',
    })

    // Nor by editing someone already on the team...
    prismaMock.platformAccess.findFirst.mockResolvedValue(storedRow())
    await expect(updateTeamMember(withoutVentas, ROW_ID, keys({ ventas: true }))).rejects.toMatchObject({ statusCode: 403 })
    // ...nor by widening a scope past their own...
    await expect(updateTeamMember(actor({ ver: 'propios', editar: 'propios' }), ROW_ID, keys({ ver: 'todos' }))).rejects.toMatchObject({
      statusCode: 403,
    })
    // ...nor by waking up a key stored without «Ver negocios», which never worked: it counts as a new key.
    prismaMock.platformAccess.findFirst.mockResolvedValue(storedRow({ verScope: null, editarScope: null, contactar: false, ventas: true }))
    await expect(updateTeamMember(withoutVentas, ROW_ID, keys({ ventas: true }))).rejects.toMatchObject({ statusCode: 403 })

    expect(prismaMock.platformAccess.upsert).not.toHaveBeenCalled()
    expect(prismaMock.platformAccess.update).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
  })

  it('repost_suelta_amarre_y_valida_todo', async () => {
    // I-2: adding again an ACTIVE row someone already claimed cuts the tie — the keys go to whoever holds the email now —
    // so the WHOLE grant is checked, not only what changes. The founder gave Carla «Ver ventas»; an admin without it
    // cannot pass that key on to the next holder of her address.
    prismaMock.platformAccess.findUnique.mockResolvedValue(storedRow({ ventas: true }))
    const withoutVentas = actor({ ventas: false })

    await expect(
      addTeamMember(withoutVentas, newMember({ email: 'carla@avoqado.io', keys: keys({ ventas: true }) })),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'CRM_KEY_ESCALATION',
    })
    expect(prismaMock.platformAccess.upsert).not.toHaveBeenCalled()

    // What the admin does hold can be given again: the tie is cut and the next verified holder claims the row.
    await addTeamMember(withoutVentas, newMember({ email: 'carla@avoqado.io' }))
    expect(prismaMock.platformAccess.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ staffId: null, ventas: false }) }),
    )

    // A row nobody claimed yet stays promised to the same email: keeping a key there is not giving it.
    prismaMock.platformAccess.upsert.mockClear()
    prismaMock.platformAccess.findUnique.mockResolvedValue(storedRow({ staffId: null, ventas: true }))
    await addTeamMember(withoutVentas, newMember({ email: 'carla@avoqado.io', keys: keys({ ventas: true }) }))
    expect(prismaMock.platformAccess.upsert).toHaveBeenCalledTimes(1)
  })

  it('puede_editar_a_quien_tiene_mas_llaves_sin_quitarselas', async () => {
    // The founder gave Carla «Ver ventas». An admin without it can still turn her email key off: keeping a key someone
    // already has is not giving it.
    prismaMock.platformAccess.findFirst.mockResolvedValue(storedRow({ ventas: true }))
    prismaMock.platformAccess.update.mockImplementation(async ({ data }: any) => storedRow({ ...data }))

    const updated = await updateTeamMember(actor({ ventas: false }), ROW_ID, keys({ ventas: true, contactar: false }))

    expect(updated).toEqual(expect.objectContaining({ id: ROW_ID, keys: expect.objectContaining({ ventas: true, contactar: false }) }))
    expect(prismaMock.platformAccess.update).toHaveBeenCalledWith({
      where: { id: ROW_ID },
      data: expect.objectContaining({ ventas: true, contactar: false, verScope: 'propios' }),
    })
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'CRM_TEAM_MEMBER_KEYS_UPDATED',
        entity: 'PlatformAccess',
        entityId: ROW_ID,
        staffId: ADMIN_ID,
        venueId: null,
      }),
    )
  })

  it('combinacion_editar_todos_ver_propios_422', async () => {
    const wider = keys({ ver: 'propios', editar: 'todos' })

    await expect(addTeamMember(actor(), newMember({ keys: wider }))).rejects.toMatchObject({
      statusCode: 422,
      code: 'CRM_EDIT_WIDER_THAN_VIEW',
    })
    prismaMock.platformAccess.findFirst.mockResolvedValue(storedRow())
    await expect(updateTeamMember(actor(), ROW_ID, wider)).rejects.toMatchObject({ statusCode: 422, code: 'CRM_EDIT_WIDER_THAN_VIEW' })

    expect(prismaMock.platformAccess.upsert).not.toHaveBeenCalled()
    expect(prismaMock.platformAccess.update).not.toHaveBeenCalled()
  })

  it('llave_dependiente_sin_ver_422', async () => {
    const noVer = { ver: null, editar: null, contactar: false }
    for (const dependent of [{ editar: 'propios' }, { contactar: true }, { exportar: true }, { ventas: true }]) {
      await expect(addTeamMember(actor(), newMember({ keys: keys({ ...noVer, ...dependent }) }))).rejects.toMatchObject({
        statusCode: 422,
        code: 'CRM_KEY_NEEDS_VER',
      })
    }
    prismaMock.platformAccess.findFirst.mockResolvedValue(storedRow())
    await expect(updateTeamMember(actor(), ROW_ID, keys({ ...noVer, exportar: true }))).rejects.toMatchObject({ statusCode: 422 })
    expect(prismaMock.platformAccess.upsert).not.toHaveBeenCalled()

    // «Campañas masivas» and «Administrar» stand alone: the marketing profile needs no «Ver negocios».
    await expect(addTeamMember(actor(), newMember({ keys: keys({ ...noVer, campanas: true }) }))).resolves.toBeDefined()
  })
})

/**
 * Ruling 60: the screen sends the keys it SAW (`expectedKeys`). Two admins editing Carla at once must not have the second
 * silently undo the first: if her keys changed since the screen read them, nothing is written and the 409 says so.
 */
describe('expectedKeys: lo viejo no pisa lo nuevo (ruling 60)', () => {
  it('llaves_cambiaron_409_sin_escribir', async () => {
    // The screen opened with «Ver ventas» off; meanwhile another admin turned it on.
    prismaMock.platformAccess.findFirst.mockResolvedValue(storedRow({ ventas: true }))

    await expect(updateTeamMember(actor(), ROW_ID, keys({ contactar: false }), keys())).rejects.toMatchObject({
      statusCode: 409,
      code: 'CRM_LLAVES_CAMBIARON',
      message: 'Alguien más cambió sus llaves',
    })
    expect(prismaMock.platformAccess.update).not.toHaveBeenCalled()
    expect(prismaMock.platformAccess.updateManyAndReturn).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
  })

  it('compara_las_llaves_efectivas_y_escribe_con_cas', async () => {
    // Stored without «Ver negocios», her «Mandar correo» never worked: the screen showed it OFF, and that is what it sends.
    prismaMock.platformAccess.findFirst.mockResolvedValue(storedRow({ verScope: null, editarScope: null, contactar: true }))
    prismaMock.platformAccess.updateManyAndReturn.mockImplementation(async ({ data }: any) => [storedRow({ ...data })])

    const updated = await updateTeamMember(actor(), ROW_ID, keys(), keys({ ver: null, editar: null, contactar: false }))

    expect(updated.keys).toEqual(expect.objectContaining({ ver: 'propios', contactar: true }))
    // The write is the compare-and-set: it only lands on the row exactly as it was read.
    expect(prismaMock.platformAccess.updateManyAndReturn).toHaveBeenCalledWith({
      where: {
        id: ROW_ID,
        active: true,
        verScope: null,
        editarScope: null,
        contactar: true,
        campanas: false,
        exportar: false,
        ventas: false,
        admin: false,
      },
      data: expect.objectContaining({ verScope: 'propios', editarScope: 'propios', contactar: true }),
    })
    expect(prismaMock.platformAccess.update).not.toHaveBeenCalled()
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'CRM_TEAM_MEMBER_KEYS_UPDATED', entityId: ROW_ID }))
  })

  it('otro_admin_gana_entre_la_lectura_y_la_escritura_409', async () => {
    prismaMock.platformAccess.findFirst.mockResolvedValue(storedRow())
    // Same keys at the read, different ones at the write: the UPDATE matches no row.
    prismaMock.platformAccess.updateManyAndReturn.mockResolvedValue([])

    await expect(updateTeamMember(actor(), ROW_ID, keys({ contactar: false }), keys())).rejects.toMatchObject({
      statusCode: 409,
      code: 'CRM_LLAVES_CAMBIARON',
    })
    expect(logAction).not.toHaveBeenCalled()
  })

  it('el_esquema_acepta_expectedKeys_opcional_con_la_forma_de_keys', () => {
    const params = { id: ROW_ID }
    expect(
      updateTeamMemberSchema.parse({ params, body: { keys: keys(), expectedKeys: keys({ ventas: true }) } }).body.expectedKeys,
    ).toEqual(keys({ ventas: true }))
    expect(updateTeamMemberSchema.parse({ params, body: { keys: keys() } }).body.expectedKeys).toBeUndefined()
    // All seven, like `keys`: half a set cannot be compared.
    expect(updateTeamMemberSchema.safeParse({ params, body: { keys: keys(), expectedKeys: { ver: 'propios' } } }).success).toBe(false)
  })
})

describe('removeTeamMember', () => {
  /** Beto is on the team (claimed row with «Ver negocios»), so he can receive accounts. */
  function personOnTheTeam(staffId: string) {
    prismaMock.staff.findUnique.mockResolvedValue({ email: 'beto@avoqado.io', active: true, emailVerified: true })
    prismaMock.staffVenue.findFirst.mockResolvedValue(null) // not a superadmin
    prismaMock.platformAccess.findUnique.mockResolvedValue(storedRow({ id: ROW2_ID, email: 'beto@avoqado.io', staffId }))
  }

  /** A transaction client of its own, so the test sees which writes happened INSIDE the one transaction. */
  function transactionClient(moved: Array<{ id: string }>) {
    return {
      platformAccess: { update: jest.fn().mockResolvedValue({}) },
      invitation: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      staffVenue: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      staffOrganization: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      crmAccount: { updateManyAndReturn: jest.fn().mockResolvedValue(moved) },
      crmActivity: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      crmTimelineEvent: { createMany: jest.fn().mockResolvedValue({ count: moved.length }) },
    }
  }

  it('baja_reasigna_en_la_misma_transaccion', async () => {
    teamExists()
    prismaMock.platformAccess.findFirst.mockResolvedValue(storedRow())
    personOnTheTeam(OTHER_ID)
    const tx = transactionClient([{ id: ACCOUNT_A }, { id: ACCOUNT_B }])
    prismaMock.$transaction.mockImplementationOnce((callback: any) => callback(tx))

    await expect(removeTeamMember(actor(), ROW_ID, { reasignarA: OTHER_ID })).resolves.toEqual({ id: ROW_ID, released: 2 })

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
    expect(tx.platformAccess.update).toHaveBeenCalledWith({ where: { id: ROW_ID }, data: { active: false, staffId: null } })
    // The seat gives its PIN back: @@unique([venueId, pin]) counts inactive seats, so a kept PIN could never be reused.
    expect(tx.staffVenue.updateMany).toHaveBeenCalledWith({
      where: { staffId: SELLER_ID, venueId: VENUE_ID, active: true },
      data: { active: false, endDate: expect.any(Date), pin: null },
    })
    expect(tx.crmAccount.updateManyAndReturn).toHaveBeenCalledWith({
      where: { ownerStaffId: SELLER_ID, stage: { kind: 'ABIERTA' } },
      data: { ownerStaffId: OTHER_ID },
      select: { id: true },
    })
    // Ruling 12: their pending activities on those accounts go with them, so the new owner's «Mis pendientes» sees them.
    expect(tx.crmActivity.updateMany).toHaveBeenCalledWith({
      where: { accountId: { in: [ACCOUNT_A, ACCOUNT_B] }, doneAt: null },
      data: { assigneeStaffId: OTHER_ID },
    })
    expect(tx.crmTimelineEvent.createMany).toHaveBeenCalledWith({
      data: [ACCOUNT_A, ACCOUNT_B].map(accountId => ({
        accountId,
        kind: 'OWNER_CHANGE',
        actorStaffId: ADMIN_ID,
        data: { fromStaffId: SELLER_ID, toStaffId: OTHER_ID, reason: 'TEAM_MEMBER_REMOVED' },
      })),
    })
    // Nothing of it is written outside that transaction.
    for (const write of [
      prismaMock.platformAccess.update,
      prismaMock.staffVenue.updateMany,
      prismaMock.crmAccount.updateManyAndReturn,
      prismaMock.crmActivity.updateMany,
      prismaMock.crmTimelineEvent.createMany,
    ]) {
      expect(write).not.toHaveBeenCalled()
    }
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'CRM_TEAM_MEMBER_REMOVED',
        entity: 'PlatformAccess',
        entityId: ROW_ID,
        staffId: ADMIN_ID,
        venueId: null,
      }),
    )

    // The LAST write fails: the whole removal fails with it (the transaction rolls back) and nothing is audited as done.
    jest.mocked(logAction).mockClear()
    const failing = transactionClient([{ id: ACCOUNT_A }])
    failing.crmTimelineEvent.createMany.mockRejectedValue(new Error('timeline write failed'))
    prismaMock.$transaction.mockImplementationOnce((callback: any) => callback(failing))
    await expect(removeTeamMember(actor(), ROW_ID, { reasignarA: OTHER_ID })).rejects.toThrow('timeline write failed')
    expect(failing.platformAccess.update).toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
  })

  it('baja_revoca_invitacion_y_membresia', async () => {
    // Ruling 14: whoever leaves keeps nothing of the team — not a pending invitation (accepting it would let them back in)
    // nor the membership of the team's organization — in the same transaction.
    teamExists()
    prismaMock.platformAccess.findFirst.mockResolvedValue(storedRow())
    const tx = transactionClient([])
    prismaMock.$transaction.mockImplementationOnce((callback: any) => callback(tx))

    await removeTeamMember(actor(), ROW_ID, {})

    expect(tx.invitation.updateMany).toHaveBeenCalledWith({
      where: { email: 'carla@avoqado.io', venueId: VENUE_ID, status: InvitationStatus.PENDING },
      data: { status: InvitationStatus.REVOKED },
    })
    expect(tx.staffOrganization.updateMany).toHaveBeenCalledWith({
      where: { staffId: SELLER_ID, organizationId: ORG_ID, isActive: true },
      data: { isActive: false, leftAt: expect.any(Date) },
    })
    expect(prismaMock.invitation.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.staffOrganization.updateMany).not.toHaveBeenCalled()

    // Someone with no Avoqado account at all: their invitation is revoked all the same.
    const noAccount = transactionClient([])
    prismaMock.$transaction.mockImplementationOnce((callback: any) => callback(noAccount))
    prismaMock.platformAccess.findFirst.mockResolvedValue(storedRow({ email: 'nadie@avoqado.io', staffId: null }))

    await removeTeamMember(actor(), ROW_ID, {})

    expect(noAccount.invitation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ email: 'nadie@avoqado.io' }) }),
    )
    expect(noAccount.staffOrganization.updateMany).not.toHaveBeenCalled()
  })

  it('baja_sin_reasignar_quedan_sin_dueno', async () => {
    teamExists()
    prismaMock.platformAccess.findFirst.mockResolvedValue(storedRow())
    const tx = transactionClient([{ id: ACCOUNT_A }])
    prismaMock.$transaction.mockImplementationOnce((callback: any) => callback(tx))

    await expect(removeTeamMember(actor(), ROW_ID, {})).resolves.toEqual({ id: ROW_ID, released: 1 })

    expect(tx.crmAccount.updateManyAndReturn).toHaveBeenCalledWith(expect.objectContaining({ data: { ownerStaffId: null } }))
    // Left without anyone in charge, like their account: they show in its ficha and in the admins' daily digest.
    expect(tx.crmActivity.updateMany).toHaveBeenCalledWith({
      where: { accountId: { in: [ACCOUNT_A] }, doneAt: null },
      data: { assigneeStaffId: null },
    })
    expect(tx.crmTimelineEvent.createMany).toHaveBeenCalledWith({
      data: [
        {
          accountId: ACCOUNT_A,
          kind: 'OWNER_CHANGE',
          actorStaffId: ADMIN_ID,
          data: { fromStaffId: SELLER_ID, toStaffId: null, reason: 'TEAM_MEMBER_REMOVED' },
        },
      ],
    })
  })

  it('reasignar_a_quien_no_es_del_equipo_422', async () => {
    teamExists()
    prismaMock.platformAccess.findFirst.mockResolvedValue(storedRow())
    // Beto has no keys at all.
    prismaMock.staff.findUnique.mockResolvedValue({ email: 'beto@avoqado.io', active: true, emailVerified: true })
    prismaMock.staffVenue.findFirst.mockResolvedValue(null)
    prismaMock.platformAccess.findUnique.mockResolvedValue(null)

    await expect(removeTeamMember(actor(), ROW_ID, { reasignarA: OTHER_ID })).rejects.toMatchObject({
      statusCode: 422,
      code: 'CRM_REASSIGN_TARGET_INVALID',
    })
    // Nor to the very person who leaves.
    await expect(removeTeamMember(actor(), ROW_ID, { reasignarA: SELLER_ID })).rejects.toMatchObject({ statusCode: 422 })
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it('reasignar_a_quien_solo_ve_422 (m-3, ruling 52): whoever receives the accounts must be able to edit them', async () => {
    teamExists()
    prismaMock.platformAccess.findFirst.mockResolvedValue(storedRow())
    prismaMock.staff.findUnique.mockResolvedValue({ email: 'beto@avoqado.io', active: true, emailVerified: true })
    prismaMock.staffVenue.findFirst.mockResolvedValue(null)
    prismaMock.platformAccess.findUnique.mockResolvedValue(
      storedRow({ id: ROW2_ID, email: 'beto@avoqado.io', staffId: OTHER_ID, editarScope: null }),
    )

    await expect(removeTeamMember(actor(), ROW_ID, { reasignarA: OTHER_ID })).rejects.toMatchObject({
      statusCode: 422,
      code: 'CRM_REASSIGN_TARGET_INVALID',
    })
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it('reasignar_a_staff_uuid', async () => {
    // M-3: some Staff ids are UUIDs (an accepted invitation can create the account with uuidv4). The schema takes any id;
    // the service is what checks that the person is on the team.
    const UUID = '3b241101-e2bb-4255-8caf-4136c566a962'
    expect(removeTeamMemberSchema.parse({ params: { id: ROW_ID }, body: { reasignarA: UUID } }).body.reasignarA).toBe(UUID)

    teamExists()
    prismaMock.platformAccess.findFirst.mockResolvedValue(storedRow())
    personOnTheTeam(UUID)
    const tx = transactionClient([{ id: ACCOUNT_A }])
    prismaMock.$transaction.mockImplementationOnce((callback: any) => callback(tx))

    await expect(removeTeamMember(actor(), ROW_ID, { reasignarA: UUID })).resolves.toEqual({ id: ROW_ID, released: 1 })
    expect(tx.crmAccount.updateManyAndReturn).toHaveBeenCalledWith(expect.objectContaining({ data: { ownerStaffId: UUID } }))
  })
})

describe('listTeamMembers', () => {
  it('lista_del_equipo_acotada_a_100', async () => {
    prismaMock.platformAccess.findMany.mockResolvedValue([
      storedRow(),
      // Not claimed yet (Beto has not entered the CRM): his account is found by its exact lowercase email.
      storedRow({ id: ROW2_ID, email: 'beto@avoqado.io', staffId: null, contactar: false }),
    ])
    prismaMock.platformAccess.count.mockResolvedValue(250)
    prismaMock.staff.findMany.mockResolvedValue([
      { id: SELLER_ID, email: 'carla@avoqado.io', firstName: 'Carla', lastName: 'Ruiz' },
      { id: OTHER_ID, email: 'beto@avoqado.io', firstName: 'Beto', lastName: 'Díaz' },
    ])
    prismaMock.crmAccount.groupBy.mockResolvedValue([{ ownerStaffId: SELLER_ID, _count: { _all: 3 } }])

    // A hostile page size: the server caps it.
    const page = await listTeamMembers({ page: 2, pageSize: 5000 })

    expect(prismaMock.platformAccess.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { active: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: 100, take: 100 }),
    )
    expect(prismaMock.staff.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        // Exact lowercase email, the login's rule (ruling 16): an account stored with capitals cannot log in anyway.
        where: { OR: [{ id: { in: [SELLER_ID] } }, { email: { in: ['beto@avoqado.io'] } }] },
      }),
    )
    expect(page.meta).toEqual({ total: 250, page: 2, pageSize: 100, totalPages: 3 })
    expect(page.data).toEqual([
      expect.objectContaining({
        id: ROW_ID,
        email: 'carla@avoqado.io',
        staffId: SELLER_ID,
        firstName: 'Carla',
        lastName: 'Ruiz',
        openAccounts: 3,
        keys: { ver: 'propios', editar: 'propios', contactar: true, campanas: false, exportar: false, ventas: false, admin: false },
      }),
      expect.objectContaining({ id: ROW2_ID, staffId: OTHER_ID, firstName: 'Beto', openAccounts: 0 }),
    ])
    // Two queries for the whole page, never one per member.
    expect(prismaMock.staff.findMany).toHaveBeenCalledTimes(1)
    expect(prismaMock.crmAccount.groupBy).toHaveBeenCalledTimes(1)
  })
})

describe('listTeamOptions', () => {
  it('opciones_del_equipo_solo_para_quien_reasigna', async () => {
    // Ruling 13: a seller who edits only their own accounts cannot reassign, so they do not even get the names.
    await expect(listTeamOptions(actor({ editar: 'propios', admin: false }))).resolves.toEqual([])
    expect(prismaMock.platformAccess.findMany).not.toHaveBeenCalled()

    // Whoever can reassign gets every member `reassign` would accept (M-4): active keys with «Ver» AND «Editar» (m-3,
    // ruling 52), and a person `getCrmAccess` would really give them to.
    const CHANGED_ID = 'cstaffchg0000000000000001'
    prismaMock.platformAccess.findMany.mockResolvedValue([
      { staffId: SELLER_ID, email: 'carla@avoqado.io' },
      // Not claimed yet: whoever holds the email today, the one who will claim it — only with a verified email.
      { staffId: null, email: 'beto@avoqado.io' },
      // Invited and never accepted: nobody to give an account to yet.
      { staffId: null, email: 'nadie@avoqado.io' },
      // Claimed, but that person changed their email since: the keys no longer reach them (`getCrmAccess` looks the row up by
      // the person's email), so `reassign` would refuse them.
      { staffId: CHANGED_ID, email: 'luis@avoqado.io' },
      // Ruling 22: the admin added Luis's NEW address before removing the old row. Unclaimed and verified, but Luis already
      // holds the old row: `getCrmAccess` could never claim this one for him (`staffId` is unique, P2002), so neither.
      { staffId: null, email: 'luis.nuevo@avoqado.io' },
    ])
    prismaMock.staff.findMany.mockResolvedValue([
      // The email of a Staff may keep the capitals typed in; the keys are stored lowercase.
      { id: SELLER_ID, email: 'Carla@Avoqado.io', emailVerified: true, firstName: 'Carla', lastName: 'Ruiz' },
      { id: OTHER_ID, email: 'beto@avoqado.io', emailVerified: true, firstName: 'Beto', lastName: 'Díaz' },
      { id: CHANGED_ID, email: 'luis.nuevo@avoqado.io', emailVerified: true, firstName: 'Luis', lastName: 'Ramírez' },
    ])

    await expect(listTeamOptions(actor({ editar: 'todos', admin: false }))).resolves.toEqual([
      { staffId: SELLER_ID, name: 'Carla Ruiz' },
      { staffId: OTHER_ID, name: 'Beto Díaz' },
    ])
    expect(prismaMock.platformAccess.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { active: true, verScope: { in: ['propios', 'todos'] }, editarScope: { in: ['propios', 'todos'] } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 100,
      }),
    )
    expect(prismaMock.staff.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        // An unclaimed row only goes to someone with a verified email: `getCrmAccess` never claims it for anyone else.
        where: {
          active: true,
          OR: [
            { id: { in: [SELLER_ID, CHANGED_ID] } },
            { email: { in: ['beto@avoqado.io', 'nadie@avoqado.io', 'luis.nuevo@avoqado.io'] }, emailVerified: true },
          ],
        },
      }),
    )

    // An admin without «Editar: todos» reassigns from «Equipo de ventas» too.
    await expect(listTeamOptions(actor({ editar: null, ver: null, admin: true }))).resolves.toHaveLength(2)
  })
})
