/**
 * The CRM's repair sweep (spec 2026-10-30 §5.3 step 5, plan task 6) over an in-memory database: outcomes, not calls.
 *
 * What these pin beyond the happy path: an entry that died before `appliedAt` is applied once (ruling 20); linking takes
 * the account's lock before its LINKED key (the note for task 6) and never takes an Organization another account holds;
 * no paged pass gets stuck behind what it can never finish; and «first money» is a real charge — not a plan on trial or
 * courtesy, not a pending or failed payment, not the demo venue's sample sales — set once, and «ANTERIOR_AL_CRM» when it
 * came before the account entered the CRM (ruling 28).
 */
import { prismaMock } from '@tests/__helpers__/setup'
import { FAKE_STAGE_ID, installCrmInboundFake } from '@tests/__helpers__/crmInboundFake'
import logger from '@/config/logger'
import { notifyNewProspect } from '@/services/crm/digest.service'
import { applyEntry } from '@/services/crm/inbound.service'
import {
  applyPending,
  backfillFromOnboarding,
  fillFirstMoney,
  linkLandingAccounts,
  resetSweepCursors,
  runSweep,
} from '@/services/crm/sweep.service'

jest.mock('@/services/crm/digest.service', () => ({ notifyNewProspect: jest.fn() }))

type Row = Record<string, any>

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
/** cuid v1 shape: 25 characters, starting with «c». */
const cuid = (prefix: string, n: number) => `c${prefix}${String(n).padStart(24 - prefix.length, '0')}`
const ORG = cuid('org', 1)
const OTHER_ORG = cuid('org', 2)
const TEAM_ORG = cuid('orgteam', 1)
const EMAIL = 'ana@cafe.mx'

/** The landing form as `contactSchema` leaves it. */
const FORM = {
  firstName: 'Ana',
  lastName: 'López',
  phone: '55 1234 5678',
  email: EMAIL,
  companyName: 'Café Ana',
  employees: '3',
  revenue: '500k-1m',
  businessType: 'Cafetería',
  modules: 'mesas,cocina',
  source: 'landing_restaurantes',
  utm: { utm_source: 'meta', utm_campaign: 'pos22' },
}

let db: ReturnType<typeof installCrmInboundFake>
let world: { staff: Row[]; organizations: Row[]; venues: Row[]; payments: Row[]; logs: Row[] }

/** The filters the sweep writes, evaluated as Postgres would. One it does not know fails loudly instead of passing. */
function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([field, filter]) => {
    if (field === 'OR') return (filter as Row[]).some(branch => matches(row, branch))
    const value = row[field] ?? null
    if (filter === null) return value === null
    if (filter instanceof Date) return value instanceof Date && value.getTime() === filter.getTime()
    if (typeof filter !== 'object') return value === filter
    return Object.entries(filter as Row).every(([operator, operand]) => {
      if (operator === 'in') return (operand as unknown[]).includes(value)
      if (operator === 'gt') return value !== null && value > operand
      if (operator === 'gte') return value !== null && value >= operand
      throw new Error(`The sweep fake does not know the filter ${field}.${operator}`)
    })
  })
}

function ordered(rows: Row[], orderBy: Row[] = []): Row[] {
  return [...rows].sort((a, b) => {
    for (const rule of orderBy) {
      const [field, direction] = Object.entries(rule)[0]
      if (a[field] < b[field]) return direction === 'asc' ? -1 : 1
      if (a[field] > b[field]) return direction === 'asc' ? 1 : -1
    }
    return 0
  })
}

const venueOf = (id: string) => world.venues.find(venue => venue.id === id)

/** A venue against `{ ...scalars, payments: { some } }`. */
function venueMatches(venue: Row | undefined, { payments, ...scalars }: Row = {}): boolean {
  if (!venue || !matches(venue, scalars)) return false
  return !payments || world.payments.some(payment => payment.venueId === venue.id && matches(payment, payments.some))
}

/** What a Staff `select: { organizations: <args> }` returns, reading the args the service really passes. */
function ownedBy(staff: Row, args: Row) {
  return ordered(
    staff.memberships.filter((membership: Row) => matches(membership, args.where)),
    args.orderBy,
  )
    .slice(0, args.take)
    .map((membership: Row) => ({
      organization: {
        id: membership.organizationId,
        createdAt: world.organizations.find(organization => organization.id === membership.organizationId)?.createdAt,
      },
    }))
}

