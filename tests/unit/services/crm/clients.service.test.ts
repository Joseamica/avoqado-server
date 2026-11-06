/**
 * «Clientes» and what is live in Avoqado for one account (spec 2026-10-30 §5.5, plan task 9, ruling 35).
 *
 * What these pin beyond the happy path: a client is real money or a paid plan in a REAL venue — never a demo's sample
 * sales, never the sales team's own organization — or a «Ganado» link; the server caps the page whatever the client
 * asks and says the real total; a «propios» seller sees every client but not a colleague's owner and stage; the ficha
 * never carries a card, shows sales only with «Ver ventas», takes the plan from the contract when there is no classic
 * row, and counts «the month» on Mexico City's calendar.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { Prisma, TransactionStatus, VenueStatus } from '@prisma/client'
import logger from '@/config/logger'
import { prismaMock } from '@tests/__helpers__/setup'
import { PRODUCTION_VENUE_STATUSES } from '@/lib/venueStatus.constants'
import type { CrmAccess } from '@/services/crm/access.service'
import { altaPendienteSql, clientFactsLateral, ingresoSql, monedaDelPagoSql } from '@/services/crm/clientFacts'
import { planesPorSucursal } from '@/services/crm/clientPage'
import { ingresoColumnas } from '@/services/crm/clientsSql'
import {
  clientsQueries,
  ensureClientAccount,
  getClientLive,
  getLive,
  hideClient,
  listClients,
  setAltaMotivo,
  setUsa,
  unhideClient,
} from '@/services/crm/clients.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import { getPlanState, type PlanState } from '@/services/dashboard/planState.service'

jest.mock('@/services/dashboard/planState.service', () => ({ getPlanState: jest.fn() }))
jest.mock('@/services/crm/accounts.service', () => ({
  ...jest.requireActual('@/services/crm/accounts.service'),
  ensureCrmDefaults: jest.fn(),
}))
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
  cerrar: false,
  bajas: false,
  plantillas: false,
  preparar: false,
  mandar: false,
  verCampanas: false,
  equipo: false,
  configurar: false,
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
  'crmStage',
  'crmTimelineEvent',
  'crmTeam',
  'crmHiddenClient',
  'organization',
  'venue',
  'staffOrganization',
  'onboardingProgress',
  'terminal',
  'payment',
  'staff',
  'fiscalEmisor',
] as const

beforeEach(() => {
  for (const model of MODELS) for (const fn of Object.values(prismaMock[model]) as jest.Mock[]) fn.mockReset()
  jest.mocked(getPlanState).mockReset()
  prismaMock.$queryRaw.mockReset()
  prismaMock.crmTeam.findUnique.mockResolvedValue({ organizationId: TEAM_ORG })
  prismaMock.crmAccount.findMany.mockResolvedValue([])
  prismaMock.fiscalEmisor.findMany.mockResolvedValue([])
  clientsDb()
})

/**
 * «Clientes» reads in raw SQL (ruling 51): the page, its total and the count by reason of the stalled signups (C1). Each
 * test answers the page with these rows, the total with this number and the count with zeros.
 */
function clientsDb(rows: Array<Record<string, unknown>> = [], total = rows.length) {
  // What the page adds (task 5: venues, devices, signup, comments) reads only the page's ids and finds nothing here.
  prismaMock.$queryRaw.mockImplementation(async (query: Prisma.Sql) =>
    isConteo(query) ? [{ altaSinTarjeta: 0 }] : isTotal(query) ? [{ total }] : isPage(query) ? rows : [],
  )
}
const isConteo = (query: Prisma.Sql) => query.sql.includes('AS "altaSinTarjeta"')
const isTotal = (query: Prisma.Sql) => query.sql.includes('AS "total"') && !query.sql.includes('ROW_NUMBER()')
/** The universe's page and the client check of `getClientLive`: the statements that answer organizations with their account. */
const isPage = (query: Prisma.Sql) => query.sql.includes('AS "crmAccountId"')
const rawQueries = () => (prismaMock.$queryRaw.mock.calls as Array<[Prisma.Sql]>).map(([query]) => query)
const pageQuery = (n = 0) => rawQueries().filter(isPage)[n]
const countQuery = (n = 0) => rawQueries().filter(isTotal)[n]
/** What follows `FROM "Organization" o`: the filter of the page (before its order) and of the total. */
const filterOf = (query: Prisma.Sql) => {
  const from = query.sql.slice(query.sql.indexOf('FROM "Organization" o')).replace(/\s+/g, ' ')
  return (from.includes('ORDER BY') ? from.slice(0, from.indexOf('ORDER BY')) : from).trim()
}

/** The month query of the ficha («Cobrado este mes»): one raw statement over the organization's real venues. */
const isMes = (query: Prisma.Sql) => query.sql.includes('AS "ventasMXN"')
/** Answers the month query with `row` and everything else as before. */
function mesDb(row: { ventasMXN: Prisma.Decimal | null; otraMoneda: boolean }) {
  const antes = prismaMock.$queryRaw.getMockImplementation()
  prismaMock.$queryRaw.mockImplementation(async (query: Prisma.Sql) => (isMes(query) ? [row] : antes ? antes(query) : []))
}

