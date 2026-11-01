/**
 * The CRM's repair sweep (spec 2026-10-30 §5.3 step 5, plan task 6) over an in-memory database: outcomes, not calls.
 *
 * What these pin beyond the happy path: an entry that died before `appliedAt` is applied once (ruling 20); linking takes
 * the account's lock before its LINKED key (the note for task 6) and never takes an Organization another account holds;
 * no paged pass gets stuck behind what it can never finish; the backfill reads the marks with the action as a SQL literal
 * (ruling 29b) and loads them by age (rulings 30 and 30b); and «first money» is a real charge — not a plan on trial or
 * courtesy, not a pending or failed payment, not a demo venue's sample sales — set once, and «ANTERIOR_AL_CRM» when it
 * came before the account entered the CRM (ruling 28).
 */
import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'
import { FAKE_STAGE_ID, installCrmInboundFake } from '@tests/__helpers__/crmInboundFake'
import logger from '@/config/logger'
import { notifyNewProspect, notifyReturningProspect } from '@/services/crm/digest.service'
import { applyEntry } from '@/services/crm/inbound.service'
import {
  applyPending,
  backfillFromOnboarding,
  fillFirstMoney,
  linkLandingAccounts,
  resendPendingNotices,
  resetSweepCursors,
  runSweep,
} from '@/services/crm/sweep.service'