/** The tables the sweep reads beyond the landing capture's, on top of `installCrmInboundFake`. */
function installSweepWorld() {
  world = { staff: [], organizations: [], venues: [], payments: [], logs: [] }
  const delegates = [
    prismaMock.crmInboundEntry.findMany,
    prismaMock.crmInboundEntry.groupBy,
    prismaMock.crmAccount.findMany,
    prismaMock.crmAccount.updateMany,
    prismaMock.staff.findMany,
    prismaMock.activityLog.findMany,
    prismaMock.organization.findMany,
    prismaMock.payment.groupBy,
    prismaMock.venue.findMany,
    prismaMock.$queryRaw,
  ]
  delegates.forEach(fn => fn.mockReset())

  prismaMock.crmInboundEntry.findMany.mockImplementation(async ({ where, orderBy, take }: Row) =>
    ordered(
      db.entries.filter(entry => matches(entry, where)),
      orderBy,
    )
      .slice(0, take)
      .map(entry => ({ id: entry.id })),
  )
  prismaMock.crmInboundEntry.groupBy.mockImplementation(async ({ by: [field], where }: Row) =>
    [...new Set(db.entries.filter(entry => matches(entry, where)).map(entry => entry[field]))].map(value => ({ [field]: value })),
  )
  prismaMock.crmAccount.findMany.mockImplementation(async ({ where: { organization, ...scalars }, orderBy, take }: Row) =>
    ordered(
      db.accounts.filter(account => {
        if (!matches(account, scalars)) return false
        if (!organization) return true
        const venues = organization.is.venues.some
        return world.venues.some(venue => venue.organizationId === account.organizationId && venueMatches(venue, venues))
      }),
      orderBy,
    )
      .slice(0, take)
      .map(account => ({ ...account })),
  )
  prismaMock.crmAccount.updateMany.mockImplementation(async ({ where, data }: Row) => {
    const rows = db.accounts.filter(account => matches(account, where))
    rows.forEach(row => Object.assign(row, data))
    return { count: rows.length }
  })
  prismaMock.staff.findUnique.mockImplementation(async ({ where, select }: Row) => {
    const staff = world.staff.find(person => person.email === where.email)
    return staff
      ? { active: staff.active, password: staff.password, createdAt: staff.createdAt, organizations: ownedBy(staff, select.organizations) }
      : null
  })
  prismaMock.staff.findMany.mockImplementation(async ({ where, select, take }: Row) =>
    world.staff
      .filter(staff => matches(staff, where))
      .slice(0, take)
      .map(staff => ({ email: staff.email, organizations: ownedBy(staff, select.organizations) })),
  )
  prismaMock.activityLog.findMany.mockImplementation(async ({ where, orderBy, take }: Row) =>
    ordered(
      world.logs.filter(log => matches(log, where)),
      orderBy,
    )
      .slice(0, take)
      .map(log => ({ ...log, staff: world.staff.find(staff => staff.id === log.staffId) ?? null })),
  )
  prismaMock.organization.findUnique.mockImplementation(
    async ({ where }: Row) => world.organizations.find(organization => organization.id === where.id) ?? null,
  )
  prismaMock.organization.findMany.mockImplementation(async ({ where, take }: Row) =>
    world.organizations
      .filter(organization => matches(organization, where))
      .slice(0, take)
      .map(organization => {
        const holder = db.accounts.find(account => account.organizationId === organization.id)
        return { ...organization, crmAccount: holder ? { id: holder.id } : null }
      }),
  )
  prismaMock.payment.groupBy.mockImplementation(async ({ by: [field], where: { venue, ...scalars } }: Row) => {
    const first = new Map<string, Date>()
    for (const payment of world.payments) {
      if (!matches(payment, scalars) || !venueMatches(venueOf(payment.venueId), venue)) continue
      const current = first.get(payment[field])
      if (!current || payment.createdAt < current) first.set(payment[field], payment.createdAt)
    }
    return [...first].map(([value, createdAt]) => ({ [field]: value, _min: { createdAt } }))
  })
  prismaMock.venue.findMany.mockImplementation(async ({ where, take }: Row) =>
    world.venues
      .filter(venue => matches(venue, where))
      .slice(0, take)
      .map(venue => ({ id: venue.id, organizationId: venue.organizationId })),
  )
  // The only raw SQL on these paths: an account's row lock.
  prismaMock.$queryRaw.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?')
    if (!sql.includes('"CrmAccount"') || !sql.includes('FOR UPDATE')) throw new Error(`The sweep fake does not know: ${sql}`)
    const account = db.accounts.find(row => row.id === values[0])
    return account ? [{ id: account.id, organizationId: account.organizationId ?? null }] : []
  })
}

function seedOrganization(over: Row = {}) {
  const organization = {
    id: ORG,
    name: 'Café Ana S.A.',
    email: EMAIL,
    phone: '5512345678',
    createdAt: new Date(Date.now() - 60 * DAY),
    ...over,
  }
  world.organizations.push(organization)
  return organization
}

