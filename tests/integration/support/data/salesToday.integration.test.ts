/**
 * C1 · «Ventas de hoy» (la B): las seis cifras del Resumen de ventas del panel, del día calendario entero de la sucursal, escritas por
 * la plantilla. Postgres de verdad (la base de la nube); el puente de QR de Mindform se simula desde su pool, como en D15.
 * Lo que vale para toda capacidad (aislamiento, venenos, logs, candados) lo prueba el barrido (`sweeps.integration.test.ts`).
 */
jest.mock('@/services/legacy/legacyPool', () => require('@tests/__helpers__/puenteQrLegacy').moduloLegacyPool)

import logger from '@/config/logger'
import * as salesSummary from '@/services/dashboard/sales-summary.dashboard.service'
import { getSalesSummary, type SalesSummaryMetrics } from '@/services/dashboard/sales-summary.dashboard.service'
import * as legacy from '@/services/legacy/qrPayments.legacy.service'
import { openDataEnvelope, prepareDataAnswer, sealDataEnvelope, type DataOutcome } from '@/services/support/data/answer.service'
import { salesToday } from '@/services/support/data/capabilities/salesToday'
import { dataCatalog, type DataCatalog, type DataRequest, type DataScope } from '@/services/support/data/catalog'
import { fmtCount, fmtMoney, fmtShortDay, fmtTime } from '@/services/support/data/format'
import { wholeDayBounds } from '@/services/support/data/params'
import { SUPPORT_DATA_QUERY_FAILED, SUPPORT_DATA_REFUSALS } from '@/services/support/data/texts'
import { venueDayKey } from '@/utils/venueDateKeys'
import {
  MINDFORM,
  PUENTE_CAIDO,
  TAMANO_DE_PAGINA,
  cobrosLegacy,
  consultasAlPuente,
  puenteContesta,
} from '@tests/__helpers__/puenteQrLegacy'
import {
  amountLeaks,
  clearSales,
  earlierToday,
  seedDataFixture,
  seedRefund,
  seedSale,
  spyLogger,
  spyQueries,
  type DataFixture,
} from '@tests/__helpers__/supportData'

const CDMX = 'America/Mexico_City'
const CANCUN = 'America/Cancun'
const REQUEST: DataRequest = { capability: 'sales_today', day: 'today', amount: null, time: null, otherVenue: false }
const MESSAGE = '¿Cuánto vendí hoy?'

let f: DataFixture
beforeAll(async () => {
  f = await seedDataFixture('support-data-sales-today')
})
afterAll(() => f?.clean())
beforeEach(async () => {
  await f.reset()
  process.env.SUPPORT_DATA_ENABLED = 'true'
  await clearSales([f.northId, f.cancunId, f.emptyId])
  await f.grant({ permissions: ['reports:read'] })
  await f.unlock()
  puenteContesta()
})
afterEach(() => jest.restoreAllMocks())

/** La pregunta en la plática de la persona con esa sucursal elegida (una plática por teléfono), con el catálogo de verdad salvo otro. */
const ask = async (venueId = f.northId, over: Partial<DataRequest> = {}, now = new Date(), catalog?: DataCatalog) =>
  prepareDataAnswer(
    { conversation: { ...(await f.conversation()), venueId }, request: { ...REQUEST, ...over }, message: MESSAGE, now },
    catalog,
  )
const answered = (out: DataOutcome) => {
  if (out.kind !== 'answer') throw new Error(`sales_today: ${out.text}`)
  return out
}
/** Los bordes con los que la B y el panel leen el mismo día. */
const filtersFor = (timezone: string, now: Date) => {
  const { from, to } = wholeDayBounds('today', { timezone, now })
  return { startDate: from.toISOString(), endDate: to.toISOString(), groupBy: 'none' as const, reportType: 'summary' as const, timezone }
}
/** Un alcance armado a mano, para leer la capacidad directo con un reloj fijo. */
const scopeFor = (venueId: string, timezone: string, now: Date): DataScope => ({
  venueId,
  organizationId: f.orgId,
  venueName: 'Sucursal',
  timezone,
  day: venueDayKey(now, timezone),
  kycVerified: true,
  now,
  rows: 5,
  openOrdersDays: 7,
  depositGroups: 2000,
  depositTimeoutMs: 3000,
})
const six = (s: SalesSummaryMetrics) => [s.grossSales, s.discounts, s.refunds, s.netSales, s.tips, s.transactionCount]

