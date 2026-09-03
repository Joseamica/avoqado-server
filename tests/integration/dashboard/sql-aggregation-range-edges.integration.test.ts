/**
 * Integration tests: exact edges of the date range in the SQL aggregations, under
 * two Postgres session time zones (REAL PostgreSQL).
 *
 * Why this file exists (2026-09-01): a JavaScript `Date` bound into `$queryRaw`
 * arrives as `timestamptz`. Compared against our `timestamp without time zone`
 * columns (which store UTC), Postgres strips the zone with the SESSION time zone.
 * Under a UTC session — production on Render, verified with `SHOW timezone` on
 * 2026-09-01 — a bare bind is right by accident; under an America/Mexico_City
 * session — every local Postgres on a Mexican machine — the same filter shifts six
 * hours. `utcTs` (src/utils/sqlDates.ts) makes the bind independent of the session.
 * A wide range hides the shift: only rows sitting exactly on `from` / `to`, and one
 * millisecond outside, expose it.
 *
 * What this file pins:
 *  · Rows at exactly `from` and `to` are IN and rows 1 ms outside are OUT, for every
 *    date bind of generalStats (`orderScope`, weekly trends) and availableBalance
 *    (cash sums, the calendar's `estimatedSettlementDate`).
 *  · The SQL agrees with Prisma's own `gte` / `lte` on the same rows.
 *  · Both hold under session zone America/Mexico_City AND UTC. The Prisma client is
 *    mocked to a SINGLE connection so `SET TIME ZONE` reaches the connection the
 *    services actually use, and each block asserts the setting took effect.
 *
 * The amounts are distinct powers of two so a shifted filter changes the SUM: a
 * six-hour shift swaps one edge row for one outside row and keeps the COUNT.
 *
 * Run with:
 *   TEST_DATABASE_URL='postgresql://…/av-db-25-test' \
 *     npx jest --selectProjects integration --testPathPattern sql-aggregation-range-edges
 */

// Single-connection client so a session-level `SET TIME ZONE` applies to every
// query the services run. `jest.mock` is hoisted above the imports; the factory
// may only touch globals (`require`, `process`). The real client adds a result-size
// guard extension that only logs — irrelevant here.
jest.mock('@/utils/prismaClient', () => {
  const { PrismaClient } = require('@prisma/client')
  const base = process.env.TEST_DATABASE_URL as string
  const url = `${base}${base.includes('?') ? '&' : '?'}connection_limit=1`
  return { __esModule: true, default: new PrismaClient({ datasources: { db: { url } } }) }
})

import { getAvailableBalance, getBalanceByCardType, getSettlementCalendar } from '@/services/dashboard/availableBalance.dashboard.service'
import { getChartData } from '@/services/dashboard/generalStats.dashboard.service'
import prisma from '@/utils/prismaClient'

const SESSION_ZONES = ['America/Mexico_City', 'UTC'] as const
type SessionZone = (typeof SESSION_ZONES)[number]

async function setSessionZone(zone: SessionZone): Promise<void> {
  await prisma.$executeRawUnsafe(`SET TIME ZONE '${zone}'`)
  const [{ tz }] = await prisma.$queryRaw<Array<{ tz: string }>>`SELECT current_setting('TimeZone') AS "tz"`
  // If this fails the single-connection mock stopped working and every assertion
  // below would be decoration: the services would run on a connection we never set.
  expect(tz).toBe(zone)
}

const FROM = new Date('2025-03-09T00:00:00.000Z')
const TO_ORDERS = new Date('2025-03-12T23:59:59.999Z') // generalStats filters
const TO_BALANCE = new Date('2025-03-15T23:59:59.999Z') // availableBalance range
const DAY = new Date('2025-03-11T18:00:00.000Z') // inside both ranges
const FILTERS = { fromDate: FROM.toISOString(), toDate: TO_ORDERS.toISOString() }
const RANGE = { from: FROM, to: TO_BALANCE }

const msBefore = (d: Date): Date => new Date(d.getTime() - 1)
const msAfter = (d: Date): Date => new Date(d.getTime() + 1)
const edgeRows = (to: Date) => [
  { at: FROM, amount: 1 },
  { at: to, amount: 2 },
  { at: msBefore(FROM), amount: 4 },
  { at: msAfter(to), amount: 8 },
]
const INSIDE_COUNT = 2
const INSIDE_SUM = 3 // 1 + 2; a six-hour shift yields 5 (1 + 4) or 9 (1 + 8)
const CARD_EDGE_NETS = [10, 20, 40, 80]
const CARD_INSIDE_NET = 30 // 10 + 20

