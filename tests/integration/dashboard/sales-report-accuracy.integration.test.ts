/**
 * Integration tests: sales-report accuracy (REAL PostgreSQL, real SQL).
 *
 * These three defects were all "the number is wrong", and every one of them
 * lives in raw SQL. A unit test with a mocked `$queryRaw` returns whatever the
 * mock was told to return, so it would pass against the broken query too —
 * it proves nothing. Hence: real database.
 *
 * 1. TPV historical summaries multiplied each order's total by its number of
 *    order lines (a LEFT JOIN added for `total_products` fanned out `SUM(o.total)`).
 * 2. "Discount analysis" only looked at Order.discountAmount, so a combo/promo
 *    giveaway written on OrderItem.discountAmount reported zero.
 * 3. Item-revenue reports summed unitPrice * quantity and ignored
 *    OrderItem.discountAmount, charging every discounted line at list price.
 *
 * Run with:
 *   TEST_DATABASE_URL='postgresql://…/av-db-25-test' \
 *     npx jest --selectProjects integration --testPathPattern sales-report-accuracy
 */

import { HistoricalGrouping } from '@/services/tpv/historical-reports.service'
import { getHistoricalSummaries } from '@/services/tpv/historical-reports.service'
import { getChartData } from '@/services/dashboard/generalStats.dashboard.service'
import { getSalesByItem } from '@/services/dashboard/sales-by-item.dashboard.service'
import { getCostVarianceReport, getPMIXReport } from '@/services/dashboard/report.service'
import { SharedQueryService } from '@/services/dashboard/shared-query.service'
import prisma from '@/utils/prismaClient'

// Anchored at 18:00 UTC = 12:00 in America/Mexico_City, so the venue-local
// calendar day is identical whether the host runs TZ=UTC (production) or
// TZ=America/Mexico_City (this Mac). Dates are the classic runtime-tz trap.
const PREV_DAY = new Date('2025-03-10T18:00:00.000Z')
const DAY = new Date('2025-03-11T18:00:00.000Z')
const RANGE = { from: new Date('2025-03-09T00:00:00.000Z'), to: new Date('2025-03-12T23:59:59.999Z') }
const FROM_ISO = RANGE.from.toISOString()
const TO_ISO = RANGE.to.toISOString()

const suffix = `rpt-acc-${Date.now()}`

let orgId: string
let fanoutVenueId: string
let itemVenueId: string
let extrasVenueId: string
let tacosProductId: string

const num = (v: unknown): number => Number(v)
const round2 = (n: number): number => Math.round(n * 100) / 100

async function makeVenue(name: string): Promise<string> {
  const venue = await prisma.venue.create({
    data: {
      organizationId: orgId,
      name,
      slug: `${name}-${suffix}`.toLowerCase(),
      timezone: 'America/Mexico_City',
    },
    select: { id: true },
  })
  return venue.id
}

