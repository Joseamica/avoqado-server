/**
 * Integration tests: date binds in raw SQL vs `timestamp without time zone` (REAL PostgreSQL).
 *
 * Every DateTime column in this schema is `timestamp without time zone` storing real UTC.
 * A Prisma `Date` bound into `$queryRaw` / `$queryRawUnsafe` travels as `timestamptz`, and
 * Postgres converts it with the SESSION time zone before comparing — directly or through
 * `::timestamp`. Locally that zone is America/Mexico_City and the filter shifts 6 hours;
 * production (Render) runs UTC, where the bare form happens to be right — measured
 * 2026-09-01, see org-stock-date-binds.integration.test.ts for both zones side by side.
 * The same session-tz dependency breaks buckets built with a SINGLE `AT TIME ZONE tz`
 * over a column that already stores UTC: the "local" day/hour comes out in UTC.
 *
 * A unit test with a mocked `$queryRaw` cannot see any of this — it returns whatever the
 * mock was told. Hence: real database, exact boundary rows.
 *
 * The venue day under test is Tuesday 2025-03-11 in America/Mexico_City, i.e. the instant
 * range [2025-03-11T06:00Z, 2025-03-12T06:00Z). Four sales sit on the edges:
 *
 *   NOON        12:00 MX  (18:00Z 11)  → inside, every filter agrees
 *   NIGHT       20:00 MX  (02:00Z 12)  → inside; a 6h-shifted filter DROPS it,
 *                                        a single-application bucket lands it on the 12th / hour 02
 *   LATE_PREV   23:30 MX  (05:30Z 11)  → outside (it is the 10th); the shifted filter INCLUDES it
 *   EARLY_NEXT  04:00 MX  (10:00Z 12)  → outside, every filter agrees
 *
 * Correct answers for "the 11th": 250 pesos, 2 orders, 3 units. The biased answers were
 * 53 pesos (NOON + LATE_PREV) — different money on the report.
 *
 * Run with:
 *   TEST_DATABASE_URL='postgresql://…/av-db-25-test' \
 *     npx jest --selectProjects integration --testPathPattern sql-date-binds-timezone
 */

import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import { SharedQueryService } from '@/services/dashboard/shared-query.service'
import { getSalesByItem } from '@/services/dashboard/sales-by-item.dashboard.service'
import { computeMerchantAccountBreakdown, getSalesSummary } from '@/services/dashboard/sales-summary.dashboard.service'
import { getPromotionSales } from '@/services/dashboard/promotion-sales.dashboard.service'
import { getHistoricalSummaries, HistoricalGrouping } from '@/services/tpv/historical-reports.service'
import { getCostVarianceReport, getPMIXReport } from '@/services/dashboard/report.service'
import { getOrderSourcesBreakdown } from '@/jobs/nightly-sales-summary.job'
import { commandCenterService } from '@/services/command-center/commandCenter.service'
import { getRevenueTrends } from '@/services/organization/organization.service'
import { getLayer1Report } from '@/services/settlement-report.service'
import { getVenueProfitMetrics } from '@/services/superadmin/paymentAnalytics.service'
import { getPerformance } from '@/services/upsell/upsellImpression.service'
import { reservationOverlapSql } from '@/services/dashboard/reservation.dashboard.service'
import { simCustodyService } from '@/services/serialized-inventory/custody.service'

const TZ = 'America/Mexico_City'
const FROM = new Date('2025-03-11T06:00:00.000Z')
const TO = new Date('2025-03-12T05:59:59.999Z')
const FROM_10 = new Date('2025-03-10T06:00:00.000Z')
const TO_12 = new Date('2025-03-13T05:59:59.999Z')

const NOON = new Date('2025-03-11T18:00:00.000Z')
const NIGHT = new Date('2025-03-12T02:00:00.000Z')
const LATE_PREV = new Date('2025-03-11T05:30:00.000Z')
const EARLY_NEXT = new Date('2025-03-12T10:00:00.000Z')

const suffix = `tzbind-${Date.now()}`
const PRODUCT_A = `Tacos Frontera ${suffix}`
const PRODUCT_B = `Agua Frontera ${suffix}`

let orgId: string
let venueId: string
let staffId: string
let aggregatorId: string
let merchantAccountId: string
let providerId: string
let productAId: string
let productBId: string
let tableId: string
let itemCategoryId: string
let serializedItemId: string

