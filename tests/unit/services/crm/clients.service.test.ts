/**
 * «Clientes» and what is live in Avoqado for one account (spec 2026-10-30 §5.5, plan task 9, ruling 35).
 *
 * What these pin beyond the happy path: a client is real money or a paid plan in a REAL venue — never a demo's sample
 * sales, never the sales team's own organization — or a «Ganado» link; the server caps the page whatever the client
 * asks and says the real total; a «propios» seller sees every client but not a colleague's owner and stage; the ficha
 * never carries a card, shows sales only with «Ver ventas», takes the plan from the contract when there is no classic
 * row, and counts «the month» on Mexico City's calendar.
 */
import { Prisma, TransactionStatus, VenueStatus } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'
import { PRODUCTION_VENUE_STATUSES } from '@/lib/venueStatus.constants'
import type { CrmAccess } from '@/services/crm/access.service'
import { getClientLive, getLive, hideClient, listClients, unhideClient } from '@/services/crm/clients.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import { getPlanState, type PlanState } from '@/services/dashboard/planState.service'

jest.mock('@/services/dashboard/planState.service', () => ({ getPlanState: jest.fn() }))
jest.mock('@/services/crm/digest.service', () => ({ notifyNewProspect: jest.fn(), notifyReturningProspect: jest.fn() }))

const SELLER = 'cstaffsel0000000000000001'
const OTHER = 'cstaffoth0000000000000001'
const ACCOUNT = 'caccounta0000000000000001'
const ACCOUNT_B = 'caccountb0000000000000001'
const ORG = 'corgclient000000000000001'
const ORG_2 = 'corgclient000000000000002'
const ORG_3 = 'corgclient000000000000003'
const TEAM_ORG = 'corgteam00000000000000001'
const VENUE = 'cvenueaaa0000000000000001'
const VENUE_2 = 'cvenuebbb0000000000000001'
const GANADO = 'cstagegan0000000000000001'

// Noon in Mexico City on 31-oct-2026 (UTC-6 all year since 2022).
const NOW = new Date('2026-10-31T18:00:00.000Z')

const access = (over: Partial<CrmAccess> = {}): CrmAccess => ({
  staffId: SELLER,
  isSuperadmin: false,
  ver: 'propios',
  editar: 'propios',
  contactar: true,
  campanas: false,
  exportar: false,
  ventas: false,
  admin: false,
  ...over,
})

const MINE_OR_UNOWNED = { OR: [{ ownerStaffId: SELLER }, { ownerStaffId: null }] }
const MONEY = { status: TransactionStatus.COMPLETED, amount: { gt: 0 } }
const REAL_VENUE = { status: { in: PRODUCTION_VENUE_STATUSES }, demoExpiresAt: null }

const planState = (over: Partial<PlanState> = {}): PlanState => ({
  hasPlan: true,
  state: 'active',
  planTier: 'PRO',
  planName: 'Plan Pro',
  interval: 'month',
  price: { base: 999, gross: 1158.84, currency: 'MXN' },
  trialEndsAt: null,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  suspendedAt: null,
  gracePeriodEndsAt: null,
  paymentMethod: null,
  stripeSubscriptionId: 'sub_secreto_123',
  grandfathered: false,
  retentionOfferEligible: false,
  origin: {
    kind: 'CLASSIC',
    tier: 'PRO',
    price: null,
    interval: 'month',
    currentPeriodEnd: null,
    cancelAt: null,
    contractId: null,
    contractRevision: null,
    subscriptionId: 'sub_secreto_123',
    paymentIssue: null,
  },
  ...over,
})

const MODELS = [
  'crmAccount',
  'crmTeam',
  'crmHiddenClient',
  'organization',
  'venue',
  'staffOrganization',
  'onboardingProgress',
  'terminal',
  'payment',
] as const

