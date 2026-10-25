import cuid from 'cuid'
import { Client } from 'pg'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { listRecentSales, fullPageSql, deltaEventsSql, recentSalesWindowStart } from '@/services/mobile/recentSales.mobile.service'
import { encodeSalesCursor, encodeSalesSince } from '@/schemas/mobile/recentSales.mobile.schema'
import { ensureExchangeCreditTender } from '@/services/exchanges/exchangeCreditTender'
import { seedClothingSale } from './seedExchange'
import { seedManySales } from './seedRecentSales'
import { clienteQueCuenta } from './contarConsultas'

jest.setTimeout(120000)

const counter = clienteQueCuenta()
const captured: Prisma.QueryEvent[] = []
counter.db.$on('query' as never, (event: Prisma.QueryEvent) => captured.push(event))
const pg = new Client({ connectionString: process.env.TEST_DATABASE_URL })
const day = 86400000
// Midday leaves room for an hour of events, independently of the CI wall clock.
const now = new Date(new Date().toISOString().slice(0, 10) + 'T18:00:00.000Z')
const windowStart = recentSalesWindowStart(now, 'America/Mexico_City')
const since = new Date(now.getTime() - 3600000)
const previousWindowStart = new Date(windowStart.getTime() - day)
let s: Awaited<ReturnType<typeof seedClothingSale>>
let ids: string[]
let at20000: Date
let lastExitId: string
let suiteStarted: number

type Plan = { 'Node Type': string; 'Relation Name'?: string; Plans?: Plan[] }
type Explained = { Plan: Plan; 'Execution Time': number }
const scans = (plan: Plan): string[] => [
  ...(plan['Node Type'] === 'Seq Scan' && ['Order', 'Payment'].includes(plan['Relation Name'] ?? '') ? [plan['Relation Name']!] : []),
  ...(plan.Plans ?? []).flatMap(scans),
]

async function explain(label: string, sql: string, values: unknown[]): Promise<Explained> {
  // Prisma query events unwrap JSON strings; pg needs their JSON wire representation for replay.
  for (const match of sql.matchAll(/::jsonb\s*=\s*\$(\d+)/g)) {
    const index = Number(match[1]) - 1
    values[index] = JSON.stringify(values[index])
  }
  const result = await pg.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, values)
  const plan = result.rows[0]['QUERY PLAN'][0] as Explained
  console.log('MEDICIÓN local', label, JSON.stringify({ sql, values, ms: plan['Execution Time'], plan }))
  return plan
}