/** Venue-local calendar day of an instant — the only thing the reports are supposed to bucket by. */
const mxDay = (d: Date | string): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(d))
const mxHour = (d: Date | string): string =>
  new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false }).format(new Date(d))

async function makeSale(args: { at: Date; productId: string; productName: string; qty: number; unitPrice: number; servedById?: string }) {
  const total = args.qty * args.unitPrice
  const order = await prisma.order.create({
    data: {
      venueId,
      orderNumber: `${args.productName.slice(0, 4)}-${args.at.getTime()}-${suffix}`,
      createdAt: args.at,
      subtotal: total,
      taxAmount: 0,
      discountAmount: 0,
      total,
      status: 'COMPLETED',
      paymentStatus: 'PAID',
      servedById: args.servedById,
      items: {
        create: [
          {
            productId: args.productId,
            productName: args.productName,
            quantity: args.qty,
            unitPrice: args.unitPrice,
            discountAmount: 0,
            taxAmount: 0,
            total,
            createdAt: args.at,
          },
        ],
      },
    },
    select: { id: true, items: { select: { id: true } } },
  })
  const payment = await prisma.payment.create({
    data: {
      venueId,
      orderId: order.id,
      amount: total,
      tipAmount: 0,
      method: 'CREDIT_CARD',
      status: 'COMPLETED',
      feePercentage: 0,
      feeAmount: 0,
      netAmount: total,
      merchantAccountId,
      processedById: args.servedById,
      createdAt: args.at,
    },
    select: { id: true },
  })
  await prisma.transactionCost.create({
    data: {
      paymentId: payment.id,
      merchantAccountId,
      transactionType: 'CREDIT',
      amount: total,
      providerRate: 0.02,
      providerCostAmount: total * 0.02,
      venueRate: 0.025,
      venueChargeAmount: total * 0.025,
      grossProfit: total * 0.005,
      profitMargin: 0.2,
      createdAt: args.at,
    },
  })
  return { orderId: order.id, orderItemId: order.items[0].id }
}