jest.mock('@/services/crm/digest.service', () => ({ notifyNewProspect: jest.fn(), notifyReturningProspect: jest.fn() }))

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
    if (field === 'AND') return (filter as Row[]).every(branch => matches(row, branch))
    // An account's `inboundEntries: { some }`: one of the entries applied to it matches.
    if (field === 'inboundEntries') return db.entries.some(entry => entry.accountId === row.id && matches(entry, (filter as Row).some))
    const value = row[field] ?? null
    if (filter === null) return value === null
    if (filter instanceof Date) return value instanceof Date && value.getTime() === filter.getTime()
    if (typeof filter !== 'object') return value === filter
    return Object.entries(filter as Row).every(([operator, operand]) => {
      if (operator === 'in') return (operand as unknown[]).includes(value)
      if (operator === 'gt') return value !== null && value > operand
      if (operator === 'gte') return value !== null && value >= operand
      if (operator === 'not') return operand === null ? value !== null : value !== operand
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

/**
 * The tables the sweep reads beyond the landing capture's, on top of `installCrmInboundFake`. `activityLog.findMany`,
 * `payment.groupBy` and `venue.findMany` are reset and left without an implementation: the sweep reads those tables with
 * raw SQL now, and a call that comes back would fail loudly.
 */
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
  prismaMock.crmAccount.findMany.mockImplementation(async (args: Row) => {
    const { where, select, orderBy, take } = args
    // The late link (rulings 57 and 65): its filter, with `inboundEntries.some` among its branches.
    const entriesOf = (account: Row, filter: Row) => db.entries.filter(entry => entry.accountId === account.id && matches(entry, filter))
    return ordered(
      db.accounts.filter(account => matches(account, where)),
      orderBy,
    )
      .slice(0, take)
      .map(account => {
        const wanted = select?.inboundEntries
        if (!wanted) return { ...account }
        const entries = ordered(entriesOf(account, wanted.where), wanted.orderBy).slice(0, wanted.take)
        return { ...account, inboundEntries: entries.map(entry => ({ externalKey: entry.externalKey })) }
      })
  })
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
  // The raw SQL on these paths: the marks, the accounts still without first money, the oldest charge of each venue, the
  // notices to retry, an entry's lock and an account's row lock.
  prismaMock.$queryRaw.mockImplementation(async (first: Prisma.Sql | TemplateStringsArray, ...values: unknown[]) => {
    if (isSql(first)) {
      if (first.sql.includes('"StaffOrganization"')) return ownedByEvidenceRead(first)
      if (first.sql.includes('"ActivityLog"')) return marksRead(first)
      if (first.sql.includes('FROM "CrmAccount" a')) return firstMoneyCandidatesRead(first)
      if (first.sql.includes('"Payment"')) return oldestChargesRead(first)
      if (first.sql.includes('"CrmInboundEntry"')) return pendingNoticesRead(first)
      throw new Error(`The sweep fake does not know: ${first.sql}`)
    }
    const sql = first.join('?')
    if (sql.includes('pg_advisory_xact_lock')) return [{ pg_advisory_xact_lock: '' }]
    if (!sql.includes('"CrmAccount"') || !sql.includes('FOR UPDATE')) throw new Error(`The sweep fake does not know: ${sql}`)
    const account = db.accounts.find(row => row.id === values[0])
    return account ? [{ id: account.id, organizationId: account.organizationId ?? null }] : []
  })
}

/**
 * A `Prisma.sql` object, told apart from a tagged template's strings by its shape: the generated client exports
 * `Prisma.sql`, but `Prisma.Sql` only as a type, so `instanceof` is not available.
 */
const isSql = (value: unknown): value is Prisma.Sql =>
  !!value && typeof value === 'object' && !Array.isArray(value) && 'strings' in value && 'values' in value

/** The text of a raw read must hold these, or the fake would answer for a query the code no longer sends. */
function expectSql(query: Prisma.Sql, pieces: string[]) {
  for (const piece of pieces) if (!query.sql.includes(piece)) throw new Error(`The sweep fake expected «${piece}» in: ${query.sql}`)
}

/**
 * The late link's evidence (rulings 57 and 65): for each bound account, the newest email of its applied landing entries
 * — and of its key, for a LANDING account — whose person, active, owns an Organization (their first OWNER membership) that is not the bound sales team's.
 */
function ownedByEvidenceRead(query: Prisma.Sql) {
  expectSql(query, [
    'SELECT DISTINCT ON (ev."accountId") ev."accountId", o."organizationId"',
    `e."source" = 'LANDING' AND e."appliedAt" IS NOT NULL`,
    `UNION ALL`,
    `a."source" = 'LANDING' AND a."externalKey" IS NOT NULL`,
    'JOIN "Staff" s ON s."email" = ev."email" AND s."active" = true',
    `so."role" = 'OWNER' AND so."isActive" = true`,
    'ORDER BY so."isPrimary" DESC, so."joinedAt" ASC, so."id" ASC',
    'ORDER BY ev."accountId", ev."at" DESC, ev."email" ASC',
  ])
  const withTeam = query.sql.includes('o."organizationId" <>')
  const team = withTeam ? (query.values.at(-1) as string) : null
  const ids = new Set(withTeam ? query.values.slice(0, -1) : query.values)
  const owner = { where: { role: 'OWNER', isActive: true }, orderBy: [{ isPrimary: 'desc' }, { joinedAt: 'asc' }], take: 1 }
  return db.accounts.flatMap(account => {
    if (!ids.has(account.id)) return []
    const key =
      account.source === 'LANDING' && account.externalKey ? [{ externalKey: account.externalKey, receivedAt: account.createdAt }] : []
    const evidence = ordered(
      [...db.entries.filter(entry => entry.accountId === account.id && entry.source === 'LANDING' && entry.appliedAt), ...key],
      [{ receivedAt: 'desc' }, { externalKey: 'asc' }],
    )
    for (const { externalKey } of evidence) {
      const staff = world.staff.find(person => person.email === externalKey && person.active)
      const organizationId = staff && ownedBy(staff, owner)[0]?.organization.id
      if (organizationId && organizationId !== team) return [{ accountId: account.id, organizationId }]
    }
    return []
  })
}

/** The landing marks after the cursor (if any), in (createdAt, id) order, with their person's fields. */
function marksRead(query: Prisma.Sql) {
  expectSql(query, [`l."action" = 'LANDING_SIGNUP_CREATED'`, 'ORDER BY l."createdAt" ASC, l."id" ASC', 'LIMIT'])
  const { values } = query
  const limit = values[values.length - 1] as number
  const cursor = values[0] instanceof Date ? { createdAt: values[0], id: values[1] as string } : null
  const isAfter = (log: Row) =>
    !cursor || log.createdAt > cursor.createdAt || (log.createdAt.getTime() === cursor.createdAt.getTime() && log.id > cursor.id)
  return ordered(
    world.logs.filter(log => log.action === 'LANDING_SIGNUP_CREATED' && isAfter(log)),
    [{ createdAt: 'asc' }, { id: 'asc' }],
  )
    .slice(0, limit)
    .map(log => {
      const staff = world.staff.find(person => person.id === log.staffId)
      return {
        id: log.id,
        createdAt: log.createdAt,
        data: log.data,
        email: staff?.email ?? null,
        firstName: staff?.firstName ?? null,
        lastName: staff?.lastName ?? null,
        phone: staff?.phone ?? null,
        active: staff?.active ?? null,
      }
    })
}

/**
 * The oldest real charge of each venue of the bound Organizations. Every bind is an Organization id or a venue status,
 * so a venue qualifies when its Organization AND its status were bound — a TRIAL one only if the code binds TRIAL.
 */
function oldestChargesRead(query: Prisma.Sql) {
  expectSql(query, [
    'CROSS JOIN LATERAL',
    `p."status" = 'COMPLETED'`,
    'p."amount" > 0',
    'ORDER BY p."createdAt" ASC',
    'LIMIT 1',
    'v."demoExpiresAt" IS NULL',
  ])
  const binds = new Set(query.values)
  return world.venues
    .filter(venue => binds.has(venue.organizationId) && binds.has(venue.status) && (venue.demoExpiresAt ?? null) === null)
    .flatMap(venue => {
      const charges = world.payments.filter(payment => payment.venueId === venue.id && payment.status === 'COMPLETED' && payment.amount > 0)
      const [oldest] = ordered(charges, [{ createdAt: 'asc' }])
      return oldest ? [{ venueId: venue.id, organizationId: venue.organizationId, createdAt: oldest.createdAt }] : []
    })
}

/**
 * The linked accounts still without first money whose Organization has a REAL venue (a bound status, no demo date) with a
 * real charge, in (createdAt, id) order, up to the LIMIT (the last bind).
 */
function firstMoneyCandidatesRead(query: Prisma.Sql) {
  expectSql(query, [
    'a."firstMoneyAt" IS NULL AND a."organizationId" IS NOT NULL',
    'EXISTS (SELECT 1 FROM "Venue" v WHERE v."organizationId" = a."organizationId"',
    'v."demoExpiresAt" IS NULL',
    `EXISTS (SELECT 1 FROM "Payment" p WHERE p."venueId" = v."id" AND p."status" = 'COMPLETED' AND p."amount" > 0)`,
    'ORDER BY a."createdAt" ASC, a."id" ASC',
    'LIMIT',
  ])
  const limit = query.values.at(-1) as number
  const statuses = new Set(query.values.slice(0, -1))
  const charged = (organizationId: string) =>
    world.venues.some(
      venue =>
        venue.organizationId === organizationId &&
        statuses.has(venue.status) &&
        (venue.demoExpiresAt ?? null) === null &&
        world.payments.some(payment => payment.venueId === venue.id && payment.status === 'COMPLETED' && payment.amount > 0),
    )
  return ordered(
    db.accounts.filter(account => (account.firstMoneyAt ?? null) === null && account.organizationId && charged(account.organizationId)),
    [{ createdAt: 'asc' }, { id: 'asc' }],
  )
    .slice(0, limit)
    .map(account => ({ id: account.id, organizationId: account.organizationId, createdAt: account.createdAt }))
}

/** The applied entries whose notice is still pending — as their ENTRY_APPLIED says — of the last 24 h, oldest first. */
function pendingNoticesRead(query: Prisma.Sql) {
  expectSql(query, [
    'JOIN "CrmTimelineEvent" t ON t."sourceKey" = \'entry:\' || e."id"',
    'e."noticeSentAt" IS NULL AND e."appliedAt" IS NOT NULL',
    'e."noticeAttempts" <',
    `e."receivedAt" >= (`,
    `e."receivedAt" + e."noticeAttempts" * INTERVAL '1 hour' < (`,
    "AT TIME ZONE 'UTC')",
    `t."kind" = 'ENTRY_APPLIED'`,
    `COALESCE(t."data"->>'signup', '') <> 'CUSTOMER'`,
    `((t."data"->>'created') = 'true' OR (t."data"->>'reactivated') = 'true')`,
    'ORDER BY e."receivedAt" ASC, e."id" ASC',
    'LIMIT',
  ])
  const [maxAttempts, since, now] = query.values as [number, Date, Date]
  const limit = query.values.at(-1) as number
  const HOUR_MS = 60 * 60_000
  const spaced = (entry: Row) => entry.receivedAt.getTime() + (entry.noticeAttempts ?? 0) * HOUR_MS < now.getTime()
  return ordered(
    db.entries.filter(
      entry =>
        (entry.noticeSentAt ?? null) === null &&
        entry.appliedAt &&
        (entry.noticeAttempts ?? 0) < maxAttempts &&
        entry.receivedAt >= since &&
        spaced(entry),
    ),
    [{ receivedAt: 'asc' }, { id: 'asc' }],
  )
    .flatMap(entry => {
      const event = db.events.find(row => row.sourceKey === `entry:${entry.id}` && row.kind === 'ENTRY_APPLIED')
      if (!event || event.data.signup === 'CUSTOMER' || !(event.data.created === true || event.data.reactivated === true)) return []
      return [{ id: entry.id, accountId: event.accountId, data: event.data }]
    })
    .slice(0, limit)
}

/** The raw reads the code sent, as `Prisma.Sql`. */
const rawReads = (table: string) =>
  (prismaMock.$queryRaw.mock.calls as unknown[][])
    .map(([first]) => first)
    .filter((first): first is Prisma.Sql => isSql(first) && first.sql.includes(`"${table}"`))

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

/** A landing account with the applied entry that made it, as the landing leaves it: the late link starts from the entry. */
function seedLandingAccount(over: Row = {}) {
  const account = seedAccount(over)
  seedEntry({
    externalKey: account.externalKey,
    payload: { ...FORM, email: account.externalKey },
    signupOutcome: null,
    accountId: account.id,
    appliedAt: account.createdAt,
    lastError: null,
  })
  return account
}

function seedVenue(over: Row = {}) {
  const venue = { id: cuid('venue', world.venues.length + 1), organizationId: ORG, status: 'ACTIVE', demoExpiresAt: null, ...over }
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
  ;(notifyNewProspect as jest.Mock).mockReset().mockResolvedValue(undefined)
  ;(notifyReturningProspect as jest.Mock).mockReset().mockResolvedValue(undefined)
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
      {
        id: expect.any(String),
        accountId: db.accounts[0].id,
        name: 'Ana López',
        phoneE164: '+525512345678',
        email: EMAIL,
        isPrimary: true,
      },
      {
        id: expect.any(String),
        accountId: db.accounts[1].id,
        name: 'Beto López',
        phoneE164: '+525512345678',
        email: 'beto@taller.mx',
        isPrimary: true,
      },
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

    const before = db.events.map(event => ({ ...event }))

    await expect(applyPending()).resolves.toBe(1)

    // The same account and not one event more, of any kind (M-5): the entry's ENTRY_APPLIED key stops the second run
    // before it touches the account.
    expect(db.accounts).toHaveLength(1)
    expect(db.contacts).toHaveLength(1)
    expect(db.events).toEqual(before)
    expect(db.entries[0]).toMatchObject({ appliedAt: expect.any(Date), accountId: db.accounts[0].id, lastError: null })

    // Applied: the next sweep has nothing to do.
    await expect(applyPending()).resolves.toBe(0)
  })
})