beforeEach(() => {
  for (const model of MODELS) for (const fn of Object.values(prismaMock[model]) as jest.Mock[]) fn.mockReset()
  jest.mocked(getPlanState).mockReset()
  prismaMock.$queryRaw.mockReset()
  prismaMock.crmTeam.findUnique.mockResolvedValue({ organizationId: TEAM_ORG })
  prismaMock.crmAccount.findMany.mockResolvedValue([])
  clientsDb()
})

/**
 * «Clientes» reads in raw SQL (ruling 51): the page and its total. Each test answers the page with these rows and the
 * total with this number.
 */
function clientsDb(rows: Array<Record<string, unknown>> = [], total = rows.length) {
  prismaMock.$queryRaw.mockImplementation(async (query: Prisma.Sql) => (query.sql.includes('COUNT(*)') ? [{ total }] : rows))
}
const rawQueries = () => (prismaMock.$queryRaw.mock.calls as Array<[Prisma.Sql]>).map(([query]) => query)
const pageQuery = (n = 0) => rawQueries().filter(query => !query.sql.includes('COUNT(*)'))[n]
const countQuery = (n = 0) => rawQueries().filter(query => query.sql.includes('COUNT(*)'))[n]
/** What follows `FROM "Organization" o`: the filter of the page (before its order) and of the total. */
const filterOf = (query: Prisma.Sql) => {
  const from = query.sql.slice(query.sql.indexOf('FROM "Organization" o')).replace(/\s+/g, ' ')
  return (from.includes('ORDER BY') ? from.slice(0, from.indexOf('ORDER BY')) : from).trim()
}

/** A row of the page as the SQL returns it. */
const client = (over: Record<string, unknown> = {}) => ({
  id: ORG,
  name: 'Tacos El Güero',
  createdAt: new Date('2026-09-01T12:00:00.000Z'),
  crmAccountId: null,
  yaCobro: true,
  ...over,
})