beforeAll(async () => {
  const org = await prisma.organization.create({
    data: { name: `TZ Binds Org ${suffix}`, email: `${suffix}@example.test`, phone: '0000000000' },
    select: { id: true },
  })
  orgId = org.id
  const venue = await prisma.venue.create({
    data: { organizationId: orgId, name: `tz-${suffix}`, slug: `tz-${suffix}`, timezone: TZ },
    select: { id: true },
  })
  venueId = venue.id

  const staff = await prisma.staff.create({
    data: { email: `waiter-${suffix}@example.test`, firstName: 'Mesero', lastName: suffix },
    select: { id: true },
  })
  staffId = staff.id
  await prisma.staffVenue.create({ data: { staffId, venueId, role: 'WAITER' } })

  const provider = await prisma.paymentProvider.create({
    data: { code: `PROV-${suffix}`, name: `Provider ${suffix}`, type: 'PAYMENT_PROCESSOR' },
    select: { id: true },
  })
  providerId = provider.id
  const aggregator = await prisma.aggregator.create({
    data: { name: `Aggregator ${suffix}`, baseFees: { DEBIT: 0.025, CREDIT: 0.025, AMEX: 0.033, INTERNATIONAL: 0.033 } },
    select: { id: true },
  })
  aggregatorId = aggregator.id
  const merchant = await prisma.merchantAccount.create({
    data: { providerId, externalMerchantId: `ext-${suffix}`, credentialsEncrypted: {}, aggregatorId },
    select: { id: true },
  })
  merchantAccountId = merchant.id

  const category = await prisma.menuCategory.create({
    data: { venueId, name: `Cat ${suffix}`, slug: `cat-${suffix}` },
    select: { id: true },
  })
  const productA = await prisma.product.create({
    data: { venueId, sku: `A-${suffix}`, name: PRODUCT_A, categoryId: category.id, price: 100 },
    select: { id: true },
  })
  productAId = productA.id
  const productB = await prisma.product.create({
    data: { venueId, sku: `B-${suffix}`, name: PRODUCT_B, categoryId: category.id, price: 7 },
    select: { id: true },
  })
  productBId = productB.id

  await makeSale({ at: NOON, productId: productAId, productName: PRODUCT_A, qty: 1, unitPrice: 50, servedById: staffId })
  const night = await makeSale({ at: NIGHT, productId: productAId, productName: PRODUCT_A, qty: 2, unitPrice: 100, servedById: staffId })
  await makeSale({ at: LATE_PREV, productId: productBId, productName: PRODUCT_B, qty: 1, unitPrice: 3 })
  await makeSale({ at: EARLY_NEXT, productId: productBId, productName: PRODUCT_B, qty: 1, unitPrice: 7 })

  // A combo sold on the NIGHT order — the promotion report must see it on the 11th.
  const promotion = await prisma.promotion.create({
    data: { venueId, name: `Combo ${suffix}`, type: 'COMBO', pricingMode: 'FIXED_TOTAL' },
    select: { id: true },
  })
  const orderPromotion = await prisma.orderPromotion.create({
    data: {
      orderId: night.orderId,
      promotionId: promotion.id,
      instanceId: `inst-${suffix}`,
      snapshotJson: { name: `Combo ${suffix}` },
      grossCents: 20000,
      discountCents: 0,
      netCents: 20000,
      createdAt: NIGHT,
    },
    select: { id: true },
  })
  await prisma.orderItem.update({ where: { id: night.orderItemId }, data: { orderPromotionId: orderPromotion.id } })

  // An upsell shown at 20:00 local on the 11th.
  await prisma.upsellImpression.create({
    data: { id: randomUUID(), venueId, orderId: night.orderId, context: 'CART', shownAt: NIGHT },
  })

  // A confirmed table reservation 10:00–11:00 local on the 11th (16:00Z–17:00Z).
  const table = await prisma.table.create({
    data: { venueId, number: `T-${suffix}`, capacity: 4, qrCode: `qr-${suffix}` },
    select: { id: true },
  })
  tableId = table.id
  await prisma.reservation.create({
    data: {
      venueId,
      tableId,
      confirmationCode: `RSV-${suffix}`,
      startsAt: new Date('2025-03-11T16:00:00.000Z'),
      endsAt: new Date('2025-03-11T17:00:00.000Z'),
      blockedEndsAt: new Date('2025-03-11T17:00:00.000Z'),
      duration: 60,
      status: 'CONFIRMED',
      partySize: 2,
    },
  })

  // An org-level serialized item (a SIM) for the custody UPDATE.
  const itemCategory = await prisma.itemCategory.create({ data: { name: `SIM ${suffix}` }, select: { id: true } })
  itemCategoryId = itemCategory.id
  const item = await prisma.serializedItem.create({
    data: { categoryId: itemCategoryId, organizationId: orgId, serialNumber: `ICCID-${suffix}`, createdBy: staffId },
    select: { id: true },
  })
  serializedItemId = item.id
})

afterAll(async () => {
  if (!venueId) return
  if (itemCategoryId) {
    await prisma.serializedItem.deleteMany({ where: { categoryId: itemCategoryId } })
    await prisma.itemCategory.deleteMany({ where: { id: itemCategoryId } })
  }
  await prisma.upsellImpression.deleteMany({ where: { venueId } })
  await prisma.reservation.deleteMany({ where: { venueId } })
  await prisma.table.deleteMany({ where: { venueId } })
  await prisma.transactionCost.deleteMany({ where: { payment: { venueId } } })
  await prisma.payment.deleteMany({ where: { venueId } })
  await prisma.orderItem.deleteMany({ where: { order: { venueId } } })
  await prisma.orderPromotion.deleteMany({ where: { order: { venueId } } })
  await prisma.order.deleteMany({ where: { venueId } })
  await prisma.promotion.deleteMany({ where: { venueId } })
  await prisma.product.deleteMany({ where: { venueId } })
  await prisma.menuCategory.deleteMany({ where: { venueId } })
  await prisma.staffVenue.deleteMany({ where: { venueId } })
  if (staffId) await prisma.staff.deleteMany({ where: { id: staffId } })
  if (merchantAccountId) await prisma.merchantAccount.deleteMany({ where: { id: merchantAccountId } })
  if (aggregatorId) await prisma.aggregator.deleteMany({ where: { id: aggregatorId } })
  if (providerId) await prisma.paymentProvider.deleteMany({ where: { id: providerId } })
  await prisma.venue.deleteMany({ where: { id: venueId } })
  if (orgId) await prisma.organization.deleteMany({ where: { id: orgId } })
})