/** A row of the page as the SQL returns it. */
const client = (over: Record<string, unknown> = {}) => ({
  id: ORG,
  name: 'Tacos El Güero',
  createdAt: new Date('2026-09-01T12:00:00.000Z'),
  crmAccountId: null,
  yaCobro: true,
  usaMedido: 'TERMINAL',
  usaVisto: 'TERMINAL',
  usaAviso: false,
  usaEscrito: false,
  nivel: 'FREE',
  estado: 'COBRA',
  ultimoCobroAt: new Date('2026-10-30T20:00:00.000Z'),
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
    // The page's select list adds its own binds before the filter: `yaCobro` and «Ingreso» (C1b) for the page's rows.
    expect(count.values).toEqual(page.values.slice(PRODUCTION_VENUE_STATUSES.length + ingresoColumnas(NOW, false).values.length, -1))
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

describe('filtros, columnas y total de C1 (Tarea 4)', () => {
  const sqlOf = (query: Prisma.Sql) => query.sql.replace(/\s+/g, ' ')

  it('🔴 propios con dueno=<otro id> → 400 CRM_FILTRO_DE_DUENO y no consulta', async () => {
    await expect(listClients(access(), { dueno: OTHER }, NOW)).rejects.toMatchObject({
      statusCode: 400,
      code: 'CRM_FILTRO_DE_DUENO',
      message: 'Con «Ver: propios» sólo puedes filtrar «Míos» o «Sin dueño»',
    })
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled()
    expect(prismaMock.crmTeam.findUnique).not.toHaveBeenCalled()

    // «Míos» and «Sin dueño» are fine for a «propios» seller; any owner is fine with «Ver: todos».
    await expect(listClients(access(), { dueno: 'MIOS' }, NOW)).resolves.toBeDefined()
    await expect(listClients(access(), { dueno: 'SIN_DUENO' }, NOW)).resolves.toBeDefined()
    await expect(listClients(access({ ver: 'todos' }), { dueno: OTHER }, NOW)).resolves.toBeDefined()
    expect(countQuery(2).values).toContain(OTHER)
  })

  it('🔴 propios con dueno=<su propio id> es «Míos»: responde y amarra al vendedor', async () => {
    await expect(listClients(access(), { dueno: SELLER }, NOW)).resolves.toMatchObject({ legible: 1 })
    expect(sqlOf(countQuery())).toContain('ca."ownerStaffId" = ?')
    expect(countQuery().values).toContain(SELLER)
    // The same SQL as «Míos».
    await listClients(access(), { dueno: 'MIOS' }, NOW)
    expect({ sql: countQuery(1).sql, values: countQuery(1).values }).toEqual({ sql: countQuery().sql, values: countQuery().values })
  })

  it('el tope sigue siendo 100 con filtros', async () => {
    const filters = { limit: 10_000, usa: 'POS', nivel: 'PRO', estado: 'COBRA', dueno: 'MIOS', motivo: 'PRECIO' } as const
    clientsDb([], 935)
    await expect(listClients(access(), filters, NOW)).resolves.toMatchObject({ total: 935, legible: 1 })
    expect(pageQuery().values.at(-1)).toBe(101)
    expect(countQuery().sql).not.toMatch(/LIMIT \?\s*$/)
    expect(pageQuery().sql).toMatch(/LIMIT \?\s*$/)
  })

  it('cada filtro va en el WHERE de la página y del total, antes del cursor', async () => {
    await listClients(access(), { usa: 'POS', nivel: 'PRO', estado: 'COBRA', cursor: ORG_2 }, NOW)
    for (const query of [pageQuery(), countQuery()]) {
      const sql = sqlOf(query)
      expect(sql).toContain('LEFT JOIN "CrmAccount" ca ON ca."organizationId" = o."id"')
      expect(sql).toContain('LEFT JOIN LATERAL')
      expect(sql).toContain('COALESCE(ca."usaManual", f."usaMedido") = ?')
      expect(sql).toContain('f."nivel" = ?')
      expect(sql).toContain('f."estado" = ?')
      expect(query.values).toEqual(expect.arrayContaining(['POS', 'PRO', 'COBRA']))
    }
    // The cursor only in the page, after the filters.
    const page = sqlOf(pageQuery())
    expect(page.indexOf('f."estado" = ?')).toBeLessThan(page.indexOf('(o."createdAt", o."id") <'))
    expect(sqlOf(countQuery())).not.toContain('(o."createdAt", o."id") <')
  })

  it('usa=AVISO es lo escrito distinto de lo medido', async () => {
    await listClients(access(), { usa: 'AVISO' }, NOW)
    expect(sqlOf(countQuery())).toContain('(ca."usaManual" IS NOT NULL AND ca."usaManual" <> f."usaMedido")')
    expect(countQuery().values).not.toContain('AVISO')
  })

  it('dueño: MIOS es el mío, SIN_DUENO es sin cuenta o sin dueño, un id es ese dueño (con «todos»)', async () => {
    await listClients(access(), { dueno: 'MIOS' }, NOW)
    expect(sqlOf(countQuery(0))).toContain('ca."ownerStaffId" = ?')
    expect(countQuery(0).values).toContain(SELLER)
    await listClients(access(), { dueno: 'SIN_DUENO' }, NOW)
    expect(sqlOf(countQuery(1))).toContain('(ca."id" IS NULL OR ca."ownerStaffId" IS NULL)')
    await listClients(access({ ver: 'todos' }), { dueno: OTHER }, NOW)
    expect(countQuery(2).values).toContain(OTHER)
  })

  it('🔴 motivo sólo sobre cuentas en el alcance de quien mira, y siempre de un 🟠', async () => {
    await listClients(access(), { motivo: 'PRECIO' }, NOW)
    const precio = sqlOf(countQuery(0))
    expect(precio).toContain(`f."estado" = 'ALTA_SIN_TARJETA'`)
    expect(precio).toContain('(ca."ownerStaffId" = ? OR ca."ownerStaffId" IS NULL) AND ca."altaMotivo" = ?')
    expect(countQuery(0).values).toEqual(expect.arrayContaining([SELLER, 'PRECIO']))

    await listClients(access(), { motivo: 'SIN_MOTIVO' }, NOW)
    expect(sqlOf(countQuery(1))).toContain(
      '(ca."id" IS NULL OR ((ca."ownerStaffId" = ? OR ca."ownerStaffId" IS NULL) AND ca."altaMotivo" IS NULL))',
    )
    // «todos» sees every account.
    await listClients(access({ ver: 'todos' }), { motivo: 'PRECIO' }, NOW)
    expect(sqlOf(countQuery(2))).toContain('TRUE AND ca."altaMotivo" = ?')
  })

  it('🔴 listClients corre como sentencias de universo exactamente page, total y conteos de clientsQueries (texto igual), y las demás consultas sólo reciben ids de la página', async () => {
    clientsDb([
      client({ id: ORG, crmAccountId: ACCOUNT, usaVisto: 'POS', usaAviso: true, usaEscrito: true }),
      client({ id: ORG_2, crmAccountId: ACCOUNT_B, usaVisto: 'AMBOS', usaAviso: true, usaEscrito: true }),
    ])
    prismaMock.crmAccount.findMany.mockResolvedValue([
      {
        id: ACCOUNT,
        organizationId: ORG,
        owner: null,
        stage: { id: GANADO, name: 'Ganado', kind: 'GANADA' },
        usaManual: 'POS',
        usaManualPorque: 'Lo vi en su local',
        usaManualById: OTHER,
        usaManualAt: new Date('2026-10-29T17:00:00.000Z'),
      },
    ])
    prismaMock.staff.findMany.mockResolvedValue([{ id: OTHER, firstName: 'Ana', lastName: 'Pérez' }])
    const filters = { usa: 'POS', altas: true, q: 'tacos' } as const

    const result = await listClients(access(), filters, NOW)

    const expected = clientsQueries(access(), filters, NOW, TEAM_ORG)
    const universo = rawQueries().filter(query => query.sql.includes('FROM "Organization" o'))
    expect(universo.map(query => ({ sql: query.sql, values: query.values }))).toEqual(
      [expected.page, expected.total, expected.conteos].map(query => ({ sql: query.sql, values: query.values })),
    )
    // Task 5: what the page adds only ever receives the page's ids (never the universe's lateral).
    const deLaPagina = rawQueries().filter(query => !query.sql.includes('FROM "Organization" o'))
    expect(deLaPagina.length).toBeGreaterThan(0)
    for (const query of deLaPagina) {
      expect(query.sql).not.toContain('"usaMedido"')
      const ids = query.values.filter((value): value is string => typeof value === 'string' && /^c[a-z0-9]{24}$/.test(value))
      for (const id of ids) expect([ORG, ORG_2, ACCOUNT]).toContain(id)
    }
    // The rest only reads the page: its organizations, and the authors of what the caller may see.
    expect(prismaMock.crmAccount.findMany.mock.calls[0][0].where).toEqual({
      AND: [{ organizationId: { in: [ORG, ORG_2] } }, MINE_OR_UNOWNED],
    })
    expect(prismaMock.staff.findMany).toHaveBeenCalledTimes(1)
    expect(prismaMock.staff.findMany.mock.calls[0][0]).toMatchObject({ where: { id: { in: [OTHER] } }, take: 1 })

    expect(result).toMatchObject({ legible: 1, total: 2 })
    expect(result.rows[0]).toMatchObject({
      usa: {
        visto: 'POS',
        medido: 'TERMINAL',
        manual: true,
        aviso: true,
        detalle: { porque: 'Lo vi en su local', por: { id: OTHER, name: 'Ana Pérez' }, at: new Date('2026-10-29T17:00:00.000Z') },
      },
      plan: { nivel: 'FREE' },
      estado: { codigo: 'COBRA', ultimoCobroAt: new Date('2026-10-30T20:00:00.000Z') },
      cuentaAjena: false,
    })
    // A colleague's ✋: the value and the mark, never who, why or when.
    expect(result.rows[1]).toMatchObject({
      usa: { visto: 'AMBOS', medido: 'TERMINAL', manual: true, aviso: true, detalle: null },
      cuenta: null,
      cuentaAjena: true,
    })
  })

  it('sin ✋ visible no busca autores, y conteos llega con todas las llaves en cero', async () => {
    clientsDb([client()])
    const result = await listClients(access(), { altas: true }, NOW)
    expect(prismaMock.staff.findMany).not.toHaveBeenCalled()
    expect(result.rows[0].usa).toEqual({
      visto: 'TERMINAL',
      medido: 'TERMINAL',
      manual: false,
      aviso: false,
      detalle: null,
      aparatos: { terminales: 0, pos: 0 },
    })
    expect(result.conteos).toEqual({
      altaSinTarjeta: 0,
      porMotivo: {
        PRECIO: 0,
        NO_QUISO_TARJETA: 0,
        SOLO_VEIA: 0,
        OTRO_SISTEMA: 0,
        PROBLEMA_TECNICO: 0,
        DESPUES: 0,
        OTRO: 0,
        SIN_MOTIVO: 0,
        DE_OTRO: 0,
      },
      perdidos: 0,
    })
  })

  it('🔴 sin altas=true (el SUPERADMIN viejo) no se cuenta nada ni viene conteos; lo demás es igual', async () => {
    clientsDb([client()])
    const sin = await listClients(access(), { q: 'tacos' }, NOW)
    expect(sin).not.toHaveProperty('conteos')
    expect(rawQueries().some(isConteo)).toBe(false)
    expect(sin).toMatchObject({ legible: 1, total: 1, nextCursor: null })
    expect(sin.rows).toHaveLength(1)
  })

  it('🔴 conteos siempre sobre el universo ampliado (altas), con la búsqueda y sin los demás filtros', async () => {
    await listClients(access(), { usa: 'POS', estado: 'COBRA', q: 'tacos', altas: true }, NOW)
    const conteos = rawQueries().find(isConteo)!
    expect(conteos.sql).toContain('op."acquisitionSource" IS NOT NULL')
    expect(conteos.values).toContain('%tacos%')
    expect(conteos.values).not.toContain('POS')
    expect(conteos.values).not.toContain('COBRA')
  })
})

describe('Ingreso (C1b)', () => {
  const sqlOf = (query: Prisma.Sql) => query.sql.replace(/\s+/g, ' ')

  it('el filtro ingreso va en el WHERE de la página y del total, antes del cursor: categoría sobre f.ingreso, pista sobre f.pistaIngreso', async () => {
    await listClients(access(), { ingreso: 'TRANSACCIONES', cursor: ORG_2 }, NOW)
    await listClients(access(), { ingreso: 'TARJETA_OTRA_TERMINAL' }, NOW)
    for (const query of [pageQuery(0), countQuery(0)]) {
      expect(sqlOf(query)).toContain('f."ingreso" = ?')
      expect(query.values).toContain('TRANSACCIONES')
    }
    const page = sqlOf(pageQuery(0))
    expect(page.indexOf('f."ingreso" = ?')).toBeLessThan(page.indexOf('(o."createdAt", o."id") <'))
    expect(sqlOf(countQuery(1))).toContain('f."pistaIngreso" = ?')
    expect(sqlOf(countQuery(1))).not.toContain('f."ingreso" = ?')
    expect(countQuery(1).values).toContain('TARJETA_OTRA_TERMINAL')
  })

  it('🔴 el monto sólo se suma con «Ver ventas», en la misma sentencia de la página y nunca en el total', async () => {
    await listClients(access({ ventas: false }), {}, NOW)
    expect(sqlOf(pageQuery(0))).toContain('NULL::numeric AS "transacciones30d"')
    expect(sqlOf(pageQuery(0))).not.toContain('SUM(p."amount")')
    await listClients(access({ ventas: true }), {}, NOW)
    const page = sqlOf(pageQuery(1))
    expect(page).toContain('(SELECT SUM(p."amount")')
    expect(page).toContain(`p."fundsFlow" IS NOT DISTINCT FROM 'AVOQADO_PROCESSED'`)
    expect(sqlOf(countQuery(1))).not.toContain('SUM(p."amount")')
  })

  it('🔴 una sola expresión: la celda selecciona el mismo texto de ingresoSql que la lateral le da al filtro', async () => {
    await listClients(access({ ventas: true }), { ingreso: 'AMBOS' }, NOW)
    const page = pageQuery(0).sql
    const { ingreso, mensualidad, pista } = ingresoSql(NOW)
    for (const expr of [ingreso, mensualidad, pista]) {
      // Once in the lateral (what the filter reads) and once in the select list (what the cell paints).
      expect(page.split(expr.sql).length - 1).toBe(2)
    }
    // The total only has the lateral's copy.
    expect(countQuery(0).sql.split(ingreso.sql).length - 1).toBe(1)
  })

  it('cada fila trae su ingreso (el monto en pesos, número) y meta dice ingreso: 1', async () => {
    clientsDb([
      client({
        ingreso: 'AMBOS',
        mensualidad: 'PRO',
        pistaIngreso: null,
        transacciones30d: new Prisma.Decimal('4488.00'),
        otraMoneda: true,
      }),
      client({
        id: ORG_2,
        ingreso: 'NINGUNO',
        mensualidad: null,
        pistaIngreso: 'TARJETA_OTRA_TERMINAL',
        transacciones30d: null,
        otraMoneda: false,
      }),
    ])
    const result = await listClients(access({ ventas: true }), {}, NOW)
    expect(result).toMatchObject({ ingreso: 1, legible: 1 })
    expect(result.rows[0].ingreso).toEqual({ codigo: 'AMBOS', mensualidad: 'PRO', transacciones30d: 4488, otraMoneda: true, pista: null })
    expect(result.rows[1].ingreso).toEqual({
      codigo: 'NINGUNO',
      mensualidad: null,
      transacciones30d: null,
      otraMoneda: null,
      pista: 'TARJETA_OTRA_TERMINAL',
    })
  })

  it('🔴 aunque la base devolviera un monto, sin «Ver ventas» la fila no lo lleva', async () => {
    clientsDb([
      client({
        ingreso: 'TRANSACCIONES',
        mensualidad: null,
        pistaIngreso: null,
        transacciones30d: new Prisma.Decimal('10'),
        otraMoneda: true,
      }),
    ])
    const result = await listClients(access({ ventas: false }), {}, NOW)
    expect(result.rows[0].ingreso).toEqual({
      codigo: 'TRANSACCIONES',
      mensualidad: null,
      transacciones30d: null,
      otraMoneda: null,
      pista: null,
    })
  })

  it('🔴 Codex r1 #1: con «Ver ventas» y «propios», el dinero va dentro del alcance de la cuenta (el mismo que abre la ficha)', async () => {
    await listClients(access({ ventas: true }), {}, NOW)
    const page = sqlOf(pageQuery(0))
    expect(page).toContain('CASE WHEN (ca."ownerStaffId" = ? OR ca."ownerStaffId" IS NULL) THEN (SELECT SUM(p."amount")')
    expect(page).toContain('CASE WHEN (ca."ownerStaffId" = ? OR ca."ownerStaffId" IS NULL) THEN EXISTS (SELECT 1 FROM "Venue" v')
    await listClients(access({ ventas: true, ver: 'todos' }), {}, NOW)
    expect(sqlOf(pageQuery(1))).toContain('CASE WHEN TRUE THEN (SELECT SUM(p."amount")')
  })

  it('🔴 Codex r1 #3: el monto sólo suma MXN (la moneda sale de la sesión de pago) y lo de otra moneda sólo se marca', async () => {
    await listClients(access({ ventas: true, ver: 'todos' }), {}, NOW)
    const page = sqlOf(pageQuery(0))
    const moneda = monedaDelPagoSql.sql.replace(/\s+/g, ' ')
    // Codex r2 #1: a link from before aed515013 (no `paymentId`) is found by its `sessionId`.
    expect(moneda).toContain(`cs."sessionId" = p."processorId" AND cs."paymentId" IS NULL`)
    expect(page).toContain(`${moneda} = 'MXN'`)
    expect(page).toContain(`${moneda} <> 'MXN'`)
    expect(page).toContain('AS "otraMoneda"')
  })
})

describe('lo de la página (C1, Tarea 5)', () => {
  const cuid = (prefix: string, i: number) => `${prefix}${String(i).padStart(25 - prefix.length, '0')}`

  /**
   * A page of `n` stalled signups, each with a visible account that has a ✋, a reason and a note, one venue with a classic
   * plan row, devices and its signup: every extra of the page has something to read.
   */
  function paginaDb(n: number) {
    const orgs = Array.from({ length: n }, (_, i) => cuid('corgpag', i))
    const cuentas = orgs.map((_, i) => cuid('cctapag', i))
    const sucursales = orgs.map((_, i) => cuid('cvenpag', i))
    clientsDb(
      orgs.map((id, i) => client({ id, crmAccountId: cuentas[i], estado: 'ALTA_SIN_TARJETA', usaEscrito: true, usaVisto: 'POS' })),
      n,
    )
    const base = prismaMock.$queryRaw.getMockImplementation()!
    prismaMock.$queryRaw.mockImplementation(async (query: Prisma.Sql) => {
      if (isPage(query) || isTotal(query) || isConteo(query)) return base(query)
      if (query.sql.includes('ROW_NUMBER()'))
        return orgs.map((organizationId, i) => ({
          id: sucursales[i],
          organizationId,
          seatCapExempt: false,
          orgSeatCapExempt: false,
          total: 1,
          concesionPro: false,
          concesionPremium: false,
        }))
      if (query.sql.includes('"Terminal"')) return orgs.map(organizationId => ({ organizationId, terminales: 1, pos: 1 }))
      if (query.sql.includes('"OnboardingProgress" op LEFT JOIN'))
        return orgs.map(organizationId => ({
          organizationId,
          ultimaVezAt: NOW,
          campana: null,
          ofertaSlug: null,
          acquisitionSource: 'landing',
          planActivationStatus: 'NONE',
          planActivationAttempt: 0,
          negocioCreadoAt: NOW,
        }))
      if (query.sql.includes('"CrmTimelineEvent"'))
        return cuentas.map(accountId => ({ accountId, actorStaffId: OTHER, createdAt: NOW, texto: 'Le marqué' }))
      return base(query)
    })
    prismaMock.crmAccount.findMany.mockResolvedValue(
      orgs.map((organizationId, i) => ({
        id: cuentas[i],
        organizationId,
        owner: null,
        stage: { id: GANADO, name: 'Ganado', kind: 'GANADA' },
        usaManual: 'POS',
        usaManualPorque: null,
        usaManualById: OTHER,
        usaManualAt: NOW,
        altaMotivo: 'PRECIO',
        altaMotivoTexto: null,
        altaPerdido: false,
      })),
    )
    prismaMock.staff.findMany.mockResolvedValue([{ id: OTHER, firstName: 'Ana', lastName: 'Pérez' }])
    prismaMock.venueFeature.findMany.mockResolvedValue(
      sucursales.map(venueId => ({
        venueId,
        active: true,
        endDate: null,
        suspendedAt: null,
        gracePeriodEndsAt: null,
        stripeSubscriptionId: null,
        updatedAt: NOW,
        feature: { code: 'PLAN_PRO' },
      })),
    )
  }
  const consultas = () =>
    prismaMock.$queryRaw.mock.calls.length +
    prismaMock.crmAccount.findMany.mock.calls.length +
    prismaMock.staff.findMany.mock.calls.length +
    prismaMock.venueFeature.findMany.mock.calls.length

  beforeEach(() => prismaMock.venueFeature.findMany.mockReset())
  afterEach(() => prismaMock.venueFeature.findMany.mockResolvedValue([]))

  it('🔴 una página de 50 hace el mismo número de consultas que una de 2 (sin N+1), y lo trae todo', async () => {
    paginaDb(2)
    const dos = await listClients(access({ ver: 'todos' }), { altas: true }, NOW)
    const deDos = consultas()

    for (const mock of [prismaMock.$queryRaw, prismaMock.crmAccount.findMany, prismaMock.staff.findMany]) mock.mockClear()
    prismaMock.venueFeature.findMany.mockReset()
    paginaDb(50)
    const cincuenta = await listClients(access({ ver: 'todos' }), { altas: true }, NOW)

    expect(consultas()).toBe(deDos)
    expect(cincuenta.rows).toHaveLength(50)
    // Every extra arrived, so the count above covers all of them.
    for (const row of [...dos.rows, ...cincuenta.rows]) {
      expect(row.usa.aparatos).toEqual({ terminales: 1, pos: 1 })
      expect(row.alta).toMatchObject({ motivo: 'PRECIO', origen: 'LANDING', tarjeta: 'NO_INTENTO', oferta: { tipo: 'LISTA' } })
      expect(row.ultimoComentario).toEqual({ texto: 'Le marqué', autor: { id: OTHER, name: 'Ana Pérez' }, at: NOW })
      expect(row.plan).toMatchObject({ nivel: 'FREE', sucursalesLeidas: 1, sucursalesTotales: 1 })
    }
    // The plan rows of the page in ONE bounded read: at most two plan rows per venue (`@@unique([venueId, featureId])`).
    expect(prismaMock.venueFeature.findMany.mock.calls[0][0]).toMatchObject({ take: 100 })
  })

  it('🔴 C12: si el nivel de SQL y el de la página no coinciden con todas las sucursales leídas, manda SQL, la condición queda vacía y avisa sin datos de personas', async () => {
    paginaDb(1)
    // SQL says PREMIUM; the page reads one venue with a Pro row.
    const base = prismaMock.$queryRaw.getMockImplementation()!
    prismaMock.$queryRaw.mockImplementation(async (query: Prisma.Sql) =>
      isPage(query) ? [client({ id: cuid('corgpag', 0), nivel: 'PREMIUM' })] : base(query),
    )
    jest.mocked(logger.warn).mockClear()

    const { rows } = await listClients(access({ ver: 'todos' }), {}, NOW)

    expect(rows[0].plan).toMatchObject({ nivel: 'PREMIUM', condicion: null, campana: null })
    expect(logger.warn).toHaveBeenCalledTimes(1)
    const [, datos] = jest.mocked(logger.warn).mock.calls[0] as unknown as [string, Record<string, unknown>]
    expect(datos).toEqual({ organizationId: cuid('corgpag', 0), nivelSql: 'PREMIUM', nivelPagina: 'PRO' })
  })

  it('con más de 20 sucursales la diferencia es esperada: manda SQL, condición vacía y sin aviso', async () => {
    paginaDb(1)
    const base = prismaMock.$queryRaw.getMockImplementation()!
    prismaMock.$queryRaw.mockImplementation(async (query: Prisma.Sql) => {
      if (isPage(query)) return [client({ id: cuid('corgpag', 0), nivel: 'PREMIUM' })]
      const rows = await base(query)
      return query.sql.includes('ROW_NUMBER()') ? rows.map((row: Record<string, unknown>) => ({ ...row, total: 21 })) : rows
    })
    jest.mocked(logger.warn).mockClear()

    const { rows } = await listClients(access({ ver: 'todos' }), {}, NOW)

    expect(rows[0].plan).toMatchObject({ nivel: 'PREMIUM', condicion: null, sucursalesLeidas: 1, sucursalesTotales: 21 })
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('🔴 T5-1: una fila con Stripe que ya no da acceso (vencida, sin gracia) nunca dice PAGADO: cae al contrato (CAMPANA) o a nada', async () => {
    const vencida = {
      venueId: VENUE,
      active: true,
      endDate: new Date('2026-09-01T00:00:00.000Z'),
      suspendedAt: null,
      gracePeriodEndsAt: null,
      stripeSubscriptionId: 'sub_vencida',
      updatedAt: NOW,
      feature: { code: 'PLAN_PRO' },
    }
    prismaMock.venueFeature.findMany.mockResolvedValue([vencida])
    const conContrato = (contrato: boolean) =>
      prismaMock.$queryRaw.mockImplementation(async (query: Prisma.Sql) =>
        query.sql.includes('ROW_NUMBER()')
          ? [
              {
                id: VENUE,
                organizationId: ORG,
                seatCapExempt: false,
                orgSeatCapExempt: false,
                total: 1,
                concesionPro: true,
                concesionPremium: false,
              },
            ]
          : query.sql.includes('"HybridOfferPublication"') && contrato
            ? [{ venueId: VENUE, planTier: 'PRO', name: 'Combo Pro' }]
            : [],
      )

    conContrato(true)
    expect(await planesPorSucursal([ORG], NOW)).toMatchObject([{ nivel: 'PRO', condicion: 'CAMPANA', campana: 'Combo Pro' }])
    conContrato(false)
    expect(await planesPorSucursal([ORG], NOW)).toMatchObject([{ nivel: 'PRO', condicion: null }])
    // With access, the same row is PAGADO (regression).
    prismaMock.venueFeature.findMany.mockResolvedValue([{ ...vencida, endDate: null }])
    expect(await planesPorSucursal([ORG], NOW)).toMatchObject([{ nivel: 'PRO', condicion: 'PAGADO' }])
  })

  it('🔴 arquitectura: la condición sale de elegirFilaDelPlan y derivePlanState importados; nadie más puntúa filas de plan', () => {
    const fuente = (archivo: string) => readFileSync(join(__dirname, '../../../../src/services/crm', archivo), 'utf8')
    const pagina = fuente('clientPage.ts')
    expect(pagina).toMatch(/import \{[^}]*\belegirFilaDelPlan\b[^}]*\} from '\.\.\/access\/filaDelPlan'/)
    expect(pagina).toMatch(/import \{[^}]*\bderivePlanState\b[^}]*\} from '\.\.\/access\/basePlan\.service'/)
    expect(pagina).toMatch(/import \{[^}]*\bdaAcceso\b[^}]*\} from '\.\.\/access\/ventanaDeAcceso'/)
    expect(pagina).toMatch(/elegirFilaDelPlan\(/)
    expect(pagina).toMatch(/derivePlanState\(/)
    for (const archivo of ['clientPage.ts', 'clientPageSql.ts', 'clientFacts.ts', 'clientsSql.ts', 'clients.service.ts']) {
      const texto = fuente(archivo)
      // No own scoring of plan rows: no score, no «which row wins» of its own, no Stripe liveness of its own.
      expect({ archivo, puntua: /\bpuntaje\b|\bscore\b|cobroVivo|function elegir|elegirFila(?!DelPlan)/.test(texto) }).toEqual({
        archivo,
        puntua: false,
      })
      // And the derivation of the state is never re-written: no other place decides `trial` / `past_due` / `suspended`.
      expect({ archivo, deriva: /'past_due'\s*:|state\s*=\s*'(trial|suspended|canceled|active)'/.test(texto) }).toEqual({
        archivo,
        deriva: false,
      })
    }
  })
})

