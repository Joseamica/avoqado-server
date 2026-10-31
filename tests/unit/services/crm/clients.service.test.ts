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
import { getLive, listClients } from '@/services/crm/clients.service'
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

const org = (over: Record<string, unknown> = {}) => ({
  id: ORG,
  name: 'Tacos El Güero',
  createdAt: new Date('2026-09-01T12:00:00.000Z'),
  crmAccount: null,
  _count: { venues: 1 },
  ...over,
})

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

const MODELS = ['crmAccount', 'crmTeam', 'organization', 'venue', 'staffOrganization', 'onboardingProgress', 'terminal', 'payment'] as const

beforeEach(() => {
  for (const model of MODELS) for (const fn of Object.values(prismaMock[model]) as jest.Mock[]) fn.mockReset()
  jest.mocked(getPlanState).mockReset()
  prismaMock.crmTeam.findUnique.mockResolvedValue({ organizationId: TEAM_ORG })
  prismaMock.organization.findMany.mockResolvedValue([])
  prismaMock.organization.count.mockResolvedValue(0)
  prismaMock.crmAccount.findMany.mockResolvedValue([])
})

describe('listClients', () => {
  it('clientes_excluye_demo_y_equipo', async () => {
    await listClients(access(), {}, NOW)

    const { where } = prismaMock.organization.findMany.mock.calls[0][0]
    // The team's organization, by its CrmTeam row (ruling 14) — never its name or slug.
    expect(prismaMock.crmTeam.findUnique).toHaveBeenCalledWith({ where: { key: 'default' }, select: { organizationId: true } })
    expect(where.AND).toContainEqual({ id: { not: TEAM_ORG } })
    // Money or a paid plan only counts in a REAL venue: a TRIAL or LIVE_DEMO comes seeded with sample sales.
    const [clientRule] = where.AND.filter((part: any) => part.OR)
    const [byVenue, byWin] = clientRule.OR
    expect(byVenue.venues.some).toMatchObject(REAL_VENUE)
    expect(PRODUCTION_VENUE_STATUSES).not.toContain(VenueStatus.TRIAL)
    expect(PRODUCTION_VENUE_STATUSES).not.toContain(VenueStatus.LIVE_DEMO)
    const reasons = byVenue.venues.some.OR
    expect(reasons).toContainEqual({ payments: { some: MONEY } })
    // A paid plan: the classic row in force without a trial end, or a live contract — the tables getPlanState reads.
    expect(reasons).toContainEqual({
      features: { some: { feature: { code: { in: ['PLAN_PRO', 'PLAN_PREMIUM'] } }, active: true, suspendedAt: null, endDate: null } },
    })
    expect(reasons).toContainEqual({
      hybridContracts: {
        some: { endedAt: null, planTier: { in: ['PRO', 'PREMIUM'] }, OR: [{ cancelAt: null }, { cancelAt: { gt: NOW } }] },
      },
    })
    // Or a seller marked it «Ganado».
    expect(byWin).toEqual({ crmAccount: { is: { stage: { kind: 'GANADA' } } } })
    // The total counts the same thing the page lists.
    expect(prismaMock.organization.count).toHaveBeenCalledWith({ where })
  })

  it('sin_equipo_creado_no_excluye_nada_de_mas', async () => {
    prismaMock.crmTeam.findUnique.mockResolvedValue(null)
    await listClients(access(), {}, NOW)
    const { where } = prismaMock.organization.findMany.mock.calls[0][0]
    expect(where.AND).not.toContainEqual(expect.objectContaining({ id: expect.anything() }))
  })

  it('el_servidor_pone_el_tope_y_dice_el_total_real', async () => {
    prismaMock.organization.count.mockResolvedValue(935)
    await listClients(access(), { limit: 10_000 }, NOW)
    const args = prismaMock.organization.findMany.mock.calls[0][0]
    // 100 a page whatever the client asks, plus one to know whether there is a next page.
    expect(args.take).toBe(101)
    expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }])

    await listClients(access(), { limit: 0 }, NOW)
    expect(prismaMock.organization.findMany.mock.calls[1][0].take).toBe(2)
  })

  it('pagina_con_cursor_y_total', async () => {
    const page = Array.from({ length: 3 }, (_, i) => org({ id: `corgclient00000000000001${i}`, name: `Negocio ${i}` }))
    prismaMock.organization.findMany.mockResolvedValue(page)
    prismaMock.organization.count.mockResolvedValue(7)

    const first = await listClients(access(), { limit: 2 }, NOW)
    expect(first.rows.map(row => row.name)).toEqual(['Negocio 0', 'Negocio 1'])
    expect(first.nextCursor).toBe('corgclient000000000000011')
    expect(first.total).toBe(7)

    prismaMock.organization.findMany.mockResolvedValue(page.slice(2))
    const last = await listClients(access(), { limit: 2, cursor: 'corgclient000000000000011' }, NOW)
    expect(prismaMock.organization.findMany.mock.calls[1][0]).toMatchObject({ cursor: { id: 'corgclient000000000000011' }, skip: 1 })
    expect(last.rows).toHaveLength(1)
    expect(last.nextCursor).toBeNull()
  })

  it('busca_por_nombre_en_la_base', async () => {
    await listClients(access(), { q: 'güero' }, NOW)
    const { where } = prismaMock.organization.findMany.mock.calls[0][0]
    expect(where.AND).toContainEqual({ name: { contains: 'güero', mode: 'insensitive' } })
  })

  it('propios_ve_a_todos_los_clientes_pero_no_el_dueno_de_otro', async () => {
    prismaMock.organization.findMany.mockResolvedValue([
      org({ id: ORG, crmAccount: { id: ACCOUNT } }),
      org({ id: ORG_2, crmAccount: { id: ACCOUNT_B }, _count: { venues: 0 } }),
      org({ id: ORG_3 }),
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

  it('vivo_trae_estado_kyc_alta_acceso_del_dueno_y_terminales', async () => {
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
        { id: VENUE, name: 'Centro', status: 'ACTIVE', kycStatus: 'VERIFIED', terminales: 2, plan: { tier: 'PRO' } },
        { id: VENUE_2, name: 'Norte', status: 'ONBOARDING', kycStatus: 'PENDING_REVIEW', terminales: 0, plan: { tier: 'PRO' } },
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