describe('linkLandingAccounts', () => {
  it('liga_cuando_aparece_el_dueno_por_otro_camino', async () => {
    // The signup failed, so the landing account stayed without Organization. Days later the person signs up through the
    // dashboard: they own one now.
    const account = seedLandingAccount()
    seedOrganization()
    seedStaff(EMAIL, {}, ORG)

    await expect(linkLandingAccounts()).resolves.toBe(1)

    expect(accountOf(account.id)?.organizationId).toBe(ORG)
    expect(eventsOf('LINKED')).toEqual([
      expect.objectContaining({
        accountId: account.id,
        actorStaffId: null,
        sourceKey: `link:${account.id}:${ORG}`,
        data: { organizationId: ORG, organizationName: 'Café Ana S.A.' },
      }),
    ])
    // Linking is not a touch and adds no note.
    expect(db.events).toHaveLength(1)
  })

  it('ligar_no_repite_evento', async () => {
    const account = seedLandingAccount()
    seedOrganization()
    seedStaff(EMAIL, {}, ORG)

    await linkLandingAccounts()

    // The row is locked BEFORE its `link:` key goes in (the note for task 6): the sweep and an entry of the same email
    // queue on it instead of deadlocking.
    const calls = prismaMock.$queryRaw.mock.calls as Array<[TemplateStringsArray, ...unknown[]]>
    const lock = calls.findIndex(([sql]) => !isSql(sql) && sql.join('?').includes('FOR UPDATE'))
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
    const raced = seedLandingAccount({ externalKey: 'beto@taller.mx' })
    seedOrganization({ id: OTHER_ORG, name: 'Taller Beto' })
    seedStaff('beto@taller.mx', {}, OTHER_ORG)
    // Its row lock answers what the winner committed; every other read goes on as before.
    const answer = prismaMock.$queryRaw.getMockImplementation()!
    prismaMock.$queryRaw.mockImplementation(async (first: Prisma.Sql | TemplateStringsArray, ...values: unknown[]) =>
      !isSql(first) && first.join('?').includes('FOR UPDATE') && values[0] === raced.id
        ? [{ id: raced.id, organizationId: cuid('orgwon', 1) }]
        : answer(first, ...values),
    )
    await expect(linkLandingAccounts()).resolves.toBe(0)
    expect(accountOf(raced.id)?.organizationId).toBeNull()
    expect(eventsOf('LINKED')).toHaveLength(1)
  })

  it('org_ya_ligada_no_se_roba', async () => {
    // A seller already won that Organization from a WhatsApp account; the person's old landing account stays as it is.
    const holder = seedAccount({ source: 'WHATSAPP', externalKey: '+525512345678', organizationId: ORG })
    const landing = seedLandingAccount()
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
    seedLandingAccount({ externalKey: 'vendedor@avoqado.io' })
    seedStaff('vendedor@avoqado.io', {}, TEAM_ORG)
    seedLandingAccount({ externalKey: 'empleada@cafe.mx' })
    seedStaff('empleada@cafe.mx', {
      memberships: [{ organizationId: ORG, role: 'MEMBER', isActive: true, isPrimary: true, joinedAt: new Date() }],
    })
    seedLandingAccount({ externalKey: 'baja@cafe.mx' })
    seedStaff('baja@cafe.mx', { active: false }, ORG)

    await expect(linkLandingAccounts()).resolves.toBe(0)

    expect(db.accounts.map(account => account.organizationId)).toEqual([null, null, null])
    expect(eventsOf('LINKED')).toHaveLength(0)
  })

  it('an account that fails to link never stops the next one', async () => {
    seedOrganization()
    seedOrganization({ id: OTHER_ORG, name: 'Taller Beto' })
    const first = seedLandingAccount({ createdAt: new Date(Date.now() - 2 * DAY) })
    const second = seedLandingAccount({ externalKey: 'beto@taller.mx', createdAt: new Date(Date.now() - DAY) })
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

  it('an Organization another account holds is skipped before any transaction, and warned about once per process (M-1)', async () => {
    const holder = seedAccount({ source: 'WHATSAPP', externalKey: '+525512345678', organizationId: ORG })
    const landing = seedLandingAccount()
    seedOrganization()
    seedStaff(EMAIL, {}, ORG)
    const warningsFor = (accountId: string) =>
      (logger.warn as jest.Mock).mock.calls.filter(([, context]) => (context as Row | undefined)?.accountId === accountId)

    // Every pass reads it again (fewer than 200 unlinked accounts), and none opens a transaction or repeats the warning.
    await linkLandingAccounts()
    await linkLandingAccounts()

    expect(prismaMock.$transaction).not.toHaveBeenCalled()
    expect(warningsFor(landing.id)).toEqual([
      [expect.stringContaining('[CRM]'), expect.objectContaining({ accountId: landing.id, organizationId: ORG, heldBy: holder.id })],
    ])

    // A new process says it once more.
    resetSweepCursors()
    await linkLandingAccounts()
    expect(warningsFor(landing.id)).toHaveLength(2)
  })

  it('liga_la_ficha_de_whatsapp_que_tomo_una_entrada_de_la_landing (ruling 57 b, Codex r2 R2-1)', async () => {
    // The landing reused the WhatsApp account (phone, no email) and the signup failed. Days later the person opens their
    // business through the dashboard.
    const whatsapp = seedAccount({ source: 'WHATSAPP', externalKey: '+525512345678', createdAt: new Date(Date.now() - 5 * DAY) })
    seedEntry({ accountId: whatsapp.id, appliedAt: new Date(Date.now() - 4 * DAY), lastError: null, signupOutcome: null })
    // A WhatsApp account no landing entry ever reached is not the sweep's to link (spec §5.3: a phone is not enough).
    const untouched = seedAccount({ source: 'WHATSAPP', externalKey: '+525599990000', createdAt: new Date(Date.now() - 6 * DAY) })
    seedOrganization()
    seedStaff(EMAIL, {}, ORG)

    await expect(linkLandingAccounts()).resolves.toBe(1)

    expect(accountOf(whatsapp.id)?.organizationId).toBe(ORG)
    expect(accountOf(untouched.id)?.organizationId).toBeNull()
    expect(eventsOf('LINKED')).toEqual([expect.objectContaining({ accountId: whatsapp.id, sourceKey: `link:${whatsapp.id}:${ORG}` })])
    // Only APPLIED landing entries count: a pending one gives nothing to link from.
    expect(prismaMock.crmAccount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: null,
          AND: [{ OR: [{ source: 'LANDING' }, { inboundEntries: { some: { source: 'LANDING', appliedAt: { not: null } } } }] }],
        }),
      }),
    )
  })

  it.each([
    { case: 'el correo original y cinco reenvíos de otro', emails: [EMAIL, ...Array(5).fill('otra@cafe.mx')] },
    { case: 'seis correos distintos', emails: [EMAIL, 'b@cafe.mx', 'c@cafe.mx', 'd@cafe.mx', 'e@cafe.mx', 'f@cafe.mx'] },
  ])('enlace_con_reenvios_busca_todos_los_correos (Codex r3 R3-1): $case', async ({ emails }) => {
    // The account took the person's first form (email A) and then five more; only A ever owns a business.
    const account = seedAccount({ createdAt: new Date(Date.now() - 9 * DAY) })
    emails.forEach((email, n) =>
      seedEntry({
        externalKey: email,
        accountId: account.id,
        appliedAt: new Date(Date.now() - (8 - n) * DAY),
        receivedAt: new Date(Date.now() - (8 - n) * DAY),
        lastError: null,
        signupOutcome: null,
      }),
    )
    seedOrganization()
    seedStaff(EMAIL, {}, ORG)
    for (const email of new Set(emails.slice(1))) seedStaff(email)

    await expect(linkLandingAccounts()).resolves.toBe(1)

    expect(accountOf(account.id)?.organizationId).toBe(ORG)
    expect(eventsOf('LINKED')).toEqual([expect.objectContaining({ accountId: account.id, sourceKey: `link:${account.id}:${ORG}` })])
  })

  it('enlace_de_ficha_creada_por_la_carga_inicial (Codex exhaustiva #3): a LANDING account with no entry still links by its key', async () => {
    // The backfill created it, linked, without any entry. Its Organization is deleted (`SetNull`) and the person opens
    // another one from the dashboard.
    const account = seedAccount({ organizationId: null })
    seedOrganization({ id: OTHER_ORG, name: 'Café Ana 2' })
    seedStaff(EMAIL, {}, OTHER_ORG)

    await expect(linkLandingAccounts()).resolves.toBe(1)

    expect(accountOf(account.id)?.organizationId).toBe(OTHER_ORG)
    expect(eventsOf('LINKED')).toEqual([expect.objectContaining({ accountId: account.id, sourceKey: `link:${account.id}:${OTHER_ORG}` })])
  })

  it('a re-link after its Organization was deleted leaves its own LINKED event (M-4)', async () => {
    const account = seedLandingAccount()
    seedOrganization()
    const ana = seedStaff(EMAIL, {}, ORG)
    await linkLandingAccounts()

    // The Organization is deleted (`SetNull` unlinks the account) and the person opens another business.
    world.organizations = world.organizations.filter(organization => organization.id !== ORG)
    Object.assign(accountOf(account.id) as Row, { organizationId: null })
    seedOrganization({ id: OTHER_ORG, name: 'Café Ana 2' })
    ana.memberships = [{ organizationId: OTHER_ORG, role: 'OWNER', isActive: true, isPrimary: true, joinedAt: new Date() }]

    await expect(linkLandingAccounts()).resolves.toBe(1)

    expect(accountOf(account.id)?.organizationId).toBe(OTHER_ORG)
    expect(eventsOf('LINKED').map(event => event.sourceKey)).toEqual([`link:${account.id}:${ORG}`, `link:${account.id}:${OTHER_ORG}`])
  })
})