/** A person; with `owns`, an active OWNER of that Organization, their primary membership. */
function seedStaff(email: string, over: Row = {}, owns?: string) {
  const staff = {
    id: cuid('staff', world.staff.length + 1),
    email,
    firstName: 'Ana',
    lastName: 'López',
    phone: '55 1234 5678',
    active: true,
    password: 'hash',
    createdAt: new Date(Date.now() - 60 * DAY),
    memberships: owns
      ? [{ organizationId: owns, role: 'OWNER', isActive: true, isPrimary: true, joinedAt: new Date(Date.now() - 60 * DAY) }]
      : [],
    ...over,
  }
  world.staff.push(staff)
  return staff
}

/** An account the CRM already has. */
function seedAccount(over: Row = {}) {
  const account = {
    id: cuid('acct', 100 + db.accounts.length),
    name: 'Café Ana',
    source: 'LANDING',
    externalKey: EMAIL,
    stageId: FAKE_STAGE_ID,
    organizationId: null,
    firstMoneyAt: null,
    createdAt: new Date(Date.now() - 10 * DAY),
    ...over,
  }
  db.accounts.push(account)
  return account
}

function seedVenue(over: Row = {}) {
  const venue = { id: cuid('venue', world.venues.length + 1), organizationId: ORG, status: 'ACTIVE', ...over }
  world.venues.push(venue)
  return venue
}

function seedPayment(venueId: string, over: Row = {}) {
  const payment = {
    id: cuid('pay', world.payments.length + 1),
    venueId,
    status: 'COMPLETED',
    amount: 150,
    createdAt: new Date(Date.now() - 5 * DAY),
    ...over,
  }
  world.payments.push(payment)
  return payment
}

/** What `signupFromLanding` writes next to the Organization it creates: the permanent landing mark. */
function seedSignup(staffId: string | null, organizationId: string, over: Row = {}) {
  const log = {
    id: cuid('log', world.logs.length + 1),
    action: 'LANDING_SIGNUP_CREATED',
    staffId,
    entity: 'Staff',
    entityId: staffId,
    data: { source: 'landing_restaurantes', organizationId, utm: { utm_source: 'meta' } },
    createdAt: new Date('2026-09-10T18:00:00.000Z'),
    ...over,
  }
  world.logs.push(log)
  return log
}

/** A saved entry whose application did not finish, as `saveLandingEntry` + `recordSignupOutcome` leave it. */
function seedEntry(over: Row = {}) {
  const entry = {
    id: cuid('entry', db.entries.length + 1),
    source: 'LANDING',
    externalKey: EMAIL,
    payload: FORM,
    receivedAt: new Date(Date.now() - 10 * MINUTE),
    signupOutcome: { organizationId: ORG, alreadyExisted: false, yaEsCliente: false },
    signupResolvedAt: new Date(Date.now() - 10 * MINUTE),
    appliedAt: null,
    accountId: null,
    lastError: 'connection reset',
    ...over,
  }
  db.entries.push(entry)
  return entry
}

const eventsOf = (kind: string) => db.events.filter(event => event.kind === kind)
const systemEvents = (event: string) => eventsOf('SYSTEM').filter(row => row.data.event === event)
const accountOf = (id: string) => db.accounts.find(account => account.id === id)

beforeEach(() => {
  db = installCrmInboundFake(prismaMock)
  installSweepWorld()
  resetSweepCursors()
  ;(notifyNewProspect as jest.Mock).mockResolvedValue(undefined)
})