beforeAll(async () => {
  const org = await prisma.organization.create({
    data: { name: `Report Accuracy Org ${suffix}`, email: `${suffix}@example.test`, phone: '0000000000' },
    select: { id: true },
  })
  orgId = org.id

  fanoutVenueId = await makeVenue(`fanout-${suffix}`)
  itemVenueId = await makeVenue(`items-${suffix}`)
  extrasVenueId = await makeVenue(`extras-${suffix}`)

  // ── Venue A — bug 1: one order worth $30 spread over THREE lines ──────────
  // Previous day: a single one-line order also worth $30, so a correct
  // salesChange is exactly 0%.
  await prisma.order.create({
    data: {
      venueId: fanoutVenueId,
      orderNumber: `PREV-${suffix}`,
      createdAt: PREV_DAY,
      subtotal: 30,
      taxAmount: 0,
      total: 30,
      status: 'COMPLETED',
      paymentStatus: 'PAID',
      items: { create: [{ quantity: 1, unitPrice: 30, discountAmount: 0, taxAmount: 0, total: 30 }] },
    },
  })
  await prisma.order.create({
    data: {
      venueId: fanoutVenueId,
      orderNumber: `FANOUT-${suffix}`,
      createdAt: DAY,
      subtotal: 30,
      taxAmount: 0,
      total: 30,
      status: 'COMPLETED',
      paymentStatus: 'PAID',
      items: {
        create: [
          { quantity: 1, unitPrice: 10, discountAmount: 0, taxAmount: 0, total: 10 },
          { quantity: 1, unitPrice: 10, discountAmount: 0, taxAmount: 0, total: 10 },
          { quantity: 1, unitPrice: 10, discountAmount: 0, taxAmount: 0, total: 10 },
        ],
      },
    },
  })

  // ── Venue B — bugs 2 and 3 ───────────────────────────────────────────────
  const category = await prisma.menuCategory.create({
    data: { venueId: itemVenueId, name: `Cat ${suffix}`, slug: `cat-${suffix}` },
    select: { id: true },
  })
  const tacos = await prisma.product.create({
    data: { venueId: itemVenueId, sku: `TACOS-${suffix}`, name: `Tacos al Pastor ${suffix}`, categoryId: category.id, price: 89 },
    select: { id: true },
  })
  tacosProductId = tacos.id
  // Deliberately NOT a hyphenated name: compareProductSales normalizes the
  // SEARCH term ("Coca-Cola" → "coca cola") but ILIKEs it against the RAW
  // productName, so a hyphenated product can never be found by that path.
  // Pre-existing quirk, unrelated to these fixes — just don't trip on it here.
  const refresco = await prisma.product.create({
    data: { venueId: itemVenueId, sku: `COLA-${suffix}`, name: `Refresco ${suffix}`, categoryId: category.id, price: 25 },
    select: { id: true },
  })
  const listPriced = await prisma.product.create({
    data: { venueId: itemVenueId, sku: `LIST-${suffix}`, name: `Producto Lista ${suffix}`, categoryId: category.id, price: 100 },
    select: { id: true },
  })
  const comped = await prisma.product.create({
    data: { venueId: itemVenueId, sku: `COMP-${suffix}`, name: `Producto Cortesia ${suffix}`, categoryId: category.id, price: 50 },
    select: { id: true },
  })

  // Combo: the giveaway lives on the LINES; Order.discountAmount stays 0 and
  // each line total is already net of it. This is the shape the real combo
  // writes, and the shape both bug 2 and bug 3 were blind to.
  await prisma.order.create({
    data: {
      venueId: itemVenueId,
      orderNumber: `COMBO-${suffix}`,
      createdAt: DAY,
      subtotal: 114,
      discountAmount: 0,
      taxAmount: 0,
      total: 99,
      status: 'COMPLETED',
      paymentStatus: 'PAID',
      items: {
        create: [
          {
            productId: tacos.id,
            productName: 'Tacos al Pastor',
            quantity: 1,
            unitPrice: 89,
            discountAmount: 11.71,
            taxAmount: 0,
            total: 77.29,
          },
          { productId: refresco.id, productName: 'Refresco', quantity: 1, unitPrice: 25, discountAmount: 3.29, taxAmount: 0, total: 21.71 },
        ],
      },
    },
  })

  // ── Venue C — two revenue sources `unitPrice * quantity` cannot see ───────
  // On their own venue so they don't perturb the discount arithmetic above.
  const extrasCategory = await prisma.menuCategory.create({
    data: { venueId: extrasVenueId, name: `Extras ${suffix}`, slug: `extras-cat-${suffix}` },
    select: { id: true },
  })
  const burger = await prisma.product.create({
    data: { venueId: extrasVenueId, sku: `BURG-${suffix}`, name: `Hamburguesa Doble ${suffix}`, categoryId: extrasCategory.id, price: 169 },
    select: { id: true },
  })
  const ham = await prisma.product.create({
    data: { venueId: extrasVenueId, sku: `HAM-${suffix}`, name: `Jamon por kg ${suffix}`, categoryId: extrasCategory.id, price: 240 },
    select: { id: true },
  })

  await prisma.order.create({
    data: {
      venueId: extrasVenueId,
      orderNumber: `EXTRAS-${suffix}`,
      createdAt: DAY,
      subtotal: 553.4,
      discountAmount: 0,
      taxAmount: 0,
      total: 553.4,
      status: 'COMPLETED',
      paymentStatus: 'PAID',
      items: {
        create: [
          {
            // MODIFIERS: unitPrice carries none of the 280 the customer added.
            // `total` here EXCLUDES them, which is the majority convention in
            // live data — so reading revenue off `total` would lose it.
            productId: burger.id,
            productName: 'Hamburguesa Doble',
            quantity: 1,
            unitPrice: 169,
            discountAmount: 0,
            taxAmount: 0,
            total: 169,
            modifiers: {
              create: [
                { name: 'Extra carne', quantity: 1, price: 250 },
                { name: 'Queso', quantity: 1, price: 30 },
              ],
            },
          },
          {
            // SOLD BY WEIGHT: quantity stays 1, the kilos are in weightQuantity.
            // unitPrice * quantity would charge a whole kilo (240) for 435 g.
            productId: ham.id,
            productName: 'Jamon por kg',
            quantity: 1,
            unitPrice: 240,
            discountAmount: 0,
            taxAmount: 0,
            weightQuantity: 0.435,
            total: 104.4,
          },
        ],
      },
    },
  })

  // Order-level discount: the line stays at list price, the giveaway is on the
  // order. Must keep counting exactly once (regression guard).
  await prisma.order.create({
    data: {
      venueId: itemVenueId,
      orderNumber: `ORDERDISC-${suffix}`,
      createdAt: DAY,
      subtotal: 100,
      discountAmount: 20,
      taxAmount: 0,
      total: 80,
      status: 'COMPLETED',
      paymentStatus: 'PAID',
      items: {
        create: [
          {
            productId: listPriced.id,
            productName: 'Producto Lista',
            quantity: 1,
            unitPrice: 100,
            discountAmount: 0,
            taxAmount: 0,
            total: 100,
          },
        ],
      },
    },
  })

  // "Cobrar" cortesía: the line is GROSS (total = unitPrice * quantity) and the
  // giveaway is ALSO on Order.discountAmount. Counting both sides would
  // double-count it — same trap salesGiveaways.ts documents.
  await prisma.order.create({
    data: {
      venueId: itemVenueId,
      orderNumber: `COMP-${suffix}`,
      createdAt: DAY,
      subtotal: 50,
      discountAmount: 50,
      taxAmount: 0,
      total: 0,
      status: 'COMPLETED',
      paymentStatus: 'PAID',
      items: {
        create: [
          {
            productId: comped.id,
            productName: 'Producto Cortesia',
            quantity: 1,
            unitPrice: 50,
            discountAmount: 50,
            taxAmount: 0,
            total: 50,
            isCortesia: true,
          },
        ],
      },
    },
  })
})

