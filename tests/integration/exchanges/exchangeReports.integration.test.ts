import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { createExchange } from '@/services/exchanges/exchange.service'
import { EXCHANGE_REFUND_ROLE, WHERE_PAYMENT_IS_EXCHANGE_CREDIT } from '@/services/exchanges/exchangeMarks'
import { getBasicMetricsData, getBasicMetricsDetailsPage, getChartData } from '@/services/dashboard/generalStats.dashboard.service'
import { getSalesSummary } from '@/services/dashboard/sales-summary.dashboard.service'
import { getTenderCommissionsReport } from '@/services/dashboard/tenderType.dashboard.service'
import { getRefundsReport } from '@/services/dashboard/refunds.dashboard.service'
import { aggregatePaymentsByMethod, aggregateTipsByProcessor } from '@/services/legacy/mergedPayments.service'
import { getBankAndCashSummary } from '@/services/dashboard/accounting.dashboard.service'
import { calculateVenueAssessment } from '@/services/superadmin/creditAssessment.service'
import { issueRefund } from '@/services/dashboard/refund.dashboard.service'
import { seedClothingSale } from './seedExchange'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))
jest.mock('@/services/dashboard/receipt.dashboard.service', () => ({ generateAndStoreReceipt: jest.fn(async () => undefined) }))
jest.setTimeout(60000)
type Seed = Awaited<ReturnType<typeof seedClothingSale>>
const fixtures: Seed[] = []
let s: Seed
let payout: Seed
let chain: Seed
let exchangeIds: string[]
let chainRefundId: string
let chainExchangeId: string
const fromDate = new Date(Date.now() - 864e5).toISOString()
const toDate = new Date(Date.now() + 864e5).toISOString()
const dates = { fromDate, toDate }
const filters = { fromDate: new Date(fromDate), toDate: new Date(toDate), includeRefunds: true, excludeCancelledOrders: false }
const range = { startDate: fromDate, endDate: toDate }
const days = { from: fromDate.slice(0, 10), to: toDate.slice(0, 10) }
async function seed(opts: Parameters<typeof seedClothingSale>[0] = {}) {
  const f = await seedClothingSale(opts)
  fixtures.push(f)
  return f
}
async function difference(f: Seed, price: number) {
  await prisma.product.update({ where: { id: f.products[3].id }, data: { price: new Prisma.Decimal(price) } })
  return createExchange(
    f.input(
      f.body({
        taken: [{ productId: f.products[3].id, quantity: 1 }],
        settlement: {
          kind: price > 500 ? 'COLLECT' : 'PAYOUT',
          method: 'CASH',
          expectedDifferenceCents: (price - 500) * 100,
          cashDrawerSessionId: f.drawer.id,
        },
      }),
    ),
  )
}
beforeAll(async () => {
  expect(new URL(process.env.TEST_DATABASE_URL!).pathname).toMatch(/^\/avoqado_(?:cambio_(?:fix_|r5_)?test_\d{8}|h1a_test_\d{8}(?:_\d+)?)$/)
  s = await seed({ card: true, quantity: 2 })
  await prisma.venue.update({ where: { id: s.venueId }, data: { seatCapExempt: true } })
  const even = await createExchange(s.input())
  const collect = await difference(s, 600)
  exchangeIds = [even.exchange.id, collect.exchange.id]
  payout = await seed()
  // La venta original queda fuera de la ventana: sólo debe verse la salida REAL de $100.
  await prisma.payment.update({ where: { id: payout.payments[0].id }, data: { createdAt: new Date(Date.parse(fromDate) - 2 * 864e5) } })
  await difference(payout, 400)
  chain = await seed()
  const e = await createExchange(chain.input())
  chainExchangeId = e.exchange.id
  chainRefundId = (
    await issueRefund({
      venueId: chain.venueId,
      staffId: chain.staffId,
      paymentId: e.exchange.paymentIds[0],
      amount: 20000,
      reason: 'RETURNED_GOODS',
    })
  ).refundId
})
afterAll(async () => {
  for (const f of fixtures) await f.cleanup()
  await prisma.$disconnect()
})