describe('applyPending', () => {
  it('aplica_pendientes_con_todos_los_campos', async () => {
    // Two forms whose application failed at the landing, the older one first, and one already applied.
    seedEntry({ receivedAt: new Date(Date.now() - 20 * MINUTE) })
    seedEntry({
      externalKey: 'beto@taller.mx',
      payload: { ...FORM, email: 'beto@taller.mx', firstName: 'Beto', companyName: 'Taller Beto', businessType: 'Taller', employees: '1' },
      signupOutcome: { organizationId: OTHER_ORG, alreadyExisted: false, yaEsCliente: false },
    })
    seedEntry({ externalKey: 'ya@cafe.mx', appliedAt: new Date(), lastError: null })

    await expect(applyPending()).resolves.toBe(2)

    expect(prismaMock.crmInboundEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { appliedAt: null }, orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }], take: 200 }),
    )
    // Every field of the form, as if the landing had applied it.
    expect(db.accounts).toEqual([
      expect.objectContaining({
        name: 'Café Ana',
        source: 'LANDING',
        externalKey: EMAIL,
        stageId: FAKE_STAGE_ID,
        giro: 'Cafetería',
        ventasRango: '500k-1m',
        sucursales: 3,
        modulos: ['mesas', 'cocina'],
        organizationId: ORG,
        sourceDetail: { page: 'landing_restaurantes', utm: { utm_source: 'meta', utm_campaign: 'pos22' } },
      }),
      expect.objectContaining({
        name: 'Taller Beto',
        externalKey: 'beto@taller.mx',
        giro: 'Taller',
        sucursales: 1,
        organizationId: OTHER_ORG,
      }),
    ])
    expect(db.contacts).toEqual([
      { accountId: db.accounts[0].id, name: 'Ana López', phoneE164: '+525512345678', email: EMAIL, isPrimary: true },
      { accountId: db.accounts[1].id, name: 'Beto López', phoneE164: '+525512345678', email: 'beto@taller.mx', isPrimary: true },
    ])
    expect(db.entries.map(entry => entry.appliedAt)).toEqual([expect.any(Date), expect.any(Date), expect.any(Date)])
    expect(db.entries.map(entry => entry.lastError)).toEqual([null, null, null])
    expect(notifyNewProspect).toHaveBeenCalledTimes(2)
  })

  it('aplica_pendiente_que_murio_antes_de_marcar_sin_repetir', async () => {
    // Ruling 20: the landing's own run writes the account and its events, then dies before `appliedAt`.
    const entry = seedEntry({ lastError: null })
    prismaMock.crmInboundEntry.update.mockRejectedValueOnce(new Error('the process died before marking'))
    await applyEntry(entry.id)
    expect(db.entries[0]).toMatchObject({ appliedAt: null, lastError: expect.stringContaining('died') })

    await expect(applyPending()).resolves.toBe(1)

    // The same account, and one set of events: the entry's ENTRY_APPLIED key stops the second run before it touches it.
    expect(db.accounts).toHaveLength(1)
    expect(db.contacts).toHaveLength(1)
    expect(eventsOf('ENTRY_APPLIED')).toHaveLength(1)
    expect(db.entries[0]).toMatchObject({ appliedAt: expect.any(Date), accountId: db.accounts[0].id, lastError: null })

    // Applied: the next sweep has nothing to do.
    await expect(applyPending()).resolves.toBe(0)
  })
})

