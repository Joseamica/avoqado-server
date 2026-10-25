import cuid from 'cuid'
import { Prisma, type OrderStatus, type PaymentStatus } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import {
  listRecentSales,
  buildSalesPage,
  fullPageSql,
  WHERE_IS_COPY_SALE,
  recentSalesWindowStart,
} from '@/services/mobile/recentSales.mobile.service'
import { decodeSalesSince, decodeSalesCursor, recentSalesQuerySchema } from '@/schemas/mobile/recentSales.mobile.schema'
import { exchangeDetailFields } from '@/services/exchanges/exchangeDetail'
import { createExchange } from '@/services/exchanges/exchange.service'
import { seedClothingSale } from './seedExchange'
import { seedManySales } from './seedRecentSales'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))
jest.mock('@/services/dashboard/receipt.dashboard.service', () => ({ generateAndStoreReceipt: jest.fn(async () => undefined) }))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn(async () => undefined) }))
jest.setTimeout(90000)

let s: Awaited<ReturnType<typeof seedClothingSale>>
const now = new Date()
const tz = 'America/Mexico_City'
const ws = recentSalesWindowStart(now, tz)
const ago = (days: number) => new Date(now.getTime() - days * 86400000)
const page = (limit = 100, cursor?: string) => listRecentSales({ venueId: s.venueId, limit, cursor, now })
const seed = (count: number, from = ago(1), to = from) =>
  seedManySales({ venueId: s.venueId, staffId: s.staffId, productId: s.products[0].id, count, from, to })

beforeAll(() => {
  const url = new URL(process.env.TEST_DATABASE_URL!)
  expect(['localhost', '127.0.0.1']).toContain(url.hostname)
  expect(url.pathname).toMatch(/^\/avoqado_(?:cambio_(?:fix_|r5_)?test_\d{8}|h1a_test_\d{8}(?:_\d+)?)$/)
})
beforeEach(async () => {
  s = await seedClothingSale({ list: 500, paid: 400, quantity: 2, payments: [400, 400] })
  await prisma.venue.update({ where: { id: s.venueId }, data: { timezone: tz } })
  await prisma.order.update({ where: { id: s.order.id }, data: { createdAt: ago(1) } })
})
afterEach(async () => {
  if (s) await s.cleanup()
})

