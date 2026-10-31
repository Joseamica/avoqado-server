/**
 * Avoqado's internal sales-team venue and the «Equipo de ventas» screen (spec 2026-10-30 §5.1, plan task 3).
 *
 * A seller logs in as a VIEWER of one internal venue, «Avoqado · Equipo de ventas», inside the organization named by
 * `CRM_TEAM_ORGANIZATION_ID`; what they can do in the CRM is their `PlatformAccess` keys. The venue must never hit the
 * Free seat cap nor the KYC queue, an admin never hands out a key they do not hold, and taking someone off the team
 * moves their open accounts in the same transaction that takes their keys away.
 */
import { Prisma, StaffRole, VenueStatus, VerificationStatus } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'
import { logAction } from '@/services/dashboard/activity-log.service'

jest.mock('@/services/email.service', () => ({
  __esModule: true,
  default: { sendTeamInvitation: jest.fn().mockResolvedValue(true) },
}))
jest.mock('@/services/dashboard/venueRoleConfig.dashboard.service', () => ({
  getRoleDisplayName: jest.fn().mockResolvedValue('Visor'),
}))

import * as teamDashboard from '@/services/dashboard/team.dashboard.service'
import { getVenueSeatCap } from '@/services/access/seatCap.service'
import { addTeamMemberSchema } from '@/schemas/crm.schema'
import type { CrmAccess } from '@/services/crm/access.service'
import { addTeamMember, ensureCrmTeamVenue, listTeamMembers, removeTeamMember, updateTeamMember } from '@/services/crm/teamVenue.service'

const ORG_ID = 'corgprime0000000000000001'
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
 * The Venue table, faked in memory: what `venue.create` stores is exactly what every later read sees — the seat cap
 * included. The organization itself is NOT grandfathered, so only the venue's own flag can lift the cap.
 */
let venueRow: Record<string, unknown> | null
function fakeVenueTable() {
  venueRow = null
  prismaMock.venue.findUnique.mockImplementation(async () =>
    venueRow ? { ...venueRow, organization: { id: ORG_ID, name: 'Grupo Avoqado Prime', seatCapExempt: false } } : null,
  )
  prismaMock.venue.create.mockImplementation(async ({ data }: any) => (venueRow = { id: VENUE_ID, ...data }))
}

const configured = () => [
  prismaMock.venue.findUnique,
  prismaMock.venue.create,
  prismaMock.platformAccess.findUnique,
  prismaMock.platformAccess.findFirst,
  prismaMock.platformAccess.findMany,
  prismaMock.platformAccess.count,
  prismaMock.platformAccess.upsert,
  prismaMock.platformAccess.update,
  prismaMock.staff.findUnique,
  prismaMock.staff.findMany,
  prismaMock.staff.create,
  prismaMock.staffVenue.upsert,
  prismaMock.staffVenue.updateMany,
  prismaMock.staffVenue.count,
  prismaMock.staffVenue.findFirst,
  prismaMock.invitation.findFirst,
  prismaMock.invitation.count,
  prismaMock.invitation.create,
  prismaMock.staffOrganization.create,
  prismaMock.venueFeature.findMany,
  prismaMock.crmAccount.groupBy,
  prismaMock.crmAccount.updateManyAndReturn,
  prismaMock.crmTimelineEvent.createMany,
  prismaMock.$transaction,
]

let invite: jest.SpyInstance

beforeEach(() => {
  process.env.CRM_TEAM_ORGANIZATION_ID = ORG_ID
  for (const fn of configured()) fn.mockReset()
  prismaMock.$transaction.mockImplementation((callback: any) => callback(prismaMock))
  fakeVenueTable()
  prismaMock.platformAccess.findUnique.mockResolvedValue(null)
  prismaMock.platformAccess.upsert.mockImplementation(async ({ create }: any) => storedRow({ ...create, staffId: null }))
  // By id: the admin who invites. By email: nobody has an account yet.
  prismaMock.staff.findUnique.mockImplementation(async ({ where }: any) =>
    where.id === ADMIN_ID ? { id: ADMIN_ID, firstName: 'Founder', lastName: 'Avoqado' } : null,
  )
  invite = jest.spyOn(teamDashboard, 'inviteTeamMember').mockResolvedValue({ emailSent: true, isTPVOnly: false, invitation: {} })
})

afterEach(() => invite.mockRestore())

afterAll(() => {
  delete process.env.CRM_TEAM_ORGANIZATION_ID
})