describe('listClients', () => {
  it('clientes_excluye_demo_y_equipo', async () => {
    await listClients(access(), {}, NOW)

    const page = pageQuery()
    // The team's organization, by its CrmTeam row (ruling 14) — never its name or slug.
    expect(prismaMock.crmTeam.findUnique).toHaveBeenCalledWith({ where: { key: 'default' }, select: { organizationId: true } })
    expect(page.sql).toContain('o."id" <> ?')
    expect(page.values).toContain(TEAM_ORG)
    // Money or a paid plan only counts in a REAL venue: a TRIAL or LIVE_DEMO comes seeded with sample sales.
    expect(page.sql).toContain('v."status"::text IN (')
    expect(page.sql).toContain('v."demoExpiresAt" IS NULL')
    for (const status of PRODUCTION_VENUE_STATUSES) expect(page.values).toContain(status)
    expect(page.values).not.toContain(VenueStatus.TRIAL)
    expect(page.values).not.toContain(VenueStatus.LIVE_DEMO)
    // Real money: a correlated EXISTS per venue that stops at the first charge (ruling 51), never `payments.some` inside an
    // OR, which Postgres runs as a hashed subplan over every completed payment of the platform.
    expect(page.sql).toContain(
      `EXISTS (SELECT 1 FROM "Payment" p WHERE p."venueId" = v."id" AND p."status" = 'COMPLETED' AND p."amount" > 0)`,
    )
    expect(page.sql).not.toMatch(/IN \(\s*SELECT/i)
    // A paid plan: the classic row in force without a trial end, or a live contract — the tables getPlanState reads.
    expect(page.sql).toMatch(/FROM "VenueFeature" vf JOIN "Feature" f ON f\."id" = vf\."featureId"/)
    expect(page.sql).toContain('vf."active" = true AND vf."suspendedAt" IS NULL AND vf."endDate" IS NULL')
    expect(page.values).toEqual(expect.arrayContaining(['PLAN_PRO', 'PLAN_PREMIUM']))
    expect(page.sql).toContain(`hc."endedAt" IS NULL AND hc."planTier" IN ('PRO', 'PREMIUM')`)
    // «Now» goes through utcTs: the column stores UTC, and a bare bind would shift with the session's zone.
    expect(page.sql).toContain(`hc."cancelAt" IS NULL OR hc."cancelAt" > (? AT TIME ZONE 'UTC')`)
    expect(page.values).toContainEqual(NOW)
    // Or a seller marked it «Ganado».
    expect(page.sql).toContain(`cs."kind" = 'GANADA'`)
    // The total counts the same thing the page lists, with the same binds.
    const count = countQuery()
    expect(filterOf(count)).toBe(filterOf(page))
    expect(count.values).toEqual(page.values.slice(PRODUCTION_VENUE_STATUSES.length, -1))
  })

  it('sin_equipo_creado_no_excluye_nada_de_mas', async () => {
    prismaMock.crmTeam.findUnique.mockResolvedValue(null)
    await listClients(access(), {}, NOW)
    expect(pageQuery().sql).not.toContain('o."id" <>')
  })

  it('el_servidor_pone_el_tope_y_dice_el_total_real', async () => {
    clientsDb([], 935)
    await expect(listClients(access(), { limit: 10_000 }, NOW)).resolves.toMatchObject({ total: 935 })
    // 100 a page whatever the client asks, plus one to know whether there is a next page.
    expect(pageQuery().values.at(-1)).toBe(101)
    expect(pageQuery().sql).toContain('ORDER BY o."createdAt" DESC, o."id" DESC')

    await listClients(access(), { limit: 0 }, NOW)
    expect(pageQuery(1).values.at(-1)).toBe(2)
  })

  it('pagina_con_cursor_y_total', async () => {
    const page = Array.from({ length: 3 }, (_, i) => client({ id: `corgclient00000000000001${i}`, name: `Negocio ${i}` }))
    clientsDb(page, 7)

    const first = await listClients(access(), { limit: 2 }, NOW)
    expect(first.rows.map(row => row.name)).toEqual(['Negocio 0', 'Negocio 1'])
    expect(first.nextCursor).toBe('corgclient000000000000011')
    expect(first.total).toBe(7)
    expect(pageQuery().sql).not.toContain('(o."createdAt", o."id") <')

    clientsDb(page.slice(2), 7)
    const last = await listClients(access(), { limit: 2, cursor: 'corgclient000000000000011' }, NOW)
    // After the cursor's row in the same (createdAt DESC, id DESC) order.
    expect(pageQuery(1).sql).toContain('(o."createdAt", o."id") < (SELECT c."createdAt", c."id" FROM "Organization" c WHERE c."id" = ?)')
    expect(pageQuery(1).values).toContain('corgclient000000000000011')
    expect(last.rows).toHaveLength(1)
    expect(last.nextCursor).toBeNull()
  })

  it('busca_por_nombre_en_la_base', async () => {
    await listClients(access(), { q: 'güero' }, NOW)
    expect(pageQuery().sql).toContain('o."name" ILIKE ?')
    expect(pageQuery().values).toContain('%güero%')
    expect(countQuery().values).toContain('%güero%')

    // A «%» or «_» typed in the search is a letter, not a wildcard.
    await listClients(access(), { q: '50%_off' }, NOW)
    expect(pageQuery(1).values).toContain('%50\\%\\_off%')
  })

  it('propios_ve_a_todos_los_clientes_pero_no_el_dueno_de_otro', async () => {
    clientsDb([
      client({ id: ORG, crmAccountId: ACCOUNT }),
      client({ id: ORG_2, crmAccountId: ACCOUNT_B, yaCobro: false }),
      client({ id: ORG_3 }),
    ])
    // Only ORG's account is in the seller's scope: ORG_2's belongs to a colleague.
    prismaMock.crmAccount.findMany.mockResolvedValue([
      {
        id: ACCOUNT,
        organizationId: ORG,
        owner: { id: SELLER, firstName: 'Luis', lastName: 'Ramírez' },
        stage: { id: GANADO, name: 'Ganado', kind: 'GANADA' },
        firstMoneyAt: null,
      },
    ])

    const { rows } = await listClients(access(), {}, NOW)

    // One query for the whole page, through the same scope as every account list — never one per row.
    expect(prismaMock.crmAccount.findMany).toHaveBeenCalledTimes(1)
    expect(prismaMock.crmAccount.findMany.mock.calls[0][0].where).toEqual({
      AND: [{ organizationId: { in: [ORG, ORG_2] } }, MINE_OR_UNOWNED],
    })
    expect(rows).toEqual([
      expect.objectContaining({
        id: ORG,
        yaCobro: true,
        cuenta: { id: ACCOUNT, owner: { id: SELLER, name: 'Luis Ramírez' }, stage: { id: GANADO, name: 'Ganado', kind: 'GANADA' } },
        cuentaAjena: false,
      }),
      // «Aún no cobra», and somebody else's account: listed, without its owner or stage.
      expect.objectContaining({ id: ORG_2, yaCobro: false, cuenta: null, cuentaAjena: true }),
      // A client nobody has in the CRM yet.
      expect.objectContaining({ id: ORG_3, cuenta: null, cuentaAjena: false }),
    ])
    // «Ya cobró» is the same real-money EXISTS, per row.
    expect(pageQuery().sql).toMatch(/AS "yaCobro"/)
  })
})

describe('organizaciones ocultas (ruling 39)', () => {
  const HIDDEN = 'NOT EXISTS (SELECT 1 FROM "CrmHiddenClient" h WHERE h."organizationId" = o."id")'
  const ONLY_HIDDEN = /(?<!NOT )EXISTS \(SELECT 1 FROM "CrmHiddenClient" h WHERE h\."organizationId" = o\."id"\)/

  it('clientes_ocultos_no_salen_ni_cuentan', async () => {
    await listClients(access(), {}, NOW)
    // In the database, before the page and in the total: Prime never takes a slot of the page.
    expect(pageQuery().sql).toContain(HIDDEN)
    expect(countQuery().sql).toContain(HIDDEN)
  })

  it('ocultos_con_admin_lista_solo_las_ocultas', async () => {
    await listClients(access({ admin: true }), { ocultos: true }, NOW)
    expect(pageQuery().sql).toMatch(ONLY_HIDDEN)
    expect(pageQuery().sql).not.toContain(HIDDEN)
    // Still clients by the same rule, and never the team's organization.
    expect(pageQuery().values).toContain(TEAM_ORG)
  })

  it('ocultos_sin_admin_se_ignora', async () => {
    await listClients(access(), { ocultos: true }, NOW)
    expect(pageQuery().sql).toContain(HIDDEN)
  })

  it('ocultar_es_idempotente_y_queda_en_la_bitacora', async () => {
    const admin = access({ admin: true, ver: null, editar: null })
    prismaMock.organization.findUnique.mockResolvedValue({ id: ORG, name: 'Grupo de pruebas' })
    prismaMock.crmHiddenClient.createMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 })
    jest.mocked(logAction).mockClear()

    await expect(hideClient(admin, ORG)).resolves.toEqual({ organizationId: ORG, oculta: true })
    expect(prismaMock.crmHiddenClient.createMany).toHaveBeenCalledWith({ data: [{ organizationId: ORG }], skipDuplicates: true })
    expect(logAction).toHaveBeenCalledWith({
      staffId: SELLER,
      venueId: null,
      organizationId: ORG,
      action: 'CRM_CLIENT_HIDDEN',
      entity: 'Organization',
      entityId: ORG,
      data: { organizationName: 'Grupo de pruebas' },
    })

    // Hiding it again changes nothing and logs nothing.
    await expect(hideClient(admin, ORG)).resolves.toEqual({ organizationId: ORG, oculta: true })
    expect(logAction).toHaveBeenCalledTimes(1)
  })

  it('ocultar_una_organizacion_que_no_existe_es_404', async () => {
    prismaMock.organization.findUnique.mockResolvedValue(null)
    await expect(hideClient(access({ admin: true }), ORG)).rejects.toMatchObject({ statusCode: 404 })
    expect(prismaMock.crmHiddenClient.createMany).not.toHaveBeenCalled()
  })

  it('regresar_es_idempotente_y_queda_en_la_bitacora', async () => {
    prismaMock.crmHiddenClient.deleteMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 })
    jest.mocked(logAction).mockClear()

    await expect(unhideClient(access({ admin: true }), ORG)).resolves.toEqual({ organizationId: ORG, oculta: false })
    expect(prismaMock.crmHiddenClient.deleteMany).toHaveBeenCalledWith({ where: { organizationId: ORG } })
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ staffId: SELLER, organizationId: ORG, action: 'CRM_CLIENT_UNHIDDEN', entityId: ORG }),
    )
    // A visible one: nothing to do, nothing logged.
    await expect(unhideClient(access({ admin: true }), ORG)).resolves.toEqual({ organizationId: ORG, oculta: false })
    expect(logAction).toHaveBeenCalledTimes(1)
  })
})