describe('altas sin tarjeta (C1, P1 = A)', () => {
  const ALTA = `op."acquisitionSource" IS NOT NULL`

  it('sin altas=1 el universo es exactamente clientSql: no aparece la rama de altas', async () => {
    await listClients(access(), {}, NOW)
    expect(pageQuery().sql).not.toContain(ALTA)
    expect(countQuery().sql).not.toContain(ALTA)
  })

  it('con altas=1 la lista y el total suman la rama de altas, y ésta también excluye al equipo', async () => {
    await listClients(access(), { altas: true }, NOW)
    for (const query of [pageQuery(), countQuery()]) {
      expect(query.sql).toContain(ALTA)
      expect(query.sql).toMatch(/OR \(o\."id" <> \? AND /)
      expect(query.sql).toContain('NOT EXISTS (SELECT 1 FROM "CrmHiddenClient"')
    }
  })

  it('getClientLive abre siempre sobre el universo ampliado (la ficha de un 🟠 se abre)', async () => {
    prismaMock.venue.findMany.mockResolvedValue([])
    prismaMock.venue.count.mockResolvedValue(0)
    clientsDb([])
    await expect(getClientLive(access(), ORG, NOW)).rejects.toBeDefined()
    expect(rawQueries()[0].sql).toContain(ALTA)
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

  it('ocultos_con_configurar_lista_solo_las_ocultas (L7)', async () => {
    await listClients(access({ configurar: true }), { ocultos: true }, NOW)
    expect(pageQuery().sql).toMatch(ONLY_HIDDEN)
    expect(pageQuery().sql).not.toContain(HIDDEN)
    // Still clients by the same rule, and never the team's organization.
    expect(pageQuery().values).toContain(TEAM_ORG)
  })

  it('ocultos_sin_configurar_se_ignora', async () => {
    await listClients(access(), { ocultos: true }, NOW)
    expect(pageQuery().sql).toContain(HIDDEN)
    // «Equipo y llaves» no ordena el archivero, y el espejo `admin` de la pantalla vieja ya no autoriza nada.
    await listClients(access({ equipo: true, bajas: true, admin: true }), { ocultos: true }, NOW)
    expect(pageQuery(1).sql).toContain(HIDDEN)
  })

  it('ocultar_es_idempotente_y_queda_en_la_bitacora', async () => {
    const admin = access({ configurar: true, ver: null, editar: null })
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
    await expect(hideClient(access({ configurar: true }), ORG)).rejects.toMatchObject({ statusCode: 404 })
    expect(prismaMock.crmHiddenClient.createMany).not.toHaveBeenCalled()
  })

  it('regresar_es_idempotente_y_queda_en_la_bitacora', async () => {
    prismaMock.crmHiddenClient.deleteMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 })
    jest.mocked(logAction).mockClear()

    await expect(unhideClient(access({ configurar: true }), ORG)).resolves.toEqual({ organizationId: ORG, oculta: false })
    expect(prismaMock.crmHiddenClient.deleteMany).toHaveBeenCalledWith({ where: { organizationId: ORG } })
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ staffId: SELLER, organizationId: ORG, action: 'CRM_CLIENT_UNHIDDEN', entityId: ORG }),
    )
    // A visible one: nothing to do, nothing logged.
    await expect(unhideClient(access({ configurar: true }), ORG)).resolves.toEqual({ organizationId: ORG, oculta: false })
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
    prismaMock.organization.findUnique.mockResolvedValue({ seatCapExempt: false })
    jest.mocked(getPlanState).mockResolvedValue(planState())
  }

  it('vivo_dice_si_la_organizacion_es_cliente_de_antes (Organization.seatCapExempt)', async () => {
    linked()
    expect(await getLive(access(), ACCOUNT, NOW)).toMatchObject({ deAntes: false })
    prismaMock.organization.findUnique.mockResolvedValue({ seatCapExempt: true })
    expect(await getLive(access(), ACCOUNT, NOW)).toMatchObject({ deAntes: true })
    expect(prismaMock.organization.findUnique).toHaveBeenLastCalledWith({ where: { id: ORG }, select: { seatCapExempt: true } })
  })

  it('🔴 vivo: los hechos del alta sólo se leen de una organización 🟠 (la misma regla altaPendienteSql que pinta la fila)', async () => {
    linked()
    await getLive(access(), ACCOUNT, NOW)
    const alta = rawQueries().find(query => query.sql.includes('"OnboardingProgress" op LEFT JOIN'))!
    expect(alta.sql.replace(/\s+/g, ' ')).toContain(altaPendienteSql().sql.replace(/\s+/g, ' '))
  })

  it('vivo: cada sucursal dice si es de demostración (demo), con la misma regla de «sucursal real» de la lista', async () => {
    linked({
      venues: [
        { id: VENUE, name: 'Centro', status: 'ACTIVE', kycStatus: 'VERIFIED', demoExpiresAt: null, _count: { terminals: 2 } },
        { id: VENUE_2, name: 'Demo', status: VenueStatus.LIVE_DEMO, kycStatus: null, demoExpiresAt: null, _count: { terminals: 0 } },
        {
          id: 'cvenueccc0000000000000001',
          name: 'Prueba',
          status: 'ACTIVE',
          kycStatus: null,
          demoExpiresAt: NOW,
          _count: { terminals: 0 },
        },
      ],
    })
    const live = await getLive(access(), ACCOUNT, NOW)
    expect((live as { venues: Array<{ id: string; demo: boolean }> }).venues.map(v => v.demo)).toEqual([false, true, true])
  })

  it('C1b: la ficha lee el ingreso de la organización con la misma expresión de la lista; el monto sólo con «Ver ventas»', async () => {
    linked()
    const fila = {
      ingreso: 'TRANSACCIONES',
      mensualidad: null,
      pistaIngreso: 'TARJETA_OTRA_TERMINAL',
      transacciones30d: new Prisma.Decimal('350'),
      otraMoneda: false,
    }
    prismaMock.$queryRaw.mockImplementation(async (query: Prisma.Sql) => (query.sql.includes('AS "pistaIngreso"') ? [fila] : []))
    const con = await getLive(access({ ventas: true }), ACCOUNT, NOW)
    expect(con).toMatchObject({
      ingreso: { codigo: 'TRANSACCIONES', mensualidad: null, transacciones30d: 350, otraMoneda: false, pista: 'TARJETA_OTRA_TERMINAL' },
    })
    const consulta = rawQueries().find(query => query.sql.includes('AS "pistaIngreso"'))!
    // The same expression the list paints and the filter reads.
    expect(consulta.sql).toContain(ingresoSql(NOW).ingreso.sql)
    expect(consulta.values).toContain(ORG)
    expect(consulta.sql).toContain('SUM(p."amount")')

    prismaMock.$queryRaw.mockClear()
    const sin = await getLive(access({ ventas: false }), ACCOUNT, NOW)
    expect(sin).toMatchObject({ ingreso: { codigo: 'TRANSACCIONES', transacciones30d: null, otraMoneda: null } })
    expect(rawQueries().find(query => query.sql.includes('AS "pistaIngreso"'))!.sql).not.toContain('SUM(p."amount")')
  })

  it('C1b: si la lectura del ingreso no trae fila, la ficha dice ingreso null (no inventa)', async () => {
    linked()
    expect(await getLive(access(), ACCOUNT, NOW)).toMatchObject({ ingreso: null })
  })

  it('vivo_sin_llave_ventas_no_trae_ventas', async () => {
    linked()
    const live = await getLive(access({ ventas: false }), ACCOUNT, NOW)

    expect(live).toMatchObject({ ligada: true, ventasMes: null, ventasMesOtraMoneda: null, ventasBloqueadas: true })
    // Not even read: what the seller may not see never leaves the database.
    expect(rawQueries().some(isMes)).toBe(false)
  })

  it('vivo_con_llave_ventas_suma_el_mes_de_ciudad_de_mexico (sólo MXN; otra moneda se marca, Codex r2 #3)', async () => {
    linked()
    mesDb({ ventasMXN: new Prisma.Decimal('1500.50'), otraMoneda: true })
    const live = await getLive(access({ ventas: true }), ACCOUNT, NOW)

    expect(live).toMatchObject({ ventasBloqueadas: false, ventasMesOtraMoneda: true })
    expect(live.ligada && live.ventasMes?.toString()).toBe('1500.5')
    // October in Mexico City: 1-oct 00:00 (06:00Z) up to, not including, 1-nov 00:00 (06:00Z). Real money, real venues, MXN.
    const mes = rawQueries().filter(isMes)
    expect(mes[0].values).toEqual(expect.arrayContaining([ORG, new Date('2026-10-01T06:00:00.000Z'), new Date('2026-11-01T06:00:00.000Z')]))
    const sql = mes[0].sql.replace(/\s+/g, ' ')
    expect(sql).toContain(`p."status" = 'COMPLETED' AND p."amount" > 0`)
    expect(sql).toContain('v."demoExpiresAt" IS NULL')
    expect(sql).toContain(`= 'MXN') AS "ventasMXN"`)
    expect(sql).toContain(`cs."sessionId" = p."processorId" AND cs."paymentId" IS NULL`)

    // 21:00 of 31-oct in Mexico City is already November in UTC: still October here.
    await getLive(access({ ventas: true }), ACCOUNT, new Date('2026-11-01T03:00:00.000Z'))
    expect(rawQueries().filter(isMes)[1].values).toEqual(
      expect.arrayContaining([new Date('2026-10-01T06:00:00.000Z'), new Date('2026-11-01T06:00:00.000Z')]),
    )

    // December rolls over to January of the next year; a month without sales is $0, not null.
    mesDb({ ventasMXN: null, otraMoneda: false })
    const december = await getLive(access({ ventas: true }), ACCOUNT, new Date('2026-12-15T18:00:00.000Z'))
    expect(rawQueries().filter(isMes)[2].values).toEqual(
      expect.arrayContaining([new Date('2026-12-01T06:00:00.000Z'), new Date('2027-01-01T06:00:00.000Z')]),
    )
    expect(december.ligada && december.ventasMes?.toString()).toBe('0')
    expect(december).toMatchObject({ ventasMesOtraMoneda: false })
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

  it('vivo_kyc_solo_con_configurar (L7)', async () => {
    // Spec §5.10 (ruling 40): the seller never sees KYC — not even its status.
    linked()
    const seller = await getLive(access({ ver: 'todos', ventas: true }), ACCOUNT, NOW)
    expect(seller.ligada && seller.venues[0]).not.toHaveProperty('kycStatus')
    expect(JSON.stringify(seller)).not.toContain('VERIFIED')

    // Ni «Equipo y llaves» ni el espejo `admin` lo abren: sólo «Configurar el CRM».
    const equipo = await getLive(access({ equipo: true, bajas: true, admin: true }), ACCOUNT, NOW)
    expect(equipo.ligada && equipo.venues[0]).not.toHaveProperty('kycStatus')

    const admin = await getLive(access({ configurar: true }), ACCOUNT, NOW)
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
    expect(rawQueries().some(isMes)).toBe(false)
    // The same locks: «Ver ventas» brings the month, «Configurar el CRM» the KYC.
    mesDb({ ventasMXN: new Prisma.Decimal('1500.50'), otraMoneda: false })
    const admin = await getClientLive(access({ ventas: true, configurar: true }), ORG, NOW)
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

describe('ensureClientAccount (C1, tarea 6)', () => {
  const STAGE = 'cstagegana000000000000001'
  const ABIERTA = 'cstageabie000000000000001'
  /** What the client check answers: the organization and whether it is a client by `clientSql` (false = only a stalled signup). */
  function org(row: { esCliente: boolean } | null) {
    prismaMock.$queryRaw.mockImplementation(async (query: Prisma.Sql) =>
      query.sql.includes('AS "esCliente"') && row ? [{ id: ORG, name: 'Tacos El Güero', ...row }] : [],
    )
  }
  beforeEach(() => {
    jest.mocked(logAction).mockClear()
    prismaMock.crmStage.findFirst.mockImplementation((async (args: { where: { kind: string } }) => ({
      id: args.where.kind === 'GANADA' ? STAGE : ABIERTA,
    })) as never)
    prismaMock.crmTimelineEvent.createMany.mockResolvedValue({ count: 1 })
  })

  it('🔴 oculta, del equipo o que no es cliente → 404 CRM_NO_ES_CLIENTE y no escribe', async () => {
    org(null)
    await expect(ensureClientAccount(access(), ORG)).rejects.toMatchObject({ statusCode: 404, code: 'CRM_NO_ES_CLIENTE' })
    expect(prismaMock.crmAccount.createMany).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
  })

  it('un cliente real: etapa GANADA, fuente CLIENTE, sin dueño ni wonAt; evento y ActivityLog sin el nombre de nadie', async () => {
    org({ esCliente: true })
    prismaMock.crmAccount.createMany.mockResolvedValue({ count: 1 })
    prismaMock.crmAccount.findFirst.mockResolvedValue({ id: ACCOUNT })

    await expect(ensureClientAccount(access(), ORG)).resolves.toEqual({ accountId: ACCOUNT, creada: true })
    expect(prismaMock.crmStage.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { kind: 'GANADA' } }))
    const data = (prismaMock.crmAccount.createMany.mock.calls[0][0] as { data: Array<Record<string, unknown>> }).data[0]
    expect(data).toMatchObject({ name: 'Tacos El Güero', source: 'CLIENTE', stageId: STAGE, organizationId: ORG })
    expect(data).not.toHaveProperty('ownerStaffId')
    expect(data).not.toHaveProperty('wonAt')
    expect(prismaMock.crmAccount.createMany).toHaveBeenCalledWith(expect.objectContaining({ skipDuplicates: true }))
    expect(prismaMock.crmAccount.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { AND: [{ organizationId: ORG }, MINE_OR_UNOWNED] } }),
    )
    expect(prismaMock.crmTimelineEvent.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ accountId: ACCOUNT, kind: 'SYSTEM', actorStaffId: SELLER, data: { event: 'CLIENT_ACCOUNT_OPENED' } }),
      ],
      skipDuplicates: true,
    })
    expect(logAction).toHaveBeenCalledTimes(1)
    const logged = jest.mocked(logAction).mock.calls[0][0]
    expect(logged).toMatchObject({
      staffId: SELLER,
      venueId: null,
      organizationId: ORG,
      action: 'CRM_CLIENT_ACCOUNT_CREATED',
      entityId: ACCOUNT,
      data: { organizationId: ORG, source: 'CLIENTE' },
    })
    expect(JSON.stringify(logged)).not.toContain('Tacos')
  })

  it('una alta sin tarjeta: la primera etapa ABIERTA y fuente ALTA, nunca GANADA', async () => {
    org({ esCliente: false })
    prismaMock.crmAccount.createMany.mockResolvedValue({ count: 1 })
    prismaMock.crmAccount.findFirst.mockResolvedValue({ id: ACCOUNT })

    await ensureClientAccount(access(), ORG)
    expect(prismaMock.crmStage.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { kind: 'ABIERTA' }, orderBy: [{ order: 'asc' }, { id: 'asc' }] }),
    )
    const data = (prismaMock.crmAccount.createMany.mock.calls[0][0] as { data: Array<Record<string, unknown>> }).data[0]
    expect(data).toMatchObject({ source: 'ALTA', stageId: ABIERTA })
  })

  it('con una cuenta visible → creada: false, sin evento ni ActivityLog', async () => {
    org({ esCliente: true })
    prismaMock.crmAccount.createMany.mockResolvedValue({ count: 0 })
    prismaMock.crmAccount.findFirst.mockResolvedValue({ id: ACCOUNT })

    await expect(ensureClientAccount(access(), ORG)).resolves.toEqual({ accountId: ACCOUNT, creada: false })
    expect(prismaMock.crmTimelineEvent.createMany).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
  })

  it('🔴 con la cuenta de B y A «propios» → 404 CRM_ACCOUNT_NOT_FOUND', async () => {
    org({ esCliente: true })
    prismaMock.crmAccount.createMany.mockResolvedValue({ count: 0 })
    prismaMock.crmAccount.findFirst.mockResolvedValue(null)
    await expect(ensureClientAccount(access(), ORG)).rejects.toMatchObject({ statusCode: 404, code: 'CRM_ACCOUNT_NOT_FOUND' })
    expect(logAction).not.toHaveBeenCalled()
  })

  it('🔴 carrera: el insert de A no inserta (count 0) porque otro la creó y B ya la tomó → 404, sin evento ni ActivityLog', async () => {
    org({ esCliente: true })
    prismaMock.crmAccount.createMany.mockResolvedValue({ count: 0 })
    prismaMock.crmAccount.findFirst.mockResolvedValue(null)
    await expect(ensureClientAccount(access(), ORG)).rejects.toMatchObject({ code: 'CRM_ACCOUNT_NOT_FOUND' })
    expect(prismaMock.crmTimelineEvent.createMany).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
  })
})