describe('sales/recent full copy (B)', () => {
  it('returns the last 30 venue days newest first with total and a watermark', async () => {
    const [oldest] = await seed(1, ago(20))
    const [newest] = await seed(1, now)
    const result = await page()
    expect(result.meta).toMatchObject({ mode: 'FULL', reset: false, total: 3, limit: 100, hasMore: false, nextCursor: null })
    expect(result.sales.map(sale => sale.orderId)).toEqual([newest, s.order.id, oldest])
    expect(result.removed).toEqual([])
    expect(decodeSalesSince(result.meta.nextSince)).toEqual({ v: 1, w: now.getTime() - 120000, ws: ws.getTime() })
    expect(result.meta.windowStart).toBe(ws.toISOString())
  })

  it('RB2 paginates seven tied timestamps without gaps and freezes the pass metadata', async () => {
    await prisma.order.update({ where: { id: s.order.id }, data: { paymentStatus: 'PENDING' } })
    const ids = await seed(7)
    const first = await page(3)
    const second = await listRecentSales({ venueId: s.venueId, limit: 3, cursor: first.meta.nextCursor!, now: ago(-2) })
    const third = await page(3, second.meta.nextCursor!)
    expect([...first.sales, ...second.sales, ...third.sales].map(sale => sale.orderId)).toEqual(ids)
    expect([first.meta.hasMore, second.meta.hasMore, third.meta.hasMore]).toEqual([true, true, false])
    expect(second.meta.nextSince).toBe(first.meta.nextSince)
    expect(third.meta.nextSince).toBe(first.meta.nextSince)
    expect(third.meta.total).toBe(7)
  })

  it('RB3 includes windowStart and excludes the preceding millisecond under UTC', async () => {
    const [outside] = await seed(1, new Date(ws.getTime() - 1))
    const [inside] = await seed(1, ws)
    const result = await page()
    expect(result.sales.map(sale => sale.orderId)).toContain(inside)
    expect(result.sales.map(sale => sale.orderId)).not.toContain(outside)
    expect(result.meta.total).toBe(2)
  })

  it('keeps fully returned sales with ALREADY_RETURNED and excludes unpaid, partial, deleted and foreign sales', async () => {
    const ids = await seed(3)
    await prisma.order.update({ where: { id: ids[0] }, data: { paymentStatus: 'PENDING' } })
    await prisma.order.update({ where: { id: ids[1] }, data: { paymentStatus: 'PARTIAL' } })
    await prisma.order.update({ where: { id: ids[2] }, data: { status: 'DELETED' } })
    await prisma.order.update({ where: { id: s.order.id }, data: { paymentStatus: 'REFUNDED' } })
    await prisma.payment.updateMany({ where: { venueId: s.venueId }, data: { status: 'REFUNDED' } })
    await refund(1, 40000, s.payments[0].id)
    await refund(1, 40000)
    const foreign = await seedClothingSale()
    try {
      const result = await page()
      expect(result.sales).toHaveLength(1)
      expect(result.sales[0]).toMatchObject({ orderId: s.order.id, exchangeable: false, notExchangeableReason: 'ALREADY_RETURNED' })
      expect(result.meta.total).toBe(1)
      expect(result.sales[0].lines[0]).toMatchObject({ returnedQtyOrder: 2, remainingQtyOrder: 0 })
    } finally {
      await foreign.cleanup()
    }
  })

  it('RF3 matches A including discounted charged cents and returns through another payment', async () => {
    await refund(1, 40000)
    await prisma.payment.update({
      where: { id: s.payments[1].id },
      data: { tenderLabel: 'Cash counter', tipAmount: 12 },
    })
    const result = (await page()).sales[0]
    const detail = await exchangeDetailFields(prisma, s.venueId, s.payments[0].id)
    const { exchangeable, notExchangeableReason, payoutOptions, exchange } = detail.fields
    const saleFields = { exchangeable, notExchangeableReason, payoutOptions, exchange }
    expect(result).toMatchObject(saleFields)
    expect(result.lines[0]).toMatchObject(detail.itemExtras.get(s.order.items[0].id)!)
    expect(result.lines[0]).toMatchObject({
      quantity: 2,
      chargedTotalCents: 80000,
      returnedQtyOrder: 1,
      remainingQtyOrder: 1,
      trackInventory: true,
      isGiftCardSale: false,
    })
    expect(result.lines[0]).not.toHaveProperty('remainingPieceValuesCents')
    expect(result).toMatchObject({ customer: { id: s.customer.id, name: 'Clienta' }, sellerName: 'Venta Original', totalCents: 80000 })
    for (const payment of result.payments) {
      const fields = (await exchangeDetailFields(prisma, s.venueId, payment.id)).fields
      expect(payment).toMatchObject({
        tenderSystemKind: fields.tenderSystemKind,
        chainRefundMethod: fields.chainRefundMethod,
        chainRefundLabel: fields.chainRefundLabel,
        chainRefundBlockedCode: fields.chainRefundBlockedCode,
        chainRefundBlockedReason: fields.chainRefundBlockedReason,
      })
    }
    expect(result.payments.find(p => p.id === s.payments[1].id)).toMatchObject({
      tenderLabel: 'Cash counter',
      tipCents: 1200,
      remainingRefundableSaleCents: 0,
    })
  })

  it('uses the primary customer and falls back to the legacy customer and creator', async () => {
    const customer = await prisma.customer.create({ data: { venueId: s.venueId, firstName: 'Ana', lastName: 'Pérez' } })
    await prisma.orderCustomer.updateMany({ where: { orderId: s.order.id }, data: { customerId: customer.id } })
    expect((await page()).sales[0].customer).toEqual({ id: customer.id, name: 'Ana Pérez' })
    await prisma.orderCustomer.deleteMany({ where: { orderId: s.order.id } })
    await prisma.order.update({ where: { id: s.order.id }, data: { servedById: null } })
    expect((await page()).sales[0]).toMatchObject({ customer: { id: s.customer.id }, sellerName: 'Venta Original' })
  })

  it('includes both exchange links and resolves the credit payment back to CASH', async () => {
    const { exchange } = await createExchange(s.input())
    const result = await page()
    expect(result.sales.find(sale => sale.orderId === s.order.id)!.exchange).toMatchObject({
      asOriginalTotal: 1,
      asOriginal: [{ exchangeId: exchange.id }],
    })
    const next = result.sales.find(sale => sale.orderId === exchange.newOrderId)!
    expect(next.exchange.asNew).toMatchObject({ exchangeId: exchange.id, originalOrderNumber: s.order.orderNumber })
    expect(next.payments[0]).toMatchObject({ tenderSystemKind: 'EXCHANGE_CREDIT', chainRefundMethod: 'CASH' })
  })

  it('RB5 removes 201 distinct lines without truncating a sale', async () => {
    await overflowLines(s.order.id)
    const result = await page()
    expect(result.sales).toEqual([])
    expect(result.removed).toEqual([s.order.id])
    expect(result.meta.total).toBe(1)
  })

  it('C9 keeps an exchanged sale of 201 pieces grouped into one discounted line', async () => {
    const grouped = await seedClothingSale({ list: 10, paid: 8, quantity: 201 })
    try {
      const { exchange } = await createExchange(
        grouped.input(
          grouped.body({
            returned: [{ orderItemId: grouped.order.items[0].id, quantity: 201, restock: true, reason: 'SIZE' }],
            taken: [{ productId: grouped.products[1].id, quantity: 201, inheritsFromOrderItemId: grouped.order.items[0].id }],
          }),
        ),
      )
      const result = await listRecentSales({ venueId: grouped.venueId, limit: 100, now })
      const sale = result.sales.find(sale => sale.orderId === exchange.newOrderId)!
      expect(sale.lines).toHaveLength(1)
      expect(sale.lines[0]).toMatchObject({ quantity: 201, chargedTotalCents: 160800, remainingQtyOrder: 201 })
      expect(result.removed).not.toContain(exchange.newOrderId)
    } finally {
      await grouped.cleanup()
    }
  })

  it('C14 advances after an entirely removed page using the last consumed SQL candidate', async () => {
    const ids = await seed(3, now)
    await overflowLines(ids[0])
    await overflowLines(ids[1])
    const first = await page(2)
    expect(first.sales).toEqual([])
    expect(first.removed).toEqual(ids.slice(0, 2))
    expect(first.meta.hasMore).toBe(true)
    expect(decodeSalesCursor(first.meta.nextCursor!)!.id).toBe(ids[1])
    const next = await page(2, first.meta.nextCursor!)
    expect(next.sales.map(sale => sale.orderId)).toEqual([ids[2], s.order.id])
    expect(next.meta.hasMore).toBe(false)
  })

  it('removes sales outside the exchange batch size map', async () => {
    await prisma.payment.createMany({
      data: Array.from({ length: 49 }, () => ({
        venueId: s.venueId,
        orderId: s.order.id,
        amount: 0,
        netAmount: 0,
        feeAmount: 0,
        feePercentage: 0,
        method: 'CASH' as const,
        status: 'COMPLETED' as const,
        type: 'REGULAR' as const,
      })),
    })
    const result = await page()
    expect(result.sales).toEqual([])
    expect(result.removed).toEqual([s.order.id])
  })

  it('C10 retains a sale with unavailable settlement as a business refusal', async () => {
    const { exchange } = await createExchange(s.input())
    await prisma.exchangeCreditLink.deleteMany({ where: { venueId: s.venueId, exchangeId: exchange.id } })
    const result = await page()
    expect(result.sales.find(sale => sale.orderId === exchange.newOrderId)).toMatchObject({
      exchangeable: false,
      notExchangeableReason: 'NOT_ATTRIBUTABLE',
    })
    expect(result.removed).not.toContain(exchange.newOrderId)
  })

  it('C10 keeps exactly 50 ancestor orders and retains an oversized scope with its business reason', async () => {
    const { exchange } = await createExchange(s.input())
    const credit = await prisma.payment.findFirstOrThrow({ where: { venueId: s.venueId, orderId: exchange.newOrderId } })
    const rootIds = await seed(49)
    const roots = await prisma.payment.findMany({
      take: 49,
      where: { venueId: s.venueId, orderId: { in: rootIds } },
      orderBy: { id: 'asc' },
    })
    const credits = roots.map(() => cuid())
    await prisma.payment.createMany({
      data: credits.map(id => ({
        id,
        venueId: s.venueId,
        orderId: exchange.newOrderId,
        tenderTypeId: credit.tenderTypeId,
        amount: 0,
        netAmount: 0,
        feeAmount: 0,
        feePercentage: 0,
        method: 'OTHER' as const,
        status: 'COMPLETED' as const,
        type: 'REGULAR' as const,
      })),
    })
    const links = roots.map((root, i) => ({
      id: cuid(),
      venueId: s.venueId,
      exchangeId: exchange.id,
      originPaymentId: root.id,
      creditPaymentId: credits[i],
      creditRefundPaymentId: root.id,
      amount: 0,
    }))
    await prisma.exchangeCreditLink.createMany({ data: links.slice(0, 48) })
    // The unlinked last payment is temporarily outside the completed set.
    await prisma.payment.update({ where: { id: credits[48] }, data: { status: 'PENDING' } })
    expect((await page()).sales.find(sale => sale.orderId === exchange.newOrderId)).toMatchObject({ exchangeable: true })
    await prisma.exchangeCreditLink.create({ data: links[48] })
    await prisma.payment.update({ where: { id: credits[48] }, data: { status: 'COMPLETED' } })
    const result = await page()
    expect(result.sales.find(sale => sale.orderId === exchange.newOrderId)).toMatchObject({
      exchangeable: false,
      notExchangeableReason: 'ORDER_LOCK_SCOPE_TOO_LARGE',
    })
    expect(result.removed).not.toContain(exchange.newOrderId)
  })

  it('RB5 clamps an oversized request through the schema and the service', async () => {
    await seed(100)
    const { query } = recentSalesQuerySchema.parse({ params: { venueId: s.venueId }, query: { limit: '500' } })
    expect(query.limit).toBe(100)
    const result = await page(500)
    expect(result.sales).toHaveLength(100)
    expect(result.meta).toMatchObject({ limit: 100, total: 101, hasMore: true })
  })

  it('returns an empty page with a decodable watermark and performs no assembly reads for no candidates', async () => {
    await prisma.order.update({ where: { id: s.order.id }, data: { paymentStatus: 'PENDING' } })
    const result = await page()
    expect(result.sales).toEqual([])
    expect(result.meta).toMatchObject({ total: 0, hasMore: false, nextCursor: null })
    expect(decodeSalesSince(result.meta.nextSince)).not.toBeNull()
    expect(await buildSalesPage({} as typeof prisma, s.venueId, ws, [], ['expired', 'expired'])).toEqual({
      sales: [],
      removed: ['expired'],
    })
  })

  it('revalidates candidates and keeps sales and removed disjoint when assembly is reused', async () => {
    const [outside] = await seed(1, new Date(ws.getTime() - 1))
    const [deleted] = await seed(1)
    await prisma.order.update({ where: { id: deleted }, data: { status: 'DELETED' } })
    const foreign = await seedClothingSale()
    try {
      const result = await buildSalesPage(
        prisma,
        s.venueId,
        ws,
        [deleted, s.order.id, foreign.order.id, outside],
        ['expired', s.order.id, 'expired'],
      )
      expect(result.sales.map(sale => sale.orderId)).toEqual([s.order.id])
      expect(result.removed).toEqual(['expired', deleted, foreign.order.id, outside])
    } finally {
      await foreign.cleanup()
    }
  })

  it('SQL and Prisma copy predicates agree across order and payment statuses', async () => {
    const cases: Array<[OrderStatus, PaymentStatus, boolean]> = [
      ['PENDING', 'PENDING', false],
      ['CONFIRMED', 'PARTIAL', false],
      ['COMPLETED', 'PAID', true],
      ['COMPLETED', 'REFUNDED', true],
      ['CANCELLED', 'PAID', true],
      ['DELETED', 'PAID', false],
    ]
    for (const [status, paymentStatus, included] of cases) {
      await prisma.order.update({ where: { id: s.order.id }, data: { status, paymentStatus } })
      const sql = await prisma.$queryRaw<Array<{ id: string }>>(
        fullPageSql({ venueId: s.venueId, windowStart: ws, after: null, take: 101 }),
      )
      const orm = await prisma.order.findMany({
        take: 101,
        where: { venueId: s.venueId, createdAt: { gte: ws }, ...WHERE_IS_COPY_SALE },
        select: { id: true },
      })
      expect(sql.map(o => o.id)).toEqual(orm.map(o => o.id))
      expect(sql.some(o => o.id === s.order.id)).toBe(included)
    }
  })

  it('rejects an unreadable cursor and a missing venue', async () => {
    await expect(page(10, 'invalid')).rejects.toMatchObject({ statusCode: 400 })
    await expect(listRecentSales({ venueId: cuid(), limit: 10, now })).rejects.toMatchObject({ statusCode: 404 })
  })
})

async function overflowLines(orderId: string) {
  await prisma.orderItem.createMany({
    data: Array.from({ length: 200 }, () => ({
      orderId,
      productId: s.products[0].id,
      productName: 'Skirt',
      quantity: 1,
      unitPrice: new Prisma.Decimal(1),
      total: new Prisma.Decimal(1),
      taxAmount: new Prisma.Decimal(0),
    })),
  })
}
async function refund(quantity: number, amountCents: number, originalPaymentId = s.payments[1].id) {
  return prisma.payment.create({
    data: {
      venueId: s.venueId,
      orderId: s.order.id,
      amount: new Prisma.Decimal(amountCents).div(100),
      netAmount: new Prisma.Decimal(amountCents).div(100),
      tipAmount: 0,
      feeAmount: 0,
      feePercentage: 0,
      method: 'CASH',
      type: 'REFUND',
      status: 'COMPLETED',
      processorData: {
        originalPaymentId,
        salesRefundCents: amountCents,
        tipRefundCents: 0,
        refundedItems: [{ orderItemId: s.order.items[0].id, quantity, amountCents }],
      },
    },
  })
}