afterAll(async () => {
  const venueIds = [fanoutVenueId, itemVenueId, extrasVenueId].filter(Boolean)
  if (venueIds.length) {
    await prisma.orderItemModifier.deleteMany({ where: { orderItem: { order: { venueId: { in: venueIds } } } } })
    await prisma.orderItem.deleteMany({ where: { order: { venueId: { in: venueIds } } } })
    await prisma.order.deleteMany({ where: { venueId: { in: venueIds } } })
    await prisma.product.deleteMany({ where: { venueId: { in: venueIds } } })
    await prisma.menuCategory.deleteMany({ where: { venueId: { in: venueIds } } })
    await prisma.venue.deleteMany({ where: { id: { in: venueIds } } })
  }
  if (orgId) await prisma.organization.deleteMany({ where: { id: orgId } })
})

// ===========================================================================
// Bug 1 — the TPV historical report multiplied sales by the line count
// ===========================================================================
describe('getHistoricalSummaries — sales are per ORDER, not per order LINE', () => {
  it('reports a 3-line $30 order as $30, not $90', async () => {
    const result = await getHistoricalSummaries(fanoutVenueId, HistoricalGrouping.DAILY, RANGE.from, RANGE.to)
    const period = result.periods.find(p => p.totalOrders === 1 && p.label && p.periodStart >= new Date('2025-03-11T00:00:00.000Z'))

    expect(period).toBeDefined()
    expect(period!.totalSales).toBe(30)
  })

  it('keeps totalOrders and totalProducts unchanged (they were already correct)', async () => {
    const result = await getHistoricalSummaries(fanoutVenueId, HistoricalGrouping.DAILY, RANGE.from, RANGE.to)
    const period = result.periods.find(p => p.periodStart >= new Date('2025-03-11T00:00:00.000Z'))

    expect(period!.totalOrders).toBe(1)
    expect(period!.totalProducts).toBe(3)
    expect(period!.averageOrderValue).toBe(30)
  })

  it('compares against the previous period on the same basis (salesChange 0%, not +200%)', async () => {
    const result = await getHistoricalSummaries(fanoutVenueId, HistoricalGrouping.DAILY, RANGE.from, RANGE.to)
    const period = result.periods.find(p => p.periodStart >= new Date('2025-03-11T00:00:00.000Z'))

    expect(period!.salesChange).toBe(0)
  })
})