// ===========================================================================
// Family 1 — the filter: a Date bound into raw SQL must select the same rows
// Prisma's own `createdAt: { gte, lte }` selects.
// ===========================================================================

describe('SharedQueryService — raw filters agree with Prisma on the venue day', () => {
  const period = { from: FROM, to: TO }

  it('getSalesTimeSeries: one bucket for the 11th with both sales', async () => {
    const series = await SharedQueryService.getSalesTimeSeries(venueId, period)
    expect(series.dataPoints).toEqual([expect.objectContaining({ date: '2025-03-11', revenue: 250, orderCount: 2 })])
    expect(series.totalRevenue).toBe(250)
  })

  it('getTopProducts: the night sale counts, the 23:30 sale of the 10th does not', async () => {
    const top = await SharedQueryService.getTopProducts(venueId, period, 10)
    const a = top.find(p => p.productId === productAId)
    expect(a).toEqual(expect.objectContaining({ quantitySold: 3, revenue: 250, orderCount: 2 }))
    expect(top.find(p => p.productId === productBId)).toBeUndefined()
  })

  it('getProductSalesByName: 250 for product A', async () => {
    const sales = await SharedQueryService.getProductSalesByName(venueId, PRODUCT_A, period)
    expect(sales.revenue).toBe(250)
    expect(sales.quantitySold).toBe(3)
  })

  it('compareProductSales: A = 250, B = 0; nightOnly keeps the 20:00 sale', async () => {
    // Search terms without the hyphenated suffix: compareProductSales normalizes the SEARCH
    // term ("a-b" → "a b") but ILIKEs it against the RAW productName. Pre-existing quirk,
    // unrelated to the date binds; the venue scope keeps the match unambiguous.
    const terms = { leftTerm: 'Tacos Frontera', rightTerm: 'Agua Frontera' }
    const cmp = await SharedQueryService.compareProductSales(venueId, { ...terms, period })
    expect(cmp.left.revenue).toBe(250)
    expect(cmp.right.revenue).toBe(0)

    const night = await SharedQueryService.compareProductSales(venueId, { ...terms, period, nightOnly: true })
    expect(night.left.revenue).toBe(200)
  })

  it('getStaffPerformance: the waiter served 2 orders worth 250', async () => {
    const staff = await SharedQueryService.getStaffPerformance(venueId, period, 10)
    expect(staff.find(s => s.staffId === staffId)).toEqual(expect.objectContaining({ totalOrders: 2, totalRevenue: 250 }))
  })

  it('getProfitAnalysis: the Prisma total and the raw per-product revenue describe the same window', async () => {
    const profit = await SharedQueryService.getProfitAnalysis(venueId, period, 10)
    expect(profit.totalRevenue).toBe(250)
    const a = profit.topProfitableProducts.find(p => p.productId === productAId)
    expect(a).toEqual(expect.objectContaining({ revenue: 250, quantitySold: 3 }))
  })
})

describe('Sales by item — filters and local buckets', () => {
  const base = { startDate: FROM.toISOString(), endDate: TO.toISOString(), timezone: TZ }

  it('summary: 250 gross, 3 units', async () => {
    const r = await getSalesByItem(venueId, { ...base, reportType: 'summary' })
    expect(r.totals.grossSales).toBe(250)
    expect(r.totals.unitsSold).toBe(3)
  })

  it('days: a single bucket, on the 11th in venue time, holding 250', async () => {
    const r = await getSalesByItem(venueId, { ...base, reportType: 'days' })
    expect(r.byPeriod?.map(p => [mxDay(p.period), p.grossSales])).toEqual([['2025-03-11', 250]])
  })

  it('hours: the 20:00 sale buckets at 20:00 venue time, not at 02:00', async () => {
    const r = await getSalesByItem(venueId, { ...base, reportType: 'hours' })
    expect(r.byPeriod?.map(p => [mxDay(p.period), mxHour(p.period), p.grossSales])).toEqual([
      ['2025-03-11', '12', 50],
      ['2025-03-11', '20', 200],
    ])
  })

  it('hourlySum: hour 20 has 200; dailySum: Tuesday has 250', async () => {
    const hourly = await getSalesByItem(venueId, { ...base, reportType: 'hourlySum' })
    expect(hourly.byPeriod?.find(p => p.period === '20:00')?.grossSales).toBe(200)
    expect(hourly.byPeriod?.find(p => p.period === '02:00')?.grossSales).toBe(0)

    const daily = await getSalesByItem(venueId, { ...base, reportType: 'dailySum' })
    expect(daily.byPeriod?.find(p => p.period === 'tuesday')?.grossSales).toBe(250)
  })

  it('hour filter 18:00–23:00 in venue time keeps only the night sale', async () => {
    const r = await getSalesByItem(venueId, { ...base, reportType: 'summary', startHour: '18:00', endHour: '23:00' })
    expect(r.totals.grossSales).toBe(200)
  })
})