describe('setUsa (C1, tarea 7)', () => {
  /** What the account holds before: `touchTx` reads it with ROW_SELECT and `setUsa` with its own select (the same mock). */
  const cuenta = (usaManual: string | null, usaManualPorque: string | null = null) =>
    prismaMock.crmAccount.findUniqueOrThrow.mockResolvedValue({ usaManual, usaManualPorque, organizationId: ORG } as never)
  beforeEach(() => {
    jest.mocked(logAction).mockClear()
    prismaMock.crmAccount.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.crmAccount.findFirst.mockResolvedValue({ id: ACCOUNT } as never)
    prismaMock.crmAccount.update.mockResolvedValue({} as never)
    prismaMock.crmTimelineEvent.createMany.mockResolvedValue({ count: 1 })
  })

  it('escribe las cuatro columnas, el evento USA_CHANGE con el porqué y el ActivityLog sin el porqué', async () => {
    cuenta(null)
    await expect(setUsa(access(), ACCOUNT, { valor: 'TERMINAL', porque: 'Lo vi en su local' })).resolves.toEqual({
      accountId: ACCOUNT,
      usaManual: 'TERMINAL',
    })
    expect(prismaMock.crmAccount.update).toHaveBeenCalledWith({
      where: { id: ACCOUNT },
      data: { usaManual: 'TERMINAL', usaManualPorque: 'Lo vi en su local', usaManualById: SELLER, usaManualAt: expect.any(Date) },
    })
    expect(prismaMock.crmTimelineEvent.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          accountId: ACCOUNT,
          kind: 'USA_CHANGE',
          actorStaffId: SELLER,
          data: { valor: 'TERMINAL', porque: 'Lo vi en su local' },
        }),
      ],
      skipDuplicates: true,
    })
    const logged = jest.mocked(logAction).mock.calls[0][0]
    expect(logged).toMatchObject({
      action: 'CRM_CLIENT_USA_SET',
      venueId: null,
      organizationId: ORG,
      entityId: ACCOUNT,
      data: { valor: 'TERMINAL' },
    })
    expect(JSON.stringify(logged)).not.toContain('local')
  })

  it('«Leerlo solo» limpia las cuatro columnas, deja su evento y CRM_CLIENT_USA_CLEARED sin datos', async () => {
    cuenta('POS')
    await expect(setUsa(access(), ACCOUNT, { valor: null })).resolves.toEqual({ accountId: ACCOUNT, usaManual: null })
    expect(prismaMock.crmAccount.update).toHaveBeenCalledWith({
      where: { id: ACCOUNT },
      data: { usaManual: null, usaManualPorque: null, usaManualById: null, usaManualAt: null },
    })
    expect(prismaMock.crmTimelineEvent.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ kind: 'USA_CHANGE', data: { valor: null } })],
      skipDuplicates: true,
    })
    expect(jest.mocked(logAction).mock.calls[0][0]).toMatchObject({ action: 'CRM_CLIENT_USA_CLEARED', data: {} })
  })

  it('limpiar algo ya limpio no deja evento ni ActivityLog ni escribe', async () => {
    cuenta(null)
    await expect(setUsa(access(), ACCOUNT, { valor: null })).resolves.toEqual({ accountId: ACCOUNT, usaManual: null })
    expect(prismaMock.crmAccount.update).not.toHaveBeenCalled()
    expect(prismaMock.crmAccount.updateMany).not.toHaveBeenCalled() // no touch: «Estancado» is not reset
    expect(prismaMock.crmTimelineEvent.createMany).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
  })

  it('🔴 guardar el MISMO ✋ (mismo valor y mismo porqué) no deja evento ni ActivityLog ni toca lastTouchAt', async () => {
    cuenta('POS', 'Lo vi en su local')
    await expect(setUsa(access(), ACCOUNT, { valor: 'POS', porque: 'Lo vi en su local' })).resolves.toEqual({
      accountId: ACCOUNT,
      usaManual: 'POS',
    })
    expect(prismaMock.crmAccount.update).not.toHaveBeenCalled()
    expect(prismaMock.crmAccount.updateMany).not.toHaveBeenCalled() // no touch: «Estancado» is not reset
    expect(prismaMock.crmTimelineEvent.createMany).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
  })

  it('el mismo valor con otro porqué sí escribe (es otra razón)', async () => {
    cuenta('POS', 'Lo vi en su local')
    await setUsa(access(), ACCOUNT, { valor: 'POS', porque: 'Me lo dijo la dueña' })
    expect(prismaMock.crmAccount.update).toHaveBeenCalledTimes(1)
    expect(prismaMock.crmTimelineEvent.createMany).toHaveBeenCalledTimes(1)
  })

  describe('«vio»: lo que el editor vio (el SERVIDOR decide si cambió mientras tanto)', () => {
    const noEscribio = () => {
      expect(prismaMock.crmAccount.update).not.toHaveBeenCalled()
      expect(prismaMock.crmAccount.updateMany).not.toHaveBeenCalled() // ni lastTouchAt
      expect(prismaMock.crmTimelineEvent.createMany).not.toHaveBeenCalled()
      expect(logAction).not.toHaveBeenCalled()
    }

    it('coincide con lo guardado → escribe como siempre', async () => {
      cuenta('TERMINAL', 'Lo dijo la dueña')
      await setUsa(access(), ACCOUNT, { valor: 'POS', porque: 'Lo vi en su local', vio: { valor: 'TERMINAL', porque: 'Lo dijo la dueña' } })
      expect(prismaMock.crmAccount.update).toHaveBeenCalledTimes(1)
      expect(prismaMock.crmTimelineEvent.createMany).toHaveBeenCalledTimes(1)
      expect(logAction).toHaveBeenCalledTimes(1)
    })

    it('se compara normalizado: espacios del porqué y null contra «» no son un cambio', async () => {
      cuenta('TERMINAL', 'Lo dijo la dueña')
      await setUsa(access(), ACCOUNT, {
        valor: 'POS',
        porque: 'Lo vi en su local',
        vio: { valor: 'TERMINAL', porque: '  Lo dijo la dueña ' },
      })
      expect(prismaMock.crmAccount.update).toHaveBeenCalledTimes(1)
      prismaMock.crmAccount.update.mockClear()
      cuenta(null, null)
      await setUsa(access(), ACCOUNT, { valor: 'POS', porque: 'Lo vi en su local', vio: { valor: null, porque: '' } })
      expect(prismaMock.crmAccount.update).toHaveBeenCalledTimes(1)
    })

    it('🔴 otro valor guardado → 409 CRM_CAMBIO_AL_EDITAR con su mensaje, y no escribe nada', async () => {
      cuenta('AMBOS', 'Lo cambió otra persona')
      await expect(
        setUsa(access(), ACCOUNT, { valor: 'POS', porque: 'Lo vi en su local', vio: { valor: 'TERMINAL', porque: 'Lo dijo la dueña' } }),
      ).rejects.toMatchObject({
        statusCode: 409,
        code: 'CRM_CAMBIO_AL_EDITAR',
        message: 'Cambió mientras lo editabas: revisa y guarda otra vez.',
      })
      noEscribio()
    })

    it('🔴 mismo valor con otro porqué guardado → 409 (alguien más lo reescribió)', async () => {
      cuenta('TERMINAL', 'Otra razón')
      await expect(
        setUsa(access(), ACCOUNT, { valor: null, vio: { valor: 'TERMINAL', porque: 'Lo dijo la dueña' } }),
      ).rejects.toMatchObject({ statusCode: 409, code: 'CRM_CAMBIO_AL_EDITAR' })
      noEscribio()
    })

    it('🔴 vio null («Leerlo solo») pero alguien ya escribió un ✋ → 409', async () => {
      cuenta('POS', 'Lo vi en su local')
      await expect(
        setUsa(access(), ACCOUNT, { valor: 'TERMINAL', porque: 'La tiene en caja', vio: { valor: null, porque: null } }),
      ).rejects.toMatchObject({
        code: 'CRM_CAMBIO_AL_EDITAR',
      })
      noEscribio()
    })

    it('lo que se pide ya está guardado (reintento del propio guardado) → no-op aunque vio sea lo de antes', async () => {
      cuenta('POS', 'Lo vi en su local')
      await expect(
        setUsa(access(), ACCOUNT, { valor: 'POS', porque: 'Lo vi en su local', vio: { valor: 'TERMINAL', porque: 'Lo dijo la dueña' } }),
      ).resolves.toEqual({ accountId: ACCOUNT, usaManual: 'POS' })
      noEscribio()
    })

    it('sin vio, otro valor guardado se pisa como hoy', async () => {
      cuenta('AMBOS', 'Lo cambió otra persona')
      await setUsa(access(), ACCOUNT, { valor: 'POS', porque: 'Lo vi en su local' })
      expect(prismaMock.crmAccount.update).toHaveBeenCalledTimes(1)
    })
  })

  it('🔴 A «propios» sobre la cuenta de B (no la ve) → 404 y no escribe', async () => {
    prismaMock.crmAccount.findFirst.mockResolvedValue(null)
    await expect(setUsa(access(), ACCOUNT_B, { valor: 'POS', porque: 'porque sí' })).rejects.toMatchObject({ statusCode: 404 })
    expect(prismaMock.crmAccount.update).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
  })

  it('🔴 ver: todos, editar: propios sobre la de B → 403 CRM_NO_ES_TUYO', async () => {
    prismaMock.crmAccount.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: ACCOUNT_B } as never)
    await expect(setUsa(access({ ver: 'todos' }), ACCOUNT_B, { valor: 'POS', porque: 'porque sí' })).rejects.toMatchObject({
      statusCode: 403,
      code: 'CRM_NO_ES_TUYO',
    })
    expect(prismaMock.crmAccount.update).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
  })
})