const suffix = `edges-${Date.now()}`
const round2 = (n: number): number => Math.round(n * 100) / 100

let orgId: string
let ordersVenueId: string
let balanceVenueId: string
let providerId: string
let merchantId: string

beforeAll(async () => {
  const org = await prisma.organization.create({
    data: { name: `Range Edges Org ${suffix}`, email: `${suffix}@example.test`, phone: '0000000000' },
    select: { id: true },
  })
  orgId = org.id

  const mkVenue = (tag: string) =>
    prisma.venue.create({
      data: { organizationId: orgId, name: `${tag}-${suffix}`, slug: `${tag}-${suffix}`, timezone: 'America/Mexico_City' },
      select: { id: true },
    })
  ordersVenueId = (await mkVenue('edge-orders')).id
  balanceVenueId = (await mkVenue('edge-balance')).id

  // generalStats: four COMPLETED orders sitting on and just outside the edges.
  for (const [i, row] of edgeRows(TO_ORDERS).entries()) {
    await prisma.order.create({
      data: {
        venueId: ordersVenueId,
        orderNumber: `EDGE-${i}-${suffix}`,
        createdAt: row.at,
        type: 'DINE_IN',
        subtotal: row.amount,
        discountAmount: 0,
        taxAmount: 0,
        total: row.amount,
        status: 'COMPLETED',
        paymentStatus: 'PAID',
      },
    })
  }

  // availableBalance: four CASH payments on the createdAt edges, and four card
  // payments (created inside the range) whose stored estimatedSettlementDate sits on
  // the edges — the calendar filters by that column, not by createdAt.
  const provider = await prisma.paymentProvider.create({
    data: { code: `PROV-${suffix}`, name: 'Proveedor Edges', type: 'PAYMENT_PROCESSOR', countryCode: ['MX'] },
    select: { id: true },
  })
  providerId = provider.id
  const merchant = await prisma.merchantAccount.create({
    data: { providerId, externalMerchantId: `ext-${suffix}`, credentialsEncrypted: {} },
    select: { id: true },
  })
  merchantId = merchant.id

  const order = await prisma.order.create({
    data: {
      venueId: balanceVenueId,
      orderNumber: `EDGE-AB-${suffix}`,
      createdAt: DAY,
      subtotal: 165,
      taxAmount: 0,
      total: 165,
      status: 'COMPLETED',
      paymentStatus: 'PAID',
    },
    select: { id: true },
  })
  const basePayment = {
    venueId: balanceVenueId,
    orderId: order.id,
    status: 'COMPLETED' as const,
    tipAmount: 0,
    feePercentage: 0,
    feeAmount: 0,
    netAmount: 0,
  }

  for (const row of edgeRows(TO_BALANCE)) {
    await prisma.payment.create({ data: { ...basePayment, amount: row.amount, method: 'CASH', createdAt: row.at } })
  }

  const settlementEdges = edgeRows(TO_BALANCE).map(r => r.at)
  for (const [i, net] of CARD_EDGE_NETS.entries()) {
    const payment = await prisma.payment.create({
      data: { ...basePayment, amount: net, method: 'CREDIT_CARD', createdAt: DAY },
      select: { id: true },
    })
    await prisma.transactionCost.create({
      data: {
        paymentId: payment.id,
        merchantAccountId: merchantId,
        transactionType: 'CREDIT',
        amount: net,
        providerRate: 0,
        providerCostAmount: 0,
        venueRate: 0,
        venueChargeAmount: 0,
        venueFixedFee: 0,
        grossProfit: 0,
        profitMargin: 0,
      },
    })
    await prisma.venueTransaction.create({
      data: {
        venueId: balanceVenueId,
        paymentId: payment.id,
        type: 'PAYMENT',
        grossAmount: net,
        feeAmount: 0,
        netAmount: net,
        status: 'PENDING',
        estimatedSettlementDate: settlementEdges[i],
        netSettlementAmount: net,
      },
    })
  }
})