describe('Sales summary — the period bars sum to the headline and sit on the right day', () => {
  const base = { startDate: FROM.toISOString(), endDate: TO.toISOString(), timezone: TZ }

  it('days: one bar, the 11th, equal to the Prisma headline', async () => {
    const r = await getSalesSummary(venueId, { ...base, reportType: 'days' })
    expect(r.summary.grossSales).toBe(250)
    expect(r.byPeriod?.map(p => [mxDay(p.period), p.metrics.grossSales])).toEqual([['2025-03-11', 250]])
  })

  it('hourlySum: hour 20 has 200', async () => {
    const r = await getSalesSummary(venueId, { ...base, reportType: 'hourlySum' })
    expect(r.byPeriod?.find(p => p.period === '20:00')?.metrics.grossSales).toBe(200)
  })

  it('computeMerchantAccountBreakdown: 2 transactions, 250 collected', async () => {
    const rows = await computeMerchantAccountBreakdown(venueId, FROM, TO)
    expect(rows).toEqual([expect.objectContaining({ merchantAccountId, collectedOnCard: 250, transactionCount: 2 })])
  })
})

describe('Promotion sales', () => {
  it('the combo sold at 20:00 on the 11th is reported on the 11th', async () => {
    const r = await getPromotionSales(venueId, {
      startDate: FROM.toISOString(),
      endDate: TO.toISOString(),
      reportType: 'days',
      timezone: TZ,
    })
    expect(r.totals.timesSold).toBe(1)
    // The period is the venue wall clock sealed in UTC (see formatPeriodLabel there).
    expect(r.byPeriod?.map(p => [p.period.slice(0, 10), p.timesSold])).toEqual([['2025-03-11', 1]])
  })
})

describe('TPV historical summaries', () => {
  it('DAILY: each sale lands on its venue-local day', async () => {
    const r = await getHistoricalSummaries(venueId, HistoricalGrouping.DAILY, FROM_10, TO_12, undefined, 10)
    expect(r.periods.map(p => [mxDay(p.periodStart), p.totalSales, p.totalOrders])).toEqual([
      ['2025-03-12', 7, 1],
      ['2025-03-11', 250, 2],
      ['2025-03-10', 3, 1],
    ])
  })

  it('pagination: the cursor does not repeat the last period of the previous page', async () => {
    const page1 = await getHistoricalSummaries(venueId, HistoricalGrouping.DAILY, FROM_10, TO_12, undefined, 1)
    expect(page1.periods.map(p => mxDay(p.periodStart))).toEqual(['2025-03-12'])
    expect(page1.pagination.hasMore).toBe(true)
    const page2 = await getHistoricalSummaries(venueId, HistoricalGrouping.DAILY, FROM_10, TO_12, page1.pagination.nextCursor!, 1)
    expect(page2.periods.map(p => mxDay(p.periodStart))).toEqual(['2025-03-11'])
  })
})

describe('Inventory / PMIX reports, nightly email, command center, organization', () => {
  it('PMIX: 3 units of A, 250 revenue', async () => {
    const r = await getPMIXReport(venueId, FROM, TO)
    expect(r.summary.totalRevenue).toBe(250)
    expect(r.products.find(p => p.productId === productAId)?.quantitySold).toBe(3)
  })

  it('cost variance: revenue 250', async () => {
    const r = await getCostVarianceReport(venueId, FROM, TO)
    expect(r.revenue).toBe(250)
  })

  it('nightly order-sources breakdown: 2 orders, 250 net', async () => {
    const rows = await getOrderSourcesBreakdown(venueId, FROM, TO)
    expect(rows.reduce((s, r) => s + r.orders, 0)).toBe(2)
    expect(rows.reduce((s, r) => s + r.netSales, 0)).toBe(250)
  })

  it('command center sales trend: the 11th sums 250', async () => {
    const r = await commandCenterService.getStockVsSales(venueId, { startDate: '2025-03-11T12:00:00', endDate: '2025-03-11T12:00:00' })
    expect(r.trend.reduce((s, p) => s + p.sales, 0)).toBe(250)
  })

  it('organization revenue trends: current period revenue is 250', async () => {
    const r = await getRevenueTrends(orgId, { from: FROM, to: TO })
    expect(r.currentPeriod.totals.revenue).toBe(250)
  })
})