// ===========================================================================
// Bug 2 — discount analysis was blind to line-level giveaways
// ===========================================================================
describe('discount-analysis — sees BOTH order-level and item-level discounts', () => {
  it('counts an order whose discount lives only on its lines', async () => {
    const data = (await getChartData(itemVenueId, 'discount-analysis', { fromDate: FROM_ISO, toDate: TO_ISO })) as any

    // combo (item-level 15) + order-level (20) + cortesía (50) = 3 of 3 orders
    expect(data.ordersWithDiscount).toBe(3)
    expect(round2(data.totalDiscount)).toBe(85)
    expect(data.totalOrders).toBe(3)
    expect(round2(data.discountRate)).toBe(100)
  })

  it('breaks the total down so an accountant can see where each peso came from', async () => {
    const data = (await getChartData(itemVenueId, 'discount-analysis', { fromDate: FROM_ISO, toDate: TO_ISO })) as any

    expect(round2(data.orderLevelDiscount)).toBe(70) // 20 order-level + 50 cortesía
    expect(round2(data.itemLevelDiscount)).toBe(15) // the combo giveaway
    expect(round2(data.orderLevelDiscount + data.itemLevelDiscount)).toBe(round2(data.totalDiscount))
  })

  it('does NOT double-count a cortesía already charged to Order.discountAmount', async () => {
    const data = (await getChartData(itemVenueId, 'discount-analysis', { fromDate: FROM_ISO, toDate: TO_ISO })) as any

    // The cortesía line carries discountAmount = 50 AND the order carries 50.
    // It must contribute 50 in total, never 100.
    expect(round2(data.totalDiscount)).toBe(85)
    expect(round2(data.itemLevelDiscount)).toBe(15)
  })
})

// ===========================================================================
// Bug 3 — item revenue was charged at LIST price
// ===========================================================================
// unitPrice * quantity  = 89 + 25 + 100 + 50 = 264
// line discounts        = 11.71 + 3.29 + 0 + 50 = 65
// real revenue          = 199
const NET_ITEM_REVENUE = 199