afterAll(async () => {
  await prisma.$executeRawUnsafe('RESET TIME ZONE')
  await prisma.transactionCost.deleteMany({ where: { payment: { venueId: balanceVenueId } } })
  await prisma.venueTransaction.deleteMany({ where: { venueId: balanceVenueId } })
  await prisma.payment.deleteMany({ where: { venueId: balanceVenueId } })
  await prisma.order.deleteMany({ where: { venueId: { in: [ordersVenueId, balanceVenueId] } } })
  await prisma.merchantAccount.deleteMany({ where: { id: merchantId } })
  await prisma.paymentProvider.deleteMany({ where: { id: providerId } })
  await prisma.venue.deleteMany({ where: { id: { in: [ordersVenueId, balanceVenueId] } } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
  await prisma.$disconnect()
})

describe.each(SESSION_ZONES)('with the Postgres session in %s', zone => {
  beforeAll(() => setSessionZone(zone))

  it('generalStats orderScope: the orders on from/to are in, the ones 1 ms outside are out — same rows as Prisma', async () => {
    const [prismaCount, prismaSum] = await Promise.all([
      prisma.order.count({ where: { venueId: ordersVenueId, createdAt: { gte: FROM, lte: TO_ORDERS } } }),
      prisma.order.aggregate({ where: { venueId: ordersVenueId, createdAt: { gte: FROM, lte: TO_ORDERS } }, _sum: { total: true } }),
    ])
    expect(prismaCount).toBe(INSIDE_COUNT)
    expect(Number(prismaSum._sum.total)).toBe(INSIDE_SUM)

    const channels = (await getChartData(ordersVenueId, 'channel-mix', FILTERS)) as Array<{
      channel: string
      revenue: number
      count: number
    }>
    expect(channels).toHaveLength(1)
    expect(channels[0].count).toBe(INSIDE_COUNT)
    expect(round2(channels[0].revenue)).toBe(INSIDE_SUM)
  })

  it('generalStats weekly-trends: the edge orders land on their venue-local weekday with the edge amounts only', async () => {
    const data = (await getChartData(ordersVenueId, 'weekly-trends', FILTERS)) as Array<{ day: string; currentWeek: number }>
    const byDay = new Map(data.map(d => [d.day, round2(d.currentWeek)]))

    // from = Sat 8-mar 18:00 local (amount 1); to = Wed 12-mar 17:59:59.999 local (amount 2).
    // A shifted filter would put 5 on Saturday (1 + the 4 from 1 ms before) and 8
    // on Wednesday (the row 1 ms after `to`) while dropping the real 2.
    expect(byDay.get('Sábado')).toBe(1)
    expect(byDay.get('Miércoles')).toBe(2)
    for (const day of ['Domingo', 'Lunes', 'Martes', 'Jueves', 'Viernes']) {
      expect(byDay.get(day)).toBe(0)
    }
  })

  it('availableBalance cash sums: the payments on from/to count, the ones 1 ms outside do not — same rows as Prisma', async () => {
    const prismaCount = await prisma.payment.count({
      where: { venueId: balanceVenueId, method: 'CASH', createdAt: { gte: FROM, lte: TO_BALANCE } },
    })
    expect(prismaCount).toBe(INSIDE_COUNT)

    const breakdown = await getBalanceByCardType(balanceVenueId, RANGE)
    const cash = breakdown.find(b => b.cardType === 'CASH')!
    expect(cash.transactionCount).toBe(INSIDE_COUNT)
    expect(round2(cash.baseSales)).toBe(INSIDE_SUM)
    expect(round2(cash.settledAmount)).toBe(INSIDE_SUM)

    // getAvailableBalance sums the cash in its own raw query; the four card payments
    // (created inside the range, 150 in total) come through Prisma.
    const summary = await getAvailableBalance(balanceVenueId, RANGE)
    expect(round2(summary.totalSales)).toBe(INSIDE_SUM + CARD_EDGE_NETS.reduce((s, n) => s + n, 0))
  })

  it('availableBalance calendar: estimatedSettlementDate on from/to is in, 1 ms outside is out — same rows as Prisma', async () => {
    const prismaCount = await prisma.venueTransaction.count({
      where: { venueId: balanceVenueId, estimatedSettlementDate: { gte: FROM, lte: TO_BALANCE } },
    })
    expect(prismaCount).toBe(INSIDE_COUNT)

    const calendar = await getSettlementCalendar(balanceVenueId, RANGE)
    // from and to fall on different venue-local days (Sat 8-mar and Sat 15-mar), so
    // two entries. A shifted filter merges the row 1 ms before `from` into the same
    // Saturday (50 instead of 10) and drops the row on `to`.
    expect(calendar).toHaveLength(2)
    expect(calendar.reduce((s, c) => s + c.transactionCount, 0)).toBe(INSIDE_COUNT)
    expect(round2(calendar.reduce((s, c) => s + c.totalNetAmount, 0))).toBe(CARD_INSIDE_NET)
    expect(calendar.map(c => round2(c.totalNetAmount))).toEqual([10, 20])
  })
})