describe('getLive', () => {
  /** A linked account with one venue and everything else empty. */
  function linked(over: { venues?: unknown[]; ventas?: unknown } = {}) {
    prismaMock.crmAccount.findFirst.mockResolvedValue({ organizationId: ORG })
    prismaMock.venue.findMany.mockResolvedValue(
      over.venues ?? [{ id: VENUE, name: 'Centro', status: 'ACTIVE', kycStatus: 'VERIFIED', _count: { terminals: 2 } }],
    )
    prismaMock.venue.count.mockResolvedValue((over.venues ?? [1]).length)
    prismaMock.staffOrganization.findFirst.mockResolvedValue({
      staff: { firstName: 'Ana', lastName: 'López', lastLoginAt: new Date('2026-10-30T15:00:00.000Z') },
    })
    prismaMock.onboardingProgress.findUnique.mockResolvedValue({ completedSteps: [1, 2, 3], completedAt: null })
    prismaMock.terminal.count.mockResolvedValue(2)
    prismaMock.payment.aggregate.mockResolvedValue({ _sum: { amount: over.ventas ?? new Prisma.Decimal('1500.50') } })
    jest.mocked(getPlanState).mockResolvedValue(planState())
  }

  it('vivo_sin_llave_ventas_no_trae_ventas', async () => {
    linked()
    const live = await getLive(access({ ventas: false }), ACCOUNT, NOW)

    expect(live).toMatchObject({ ligada: true, ventasMes: null, ventasBloqueadas: true })
    // Not even read: what the seller may not see never leaves the database.
    expect(prismaMock.payment.aggregate).not.toHaveBeenCalled()
  })

  it('vivo_con_llave_ventas_suma_el_mes_de_ciudad_de_mexico', async () => {
    linked()
    const live = await getLive(access({ ventas: true }), ACCOUNT, NOW)

    expect(live).toMatchObject({ ventasBloqueadas: false })
    expect(live.ligada && live.ventasMes?.toString()).toBe('1500.5')
    // October in Mexico City: 1-oct 00:00 (06:00Z) up to, not including, 1-nov 00:00 (06:00Z). Real money, real venues.
    expect(prismaMock.payment.aggregate).toHaveBeenCalledWith({
      where: {
        ...MONEY,
        createdAt: { gte: new Date('2026-10-01T06:00:00.000Z'), lt: new Date('2026-11-01T06:00:00.000Z') },
        venue: { organizationId: ORG, ...REAL_VENUE },
      },
      _sum: { amount: true },
    })

    // 21:00 of 31-oct in Mexico City is already November in UTC: still October here.
    await getLive(access({ ventas: true }), ACCOUNT, new Date('2026-11-01T03:00:00.000Z'))
    expect(prismaMock.payment.aggregate.mock.calls[1][0].where.createdAt).toEqual({
      gte: new Date('2026-10-01T06:00:00.000Z'),
      lt: new Date('2026-11-01T06:00:00.000Z'),
    })

    // December rolls over to January of the next year; a month without sales is $0, not null.
    prismaMock.payment.aggregate.mockResolvedValue({ _sum: { amount: null } })
    const december = await getLive(access({ ventas: true }), ACCOUNT, new Date('2026-12-15T18:00:00.000Z'))
    expect(prismaMock.payment.aggregate.mock.calls[2][0].where.createdAt).toEqual({
      gte: new Date('2026-12-01T06:00:00.000Z'),
      lt: new Date('2027-01-01T06:00:00.000Z'),
    })
    expect(december.ligada && december.ventasMes?.toString()).toBe('0')
  })

  it('vivo_plan_por_contrato_sin_fila_clasica', async () => {
    linked()
    // A commercial contract without a classic row: getPlanState says planTier null (Codex plan r1 #8).
    jest.mocked(getPlanState).mockResolvedValue(
      planState({
        hasPlan: false,
        state: 'none',
        planTier: null,
        stripeSubscriptionId: null,
        origin: { ...planState().origin!, kind: 'CONTRACT', tier: 'PREMIUM', contractId: 'ccontract000000000000001' },
      }),
    )

    const live = await getLive(access(), ACCOUNT, NOW)
    expect(getPlanState).toHaveBeenCalledWith(VENUE)
    expect(live.ligada && live.venues[0].plan).toEqual({ tier: 'PREMIUM', origen: 'CONTRACT', estado: 'none' })
  })

  it('vivo_nunca_trae_tarjeta', async () => {
    linked()
    jest.mocked(getPlanState).mockResolvedValue(planState({ paymentMethod: { brand: 'visa', last4: '4242', expMonth: 12, expYear: 2030 } }))

    const live = await getLive(access({ ventas: true }), ACCOUNT, NOW)
    const text = JSON.stringify(live)
    for (const leak of ['paymentMethod', 'visa', '4242', 'sub_secreto_123', 'stripe']) expect(text).not.toContain(leak)
  })

  it('vivo_trae_estado_alta_acceso_del_dueno_y_terminales', async () => {
    linked({
      venues: [
        { id: VENUE, name: 'Centro', status: 'ACTIVE', kycStatus: 'VERIFIED', _count: { terminals: 2 } },
        { id: VENUE_2, name: 'Norte', status: 'ONBOARDING', kycStatus: 'PENDING_REVIEW', _count: { terminals: 0 } },
      ],
    })
    prismaMock.venue.count.mockResolvedValue(2)

    const live = await getLive(access(), ACCOUNT, NOW)

    expect(live).toMatchObject({
      ligada: true,
      organizationId: ORG,
      venues: [
        { id: VENUE, name: 'Centro', status: 'ACTIVE', terminales: 2, plan: { tier: 'PRO' } },
        { id: VENUE_2, name: 'Norte', status: 'ONBOARDING', terminales: 0, plan: { tier: 'PRO' } },
      ],
      sucursales: 2,
      terminales: 2,
      dueno: { nombre: 'Ana López', ultimoAcceso: new Date('2026-10-30T15:00:00.000Z') },
      alta: { hechos: 3, totales: 8, terminada: false },
    })
    // One organization's venues, capped; the owner is the active OWNER, the primary first.
    expect(prismaMock.venue.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { organizationId: ORG }, take: 20 }))
    expect(prismaMock.staffOrganization.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: ORG, role: 'OWNER', isActive: true } }),
    )
  })

  it('vivo_kyc_solo_con_admin', async () => {
    // Spec §5.10 (ruling 40): the seller never sees KYC — not even its status.
    linked()
    const seller = await getLive(access({ ver: 'todos', ventas: true }), ACCOUNT, NOW)
    expect(seller.ligada && seller.venues[0]).not.toHaveProperty('kycStatus')
    expect(JSON.stringify(seller)).not.toContain('VERIFIED')

    const admin = await getLive(access({ admin: true }), ACCOUNT, NOW)
    expect(admin.ligada && admin.venues[0]).toMatchObject({ kycStatus: 'VERIFIED' })
  })

  it('vivo_lee_el_plan_de_a_lo_mas_4_venues_a_la_vez', async () => {
    const venues = Array.from({ length: 10 }, (_, i) => ({
      id: `cvenue${String(i).padStart(19, '0')}`,
      name: `Sucursal ${i}`,
      status: 'ACTIVE',
      kycStatus: 'VERIFIED',
      _count: { terminals: 0 },
    }))
    linked({ venues })
    // getPlanState can go to Stripe with retries: each call waits until the test lets it go.
    let running = 0
    let peak = 0
    const waiting: Array<() => void> = []
    jest.mocked(getPlanState).mockImplementation(async () => {
      running++
      peak = Math.max(peak, running)
      await new Promise<void>(resolve => waiting.push(resolve))
      running--
      return planState()
    })

    const pending = getLive(access(), ACCOUNT, NOW)
    for (let released = 0; released < venues.length; released++) {
      while (!waiting.length) await new Promise(resolve => setImmediate(resolve))
      expect(running).toBeLessThanOrEqual(4)
      waiting.shift()!()
    }
    const live = await pending

    expect(peak).toBe(4)
    expect(getPlanState).toHaveBeenCalledTimes(10)
    // Still one plan per venue, in the venues' order.
    expect(live.ligada && live.venues.map(venue => venue.id)).toEqual(venues.map(venue => venue.id))
  })

  it('vivo_de_cuenta_sin_organizacion_responde_no_ligada', async () => {
    prismaMock.crmAccount.findFirst.mockResolvedValue({ organizationId: null })

    await expect(getLive(access({ ventas: true }), ACCOUNT, NOW)).resolves.toEqual({ ligada: false })
    expect(prismaMock.venue.findMany).not.toHaveBeenCalled()
    expect(getPlanState).not.toHaveBeenCalled()
  })

  it('vivo_de_cuenta_fuera_de_alcance_es_404', async () => {
    prismaMock.crmAccount.findFirst.mockResolvedValue(null)

    await expect(getLive(access(), ACCOUNT, NOW)).rejects.toMatchObject({ statusCode: 404, code: 'CRM_ACCOUNT_NOT_FOUND' })
    expect(prismaMock.crmAccount.findFirst.mock.calls[0][0].where).toEqual({ AND: [{ id: ACCOUNT }, MINE_OR_UNOWNED] })
  })

  it('vivo_de_otro_vendedor_con_todos_si_se_ve', async () => {
    linked()
    await getLive(access({ ver: 'todos', staffId: OTHER }), ACCOUNT, NOW)
    expect(prismaMock.crmAccount.findFirst.mock.calls[0][0].where).toEqual({ AND: [{ id: ACCOUNT }, {}] })
  })
})