describe('item revenue subtracts the line discount', () => {
  // `sales-by-item` is the ONE site that must NOT net its existing figure: it
  // already reports the giveaway on its own `discounts` column (Square parity),
  // and the chart labels the bar "Ventas brutas". Netting `grossSales` there
  // would double-subtract and make the label lie. What was missing is the
  // breakdown on the PERIOD rows, so a bar can be reconciled with the table.
  it('sales-by-item: byPeriod carries the same three figures as the table', async () => {
    const result = await getSalesByItem(itemVenueId, {
      startDate: FROM_ISO,
      endDate: TO_ISO,
      reportType: 'days',
      timezone: 'America/Mexico_City',
    })

    expect(round2(result.totals.grossSales)).toBe(264)
    expect(round2(result.totals.discounts)).toBe(65)
    expect(round2(result.totals.netSales)).toBe(NET_ITEM_REVENUE)

    const charted = result.byPeriod!.reduce(
      (acc, p) => ({
        gross: acc.gross + p.grossSales,
        discounts: acc.discounts + p.discounts,
        net: acc.net + p.netSales,
      }),
      { gross: 0, discounts: 0, net: 0 },
    )

    expect(round2(charted.gross)).toBe(round2(result.totals.grossSales))
    expect(round2(charted.discounts)).toBe(round2(result.totals.discounts))
    expect(round2(charted.net)).toBe(NET_ITEM_REVENUE)
  })

  it('PMIX report: revenue and avgPrice of a discounted item are net', async () => {
    const report = await getPMIXReport(itemVenueId, RANGE.from, RANGE.to)
    const tacos = report.products.find(p => p.productId === tacosProductId)

    expect(tacos).toBeDefined()
    expect(round2(tacos!.revenue)).toBe(77.29)
    expect(round2(tacos!.avgPrice)).toBe(77.29)
    expect(round2(report.summary.totalRevenue)).toBe(NET_ITEM_REVENUE)
  })

  it('cost-variance report: actual revenue is net', async () => {
    const report = await getCostVarianceReport(itemVenueId, RANGE.from, RANGE.to)
    expect(round2(num(report.revenue))).toBe(NET_ITEM_REVENUE)
  })

  it('top products: revenue is net', async () => {
    const top = await SharedQueryService.getTopProducts(itemVenueId, RANGE, 10)
    const tacos = top.find(p => p.productId === tacosProductId)

    expect(tacos).toBeDefined()
    expect(round2(tacos!.revenue)).toBe(77.29)
  })

  it('product sales by name: revenue is net', async () => {
    const sales = await SharedQueryService.getProductSalesByName(itemVenueId, 'Tacos al Pastor', RANGE)
    expect(round2(sales.revenue)).toBe(77.29)
  })

  it('product comparison: revenue is net on both sides', async () => {
    const comparison = await SharedQueryService.compareProductSales(itemVenueId, {
      leftTerm: 'Tacos al Pastor',
      rightTerm: 'Refresco',
      period: RANGE,
    })

    expect(round2(comparison.left.revenue)).toBe(77.29)
    expect(round2(comparison.right.revenue)).toBe(21.71)
  })

  it('profit analysis: revenue is net', async () => {
    const analysis = await SharedQueryService.getProfitAnalysis(itemVenueId, RANGE, 10)
    const tacos = analysis.topProfitableProducts.find(p => p.productId === tacosProductId)

    expect(tacos).toBeDefined()
    expect(round2(tacos!.revenue)).toBe(77.29)
  })

  // ── Revenue the old formula could not see at all ─────────────────────────
  // Burger 169 + modifiers 280 = 449; ham 240/kg × 0.435 kg = 104.40.
  // Old formula: 169 + 240 = 409. Real: 553.40.
  const EXTRAS_REVENUE = 553.4

  it('counts paid MODIFIERS, which unitPrice never carries (449, not 169)', async () => {
    const top = await SharedQueryService.getTopProducts(extrasVenueId, RANGE, 10)
    const burger = top.find(p => p.productName.startsWith('Hamburguesa Doble'))

    expect(burger).toBeDefined()
    expect(round2(burger!.revenue)).toBe(449)
  })

  it('charges a weighed item by the KILO, not by the unit (104.40, not 240)', async () => {
    const top = await SharedQueryService.getTopProducts(extrasVenueId, RANGE, 10)
    const ham = top.find(p => p.productName.startsWith('Jamon por kg'))

    expect(ham).toBeDefined()
    expect(round2(ham!.revenue)).toBe(104.4)
  })

  it('PMIX: both land in revenue, and avgPrice reads per-kilo for the weighed one', async () => {
    const report = await getPMIXReport(extrasVenueId, RANGE.from, RANGE.to)

    expect(round2(report.summary.totalRevenue)).toBe(EXTRAS_REVENUE)
    const ham = report.products.find(p => p.productName.startsWith('Jamon por kg'))
    expect(round2(ham!.avgPrice)).toBe(240) // price per kilo, not per weighing
  })

  it('sales-by-item keeps net = gross − discounts once modifiers and weight are in play', async () => {
    const result = await getSalesByItem(extrasVenueId, {
      startDate: FROM_ISO,
      endDate: TO_ISO,
      reportType: 'days',
      timezone: 'America/Mexico_City',
    })

    // No discounts here, so gross and net coincide — the point is that BOTH
    // sides moved together. If gross had stayed `unitPrice * quantity` it would
    // read 409 while net read 553.40, and the table would contradict itself.
    expect(round2(result.totals.grossSales)).toBe(EXTRAS_REVENUE)
    expect(round2(result.totals.netSales)).toBe(EXTRAS_REVENUE)

    const charted = result.byPeriod!.reduce((sum, p) => sum + p.netSales, 0)
    expect(round2(charted)).toBe(EXTRAS_REVENUE)
  })

  // The remaining two sites — `product-profitability` and the shift's
  // topProducts — do their arithmetic in JavaScript over rows Prisma already
  // returned, so a mocked client exercises the real path. They live in
  // tests/unit/services/dashboard/lineRevenue.test.ts.
  //
  // They are not here for an environment reason, NOT because this file can't
  // run: everything above is raw SQL and runs green against av-db-25-test.
  // Those two go through a Prisma `include`, which selects every column of the
  // model — including ones the test DB lacks while it sits behind av-db-25 on
  // migrations (e.g. OrderItem.orderPromotionId).
})