describe('backfillFromOnboarding', () => {
  it('carga_inicial_sin_calificacion', async () => {
    // A signup from before the CRM, three days old: its Organization and its mark, and no entry.
    seedOrganization({ name: 'Taquería Lalo', phone: '5511112222' })
    const lalo = seedStaff('lalo@taqueria.mx', { firstName: 'Lalo', lastName: 'Pérez', phone: '55 1111 2222' }, ORG)
    const signup = seedSignup(lalo.id, ORG, {
      data: { source: 'landing_oferta', organizationId: ORG, utm: { utm_source: 'meta' }, launchCampaignCode: 'POS22' },
      createdAt: new Date(Date.now() - 3 * DAY),
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
      {
        id: expect.any(String),
        accountId: db.accounts[0].id,
        name: 'Lalo Pérez',
        phoneE164: '+525511112222',
        email: 'lalo@taqueria.mx',
        isPrimary: true,
      },
    ])
    expect(eventsOf('SYSTEM')).toEqual([
      expect.objectContaining({
        accountId: db.accounts[0].id,
        actorStaffId: null,
        data: { event: 'CREATED_FROM_SIGNUP', activityLogId: signup.id, signedUpAt: signup.createdAt.toISOString(), archived: false },
      }),
    ])
    // Three days old: open, but not «new» enough to announce (ruling 30b).
    expect(db.accounts[0].archivedAt ?? null).toBeNull()
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

  it('carga_por_edad: más de 14 días archivada, de 1 a 14 abierta sin correo, menos de 24 h abierta y anunciada (rulings 30 y 30b)', async () => {
    const signups = [
      { email: 'vieja@cafe.mx', age: 20 * DAY, archived: true, announced: false },
      { email: 'casi-vieja@cafe.mx', age: 14 * DAY - MINUTE, archived: false, announced: false },
      { email: 'tibia@cafe.mx', age: 5 * DAY, archived: false, announced: false },
      { email: 'de-ayer@cafe.mx', age: DAY + MINUTE, archived: false, announced: false },
      { email: 'hoy@cafe.mx', age: 2 * 60 * MINUTE, archived: false, announced: true },
    ]
    signups.forEach(({ email, age }, n) => {
      const organizationId = cuid('orgedad', n + 1)
      seedOrganization({ id: organizationId, name: email })
      seedSignup(seedStaff(email, {}, organizationId).id, organizationId, { createdAt: new Date(Date.now() - age) })
    })

    await expect(backfillFromOnboarding()).resolves.toBe(5)

    for (const { email, archived } of signups) {
      const account = db.accounts.find(row => row.externalKey === email)
      expect({ email, archived: (account?.archivedAt ?? null) !== null }).toEqual({ email, archived })
      // Archived or open, nobody owns it yet, and its event says which.
      expect(account).not.toHaveProperty('ownerStaffId')
      expect(systemEvents('CREATED_FROM_SIGNUP').find(event => event.accountId === account?.id)?.data.archived).toBe(archived)
    }
    // Only the signup of today is a new prospect: its entry was never saved, so this is its only notice — with the content
    // its recoverable entry keeps (ruling 65 f).
    expect((notifyNewProspect as jest.Mock).mock.calls).toEqual(
      signups
        .filter(({ announced }) => announced)
        .map(({ email }) => [
          db.accounts.find(row => row.externalKey === email)?.id,
          expect.objectContaining({ name: email, qualificationAvailable: false }),
        ]),
    )
  })

  it('aviso_de_la_carga_inicial_se_recupera (Codex exhaustiva #12): a notice that did not go out is retried with its key', async () => {
    seedOrganization()
    seedSignup(seedStaff(EMAIL, {}, ORG).id, ORG, { createdAt: new Date(Date.now() - 2 * 60 * MINUTE) })
    // Resend is down when the backfill creates today's account.
    ;(notifyNewProspect as jest.Mock).mockResolvedValue(false)

    await expect(backfillFromOnboarding()).resolves.toBe(1)
    const [account] = db.accounts
    const entry = db.entries.find(row => row.source === 'CARGA_INICIAL')
    expect(entry).toMatchObject({
      externalKey: EMAIL,
      accountId: account.id,
      appliedAt: expect.any(Date),
      noticeSentAt: null,
      noticeAttempts: 1,
    })
    expect(eventsOf('ENTRY_APPLIED')).toEqual([
      expect.objectContaining({ accountId: account.id, sourceKey: `entry:${entry!.id}`, data: expect.objectContaining({ created: true }) }),
    ])

    // Resend is back: the sweep's retry sends the same notice, with the same content.
    ;(notifyNewProspect as jest.Mock).mockResolvedValue(true)
    await expect(resendPendingNotices()).resolves.toBe(1)
    expect(notifyNewProspect).toHaveBeenLastCalledWith(account.id, expect.objectContaining({ name: 'Café Ana S.A.' }))
    expect(entry!.noticeSentAt).toEqual(expect.any(Date))

    // A restart walks the marks again: nothing is created and nothing is announced again.
    resetSweepCursors()
    await expect(backfillFromOnboarding()).resolves.toBe(0)
    await expect(resendPendingNotices()).resolves.toBe(0)
    expect(notifyNewProspect).toHaveBeenCalledTimes(2)
    expect(db.accounts).toHaveLength(1)
  })

  it('backfill_reusa_la_ficha_de_la_persona (ruling 59): a signup whose person is already in the CRM by phone gets no second account', async () => {
    // WhatsApp met them first; the signup's entry was never saved, so only the backfill sees the signup.
    const whatsapp = seedAccount({ source: 'WHATSAPP', externalKey: '+525512345678', organizationId: null })
    db.contacts.push({
      id: cuid('cont', 900),
      accountId: whatsapp.id,
      name: 'Ana',
      email: null,
      phoneE164: '+525512345678',
      isPrimary: true,
    })
    seedOrganization()
    seedSignup(seedStaff(EMAIL, {}, ORG).id, ORG, { createdAt: new Date(Date.now() - 2 * 60 * MINUTE) })

    await expect(backfillFromOnboarding()).resolves.toBe(0)

    expect(db.accounts).toEqual([expect.objectContaining({ id: whatsapp.id, organizationId: ORG })])
    expect(eventsOf('LINKED')).toEqual([expect.objectContaining({ accountId: whatsapp.id, sourceKey: `link:${whatsapp.id}:${ORG}` })])
    // The same person: the signup's email lands on the phone's contact, and nobody is told about a «new» prospect.
    expect(db.contacts).toEqual([expect.objectContaining({ accountId: whatsapp.id, email: EMAIL, phoneE164: '+525512345678' })])
    expect(notifyNewProspect).not.toHaveBeenCalled()

    // Linked now: the next pass skips the signup (its Organization has its account).
    resetSweepCursors()
    await expect(backfillFromOnboarding()).resolves.toBe(0)
    expect(eventsOf('LINKED')).toHaveLength(1)
  })

  it('carga_inicial_no_duplica_al_contacto_51 (Codex r3 R3-2): the person found past the first 50 contacts is not added again', async () => {
    const imported = seedAccount({ source: 'IMPORTACION', externalKey: 'hubspot:deal:51', organizationId: null })
    for (let n = 1; n <= 50; n++) {
      db.contacts.push({
        id: cuid('cont', n),
        accountId: imported.id,
        name: `P${n}`,
        email: `p${n}@cafe.mx`,
        phoneE164: null,
        isPrimary: n === 1,
      })
    }
    db.contacts.push({
      id: cuid('cont', 51),
      accountId: imported.id,
      name: 'Ana',
      email: EMAIL,
      phoneE164: '+525512345678',
      isPrimary: false,
    })
    seedOrganization()
    seedSignup(seedStaff(EMAIL, {}, ORG).id, ORG, { createdAt: new Date(Date.now() - 3 * DAY) })

    await expect(backfillFromOnboarding()).resolves.toBe(0)

    expect(db.accounts).toEqual([expect.objectContaining({ id: imported.id, organizationId: ORG })])
    expect(db.contacts).toHaveLength(51)
  })

  it('choque_de_organizacion_en_la_carga_inicial_devuelve_al_titular (Codex exhaustiva #6): no unlinked duplicate', async () => {
    seedOrganization()
    seedSignup(seedStaff(EMAIL, {}, ORG).id, ORG, { createdAt: new Date(Date.now() - 3 * DAY) })
    // A «Ganar» links another account to that Organization between the read and the insert.
    const holder = { id: cuid('acctwon', 1), name: 'Café Ana', source: 'MANUAL', externalKey: null, stageId: FAKE_STAGE_ID }
    const insert = prismaMock.crmAccount.createMany.getMockImplementation()!
    prismaMock.crmAccount.createMany.mockImplementationOnce(async (args: unknown) => {
      db.accounts.push({ ...holder, organizationId: ORG, createdAt: new Date() })
      return insert(args)
    })

    await expect(backfillFromOnboarding()).resolves.toBe(0)

    expect(db.accounts).toEqual([expect.objectContaining({ id: holder.id, organizationId: ORG })])
    expect(db.contacts).toEqual([expect.objectContaining({ accountId: holder.id, email: EMAIL })])
    expect(notifyNewProspect).not.toHaveBeenCalled()
  })

  it('llave_landing_ligada_a_otro_negocio_se_salta_sin_retener_el_cursor (Codex autorización H1)', async () => {
    // The person's landing account belongs to another business; their signup created ORG. And another person's signup.
    const theirs = seedAccount({ organizationId: OTHER_ORG })
    seedOrganization()
    seedOrganization({ id: cuid('org', 3), name: 'Taller Beto' })
    seedSignup(seedStaff(EMAIL, {}, ORG).id, ORG, { createdAt: new Date(Date.now() - 3 * DAY) })
    seedSignup(seedStaff('beto@taller.mx', {}, cuid('org', 3)).id, cuid('org', 3), { createdAt: new Date(Date.now() - 2 * DAY) })

    await expect(backfillFromOnboarding()).resolves.toBe(1)

    // Nothing written to the other business, and it is not a failure: no error, and the next pass does not read it again.
    expect(accountOf(theirs.id)).toMatchObject({ organizationId: OTHER_ORG })
    expect(db.contacts.filter(contact => contact.accountId === theirs.id)).toEqual([])
    expect(db.accounts.map(account => account.externalKey).sort()).toEqual([EMAIL, 'beto@taller.mx'])
    expect(logger.error).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('another Organization'), expect.anything())
    ;(logger.warn as jest.Mock).mockClear()
    await expect(backfillFromOnboarding()).resolves.toBe(0)
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('another Organization'), expect.anything())
  })

  it('la_marca_de_una_persona_borrada_no_crea_nada (I-2)', async () => {
    // The platform's deletion anonymizes and keeps the row (`staffDeletion.service.ts`): inactive, struck-out email, no
    // phone. Its mark still points at it.
    seedOrganization()
    const deleted = seedStaff('deleted+cstaff000000000000000001@redacted.avoqado.invalid', {
      active: false,
      firstName: 'Usuario',
      lastName: 'eliminado',
      phone: null,
    })
    seedSignup(deleted.id, ORG, { createdAt: new Date(Date.now() - 3 * DAY) })

    await expect(backfillFromOnboarding()).resolves.toBe(0)

    expect(db.accounts).toHaveLength(0)
    expect(db.events).toHaveLength(0)
  })

  it('reads the marks with the action as a SQL literal, so any plan can use the partial index (ruling 29b)', async () => {
    seedOrganization()
    seedSignup(seedStaff(EMAIL, {}, ORG).id, ORG)

    await backfillFromOnboarding()
    // The page after the cursor.
    await backfillFromOnboarding()

    const reads = rawReads('ActivityLog')
    expect(reads).toHaveLength(2)
    for (const read of reads) {
      expect(read.sql).toContain(`l."action" = 'LANDING_SIGNUP_CREATED'`)
      expect(read.values).not.toContain('LANDING_SIGNUP_CREATED')
    }
    // The cursor's date goes through `utcTs`, as rawSqlDateBindGuard asks: what Postgres receives.
    expect(reads[1].text).toContain(`(l."createdAt", l."id") > (($1 AT TIME ZONE 'UTC'), $2)`)
    expect(prismaMock.activityLog.findMany).not.toHaveBeenCalled()
  })

  it('fallo_transitorio_no_queda_detras_del_cursor (Codex exhaustiva #11): the next pass, without a restart, retries it', async () => {
    seedOrganization()
    seedOrganization({ id: OTHER_ORG, name: 'Taller Beto' })
    seedSignup(seedStaff(EMAIL, {}, ORG).id, ORG, { createdAt: new Date(Date.now() - 3 * DAY) })
    seedSignup(seedStaff('beto@taller.mx', {}, OTHER_ORG).id, OTHER_ORG, { createdAt: new Date(Date.now() - 2 * DAY) })
    // The first mark's transaction fails once (a blip); the database is back at once.
    prismaMock.$transaction.mockImplementationOnce(async () => {
      throw new Error('connection reset')
    })

    await expect(backfillFromOnboarding()).resolves.toBe(1)
    expect(db.accounts.map(account => account.externalKey)).toEqual(['beto@taller.mx'])

    await expect(backfillFromOnboarding()).resolves.toBe(1)
    expect(db.accounts.map(account => account.externalKey).sort()).toEqual([EMAIL, 'beto@taller.mx'])
  })

  it('a mark that commits late with an earlier time is still read: the cursor waits ten minutes behind «now» (M-3)', async () => {
    seedOrganization()
    seedOrganization({ id: OTHER_ORG, name: 'Taller Beto' })
    seedSignup(seedStaff(EMAIL, {}, ORG).id, ORG, { createdAt: new Date(Date.now() - 2 * MINUTE) })
    await expect(backfillFromOnboarding()).resolves.toBe(1)

    // A signup whose transaction started earlier commits now: its mark is OLDER than the one already read.
    seedSignup(seedStaff('beto@taller.mx', {}, OTHER_ORG).id, OTHER_ORG, { createdAt: new Date(Date.now() - 3 * MINUTE) })
    await expect(backfillFromOnboarding()).resolves.toBe(1)

    expect(db.accounts.map(account => account.externalKey).sort()).toEqual([EMAIL, 'beto@taller.mx'])
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

  it('a demo venue moved to ACTIVE without its conversion keeps its sample sales: still not money (I-1)', async () => {
    // A superadmin moves the TRIAL demo to ACTIVE (or the owner suspends or closes it): the status changes, the sample
    // sales and `demoExpiresAt` stay. Only `convertDemoVenue` deletes the sales and clears the date.
    const account = seedAccount({ organizationId: ORG })
    seedPayment(seedVenue({ status: 'ACTIVE', demoExpiresAt: new Date(Date.now() + 20 * DAY) }).id)

    await expect(fillFirstMoney()).resolves.toBe(0)

    expect(accountOf(account.id)?.firstMoneyAt).toBeNull()
  })

  it('reads the oldest charge of each venue with one LATERAL, never the whole history of the batch (M-2)', async () => {
    seedAccount({ organizationId: ORG })
    const venue = seedVenue()
    for (const days of [9, 7, 5]) seedPayment(venue.id, { createdAt: new Date(Date.now() - days * DAY) })

    await expect(fillFirstMoney()).resolves.toBe(1)

    expect(prismaMock.payment.groupBy).not.toHaveBeenCalled()
    // The candidates' EXISTS names "Payment" too (ruling 51): this is the LATERAL read.
    const read = rawReads('Payment').find(query => query.sql.includes('LATERAL'))!
    expect(read.sql).toMatch(
      /CROSS JOIN LATERAL \(\s*SELECT p\."createdAt" FROM "Payment" p[\s\S]*ORDER BY p\."createdAt" ASC\s+LIMIT 1\s*\)/,
    )
    // Only ids and statuses travel as binds: no date, so nothing for the session time zone to shift.
    expect(read.values.some(value => value instanceof Date)).toBe(false)
    expect(db.accounts[0].firstMoneyAt).toEqual(world.payments[0].createdAt)
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

describe('a new link starts the first money over (ruling 65 g)', () => {
  it('reenlazar_reinicia_el_primer_cobro (Codex exhaustiva #13): the new Organization never inherits the old one’s charge', async () => {
    // Linked to ORG, which charged; its first money is set.
    const account = seedLandingAccount({ organizationId: ORG, firstMoneyAt: new Date(Date.now() - 20 * DAY), firstMoneySource: 'PAGO' })
    // ORG is deleted (`SetNull` unlinks the account) and the person opens another business, which never charged.
    Object.assign(accountOf(account.id) as Row, { organizationId: null })
    seedOrganization({ id: OTHER_ORG, name: 'Café Ana 2' })
    const venue = seedVenue({ organizationId: OTHER_ORG })
    seedStaff(EMAIL, {}, OTHER_ORG)

    await expect(linkLandingAccounts()).resolves.toBe(1)

    expect(accountOf(account.id)).toMatchObject({ organizationId: OTHER_ORG, firstMoneyAt: null, firstMoneySource: null })
    expect(systemEvents('FIRST_MONEY_RESET')).toEqual([
      expect.objectContaining({
        accountId: account.id,
        actorStaffId: null,
        data: expect.objectContaining({ previousSource: 'PAGO', organizationId: OTHER_ORG }),
      }),
    ])
    // Nothing to fill until the new business charges for real; then its own date.
    await expect(fillFirstMoney()).resolves.toBe(0)
    const charge = seedPayment(venue.id, { createdAt: new Date() })
    await expect(fillFirstMoney()).resolves.toBe(1)
    expect(accountOf(account.id)).toMatchObject({ firstMoneyAt: charge.createdAt, firstMoneySource: 'PAGO' })
  })
})

describe('fillFirstMoney writes only for the Organization it read (Codex autorización H2)', () => {
  it('un_barrido_que_leyo_antes_del_reenlace_no_repone_el_cobro_viejo', async () => {
    const account = seedAccount({ organizationId: ORG })
    seedPayment(seedVenue().id)
    // Between the read and the write, ORG is deleted and the account is linked to OTHER_ORG, which never charged.
    const plain = prismaMock.$transaction.getMockImplementation()!
    prismaMock.$transaction.mockImplementationOnce(async (callback: (tx: unknown) => unknown) => {
      Object.assign(accountOf(account.id) as Row, { organizationId: OTHER_ORG })
      return plain(callback)
    })

    await expect(fillFirstMoney()).resolves.toBe(0)

    expect(accountOf(account.id)).toMatchObject({ organizationId: OTHER_ORG, firstMoneyAt: null })
    expect(systemEvents('FIRST_MONEY')).toEqual([])
  })
})

describe('fillFirstMoney reads its candidates with a correlated EXISTS (ruling 51)', () => {
  it('never a `payments.some` inside an OR: one EXISTS per venue on Payment(venueId, status, createdAt), and the partial index literals', async () => {
    seedAccount({ organizationId: ORG })
    seedPayment(seedVenue().id)

    await expect(fillFirstMoney()).resolves.toBe(1)

    const [candidates] = rawReads('CrmAccount')
    // The two conditions of `CrmAccount_first_money_pending_idx`, as literals: any plan can prove the predicate.
    expect(candidates.sql).toContain('a."firstMoneyAt" IS NULL AND a."organizationId" IS NOT NULL')
    expect(candidates.sql).not.toMatch(/IN \(\s*SELECT/i)
    expect(candidates.values.some(value => value instanceof Date)).toBe(false)
    // The Prisma relation filter that turned into a hashed subplan over every payment is gone.
    expect(prismaMock.crmAccount.findMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ firstMoneyAt: null }) }),
    )
  })
})

describe('resendPendingNotices (ruling 49)', () => {
  const HOUR = 60 * MINUTE
  const CONTENT = {
    name: 'Café Ana',
    giro: 'Cafetería',
    ventasRango: '500k-1m',
    sucursales: 3,
    modulos: ['mesas'],
    qualificationAvailable: true,
  }

  /** An entry applied by the landing whose notice did not reach everyone (its first try, two hours ago). */
  function pendingNotice(over: Row = {}, applied: Row = { signup: 'NEW_SIGNUP', created: true, noticeContent: CONTENT }) {
    const account = seedAccount({ id: cuid('acctntc', db.accounts.length + 1) })
    const entry = seedEntry({
      appliedAt: new Date(Date.now() - 2 * HOUR),
      accountId: account.id,
      lastError: null,
      receivedAt: new Date(Date.now() - 2 * HOUR),
      noticeSentAt: null,
      noticeAttempts: 1,
      ...over,
    })
    db.events.push({
      accountId: account.id,
      kind: 'ENTRY_APPLIED',
      actorStaffId: null,
      sourceKey: `entry:${entry.id}`,
      data: { entryId: entry.id, ...applied },
    })
    return { account, entry }
  }

  it('aviso_pendiente_se_reintenta_con_la_misma_llave_y_el_mismo_contenido', async () => {
    const { account, entry } = pendingNotice()
    ;(notifyNewProspect as jest.Mock).mockResolvedValue(true)

    await expect(resendPendingNotices()).resolves.toBe(1)

    // The content its ENTRY_APPLIED fixed, never the account as it is now — Resend refuses a key with other content.
    expect(notifyNewProspect).toHaveBeenCalledWith(account.id, CONTENT)
    expect(db.entries[0]).toMatchObject({ id: entry.id, noticeSentAt: expect.any(Date) })

    // Sent: the next sweep has nothing to retry.
    await expect(resendPendingNotices()).resolves.toBe(0)
    expect(notifyNewProspect).toHaveBeenCalledTimes(1)
  })

  it('«Volvió» is retried under its own key, with its entry', async () => {
    const { account, entry } = pendingNotice({}, { signup: 'EXISTING_ACCOUNT', created: false, reactivated: true, noticeContent: CONTENT })
    ;(notifyReturningProspect as jest.Mock).mockResolvedValue(true)

    await resendPendingNotices()

    expect(notifyReturningProspect).toHaveBeenCalledWith(account.id, entry.id, CONTENT)
    expect(notifyNewProspect).not.toHaveBeenCalled()
  })

  it('a failing retry counts, stops at 5 tries, and never after the 24 h of the entry (Resend’s idempotency window)', async () => {
    pendingNotice({ noticeAttempts: 4, receivedAt: new Date(Date.now() - 5 * HOUR) })
    pendingNotice({ externalKey: 'vieja@cafe.mx', receivedAt: new Date(Date.now() - 25 * HOUR), noticeAttempts: 1 })
    ;(notifyNewProspect as jest.Mock).mockResolvedValue(false)

    await expect(resendPendingNotices()).resolves.toBe(1)
    expect(db.entries[0]).toMatchObject({ noticeSentAt: null, noticeAttempts: 5 })

    await expect(resendPendingNotices()).resolves.toBe(0)
    expect(notifyNewProspect).toHaveBeenCalledTimes(1)
    const [read] = rawReads('CrmInboundEntry')
    expect(read.values[0]).toBe(5)
  })

  it('reintentos_espaciados (ruling 59): one more hour of wait per try already made, within the 24 h', async () => {
    // Tried once, 30 minutes ago: waits until an hour after the entry. Tried three times, entry 2.5 h old: waits until 3 h.
    pendingNotice({ receivedAt: new Date(Date.now() - 30 * MINUTE), noticeAttempts: 1 })
    pendingNotice({ externalKey: 'tres@cafe.mx', receivedAt: new Date(Date.now() - 150 * MINUTE), noticeAttempts: 3 })
    // A notice that never got its first try (the process died after applying it) goes at once.
    const fresh = pendingNotice({ externalKey: 'cero@cafe.mx', receivedAt: new Date(Date.now() - MINUTE), noticeAttempts: 0 })
    ;(notifyNewProspect as jest.Mock).mockResolvedValue(true)

    await expect(resendPendingNotices()).resolves.toBe(1)
    expect(notifyNewProspect).toHaveBeenCalledWith(fresh.account.id, CONTENT)

    // The spacing is in the database: the entry's age against its tries, with «now» through utcTs.
    const [read] = rawReads('CrmInboundEntry')
    expect(read.sql).toContain(`e."receivedAt" + e."noticeAttempts" * INTERVAL '1 hour' < (? AT TIME ZONE 'UTC')`)
  })

  it('an entry with nothing to announce is never retried: a customer, or a return that brought nothing back', async () => {
    pendingNotice({}, { signup: 'CUSTOMER', created: true })
    pendingNotice({ externalKey: 'otra@cafe.mx' }, { signup: 'EXISTING_ACCOUNT', created: false })

    await expect(resendPendingNotices()).resolves.toBe(0)

    expect(notifyNewProspect).not.toHaveBeenCalled()
    expect(notifyReturningProspect).not.toHaveBeenCalled()
  })
})

describe('todo_con_tope_de_lote', () => {
  /** The `take` of the last call to a Prisma read that matches. */
  const lastTake = (fn: jest.Mock, isTheRead: (args: Row) => boolean = () => true) =>
    [...fn.mock.calls].reverse().find(([args]) => isTheRead(args))?.[0]?.take
  /** The LIMIT of the last raw read of the marks: its last bind. */
  const lastMarksLimit = () => rawReads('ActivityLog').at(-1)?.values.at(-1)

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
      limit: () => lastTake(prismaMock.crmInboundEntry.findMany),
      done: () => db.entries.filter(entry => entry.appliedAt).length,
    },
    {
      pass: 'linkLandingAccounts',
      seed: () =>
        three.forEach(({ email, organizationId, createdAt }) => {
          seedLandingAccount({ externalKey: email, createdAt })
          seedOrganization({ id: organizationId })
          seedStaff(email, {}, organizationId)
        }),
      run: linkLandingAccounts,
      limit: () => lastTake(prismaMock.crmAccount.findMany, args => !!args.where.AND),
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
      limit: lastMarksLimit,
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
      // A raw read now (ruling 51): its LIMIT is the last bind.
      limit: () => rawReads('CrmAccount').at(-1)?.values.at(-1),
      done: () => db.accounts.filter(account => account.firstMoneyAt).length,
    },
  ])('$pass reads one batch per pass, and the next pass goes on with the rest', async ({ seed, run, limit, done }) => {
    seed()

    await run(2)
    expect(limit()).toBe(2)
    expect(done()).toBe(2)

    await run(2)
    expect(done()).toBe(3)

    // The cap is the server's: asked for ten thousand, it reads 200.
    await run(10_000)
    expect(limit()).toBe(200)
    expect(done()).toBe(3)
  })

  it.each([
    {
      pass: 'linkLandingAccounts',
      // The two oldest landing accounts belong to people who own nothing — the ones that never link.
      seed: () => {
        seedLandingAccount({ externalKey: 'nada1@cafe.mx', createdAt: new Date(Date.now() - 9 * DAY) })
        seedLandingAccount({ externalKey: 'nada2@cafe.mx', createdAt: new Date(Date.now() - 8 * DAY) })
        seedLandingAccount({ createdAt: new Date(Date.now() - DAY) })
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
    const landing = seedLandingAccount()
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