describe('linkLandingAccounts', () => {
  it('liga_cuando_aparece_el_dueno_por_otro_camino', async () => {
    // The signup failed, so the landing account stayed without Organization. Days later the person signs up through the
    // dashboard: they own one now.
    const account = seedAccount()
    seedOrganization()
    seedStaff(EMAIL, {}, ORG)

    await expect(linkLandingAccounts()).resolves.toBe(1)

    expect(accountOf(account.id)?.organizationId).toBe(ORG)
    expect(eventsOf('LINKED')).toEqual([
      expect.objectContaining({
        accountId: account.id,
        actorStaffId: null,
        sourceKey: `link:${account.id}`,
        data: { organizationId: ORG, organizationName: 'Café Ana S.A.' },
      }),
    ])
    // Linking is not a touch and adds no note.
    expect(db.events).toHaveLength(1)
  })

  it('ligar_no_repite_evento', async () => {
    const account = seedAccount()
    seedOrganization()
    seedStaff(EMAIL, {}, ORG)

    await linkLandingAccounts()

    // The row is locked BEFORE its `link:` key goes in (the note for task 6): the sweep and an entry of the same email
    // queue on it instead of deadlocking.
    const calls = prismaMock.$queryRaw.mock.calls as Array<[TemplateStringsArray, ...unknown[]]>
    const lock = calls.findIndex(([sql]) => sql.join('?').includes('FOR UPDATE'))
    expect(lock).toBeGreaterThanOrEqual(0)
    expect(calls[lock].slice(1)).toEqual([account.id])
    expect(prismaMock.$queryRaw.mock.invocationCallOrder[lock]).toBeLessThan(
      prismaMock.crmTimelineEvent.createMany.mock.invocationCallOrder[0],
    )

    // Again, from the start: it is linked, so nothing is read for it and nothing is written.
    resetSweepCursors()
    await expect(linkLandingAccounts()).resolves.toBe(0)
    expect(eventsOf('LINKED')).toHaveLength(1)

    // Linked by someone else between the page and the lock (an entry, «Ganar»): the lock sees it and leaves it alone.
    const raced = seedAccount({ externalKey: 'beto@taller.mx' })
    seedOrganization({ id: OTHER_ORG, name: 'Taller Beto' })
    seedStaff('beto@taller.mx', {}, OTHER_ORG)
    prismaMock.$queryRaw.mockResolvedValueOnce([{ id: raced.id, organizationId: cuid('orgwon', 1) }])
    await expect(linkLandingAccounts()).resolves.toBe(0)
    expect(accountOf(raced.id)?.organizationId).toBeNull()
    expect(eventsOf('LINKED')).toHaveLength(1)
  })

  it('org_ya_ligada_no_se_roba', async () => {
    // A seller already won that Organization from a WhatsApp account; the person's old landing account stays as it is.
    const holder = seedAccount({ source: 'WHATSAPP', externalKey: '+525512345678', organizationId: ORG })
    const landing = seedAccount()
    seedOrganization()
    seedStaff(EMAIL, {}, ORG)

    await expect(linkLandingAccounts()).resolves.toBe(0)

    expect(accountOf(landing.id)?.organizationId).toBeNull()
    expect(accountOf(holder.id)?.organizationId).toBe(ORG)
    expect(eventsOf('LINKED')).toHaveLength(0)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('[CRM]'),
      expect.objectContaining({ accountId: landing.id, organizationId: ORG, heldBy: holder.id }),
    )
  })

  it('never links the sales team’s own Organization, someone who owns nothing, or a deactivated owner', async () => {
    prismaMock.crmTeam.findUnique.mockResolvedValue({ organizationId: TEAM_ORG })
    seedOrganization({ id: TEAM_ORG, name: 'Avoqado · Equipo de ventas' })
    seedOrganization()
    seedAccount({ externalKey: 'vendedor@avoqado.io' })
    seedStaff('vendedor@avoqado.io', {}, TEAM_ORG)
    seedAccount({ externalKey: 'empleada@cafe.mx' })
    seedStaff('empleada@cafe.mx', {
      memberships: [{ organizationId: ORG, role: 'MEMBER', isActive: true, isPrimary: true, joinedAt: new Date() }],
    })
    seedAccount({ externalKey: 'baja@cafe.mx' })
    seedStaff('baja@cafe.mx', { active: false }, ORG)

    await expect(linkLandingAccounts()).resolves.toBe(0)

    expect(db.accounts.map(account => account.organizationId)).toEqual([null, null, null])
    expect(eventsOf('LINKED')).toHaveLength(0)
  })

  it('an account that fails to link never stops the next one', async () => {
    seedOrganization()
    seedOrganization({ id: OTHER_ORG, name: 'Taller Beto' })
    const first = seedAccount({ createdAt: new Date(Date.now() - 2 * DAY) })
    const second = seedAccount({ externalKey: 'beto@taller.mx', createdAt: new Date(Date.now() - DAY) })
    seedStaff(EMAIL, {}, ORG)
    seedStaff('beto@taller.mx', {}, OTHER_ORG)
    prismaMock.$transaction.mockImplementationOnce(async () => {
      throw new Error('deadlock detected')
    })

    await expect(linkLandingAccounts()).resolves.toBe(1)

    expect(accountOf(first.id)?.organizationId).toBeNull()
    expect(accountOf(second.id)?.organizationId).toBe(OTHER_ORG)
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('[CRM]'), expect.objectContaining({ accountId: first.id }))
  })
})