beforeAll(async () => {
  suiteStarted = performance.now()
  expect(['localhost', '127.0.0.1']).toContain(new URL(process.env.TEST_DATABASE_URL!).hostname)
  expect(new URL(process.env.TEST_DATABASE_URL!).pathname).toMatch(/^\/avoqado_(?:cambio_(?:fix_|r5_)?test_\d{8}|h1a_test_\d{8}(?:_\d+)?)$/)
  await pg.connect()
  const index = await pg.query(`SELECT i.indisvalid, i.indisready, pg_get_indexdef(i.indexrelid) AS definition
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = 'Payment_venueId_updatedAt_idx'`)
  console.log('MEDICIÓN local index', index.rows)
  expect(index.rows).toEqual([
    expect.objectContaining({ indisvalid: true, indisready: true, definition: expect.stringContaining('("venueId", "updatedAt")') }),
  ])
  s = await seedClothingSale()
  await prisma.venue.update({ where: { id: s.venueId }, data: { timezone: 'America/Mexico_City' } })
  await prisma.order.update({ where: { id: s.order.id }, data: { createdAt: new Date(previousWindowStart.getTime() - day) } })
  await prisma.payment.updateMany({
    where: { venueId: s.venueId },
    data: { createdAt: new Date(previousWindowStart.getTime() - day), updatedAt: new Date(previousWindowStart.getTime() - day) },
  })
  ids = []
  for (let d = -1; d < 30; d++) {
    const from = new Date(windowStart.getTime() + d * day)
    const to = new Date(Math.min(from.getTime() + day - 1, since.getTime() - 1))
    const batch = await seedManySales({ venueId: s.venueId, staffId: s.staffId, productId: s.products[0].id, count: 1000, from, to })
    if (d >= 0) ids.unshift(...batch)
    else lastExitId = batch[0]
  }
  at20000 = (await prisma.order.findUniqueOrThrow({ where: { id: ids[19999] }, select: { createdAt: true } })).createdAt
  const payments = await prisma.payment.findMany({ take: 300, where: { venueId: s.venueId, orderId: { in: ids.slice(0, 300) } } })
  const items = (
    await pg.query<{ id: string; orderId: string }>(
      `
    SELECT l.id, l."orderId" FROM "Order" o
    JOIN LATERAL (SELECT id, "orderId" FROM "OrderItem" WHERE "orderId" = o.id LIMIT 1) l ON true
    WHERE o."venueId" = $1 AND o.id = ANY($2::text[]) LIMIT 300`,
      [s.venueId, ids.slice(0, 300)],
    )
  ).rows
  const paymentByOrder = new Map(payments.map(p => [p.orderId, p]))
  const itemByOrder = new Map(items.map(i => [i.orderId, i]))
  const refundIds = Array.from({ length: 300 }, () => cuid())
  await prisma.payment.createMany({
    data: ids.slice(0, 300).map((id, i) => ({
      id: refundIds[i],
      venueId: s.venueId,
      orderId: id,
      amount: new Prisma.Decimal(10),
      netAmount: new Prisma.Decimal(10),
      feeAmount: new Prisma.Decimal(0),
      feePercentage: new Prisma.Decimal(0),
      method: 'CASH',
      source: 'POS',
      type: 'REFUND',
      status: 'COMPLETED',
      createdAt: new Date(since.getTime() + i * 1000),
      updatedAt: new Date(since.getTime() + i * 1000),
      processorData: {
        originalPaymentId: paymentByOrder.get(id)!.id,
        salesRefundCents: 1000,
        tipRefundCents: 0,
        refundedItems: [{ orderItemId: itemByOrder.get(id)!.id, quantity: 1, amountCents: 1000 }],
      },
    })),
  })
  const tender = await ensureExchangeCreditTender(prisma, s.venueId)
  await prisma.payment.updateMany({
    where: { venueId: s.venueId, id: { in: ids.slice(0, 40).map(id => paymentByOrder.get(id)!.id) } },
    data: {
      tenderTypeId: tender.id,
      method: 'OTHER',
      fundsFlow: 'EXTERNAL_RECORDED',
      createdAt: new Date(since.getTime() - 1),
      updatedAt: new Date(since.getTime() - 1),
    },
  })
  const exchangeIds = Array.from({ length: 40 }, () => cuid())
  await prisma.exchange.createMany({
    data: exchangeIds.map((id, i) => ({
      id,
      venueId: s.venueId,
      originalOrderId: ids[i + 40],
      newOrderId: ids[i],
      originalPaymentId: paymentByOrder.get(ids[i + 40])!.id,
      idempotencyKey: id,
      requestHash: 'capacity-fixture',
      status: 'COMPLETED',
      returnedAmount: new Prisma.Decimal(100),
      takenAmount: new Prisma.Decimal(100),
      differenceAmount: new Prisma.Decimal(0),
      settlementKind: 'EVEN',
      lines: {},
      staffId: s.staffId,
      createdAt: new Date(since.getTime() + 600000 + i * 1000),
      updatedAt: new Date(since.getTime() + 600000 + i * 1000),
    })),
  })
  await prisma.exchangeCreditLink.createMany({
    data: exchangeIds.map((exchangeId, i) => ({
      id: cuid(),
      venueId: s.venueId,
      exchangeId,
      originPaymentId: paymentByOrder.get(ids[i + 40])!.id,
      creditPaymentId: paymentByOrder.get(ids[i])!.id,
      creditRefundPaymentId: refundIds[i + 40],
      amount: new Prisma.Decimal(100),
      createdAt: new Date(since.getTime() + 600000 + i * 1000),
    })),
  })
  const groupedId = ids[80]
  await prisma.orderItem.updateMany({
    where: { orderId: groupedId, order: { venueId: s.venueId } },
    data: { quantity: 201, unitPrice: new Prisma.Decimal(8), total: new Prisma.Decimal(1608) },
  })
  await prisma.order.update({ where: { id: groupedId }, data: { subtotal: new Prisma.Decimal(1608), total: new Prisma.Decimal(1608) } })
  const groupedPayment = paymentByOrder.get(groupedId)!
  await prisma.payment.update({
    where: { id: groupedPayment.id },
    data: { amount: new Prisma.Decimal(1608), netAmount: new Prisma.Decimal(1608), updatedAt: groupedPayment.createdAt },
  })
  await pg.query('ANALYZE "Order", "Payment", "Exchange", "ExchangeCreditLink"')
  console.log('MEDICIÓN local seed ms', performance.now() - suiteStarted)
})

afterAll(async () => {
  await counter.cerrar()
  await pg.end()
  if (s?.venueId) await s.cleanup()
  console.log('MEDICIÓN local complete test ms (seed + assertions + cleanup)', performance.now() - suiteStarted)
})