describe('setAltaMotivo (C1, tarea 8)', () => {
  /** What the account holds before, and whether its organization still matches the pending signup (`AS "pendiente"`). */
  const cuenta = (
    over: Partial<{ altaMotivo: string | null; altaMotivoTexto: string | null; altaPerdido: boolean; organizationId: string | null }> = {},
    pendiente = true,
  ) => {
    prismaMock.crmAccount.findUniqueOrThrow.mockResolvedValue({
      altaMotivo: null,
      altaMotivoTexto: null,
      altaPerdido: false,
      organizationId: ORG,
      ...over,
    } as never)
    prismaMock.$queryRaw.mockImplementation(async (query: Prisma.Sql) =>
      query.sql.includes('AS "pendiente"') ? (pendiente ? [{ pendiente: 1 }] : []) : [],
    )
  }
  beforeEach(() => {
    jest.mocked(logAction).mockClear()
    prismaMock.crmAccount.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.crmAccount.findFirst.mockResolvedValue({ id: ACCOUNT } as never)
    prismaMock.crmAccount.update.mockResolvedValue({} as never)
    prismaMock.crmTimelineEvent.createMany.mockResolvedValue({ count: 1 })
  })

  it('escribe motivo, texto y Perdido, deja su evento ALTA_MOTIVO y un ActivityLog sin el texto', async () => {
    cuenta()
    await expect(setAltaMotivo(access(), ACCOUNT, { motivo: 'OTRO', texto: 'Se fue con su cuñado', perdido: true })).resolves.toEqual({
      accountId: ACCOUNT,
      motivo: 'OTRO',
      texto: 'Se fue con su cuñado',
      perdido: true,
    })
    expect(prismaMock.crmAccount.update).toHaveBeenCalledWith({
      where: { id: ACCOUNT },
      data: { altaMotivo: 'OTRO', altaMotivoTexto: 'Se fue con su cuñado', altaPerdido: true },
    })
    expect(prismaMock.crmTimelineEvent.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          accountId: ACCOUNT,
          kind: 'ALTA_MOTIVO',
          actorStaffId: SELLER,
          data: { motivo: 'OTRO', texto: 'Se fue con su cuñado', perdido: true },
        }),
      ],
      skipDuplicates: true,
    })
    const logged = jest.mocked(logAction).mock.calls[0][0]
    expect(logged).toMatchObject({
      action: 'CRM_CLIENT_ALTA_MOTIVO_SET',
      venueId: null,
      organizationId: ORG,
      entityId: ACCOUNT,
      data: { motivo: 'OTRO', perdido: true },
    })
    expect(JSON.stringify(logged)).not.toContain('cuñado')
  })

  it('un motivo de la lista borra el texto de antes', async () => {
    cuenta({ altaMotivo: 'OTRO', altaMotivoTexto: 'viejo' })
    await setAltaMotivo(access(), ACCOUNT, { motivo: 'PRECIO', perdido: false })
    expect(prismaMock.crmAccount.update).toHaveBeenCalledWith({
      where: { id: ACCOUNT },
      data: { altaMotivo: 'PRECIO', altaMotivoTexto: null, altaPerdido: false },
    })
  })

  it('🔴 una cuenta cuya organización ya activó → 409 CRM_ALTA_TERMINADA y nada escrito', async () => {
    cuenta({}, false)
    await expect(setAltaMotivo(access(), ACCOUNT, { motivo: 'PRECIO', perdido: false })).rejects.toMatchObject({
      statusCode: 409,
      code: 'CRM_ALTA_TERMINADA',
    })
    expect(prismaMock.crmAccount.update).not.toHaveBeenCalled()
    expect(prismaMock.crmTimelineEvent.createMany).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
  })

  it('🔴 una cuenta sin organización → 409 CRM_NO_ES_ALTA (nunca dice «ya terminó»)', async () => {
    cuenta({ organizationId: null })
    await expect(setAltaMotivo(access(), ACCOUNT, { motivo: 'PRECIO', perdido: false })).rejects.toMatchObject({
      statusCode: 409,
      code: 'CRM_NO_ES_ALTA',
      message: 'Este cliente no tiene un alta pendiente',
    })
    expect(prismaMock.crmAccount.update).not.toHaveBeenCalled()
  })

  it('el mismo valor que ya tiene no deja evento ni ActivityLog ni escribe', async () => {
    cuenta({ altaMotivo: 'PRECIO', altaPerdido: true })
    await setAltaMotivo(access(), ACCOUNT, { motivo: 'PRECIO', perdido: true })
    expect(prismaMock.crmAccount.update).not.toHaveBeenCalled()
    expect(prismaMock.crmAccount.updateMany).not.toHaveBeenCalled() // no touch: «Estancado» is not reset
    expect(prismaMock.crmTimelineEvent.createMany).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
  })

  describe('«vio»: lo que el editor vio (el SERVIDOR decide si cambió mientras tanto)', () => {
    const noEscribio = () => {
      expect(prismaMock.crmAccount.update).not.toHaveBeenCalled()
      expect(prismaMock.crmAccount.updateMany).not.toHaveBeenCalled() // ni lastTouchAt
      expect(prismaMock.crmTimelineEvent.createMany).not.toHaveBeenCalled()
      expect(logAction).not.toHaveBeenCalled()
    }

    it('coincide con lo guardado → escribe como siempre', async () => {
      cuenta({ altaMotivo: 'OTRO', altaMotivoTexto: 'Se fue', altaPerdido: false })
      await setAltaMotivo(access(), ACCOUNT, { motivo: 'PRECIO', perdido: true, vio: { motivo: 'OTRO', texto: 'Se fue', perdido: false } })
      expect(prismaMock.crmAccount.update).toHaveBeenCalledTimes(1)
      expect(logAction).toHaveBeenCalledTimes(1)
    })

    it('se compara normalizado: espacios del texto y null contra «» no son un cambio', async () => {
      cuenta({ altaMotivo: 'OTRO', altaMotivoTexto: 'Se fue', altaPerdido: false })
      await setAltaMotivo(access(), ACCOUNT, {
        motivo: 'PRECIO',
        perdido: true,
        vio: { motivo: 'OTRO', texto: ' Se fue  ', perdido: false },
      })
      expect(prismaMock.crmAccount.update).toHaveBeenCalledTimes(1)
      prismaMock.crmAccount.update.mockClear()
      cuenta()
      await setAltaMotivo(access(), ACCOUNT, { motivo: 'PRECIO', perdido: true, vio: { motivo: null, texto: '', perdido: false } })
      expect(prismaMock.crmAccount.update).toHaveBeenCalledTimes(1)
    })

    it('🔴 otro motivo guardado → 409 CRM_CAMBIO_AL_EDITAR con su mensaje, y no escribe nada', async () => {
      cuenta({ altaMotivo: 'DESPUES' })
      await expect(
        setAltaMotivo(access(), ACCOUNT, { motivo: 'PRECIO', perdido: true, vio: { motivo: null, texto: null, perdido: false } }),
      ).rejects.toMatchObject({
        statusCode: 409,
        code: 'CRM_CAMBIO_AL_EDITAR',
        message: 'Cambió mientras lo editabas: revisa y guarda otra vez.',
      })
      noEscribio()
    })

    it('🔴 otro texto o otro «Perdido» guardado → 409', async () => {
      cuenta({ altaMotivo: 'OTRO', altaMotivoTexto: 'Otra historia', altaPerdido: false })
      await expect(
        setAltaMotivo(access(), ACCOUNT, {
          motivo: 'OTRO',
          texto: 'Se fue',
          perdido: true,
          vio: { motivo: 'OTRO', texto: 'Se fue', perdido: false },
        }),
      ).rejects.toMatchObject({ code: 'CRM_CAMBIO_AL_EDITAR' })
      cuenta({ altaMotivo: 'PRECIO', altaPerdido: true })
      await expect(
        setAltaMotivo(access(), ACCOUNT, { motivo: null, perdido: true, vio: { motivo: 'PRECIO', texto: null, perdido: false } }),
      ).rejects.toMatchObject({ code: 'CRM_CAMBIO_AL_EDITAR' })
      noEscribio()
    })

    it('lo que se pide ya está guardado (reintento del propio guardado) → no-op aunque vio sea lo de antes', async () => {
      cuenta({ altaMotivo: 'PRECIO', altaPerdido: true })
      await setAltaMotivo(access(), ACCOUNT, { motivo: 'PRECIO', perdido: true, vio: { motivo: null, texto: null, perdido: false } })
      noEscribio()
    })

    it('el alta ya terminó → sigue siendo CRM_ALTA_TERMINADA aunque vio no coincida', async () => {
      cuenta({ altaMotivo: 'DESPUES' }, false)
      await expect(
        setAltaMotivo(access(), ACCOUNT, { motivo: 'PRECIO', perdido: false, vio: { motivo: null, texto: null, perdido: false } }),
      ).rejects.toMatchObject({ code: 'CRM_ALTA_TERMINADA' })
    })

    it('sin vio, otro motivo guardado se pisa como hoy', async () => {
      cuenta({ altaMotivo: 'DESPUES' })
      await setAltaMotivo(access(), ACCOUNT, { motivo: 'PRECIO', perdido: false })
      expect(prismaMock.crmAccount.update).toHaveBeenCalledTimes(1)
    })
  })

  it('🔴 A «propios» sobre la de B (no la ve) → 404 y no escribe', async () => {
    prismaMock.crmAccount.findFirst.mockResolvedValue(null)
    await expect(setAltaMotivo(access(), ACCOUNT_B, { motivo: 'PRECIO', perdido: false })).rejects.toMatchObject({ statusCode: 404 })
    expect(prismaMock.crmAccount.update).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
  })

  it('🔴 ver: todos, editar: propios sobre la de B → 403 CRM_NO_ES_TUYO', async () => {
    prismaMock.crmAccount.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: ACCOUNT_B } as never)
    await expect(setAltaMotivo(access({ ver: 'todos' }), ACCOUNT_B, { motivo: null, perdido: true })).rejects.toMatchObject({
      statusCode: 403,
      code: 'CRM_NO_ES_TUYO',
    })
    expect(prismaMock.crmAccount.update).not.toHaveBeenCalled()
  })
})