describe('backfillFromOnboarding', () => {
  it('carga_inicial_sin_calificacion', async () => {
    // A signup from before the CRM: its Organization and its mark, and no entry.
    seedOrganization({ name: 'Taquería Lalo', phone: '5511112222' })
    const lalo = seedStaff('lalo@taqueria.mx', { firstName: 'Lalo', lastName: 'Pérez', phone: '55 1111 2222' }, ORG)
    const signup = seedSignup(lalo.id, ORG, {
      data: { source: 'landing_oferta', organizationId: ORG, utm: { utm_source: 'meta' }, launchCampaignCode: 'POS22' },
    })

    await expect(backfillFromOnboarding()).resolves.toBe(1)

    expect(db.accounts).toEqual([
      expect.objectContaining({
        source: 'LANDING',
        externalKey: 'lalo@taqueria.mx',
        name: 'Taquería Lalo',
        stageId: FAKE_STAGE_ID,
        organizationId: ORG,
        qualificationAvailable: false,
        sourceDetail: { page: 'landing_oferta', utm: { utm_source: 'meta' }, launchCampaignCode: 'POS22' },
      }),
    ])
    // «Sin dueño», and no qualification it never had.
    expect(db.accounts[0]).not.toHaveProperty('ownerStaffId')
    expect(db.accounts[0]).not.toHaveProperty('giro')
    expect(db.contacts).toEqual([
      { accountId: db.accounts[0].id, name: 'Lalo Pérez', phoneE164: '+525511112222', email: 'lalo@taqueria.mx', isPrimary: true },
    ])
    expect(eventsOf('SYSTEM')).toEqual([
      expect.objectContaining({
        accountId: db.accounts[0].id,
        actorStaffId: null,
        data: { event: 'CREATED_FROM_SIGNUP', activityLogId: signup.id, signedUpAt: signup.createdAt.toISOString() },
      }),
    ])
    // An initial load is not hundreds of new prospects to announce.
    expect(notifyNewProspect).not.toHaveBeenCalled()

    // Twice, from the start: nothing new (spec §7, «correrla dos veces»).
    resetSweepCursors()
    await expect(backfillFromOnboarding()).resolves.toBe(0)
    expect(db.accounts).toHaveLength(1)
    expect(eventsOf('SYSTEM')).toHaveLength(1)
  })

  it('a signup that already has its account, whose entry is still pending, or whose person or Organization is gone gets none', async () => {
    // Its Organization was won from WhatsApp.
    seedOrganization()
    seedAccount({ source: 'WHATSAPP', externalKey: '+525512345678', organizationId: ORG })
    seedSignup(seedStaff(EMAIL, {}, ORG).id, ORG)
    // Its entry is still waiting: `applyPending` brings every field of the form.
    seedOrganization({ id: OTHER_ORG, name: 'Taller Beto' })
    seedSignup(seedStaff('beto@taller.mx', {}, OTHER_ORG).id, OTHER_ORG)
    seedEntry({ externalKey: 'beto@taller.mx' })
    // Its Organization was deleted, or its person (the mark keeps `staffId: null`).
    seedSignup(seedStaff('borrada@cafe.mx').id, cuid('orggone', 1))
    seedOrganization({ id: cuid('org', 3), name: 'Sin persona' })
    seedSignup(null, cuid('org', 3))
    // Another action, even about a signup.
    seedOrganization({ id: cuid('org', 4), name: 'Otra acción' })
    seedSignup(seedStaff('otra@cafe.mx', {}, cuid('org', 4)).id, cuid('org', 4), { action: 'ONBOARDING_MAGIC_LINK_CLICKED' })

    await expect(backfillFromOnboarding()).resolves.toBe(0)

    expect(db.accounts).toHaveLength(1)
    expect(db.events).toHaveLength(0)
  })
})