describe('sales/recent at 30 days × 1,000 sales a day (B)', () => {
  it('uses indexed full and updatedAt delta SELECT and COUNT plans', async () => {
    const full = { venueId: s.venueId, windowStart, after: { at: at20000, id: ids[19999] }, take: 101 }
    const delta = { venueId: s.venueId, since, previousWindowStart, windowStart, until: now, after: null, take: 101 }
    const plans: Explained[] = []
    for (const [label, sql] of [
      ['full at sale 20000', fullPageSql(full)],
      ['delta SELECT updatedAt', deltaEventsSql(delta)],
      ['delta COUNT updatedAt', deltaEventsSql({ ...delta, take: null })],
    ] as const)
      plans.push(await explain(label, sql.text, sql.values))
    for (const plan of plans) {
      expect(scans(plan.Plan)).toEqual([])
      expect(JSON.stringify(plan)).toMatch(/Index/)
      expect(plan['Execution Time']).toBeLessThanOrEqual(300)
    }
    const count = fullPageSql({ venueId: s.venueId, windowStart, after: null, take: null })
    let indexedCount: Explained
    await pg.query('BEGIN')
    try {
      await pg.query('SET LOCAL enable_seqscan = off')
      indexedCount = await explain('FULL COUNT indexed alternative', count.text, count.values)
    } finally {
      await pg.query('ROLLBACK')
    }
    const usesOrderIndex = (plan: Plan): boolean =>
      (plan['Relation Name'] === 'Order' && ['Index Scan', 'Index Only Scan', 'Bitmap Heap Scan'].includes(plan['Node Type'])) ||
      (plan.Plans ?? []).some(usesOrderIndex)
    expect(usesOrderIndex(indexedCount.Plan)).toBe(true)
    expect(scans(indexedCount.Plan)).toEqual([])
    expect(indexedCount['Execution Time']).toBeLessThanOrEqual(300)
  })

  it('keeps SQL constant from one occupied sale to 100 and measures every actual statement', async () => {
    const read = async (label: string, input: { limit: number; cursor?: string; since?: string }) => {
      counter.reiniciar()
      captured.length = 0
      const started = performance.now()
      const result = await listRecentSales({ venueId: s.venueId, now, ...input }, counter.db)
      const queries = [...captured]
      console.log('MEDICIÓN local page', label, {
        ms: performance.now() - started,
        statements: counter.consultas(),
        total: result.meta.total,
        statementMs: queries.map(query => query.duration),
      })
      return { result, queries }
    }
    const one = await read('FULL 1', { limit: 1 })
    const hundred = await read('FULL 100', { limit: 100 })
    const deep = await read('FULL at sale 20000', {
      limit: 100,
      cursor: encodeSalesCursor({
        v: 1,
        m: 'F',
        t0: now.getTime(),
        ws: windowStart.getTime(),
        w: null,
        ws0: null,
        total: 30000,
        at: at20000.getTime(),
        id: ids[19999],
      }),
    })
    const delta = await read('DELTA 1h + 1 day exits', {
      limit: 100,
      since: encodeSalesSince({ v: 1, w: since.getTime(), ws: previousWindowStart.getTime() }),
    })
    const deltaSales = await read('DELTA after exits (100 refund events)', {
      limit: 100,
      cursor: encodeSalesCursor({
        v: 1,
        m: 'D',
        t0: now.getTime(),
        ws: windowStart.getTime(),
        w: since.getTime(),
        ws0: previousWindowStart.getTime(),
        total: 1380,
        at: windowStart.getTime() - 1,
        id: lastExitId,
      }),
    })
    expect(one.result.sales.map(sale => sale.orderId)).toEqual(ids.slice(0, 1))
    expect(hundred.result.sales.map(sale => sale.orderId)).toEqual(ids.slice(0, 100))
    expect(hundred.result.meta.total).toBe(30000)
    expect(hundred.result.sales[0].payments[0]).toMatchObject({ tenderSystemKind: 'EXCHANGE_CREDIT', chainRefundMethod: 'CASH' })
    expect(hundred.result.sales[0].exchange.asNew).not.toBeNull()
    expect(hundred.result.sales[40].exchange.asOriginalTotal).toBe(1)
    expect(hundred.result.sales[80].lines[0]).toMatchObject({ quantity: 201, returnedQtyOrder: 1, remainingQtyOrder: 200 })
    expect(deep.result.sales.map(sale => sale.orderId)).toEqual(ids.slice(20000, 20100))
    expect(delta.result.meta).toMatchObject({ mode: 'DELTA', total: 1380, hasMore: true })
    expect(delta.result.removed).toHaveLength(100)
    expect(deltaSales.result.sales.map(sale => sale.orderId)).toEqual(ids.slice(0, 100))
    expect(deltaSales.result.removed).toEqual([])
    const plans: Explained[] = []
    const fullCount = fullPageSql({ venueId: s.venueId, windowStart, after: null, take: null })
    let fullCountPlans = 0
    for (const [i, event] of hundred.queries.entries()) {
      console.log('MEDICIÓN local statement', i + 1, { ms: event.duration, sql: event.query, params: event.params })
      if (/^\s*(SELECT|WITH)\b/i.test(event.query)) {
        const plan = await explain(`page100 statement ${i + 1}`, event.query, JSON.parse(event.params))
        if (event.query === fullCount.text) {
          // This fixture owns almost all Order rows, so scanning its FULL COUNT is optimal; production venues own a fraction.
          fullCountPlans++
          expect(plan['Execution Time']).toBeLessThanOrEqual(300)
        } else plans.push(plan)
      }
    }
    expect(fullCountPlans).toBe(1)
    expect(hundred.queries.length).toBe(one.queries.length)
    for (const page of [one, hundred, deep, delta, deltaSales]) {
      expect(page.queries.length).toBeLessThanOrEqual(40)
      expect(Math.max(...page.queries.map(q => q.duration))).toBeLessThanOrEqual(300)
    }
    for (const plan of plans) {
      expect(scans(plan.Plan)).toEqual([])
      expect(plan['Execution Time']).toBeLessThanOrEqual(300)
    }
  })
})