describe('getClientLive (ruling 47): a client without a CRM account opens its live data by Organization', () => {
  function liveWorld() {
    prismaMock.venue.findMany.mockResolvedValue([
      { id: VENUE, name: 'Centro', status: 'ACTIVE', kycStatus: 'VERIFIED', _count: { terminals: 2 } },
    ])
    prismaMock.venue.count.mockResolvedValue(1)
    prismaMock.staffOrganization.findFirst.mockResolvedValue({
      staff: { firstName: 'Ana', lastName: 'López', lastLoginAt: new Date('2026-10-30T15:00:00.000Z') },
    })
    prismaMock.onboardingProgress.findUnique.mockResolvedValue({ completedSteps: [1, 2, 3], completedAt: null })
    prismaMock.terminal.count.mockResolvedValue(2)
    prismaMock.payment.aggregate.mockResolvedValue({ _sum: { amount: new Prisma.Decimal('1500.50') } })
    jest.mocked(getPlanState).mockResolvedValue(planState())
  }

  it('cliente_sin_ficha_ve_lo_vivo_con_la_misma_forma_y_candados', async () => {
    liveWorld()
    clientsDb([{ id: ORG }])

    const seller = await getClientLive(access({ ventas: false }), ORG, NOW)

    // The same shape `GET /accounts/:id/live` answers for a linked account.
    prismaMock.crmAccount.findFirst.mockResolvedValue({ organizationId: ORG })
    expect(seller).toEqual(await getLive(access({ ventas: false }), ACCOUNT, NOW))
    expect(seller).toMatchObject({ ligada: true, organizationId: ORG, ventasMes: null, ventasBloqueadas: true })
    expect(seller.venues[0]).not.toHaveProperty('kycStatus')
    expect(prismaMock.payment.aggregate).not.toHaveBeenCalled()
    // The same locks: «Ver ventas» brings the month, «Administrar» the KYC.
    const admin = await getClientLive(access({ ventas: true, admin: true }), ORG, NOW)
    expect(admin).toMatchObject({ ventasBloqueadas: false, venues: [expect.objectContaining({ kycStatus: 'VERIFIED' })] })
    expect(admin.ventasMes?.toString()).toBe('1500.5')

    // Without a CRM account there is no account scope to ask.
    expect(prismaMock.crmAccount.findFirst).toHaveBeenCalledTimes(1) // only the `getLive` comparison above
    // Asked by the client rule of «Clientes» — this Organization, not the team's, not hidden — in one raw read.
    const [check] = rawQueries()
    expect(check.sql).toContain('o."id" = ?')
    expect(check.values).toContain(ORG)
    expect(check.values).toContain(TEAM_ORG)
    expect(check.sql).toContain('NOT EXISTS (SELECT 1 FROM "CrmHiddenClient" h WHERE h."organizationId" = o."id")')
    expect(check.sql).toContain(`EXISTS (SELECT 1 FROM "Payment" p WHERE p."venueId" = v."id"`)
  })

  it('cliente_de_otro_vendedor_404 (ruling 56): the Organization route never bypasses the account scope of `/accounts/:id/live`', async () => {
    liveWorld()
    // A client whose CRM account belongs to a colleague: not in this «propios» seller's scope.
    clientsDb([{ id: ORG, crmAccountId: ACCOUNT_B }])
    prismaMock.crmAccount.findFirst.mockResolvedValue(null)

    await expect(getClientLive(access(), ORG, NOW)).rejects.toMatchObject({ statusCode: 404, code: 'CRM_ACCOUNT_NOT_FOUND' })
    expect(prismaMock.crmAccount.findFirst).toHaveBeenCalledWith({
      where: { AND: [{ id: ACCOUNT_B }, MINE_OR_UNOWNED] },
      select: { id: true },
    })
    expect(prismaMock.venue.findMany).not.toHaveBeenCalled()
    expect(getPlanState).not.toHaveBeenCalled()

    // An account the caller does see — theirs, nobody's, or anyone's with «Ver: todos» — keeps working.
    prismaMock.crmAccount.findFirst.mockResolvedValue({ id: ACCOUNT_B })
    await expect(getClientLive(access({ ver: 'todos' }), ORG, NOW)).resolves.toMatchObject({ ligada: true, organizationId: ORG })
    expect(prismaMock.crmAccount.findFirst).toHaveBeenLastCalledWith({ where: { AND: [{ id: ACCOUNT_B }, {}] }, select: { id: true } })
  })

  it('no_es_cliente_404: not a client, hidden, the team’s own or gone — and nothing live is read', async () => {
    clientsDb([])

    await expect(getClientLive(access({ ventas: true }), ORG, NOW)).rejects.toMatchObject({ statusCode: 404, code: 'CRM_NO_ES_CLIENTE' })
    expect(prismaMock.venue.findMany).not.toHaveBeenCalled()
    expect(getPlanState).not.toHaveBeenCalled()
  })
})