describe('fillFirstMoney', () => {
  it('primer_dinero_por_pago_completado', async () => {
    const account = seedAccount({ organizationId: ORG, createdAt: new Date('2026-10-01T15:00:00.000Z') })
    const venue = seedVenue()
    const paidAt = new Date('2026-10-05T19:30:00.000Z')
    seedPayment(venue.id, { createdAt: paidAt })

    await expect(fillFirstMoney()).resolves.toBe(1)

    expect(accountOf(account.id)).toMatchObject({ firstMoneyAt: paidAt, firstMoneySource: 'PAGO' })
    expect(systemEvents('FIRST_MONEY')).toEqual([
      expect.objectContaining({
        accountId: account.id,
        actorStaffId: null,
        data: { event: 'FIRST_MONEY', at: paidAt.toISOString(), source: 'PAGO' },
      }),
    ])

    // Set once: an older charge that shows up later never moves it, and nothing is written again.
    seedPayment(venue.id, { createdAt: new Date('2026-10-02T12:00:00.000Z') })
    await expect(fillFirstMoney()).resolves.toBe(0)
    expect(accountOf(account.id)?.firstMoneyAt).toEqual(paidAt)
    expect(systemEvents('FIRST_MONEY')).toHaveLength(1)
  })

  it('a charge older than the account itself is kept as «ANTERIOR_AL_CRM» (ruling 28)', async () => {
    // A customer imported today: their money came before they entered the CRM.
    const account = seedAccount({ organizationId: ORG, createdAt: new Date('2026-10-31T00:00:00.000Z') })
    const paidAt = new Date('2026-06-15T17:00:00.000Z')
    seedPayment(seedVenue().id, { createdAt: paidAt })

    await fillFirstMoney()

    expect(accountOf(account.id)).toMatchObject({ firstMoneyAt: paidAt, firstMoneySource: 'ANTERIOR_AL_CRM' })
  })

  it('two writers at once: the date is written by one of them, with one event', async () => {
    const account = seedAccount({ organizationId: ORG })
    seedPayment(seedVenue().id)
    // Someone else fills it between the read and the write.
    prismaMock.crmAccount.updateMany.mockImplementationOnce(async () => {
      Object.assign(accountOf(account.id) as Row, { firstMoneyAt: new Date('2026-09-01T00:00:00.000Z'), firstMoneySource: 'PAGO' })
      return { count: 0 }
    })

    await expect(fillFirstMoney()).resolves.toBe(0)

    expect(accountOf(account.id)?.firstMoneyAt).toEqual(new Date('2026-09-01T00:00:00.000Z'))
    expect(systemEvents('FIRST_MONEY')).toHaveLength(0)
  })

  it('primer_dinero_es_el_mas_viejo_de_todas_sus_sucursales', async () => {
    const account = seedAccount({ organizationId: ORG, createdAt: new Date('2026-09-01T00:00:00.000Z') })
    const centro = seedVenue()
    const norte = seedVenue()
    seedPayment(centro.id, { createdAt: new Date('2026-10-10T18:00:00.000Z') })
    seedPayment(norte.id, { createdAt: new Date('2026-10-20T18:00:00.000Z') })
    seedPayment(norte.id, { createdAt: new Date('2026-10-03T18:00:00.000Z') })
    // Another Organization's venue, charged earlier: never its money.
    seedPayment(seedVenue({ organizationId: OTHER_ORG }).id, { createdAt: new Date('2026-09-20T18:00:00.000Z') })

    await fillFirstMoney()

    expect(accountOf(account.id)?.firstMoneyAt).toEqual(new Date('2026-10-03T18:00:00.000Z'))
  })

  it('plan_en_prueba_o_cortesia_sin_cobros_no_es_dinero', async () => {
    // A venue on PRO by courtesy (the plan resolver would call it «paid»), that never charged anything.
    const account = seedAccount({ organizationId: ORG })
    const venue = seedVenue()
    prismaMock.venueFeature.findMany.mockResolvedValue([
      { venueId: venue.id, active: true, trialEndDate: null, monthlyPrice: 0, feature: { code: 'PLAN_PRO' } },
    ])

    await expect(fillFirstMoney()).resolves.toBe(0)

    expect(accountOf(account.id)?.firstMoneyAt).toBeNull()
    // The plan is never asked: a plan on trial or courtesy is not money (Codex, plan r1 #1).
    expect(prismaMock.venueFeature.findMany).not.toHaveBeenCalled()
  })

  it('the sample sales of a demo venue are not money', async () => {
    // The onboarding's demo venue (TRIAL) comes seeded with COMPLETED sample sales, and so does the public demo.
    const account = seedAccount({ organizationId: ORG })
    seedPayment(seedVenue({ status: 'TRIAL' }).id)
    seedPayment(seedVenue({ status: 'LIVE_DEMO' }).id)

    await expect(fillFirstMoney()).resolves.toBe(0)

    expect(accountOf(account.id)?.firstMoneyAt).toBeNull()
  })

  it('pago_pendiente_o_fallido_no_cuenta', async () => {
    const account = seedAccount({ organizationId: ORG })
    const venue = seedVenue()
    for (const status of ['PENDING', 'PROCESSING', 'FAILED', 'REFUNDED']) seedPayment(venue.id, { status })
    // A sale a discount left at $0.00, closed in cash, moves no money.
    seedPayment(venue.id, { amount: 0 })

    await expect(fillFirstMoney()).resolves.toBe(0)
    expect(accountOf(account.id)?.firstMoneyAt).toBeNull()

    // Its first COMPLETED charge is.
    const paidAt = new Date('2026-10-28T20:00:00.000Z')
    seedPayment(venue.id, { createdAt: paidAt })
    await expect(fillFirstMoney()).resolves.toBe(1)
    expect(accountOf(account.id)?.firstMoneyAt).toEqual(paidAt)
  })
})