it('parity: the six figures are the ones getSalesSummary gives the panel for the same day, to the cent', async () => {
  const at = earlierToday(CDMX)
  const card = await seedSale(f.northId, at, { subtotal: 1000, discount: 100, tip: 50, method: 'CREDIT_CARD' })
  await seedSale(f.northId, at, { subtotal: 456.78, discount: 6.78, tip: 25.5 })
  await seedRefund(f.northId, card, at, 120.4)
  const now = new Date()
  const lines = answered(await ask(f.northId, {}, now)).envelope.text.split('\n')
  const panel = (await getSalesSummary(f.northId, filtersFor(CDMX, now))).summary
  expect(lines.slice(1, 4)).toEqual([
    `Ventas brutas ${fmtMoney(panel.grossSales!)} · Descuentos ${fmtMoney(-panel.discounts!)} · Devoluciones ${fmtMoney(-panel.refunds)}`,
    `*Ventas netas ${fmtMoney(panel.netSales!)}*`,
    `Propinas (aparte) ${fmtMoney(panel.tips)} · ${fmtCount(panel.transactionCount)} transacciones`,
  ])
  // …y son las sembradas: dos ventas y una devolución, al centavo. D10.1 (21-nov-2026): la devolución no es una transacción.
  expect(lines.slice(1, 4)).toEqual([
    'Ventas brutas $1,456.78 · Descuentos −$106.78 · Devoluciones −$120.40',
    '*Ventas netas $1,229.60*',
    'Propinas (aparte) $75.50 · 2 transacciones',
  ])
})

it("Cancún: a sale at 05:30Z is today's there and not in Mexico City", async () => {
  // 05:30Z del 12-nov: las 00:30 del 12 en Cancún (UTC−5), las 23:30 del 11 en la CDMX (UTC−6)
  const at = new Date('2026-11-12T05:30:00Z')
  await seedSale(f.cancunId, at, { subtotal: 850 })
  await seedSale(f.northId, at, { subtotal: 850 })
  const now = new Date('2026-11-12T18:00:00Z')
  expect(six(await salesToday.read(scopeFor(f.cancunId, CANCUN, now), {}))).toEqual([850, 0, 0, 850, 0, 1])
  expect(six(await salesToday.read(scopeFor(f.northId, CDMX, now), {}))).toEqual([0, 0, 0, 0, 0, 0])
})

it('a sale of $850.00 prints «$850.00», never «$8.50» nor «$85,000.00»', async () => {
  await seedSale(f.northId, earlierToday(CDMX), { subtotal: 850 })
  const { text } = answered(await ask()).envelope
  expect(text).toContain('Ventas brutas $850.00 · Descuentos $0.00 · Devoluciones $0.00')
  expect(text).toContain('*Ventas netas $850.00*')
  expect(text).not.toContain('$8.50')
  expect(text).not.toContain('$85,000.00')
})

it.each(['yesterday', 'other'] as const)(
  '«¿cuánto vendí ayer?» (day %s) → SALES_TODAY_ONLY, PARAM_INVALID, read never called (case 35)',
  async day => {
    const read = jest.fn(salesToday.read)
    const out = await ask(f.northId, { day }, new Date(), dataCatalog({ ...salesToday, read }))
    expect(out).toMatchObject({
      kind: 'refusal',
      capability: 'sales_today',
      text: SUPPORT_DATA_REFUSALS.SALES_TODAY_ONLY,
      log: { result: 'PARAM_INVALID' },
    })
    expect(read).not.toHaveBeenCalled()
  },
)

it('the bridge venue: SALES_LEGACY_QR, NOT_OFFERED, and neither getSalesSummary nor legacyPool.query run; any other venue gets the figure (case 36)', async () => {
  const bridge = jest.spyOn(legacy, 'sumsLegacyQrPayments').mockImplementation(venueId => venueId === f.northId)
  const summary = jest.spyOn(salesSummary, 'getSalesSummary')
  puenteContesta(cobrosLegacy(3))
  await seedSale(f.northId, earlierToday(CDMX), { subtotal: 850 })
  expect(await ask()).toMatchObject({
    kind: 'refusal',
    capability: 'sales_today',
    text: SUPPORT_DATA_REFUSALS.SALES_LEGACY_QR,
    log: { result: 'NOT_OFFERED' },
  })
  expect(bridge).toHaveBeenCalledWith(f.northId)
  expect(summary).not.toHaveBeenCalled()
  expect(consultasAlPuente()).toBe(0)
  // Otra sucursal de la misma persona sí recibe su cifra (y tampoco le pregunta al puente)
  await f.unlock(f.cancunId)
  await seedSale(f.cancunId, earlierToday(CANCUN), { subtotal: 640 })
  expect(answered(await ask(f.cancunId)).envelope.text).toContain('*Ventas netas $640.00*')
  expect(summary).toHaveBeenCalledTimes(1)
  expect(consultasAlPuente()).toBe(0)
})