describe('exchange reports against Postgres', () => {
  it('basic metrics and the pie exclude credit in compact and legacy responses and paged details', async () => {
    for (const responseMode of ['aggregated-v1', undefined] as const) {
      const r = await getBasicMetricsData(s.venueId, { ...dates, responseMode })
      expect(r.summary.totalAmount).toBe(1100)
      expect(r.summary.totalTransactions).toBe(2)
      if (!responseMode) expect(r.payments).toHaveLength(2)
      expect(r.paymentMethodsData.some((p: { method: string }) => p.method === 'Otro')).toBe(false)
    }
    const r = await getBasicMetricsDetailsPage(s.venueId, { ...dates, kind: 'payments', limit: 100 })
    expect(r.items).toHaveLength(2)
  })
  it('payment method charts and tips readers do not admit exchange credit', async () => {
    const chart = (await getChartData(s.venueId, 'sales-by-payment-method', dates)) as { payments: unknown[] }
    const tips = (await getChartData(s.venueId, 'tips-over-time', dates)) as { payments: unknown[] }
    expect(chart.payments).toHaveLength(2)
    expect(tips.payments).toHaveLength(2)
    for (const vista of ['dinero', 'ventas'] as const) {
      const rows = await aggregatePaymentsByMethod(s.venueId, filters, vista)
      expect(rows.map(r => r.method).sort()).toEqual(['CASH', 'CREDIT_CARD'])
      expect(rows.reduce((n, r) => n + r.count, 0)).toBe(2)
    }
    expect(await aggregateTipsByProcessor(s.venueId, filters)).toEqual([])
  })
  it('by-method Prisma and SQL views exclude both EC rows while gross and net sales retain credit refunds', async () => {
    const r = await getSalesSummary(s.venueId, { ...range, groupBy: 'paymentMethod' })
    expect(r.byPaymentMethod?.some(p => p.method === 'OTHER')).toBe(false)
    expect(r.byPaymentMethodDetailed?.find(p => p.bucket === 'OTHER')?.count ?? 0).toBe(0)
    expect(r.byPaymentMethodDetailed?.reduce((n, p) => n + p.refunds, 0)).toBe(0)
    expect(r.summary).toMatchObject({ grossSales: 2100, refunds: 1000, netSales: 1100 })
  })
  it('cash payout is real money out in both method views, not an excluded credit refund', async () => {
    const r = await getSalesSummary(payout.venueId, { ...range, groupBy: 'paymentMethod' })
    expect(r.byPaymentMethod?.find(p => p.method === 'CASH')?.amount).toBe(-100)
    expect(r.byPaymentMethodDetailed?.find(p => p.bucket === 'CASH')).toMatchObject({ amount: -100, refunds: 100 })
    expect(r.summary).toMatchObject({ grossSales: 900, refunds: 500, netSales: 400 })
    const rows = await aggregatePaymentsByMethod(payout.venueId, filters, 'dinero')
    expect(rows).toEqual([{ method: 'CASH', amount: -100, tips: 0, count: 1 }])
    const ec = await prisma.payment.findMany({ where: { venueId: payout.venueId, AND: [WHERE_PAYMENT_IS_EXCHANGE_CREDIT] }, take: 10 })
    expect(ec.map(p => Number(p.amount)).sort((a, b) => a - b)).toEqual([-400, 400])
    const refunds = await getRefundsReport(payout.venueId, range)
    expect(refunds.totals).toMatchObject({ totalRefunded: 500, exchangesCount: 1, exchangeCreditTotal: 400 })
    expect(refunds.refunds.map(p => [p.isExchange, p.chainOfExchangeId])).toEqual([
      [true, null],
      [true, null],
    ])
  })
  it('tender commissions never list the exchange credit tender', async () => {
    const r = await getTenderCommissionsReport(s.venueId, days)
    expect(r.rows).toEqual([])
  })
  it('refund report counts two exchanges, sums positive credit only and marks exchange rows', async () => {
    const r = await getRefundsReport(s.venueId, range)
    expect(r.totals).toMatchObject({ exchangesCount: 2, exchangeCreditTotal: 1000, totalRefunded: 1000 })
    expect(r.refunds).toHaveLength(2)
    expect(r.refunds.every(p => p.isExchange && exchangeIds.includes(p.exchangeId!))).toBe(true)
  })
  it('chain refunds remain real refunds with an additive chain link (R24)', async () => {
    const r = await getRefundsReport(chain.venueId, range)
    expect(r.refunds.find(p => p.id === chainRefundId)).toMatchObject({
      isExchange: false,
      exchangeId: null,
      chainOfExchangeId: chainExchangeId,
      saleAmount: 200,
    })
    expect(r.totals).toMatchObject({ totalRefunded: 700, exchangesCount: 1, exchangeCreditTotal: 500 })
    const row = await prisma.payment.findUniqueOrThrow({ where: { id: chainRefundId } })
    expect(row.processorData).toMatchObject({ exchange: { role: EXCHANGE_REFUND_ROLE.CHAIN } })
  })
  it('cash and banks already excludes the EC pair without changing gift card marks (R28)', async () => {
    const r = await getBankAndCashSummary(s.venueId, days)
    expect(r.accounts.reduce((n, p) => n + p.count, 0)).toBe(2)
    expect(r.totals).toMatchObject({ cashInflowCents: 10000, electronicInflowCents: 100000 })
    const out = await getBankAndCashSummary(payout.venueId, days)
    expect(out.totals.cashInflowCents).toBe(-10000)
  })
  it('the reconciliation script agrees with MCP method totals and counts, excluding the EC pair (R28)', async () => {
    const run = promisify(execFile)
    const { stdout } = await run(
      path.resolve('node_modules/.bin/tsx'),
      ['scripts/mcp-money-reconcile.ts', '--venue', s.venueId, '--from', days.from, '--to', days.to],
      {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL },
        timeout: 45000,
      },
    ).catch((error: { stdout?: string; stderr?: string }) => {
      throw new Error(`${error.stdout ?? ''}\n${error.stderr ?? ''}`)
    })
    expect(stdout).toContain('0 ❌')
    expect(stdout).toContain('── sales_by_payment_method ──')
  })
  it('empty periods and ordinary refunds keep their existing totals without exchange links', async () => {
    const normal = await seed()
    const empty = await getRefundsReport(normal.venueId, range)
    expect(empty.totals).toMatchObject({ count: 0, totalRefunded: 0, exchangesCount: 0, exchangeCreditTotal: 0 })
    expect(empty.refunds).toEqual([])
    await issueRefund({
      venueId: normal.venueId,
      staffId: normal.staffId,
      paymentId: normal.payments[0].id,
      amount: 10000,
      reason: 'RETURNED_GOODS',
    })
    const refunded = await getRefundsReport(normal.venueId, range)
    expect(refunded.refunds[0]).toMatchObject({ isExchange: false, exchangeId: null, chainOfExchangeId: null, saleAmount: 100 })
    expect(refunded.totals).toMatchObject({ count: 1, totalRefunded: 100, exchangesCount: 0, exchangeCreditTotal: 0 })
    const outside = await getRefundsReport(s.venueId, { startDate: '2020-01-01T00:00:00Z', endDate: '2020-01-02T00:00:00Z' })
    expect(outside.totals).toMatchObject({ exchangesCount: 0, exchangeCreditTotal: 0, totalRefunded: 0 })
  })
  it('credit assessment excludes the EC pair from volume, count and refund rate (R28)', async () => {
    await calculateVenueAssessment(s.venueId)
    const r = await prisma.venueCreditAssessment.findUniqueOrThrow({ where: { venueId: s.venueId } })
    expect(r.transactionCount12m).toBe(2)
    expect(Number(r.annualVolume)).toBe(1100)
    expect(Number(r.refundRate)).toBe(0)
  })
})