describe('C2 Tarea 5: lo vivo gana Usa, último cobro, «Cobrado · 30 días» y RFC', () => {
  function linked(
    venues = [{ id: VENUE, name: 'Centro', status: 'ACTIVE', kycStatus: 'VERIFIED', demoExpiresAt: null, _count: { terminals: 2 } }],
  ) {
    prismaMock.crmAccount.findFirst.mockResolvedValue({ organizationId: ORG })
    prismaMock.venue.findMany.mockResolvedValue(venues)
    prismaMock.venue.count.mockResolvedValue(venues.length)
    prismaMock.staffOrganization.findFirst.mockResolvedValue(null)
    prismaMock.onboardingProgress.findUnique.mockResolvedValue(null)
    prismaMock.terminal.count.mockResolvedValue(0)
    prismaMock.organization.findUnique.mockResolvedValue({ seatCapExempt: false })
    jest.mocked(getPlanState).mockResolvedValue(planState())
  }
  const hechos = {
    usaMedido: 'TERMINAL',
    usaVisto: 'POS',
    usaAviso: true,
    usaEscrito: true,
    estado: 'COBRA',
    ultimoCobroAt: new Date('2026-10-30T15:00:00.000Z'),
  }
  function respuestas(over: { cobrado?: Record<string, unknown> } = {}) {
    prismaMock.$queryRaw.mockImplementation(async (query: Prisma.Sql) => {
      if (query.sql.includes('AS "usaEscrito"')) return [hechos]
      if (query.sql.includes('AS "cobradoMXN"')) return [over.cobrado ?? { cobradoMXN: new Prisma.Decimal('900'), otraMoneda: false }]
      if (query.sql.includes('AS "terminales"')) return [{ organizationId: ORG, terminales: 1, pos: 2 }]
      return []
    })
  }

  it('🔴 usa y estado salen de la misma lateral y columnas que la fila de la lista; el porqué sólo de la cuenta en «Ver»', async () => {
    linked()
    respuestas()
    prismaMock.crmAccount.findMany.mockResolvedValue([
      { usaManual: 'POS', usaManualPorque: 'Lo vi', usaManualById: OTHER, usaManualAt: NOW },
    ])
    prismaMock.staff.findMany.mockResolvedValue([{ id: OTHER, firstName: 'Ana', lastName: 'Pérez' }])

    const live = (await getLive(access({ ventas: true }), ACCOUNT, NOW)) as Record<string, any>

    expect(live.usa).toEqual({
      visto: 'POS',
      medido: 'TERMINAL',
      manual: true,
      aviso: true,
      detalle: { porque: 'Lo vi', por: { id: OTHER, name: 'Ana Pérez' }, at: NOW },
      aparatos: { terminales: 1, pos: 2 },
    })
    expect(live.estado).toEqual({ codigo: 'COBRA', ultimoCobroAt: hechos.ultimoCobroAt })
    const consulta = rawQueries().find(query => query.sql.includes('AS "usaEscrito"'))!
    expect(consulta.sql).toContain(clientFactsLateral(NOW).sql)
    expect(consulta.values).toContain(ORG)
    expect(prismaMock.crmAccount.findMany.mock.calls[0][0]).toMatchObject({
      where: { AND: [{ organizationId: ORG }, { OR: [{ ownerStaffId: SELLER }, { ownerStaffId: null }] }] },
      take: 1,
    })
  })

  it('sin cuenta visible, el ✋ dice su valor pero no el porqué', async () => {
    linked()
    respuestas()
    const live = (await getLive(access(), ACCOUNT, NOW)) as Record<string, any>
    expect(live.usa).toMatchObject({ visto: 'POS', manual: true, detalle: null })
  })

  it('«Cobrado · 30 días» en MXN de las sucursales reales desde hace 30 días, con la misma regla de moneda que la ficha', async () => {
    linked()
    respuestas({ cobrado: { cobradoMXN: new Prisma.Decimal('900'), otraMoneda: true } })
    const live = (await getLive(access({ ventas: true }), ACCOUNT, NOW)) as Record<string, any>
    expect(live).toMatchObject({ cobrado30: new Prisma.Decimal('900'), cobrado30OtraMoneda: true })
    const consulta = rawQueries().find(query => query.sql.includes('AS "cobradoMXN"'))!
    expect(consulta.sql).toContain(monedaDelPagoSql.sql)
    expect(consulta.values).toEqual(expect.arrayContaining([ORG, new Date(NOW.getTime() - 30 * 24 * 3_600_000)]))
  })

  it('🔴 sin «Ver ventas», cobrado30 null, ventasBloqueadas y ni se consulta', async () => {
    linked()
    respuestas()
    const live = (await getLive(access({ ventas: false }), ACCOUNT, NOW)) as Record<string, any>
    expect(live).toMatchObject({ cobrado30: null, cobrado30OtraMoneda: null, ventasBloqueadas: true })
    expect(rawQueries().some(query => query.sql.includes('AS "cobradoMXN"'))).toBe(false)
  })

  it('fiscal: del emisor de facturas de sus sucursales, sin repetir RFC y a lo más 5; nunca Venue.rfc', async () => {
    linked()
    respuestas()
    prismaMock.fiscalEmisor.findMany.mockResolvedValue([
      { rfc: 'AAA010101AAA', legalName: 'Café SA' },
      { rfc: 'AAA010101AAA', legalName: 'Café SA' },
      ...['B', 'C', 'D', 'E', 'F'].map(l => ({ rfc: `${l}${l}${l}010101AAA`, legalName: `Razón ${l}` })),
    ])
    const live = (await getLive(access(), ACCOUNT, NOW)) as Record<string, any>
    expect(live.fiscal).toEqual([
      { rfc: 'AAA010101AAA', razonSocial: 'Café SA' },
      ...['B', 'C', 'D', 'E'].map(l => ({ rfc: `${l}${l}${l}010101AAA`, razonSocial: `Razón ${l}` })),
    ])
    expect(prismaMock.fiscalEmisor.findMany.mock.calls[0][0]).toMatchObject({ where: { venueId: { in: [VENUE] } } })
    expect(JSON.stringify(prismaMock.venue.findMany.mock.calls)).not.toContain('rfc')
  })

  it('🔴 la ficha hace el mismo número de consultas con 20 sucursales que con 2 (sin N+1, salvo el plan por sucursal de antes)', async () => {
    const venue = (i: number) => ({
      id: `cvenue${String(i).padStart(19, '0')}`,
      name: `S${i}`,
      status: 'ACTIVE',
      kycStatus: null,
      demoExpiresAt: null,
      _count: { terminals: 0 },
    })
    const cuenta = async (n: number) => {
      linked(Array.from({ length: n }, (_, i) => venue(i)))
      respuestas()
      prismaMock.$queryRaw.mockClear()
      prismaMock.fiscalEmisor.findMany.mockClear()
      prismaMock.crmAccount.findMany.mockClear()
      await getLive(access({ ventas: true }), ACCOUNT, NOW)
      return (
        prismaMock.$queryRaw.mock.calls.length +
        prismaMock.fiscalEmisor.findMany.mock.calls.length +
        prismaMock.crmAccount.findMany.mock.calls.length
      )
    }
    expect(await cuenta(20)).toBe(await cuenta(2))
  })
})