it('a summary marked legacyUnavailable is never said as a figure: SUPPORT_DATA_QUERY_FAILED, QUERY_FAILED, and no amount in the outcome', async () => {
  const partial: SalesSummaryMetrics = {
    grossSales: 12345.6,
    items: 12345.6,
    serviceCosts: 0,
    discounts: 0,
    refunds: 0,
    netSales: 12345.6,
    deferredSales: 0,
    taxes: 0,
    tips: 987.65,
    platformFees: 0,
    staffCommissions: 0,
    commissions: 0,
    totalCollected: 13333.25,
    netProfit: 12345.6,
    transactionCount: 7,
  }
  jest.spyOn(salesSummary, 'getSalesSummary').mockResolvedValue({
    dateRange: { startDate: new Date(), endDate: new Date() },
    reportType: 'summary',
    summary: partial,
    filtered: false,
    legacyUnavailable: true,
  })
  // El resultado entero: el texto fijo y el renglón del registro (ids, la huella y el día). Ningún campo puede traer un importe.
  expect(await ask()).toEqual({
    kind: 'refusal',
    capability: 'sales_today',
    text: SUPPORT_DATA_QUERY_FAILED,
    log: {
      staffId: f.staffId,
      venueId: f.northId,
      capability: 'sales_today',
      paramsHmac: expect.stringMatching(/^[0-9a-f]{64}$/),
      result: 'QUERY_FAILED',
      day: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    },
  })
})

it('D15 stays as it is for the panel: with the bridge down on a later page, getSalesSummary of the bridge venue still returns legacyUnavailable: true after this task', async () => {
  puenteContesta(cobrosLegacy(TAMANO_DE_PAGINA), PUENTE_CAIDO)
  const report = await getSalesSummary(MINDFORM, { startDate: '2026-10-01T06:00:00.000Z', endDate: '2026-11-01T05:59:59.999Z' })
  expect(report.legacyUnavailable).toBe(true)
  expect(report.summary).toMatchObject({ grossSales: 50000, tips: 5000, transactionCount: TAMANO_DE_PAGINA })
})

it('the summary and the capability share the condition: with it true for a venue, getSalesSummary reads the bridge for that venue and the capability refuses it (case 36)', async () => {
  jest.spyOn(legacy, 'sumsLegacyQrPayments').mockImplementation(venueId => venueId === f.cancunId)
  puenteContesta(cobrosLegacy(3))
  const now = new Date()
  const report = await getSalesSummary(f.cancunId, filtersFor(CANCUN, now))
  expect(consultasAlPuente()).toBe(1)
  expect(report.summary).toMatchObject({ grossSales: 300, netSales: 300, tips: 30, transactionCount: 3 })
  expect(salesToday.notOffered!(scopeFor(f.cancunId, CANCUN, now))).toBe('SALES_LEGACY_QR')
  expect(salesToday.notOffered!(scopeFor(f.northId, CDMX, now))).toBeNull()
})

it('with skipStaffCommissions the commissions aggregate does not run and the six printed fields are equal; without it, it runs as today (case 22)', async () => {
  const at = earlierToday(CDMX)
  const order = await seedSale(f.northId, at, { subtotal: 1250, discount: 50, tip: 120 })
  await seedRefund(f.northId, order, at, 30)
  const filters = filtersFor(CDMX, new Date())
  const run = async (skipStaffCommissions?: true) => {
    const spy = spyQueries()
    try {
      const { summary } = await getSalesSummary(f.northId, { ...filters, ...(skipStaffCommissions ? { skipStaffCommissions } : {}) })
      return { summary, commissions: spy.calls.filter(call => call.model === 'CommissionCalculation') }
    } finally {
      spy.restore()
    }
  }
  const panel = await run()
  const b = await run(true)
  expect(panel.commissions.map(call => call.args)).toEqual([
    {
      where: {
        venueId: f.northId,
        createdAt: { gte: new Date(filters.startDate), lte: new Date(filters.endDate) },
        status: { not: 'VOIDED' },
      },
      _sum: { netCommission: true },
    },
  ])
  expect(b.commissions).toEqual([])
  expect(b.summary.staffCommissions).toBe(0)
  expect(six(b.summary)).toEqual(six(panel.summary))
  // D10.1 (21-nov-2026): una venta y una devolución = 1 transacción.
  expect(six(b.summary)).toEqual([1250, 50, 30, 1170, 120, 1])
})