describe('todo_con_tope_de_lote', () => {
  /** Three things for a pass to do, each with its own Organization. */
  const three = [1, 2, 3].map(n => ({
    email: `p${n}@cafe.mx`,
    organizationId: cuid('orgp', n),
    createdAt: new Date(Date.now() - (10 - n) * DAY),
  }))

  it.each([
    {
      pass: 'applyPending',
      seed: () =>
        three.forEach(({ email, organizationId }, n) =>
          seedEntry({
            externalKey: email,
            payload: { ...FORM, email },
            receivedAt: new Date(Date.now() - (30 - n) * MINUTE),
            signupOutcome: { organizationId, alreadyExisted: false, yaEsCliente: false },
          }),
        ),
      run: applyPending,
      read: () => prismaMock.crmInboundEntry.findMany,
      done: () => db.entries.filter(entry => entry.appliedAt).length,
    },
    {
      pass: 'linkLandingAccounts',
      seed: () =>
        three.forEach(({ email, organizationId, createdAt }) => {
          seedAccount({ externalKey: email, createdAt })
          seedOrganization({ id: organizationId })
          seedStaff(email, {}, organizationId)
        }),
      run: linkLandingAccounts,
      read: () => prismaMock.crmAccount.findMany,
      done: () => db.accounts.filter(account => account.organizationId).length,
    },
    {
      pass: 'backfillFromOnboarding',
      seed: () =>
        three.forEach(({ email, organizationId, createdAt }) => {
          seedOrganization({ id: organizationId })
          seedSignup(seedStaff(email, {}, organizationId).id, organizationId, { createdAt })
        }),
      run: backfillFromOnboarding,
      read: () => prismaMock.activityLog.findMany,
      done: () => db.accounts.length,
    },
    {
      pass: 'fillFirstMoney',
      seed: () =>
        three.forEach(({ email, organizationId, createdAt }) => {
          seedAccount({ externalKey: email, organizationId, createdAt })
          seedPayment(seedVenue({ organizationId }).id)
        }),
      run: fillFirstMoney,
      read: () => prismaMock.crmAccount.findMany,
      done: () => db.accounts.filter(account => account.firstMoneyAt).length,
    },
  ])('$pass reads one batch per pass, and the next pass goes on with the rest', async ({ seed, run, read, done }) => {
    seed()

    await run(2)
    expect(read()).toHaveBeenLastCalledWith(expect.objectContaining({ take: 2 }))
    expect(done()).toBe(2)

    await run(2)
    expect(done()).toBe(3)

    // The cap is the server's: asked for ten thousand, it reads 200.
    await run(10_000)
    expect(read()).toHaveBeenLastCalledWith(expect.objectContaining({ take: 200 }))
    expect(done()).toBe(3)
  })

  it.each([
    {
      pass: 'linkLandingAccounts',
      // The two oldest landing accounts belong to people who own nothing — the ones that never link.
      seed: () => {
        seedAccount({ externalKey: 'nada1@cafe.mx', createdAt: new Date(Date.now() - 9 * DAY) })
        seedAccount({ externalKey: 'nada2@cafe.mx', createdAt: new Date(Date.now() - 8 * DAY) })
        seedAccount({ createdAt: new Date(Date.now() - DAY) })
        seedOrganization()
        seedStaff(EMAIL, {}, ORG)
      },
      run: linkLandingAccounts,
      done: () => db.accounts.filter(account => account.organizationId).length,
    },
    {
      pass: 'backfillFromOnboarding',
      // The two oldest signups already have their account.
      seed: () => {
        for (const n of [1, 2]) {
          const organizationId = cuid('orgdone', n)
          seedOrganization({ id: organizationId })
          seedAccount({ externalKey: `hecho${n}@cafe.mx`, organizationId })
          seedSignup(seedStaff(`hecho${n}@cafe.mx`, {}, organizationId).id, organizationId, {
            createdAt: new Date(`2026-09-0${n}T12:00:00.000Z`),
          })
        }
        seedOrganization()
        seedSignup(seedStaff(EMAIL, {}, ORG).id, ORG, { createdAt: new Date('2026-09-20T12:00:00.000Z') })
      },
      run: backfillFromOnboarding,
      done: () => db.accounts.filter(account => account.externalKey === EMAIL).length,
    },
    {
      pass: 'fillFirstMoney',
      // The two oldest linked accounts never charged anything.
      seed: () => {
        seedAccount({ externalKey: 'nada1@cafe.mx', organizationId: cuid('orgnada', 1), createdAt: new Date(Date.now() - 9 * DAY) })
        seedAccount({ externalKey: 'nada2@cafe.mx', organizationId: cuid('orgnada', 2), createdAt: new Date(Date.now() - 8 * DAY) })
        seedAccount({ organizationId: ORG, createdAt: new Date(Date.now() - DAY) })
        seedPayment(seedVenue().id)
      },
      run: fillFirstMoney,
      done: () => db.accounts.filter(account => account.firstMoneyAt).length,
    },
  ])('$pass never gets stuck behind what it can never finish', async ({ seed, run, done }) => {
    seed()

    await run(2)
    await run(2)

    expect(done()).toBe(1)
  })
})

describe('runSweep', () => {
  it('a pass that fails never stops the others', async () => {
    // An account to link and an account with a charge; the read of pending entries fails.
    const landing = seedAccount()
    seedOrganization()
    seedStaff(EMAIL, {}, ORG)
    const charged = seedAccount({ source: 'MANUAL', externalKey: null, organizationId: OTHER_ORG })
    seedPayment(seedVenue({ organizationId: OTHER_ORG }).id)
    prismaMock.crmInboundEntry.findMany.mockRejectedValueOnce(new Error('relation "CrmInboundEntry" does not exist'))

    await expect(runSweep()).resolves.toBeUndefined()

    expect(accountOf(landing.id)?.organizationId).toBe(ORG)
    expect(accountOf(charged.id)?.firstMoneyAt).toEqual(expect.any(Date))
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('[CRM]'), expect.objectContaining({ pass: 'applyPending' }))
  })
})