describe('Money for third parties — aggregator settlement and platform analytics', () => {
  it('Layer 1 settlement for the 11th: 2 transactions, 250 gross', async () => {
    const r = await getLayer1Report(aggregatorId, '2025-03-11', '2025-03-11')
    expect(r?.grandTotal).toEqual(expect.objectContaining({ txCount: 2, grossAmount: 250 }))
  })

  it('venue profit metrics: the raw per-provider volume equals the Prisma total', async () => {
    const r = await getVenueProfitMetrics(venueId, { startDate: FROM, endDate: TO })
    expect(r.totalVolume).toBe(250)
    expect(r.byProvider.map(p => p.volume)).toEqual([250])
  })

  it('upsell performance: the impression shown at 20:00 belongs to the 11th', async () => {
    const r = await getPerformance(venueId, FROM, TO)
    expect(r.shownCount).toBe(1)
  })
})

// ===========================================================================
// Reservations — the overlap predicate used under FOR UPDATE by the booking locks.
// A 10:00–11:00 booking on the same table MUST overlap an existing 10:00–11:00 one.
// ===========================================================================

// ===========================================================================
// SIM custody — the only raw UPDATE that writes dates. Bound bare, a Date landed in the
// `timestamp` column converted to the session zone (six hours early), and every later
// transition that preserved the previous value shifted it six more hours.
// ===========================================================================

describe('SerializedItem custody UPDATE', () => {
  const write = (patch: Record<string, unknown>) =>
    prisma.$transaction(async tx => {
      const item = await tx.serializedItem.findUniqueOrThrow({ where: { id: serializedItemId } })
      // Private on purpose in the service; exercised directly because it is the one statement
      // that can corrupt a custody timestamp, and no public transition fixture is cheaper.
      return (
        simCustodyService as unknown as {
          updateWithVersion: (transaction: typeof tx, currentItem: typeof item, changes: typeof patch) => Promise<typeof item>
        }
      ).updateWithVersion(tx, item, patch)
    })

  it('stores the instant it was given, and preserving it across a transition does not move it', async () => {
    await write({ custodyState: 'SUPERVISOR_HELD', assignedSupervisorId: staffId, assignedSupervisorAt: NIGHT })
    const first = await prisma.serializedItem.findUniqueOrThrow({ where: { id: serializedItemId } })
    expect(first.assignedSupervisorAt?.toISOString()).toBe(NIGHT.toISOString())

    // Second transition without touching assignedSupervisorAt: the service re-writes the value it read.
    await write({ custodyState: 'PROMOTER_PENDING', assignedPromoterId: staffId, assignedPromoterAt: EARLY_NEXT })
    const second = await prisma.serializedItem.findUniqueOrThrow({ where: { id: serializedItemId } })
    expect(second.assignedSupervisorAt?.toISOString()).toBe(NIGHT.toISOString())
    expect(second.assignedPromoterAt?.toISOString()).toBe(EARLY_NEXT.toISOString())
    expect(second.promoterAcceptedAt).toBeNull()
  })
})

describe('Reservation overlap predicate', () => {
  it('finds the existing 10:00–11:00 booking when the same slot is requested', async () => {
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM "Reservation"
      WHERE "venueId" = ${venueId}
        AND "tableId" = ${tableId}
        AND ${reservationOverlapSql(new Date('2025-03-11T16:00:00.000Z'), new Date('2025-03-11T17:00:00.000Z'))}
    `
    expect(rows).toHaveLength(1)
  })

  it('does not flag a 16:00–17:00 local booking (six hours later) as a conflict', async () => {
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM "Reservation"
      WHERE "venueId" = ${venueId}
        AND "tableId" = ${tableId}
        AND ${reservationOverlapSql(new Date('2025-03-11T22:00:00.000Z'), new Date('2025-03-11T23:00:00.000Z'))}
    `
    expect(rows).toHaveLength(0)
  })
})