it('«Sales summary calculated» carries no amount, also when the panel calls it (case 23)', async () => {
  await seedSale(f.northId, earlierToday(CDMX), { subtotal: 1250, discount: 50, tip: 120 })
  // El logger de las pruebas de integración es de mentira y guarda las llamadas de las pruebas anteriores: se limpia.
  for (const method of Object.values(logger)) if (jest.isMockFunction(method)) method.mockClear()
  const log = spyLogger()
  const { summary } = await getSalesSummary(f.northId, filtersFor(CDMX, new Date()))
  expect(amountLeaks(log.args(), [summary.grossSales!, summary.netSales!])).toEqual([])
  const calculated = (logger.info as unknown as jest.Mock).mock.calls.find(call => call[0] === 'Sales summary calculated')
  expect(calculated?.[1]).toEqual({
    venueId: f.northId,
    transactionCount: 1,
    reportType: 'summary',
    periodsCount: undefined,
    filtered: false,
  })
  log.restore()
})

it('a day with only a $150.00 refund of an earlier sale: the final answer says «Ventas netas −$150.00», the same net as getSalesSummary, ANSWERED and never CHECK_FAILED', async () => {
  const { from } = wholeDayBounds('today', { timezone: CDMX, now: new Date() })
  const yesterday = await seedSale(f.northId, new Date(from.getTime() - 3_600_000), { subtotal: 150 })
  await seedRefund(f.northId, yesterday, earlierToday(CDMX), 150)
  const now = new Date()
  const out = answered(await ask(f.northId, {}, now))
  expect(out.log.result).toBe('ANSWERED')
  const sealed = openDataEnvelope(sealDataEnvelope(out.envelope))
  const panel = (await getSalesSummary(f.northId, filtersFor(CDMX, now))).summary
  expect(fmtMoney(panel.netSales!)).toBe('−$150.00')
  expect(sealed?.text.split('\n').slice(1, 4)).toEqual([
    'Ventas brutas $0.00 · Descuentos $0.00 · Devoluciones −$150.00',
    `*Ventas netas ${fmtMoney(panel.netSales!)}*`,
    // D10.1 (21-nov-2026): un día de sólo una devolución no tiene transacciones.
    'Propinas (aparte) $0.00 · 0 transacciones',
  ])
})

it('no cash total and no breakdown by method, also for a cashier without cash-drawer:view-expected (case 34)', async () => {
  await f.grant({ permissions: ['reports:read'], role: 'CASHIER' })
  const at = earlierToday(CDMX)
  await seedSale(f.northId, at, { subtotal: 300 })
  await seedSale(f.northId, at, { subtotal: 550, method: 'CREDIT_CARD' })
  const { text } = answered(await ask()).envelope
  expect(text).toContain('Ventas brutas $850.00')
  expect(text).not.toContain('$300.00')
  expect(text).not.toContain('$550.00')
  expect(text).not.toMatch(/efectivo|tarjeta/i)
})

it('zero rows: a complete sentence with $0.00 and «0 transacciones» (Review Focus 2)', async () => {
  await f.unlock(f.emptyId)
  const now = new Date()
  expect(answered(await ask(f.emptyId, {}, now)).envelope.text).toBe(
    [
      `Ventas de hoy, ${fmtShortDay(now, CDMX)}, en Sur (corte ${fmtTime(now, CDMX)}):`,
      'Ventas brutas $0.00 · Descuentos $0.00 · Devoluciones $0.00',
      '*Ventas netas $0.00*',
      'Propinas (aparte) $0.00 · 0 transacciones',
      'Es lo mismo que Reportes › Resumen de ventas.',
    ].join('\n'),
  )
})