describe('ensureCrmTeamVenue', () => {
  it('crea_venue_interno_exento_y_fuera_de_kyc', async () => {
    const { venueId } = await ensureCrmTeamVenue()

    expect(venueId).toBe(VENUE_ID)
    expect(prismaMock.venue.create).toHaveBeenCalledTimes(1)
    const { data } = prismaMock.venue.create.mock.calls[0][0]
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

  it('idempotente_dos_veces_un_venue', async () => {
    const first = await ensureCrmTeamVenue()
    const second = await ensureCrmTeamVenue()

    expect(second).toEqual(first)
    expect(prismaMock.venue.create).toHaveBeenCalledTimes(1)
    expect(prismaMock.venue.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { slug: 'avoqado-equipo-ventas' } }))

    // Two first calls at once: the one that loses the unique slug reads the winner's venue instead of failing.
    venueRow = null
    prismaMock.venue.create.mockImplementationOnce(async ({ data }: any) => {
      venueRow = { id: VENUE_ID, ...data }
      throw uniqueViolation()
    })
    await expect(ensureCrmTeamVenue()).resolves.toEqual({ venueId: VENUE_ID })
  })

  it('slug_en_otra_organizacion_no_se_usa', async () => {
    // Someone else's venue with our slug: sellers must never become VIEWERs of a client's venue.
    venueRow = { id: 'cvenueaje0000000000000001', organizationId: 'corgajena0000000000000001', slug: 'avoqado-equipo-ventas' }

    await expect(ensureCrmTeamVenue()).rejects.toMatchObject({ statusCode: 500 })
    expect(prismaMock.venue.create).not.toHaveBeenCalled()
  })

  it('falta_la_variable_error_claro', async () => {
    delete process.env.CRM_TEAM_ORGANIZATION_ID

    await expect(ensureCrmTeamVenue()).rejects.toMatchObject({ statusCode: 500, message: 'Falta CRM_TEAM_ORGANIZATION_ID' })
    // Adding someone fails the same way, BEFORE writing anything.
    await expect(addTeamMember(actor(), newMember())).rejects.toMatchObject({ statusCode: 500, message: 'Falta CRM_TEAM_ORGANIZATION_ID' })
    expect(prismaMock.venue.create).not.toHaveBeenCalled()
    expect(prismaMock.platformAccess.upsert).not.toHaveBeenCalled()
    expect(invite).not.toHaveBeenCalled()
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
    // Carla already has an Avoqado account; Ana and Beto do not.
    prismaMock.staff.findUnique.mockImplementation(async ({ where }: any) =>
      where.id === ADMIN_ID
        ? { id: ADMIN_ID, firstName: 'Founder', lastName: 'Avoqado' }
        : where.email === 'carla@avoqado.io'
          ? { id: SELLER_ID, email: 'carla@avoqado.io' }
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

describe('removeTeamMember', () => {
  /** Beto is on the team (claimed row with «Ver negocios»), so he can receive accounts. */
  function betoIsOnTheTeam() {
    prismaMock.staff.findUnique.mockResolvedValue({ email: 'beto@avoqado.io', active: true, emailVerified: true })
    prismaMock.staffVenue.findFirst.mockResolvedValue(null) // not a superadmin
    prismaMock.platformAccess.findUnique.mockResolvedValue(storedRow({ id: ROW2_ID, email: 'beto@avoqado.io', staffId: OTHER_ID }))
  }

  /** A transaction client of its own, so the test sees which writes happened INSIDE the one transaction. */
  function transactionClient(moved: Array<{ id: string }>) {
    return {
      platformAccess: { update: jest.fn().mockResolvedValue({}) },
      staffVenue: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      crmAccount: { updateManyAndReturn: jest.fn().mockResolvedValue(moved) },
      crmTimelineEvent: { createMany: jest.fn().mockResolvedValue({ count: moved.length }) },
    }
  }

  it('baja_reasigna_en_la_misma_transaccion', async () => {
    venueRow = { id: VENUE_ID, organizationId: ORG_ID, slug: 'avoqado-equipo-ventas' }
    prismaMock.platformAccess.findFirst.mockResolvedValue(storedRow())
    betoIsOnTheTeam()
    const tx = transactionClient([{ id: ACCOUNT_A }, { id: ACCOUNT_B }])
    prismaMock.$transaction.mockImplementationOnce((callback: any) => callback(tx))

    await expect(removeTeamMember(actor(), ROW_ID, { reasignarA: OTHER_ID })).resolves.toEqual({ id: ROW_ID, released: 2 })

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
    expect(tx.platformAccess.update).toHaveBeenCalledWith({ where: { id: ROW_ID }, data: { active: false, staffId: null } })
    expect(tx.staffVenue.updateMany).toHaveBeenCalledWith({
      where: { staffId: SELLER_ID, venueId: VENUE_ID, active: true },
      data: { active: false, endDate: expect.any(Date) },
    })
    expect(tx.crmAccount.updateManyAndReturn).toHaveBeenCalledWith({
      where: { ownerStaffId: SELLER_ID, stage: { kind: 'ABIERTA' } },
      data: { ownerStaffId: OTHER_ID },
      select: { id: true },
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

  it('baja_sin_reasignar_quedan_sin_dueno', async () => {
    venueRow = { id: VENUE_ID, organizationId: ORG_ID, slug: 'avoqado-equipo-ventas' }
    prismaMock.platformAccess.findFirst.mockResolvedValue(storedRow())
    const tx = transactionClient([{ id: ACCOUNT_A }])
    prismaMock.$transaction.mockImplementationOnce((callback: any) => callback(tx))

    await expect(removeTeamMember(actor(), ROW_ID, {})).resolves.toEqual({ id: ROW_ID, released: 1 })

    expect(tx.crmAccount.updateManyAndReturn).toHaveBeenCalledWith(expect.objectContaining({ data: { ownerStaffId: null } }))
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
})

describe('listTeamMembers', () => {
  it('lista_del_equipo_acotada_a_100', async () => {
    prismaMock.platformAccess.findMany.mockResolvedValue([
      storedRow(),
      // Not claimed yet (Beto has not entered the CRM): his account is found by email.
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
