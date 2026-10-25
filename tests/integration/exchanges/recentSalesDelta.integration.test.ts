import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { listRecentSales, recentSalesWindowStart } from '@/services/mobile/recentSales.mobile.service'
import { decodeSalesCursor, decodeSalesSince, encodeSalesCursor, encodeSalesSince } from '@/schemas/mobile/recentSales.mobile.schema'
import { createExchange } from '@/services/exchanges/exchange.service'
import { issueRefund } from '@/services/dashboard/refund.dashboard.service'
import { updatePayment } from '@/services/dashboard/payment.dashboard.service'
import { payCashOrder, payGiftCardBalanceOnOrder, returnGiftBalanceAndCancelOrder } from '@/services/mobile/order.mobile.service'
import { encryptGiftCardCode, generateGiftCardCode, generateOpaqueToken, hashGiftCardCode } from '@/services/giftCards/giftCardCode'
import { seedClothingSale } from './seedExchange'
import { seedManySales } from './seedRecentSales'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))
jest.mock('@/services/dashboard/receipt.dashboard.service', () => ({ generateAndStoreReceipt: jest.fn(async () => undefined) }))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn(async () => undefined) }))
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({ notifyCustomerPassUpdated: jest.fn(async () => ({ notified: 0 })) }))
jest.setTimeout(90000)

let s: Awaited<ReturnType<typeof seedClothingSale>>
let now: Date
let ws: Date
const tz = 'America/Mexico_City'
const read = (input: { since?: string; cursor?: string; limit?: number; now?: Date } = {}) =>
  listRecentSales({ venueId: s.venueId, limit: 100, now: new Date(Date.now() + 10), ...input })
const full = () => read({ now })
const seed = (count: number, at = now) =>
  seedManySales({ venueId: s.venueId, staffId: s.staffId, productId: s.products[0].id, count, from: at, to: at })

beforeAll(() => {
  expect(['localhost', '127.0.0.1']).toContain(new URL(process.env.TEST_DATABASE_URL!).hostname)
  expect(new URL(process.env.TEST_DATABASE_URL!).pathname).toMatch(/^\/avoqado_(?:cambio_(?:fix_|r5_)?test_\d{8}|h1a_test_\d{8}(?:_\d+)?)$/)
})
beforeEach(async () => {
  s = await seedClothingSale({ list: 500, paid: 400, quantity: 2, payments: [400, 400] })
  now = new Date()
  ws = recentSalesWindowStart(now, tz)
  await prisma.venue.update({ where: { id: s.venueId }, data: { timezone: tz } })
  await prisma.order.update({ where: { id: s.order.id }, data: { createdAt: new Date(now.getTime() - 86400000) } })
  await prisma.payment.updateMany({
    where: { venueId: s.venueId },
    data: { createdAt: new Date(now.getTime() - 86400000), updatedAt: new Date(now.getTime() - 600000) },
  })
})
afterEach(async () => {
  if (s) await s.cleanup()
})

describe('sales/recent delta copy (B)', () => {
  it('brings a sale created after the watermark and excludes untouched and foreign sales', async () => {
    const initial = await full()
    const [id] = await seed(1, new Date())
    const foreign = await seedClothingSale()
    try {
      const result = await read({ since: initial.meta.nextSince })
      expect(result.meta).toMatchObject({ mode: 'DELTA', reset: false, total: 1, hasMore: false, nextCursor: null })
      expect(result.sales.map(sale => sale.orderId)).toEqual([id])
      expect(result.removed).toEqual([])
    } finally {
      await foreign.cleanup()
    }
  })

  it('RF3 brings an item refund through another payment with order-wide quantities and payment-specific money', async () => {
    const initial = await full()
    await issueRefund({
      venueId: s.venueId,
      staffId: s.staffId,
      paymentId: s.payments[1].id,
      reason: 'RETURNED_GOODS',
      items: [{ orderItemId: s.order.items[0].id, quantity: 1 }],
    })
    const result = await read({ since: initial.meta.nextSince })
    expect(result.meta.mode).toBe('DELTA')
    const sale = result.sales.find(sale => sale.orderId === s.order.id)!
    expect(sale.lines[0]).toMatchObject({ returnedQtyOrder: 1, returnedCentsOrder: 40000, remainingQtyOrder: 1 })
    expect(sale.payments.find(p => p.id === s.payments[0].id)!.remainingRefundableSaleCents).toBe(40000)
    expect(sale.payments.find(p => p.id === s.payments[1].id)!.remainingRefundableSaleCents).toBe(0)
  })

  it('C6 keeps historical cross-order monetary refunds separate from order-wide quantities in the delta', async () => {
    const [historicalId] = await seed(1, new Date(ws.getTime() - 1))
    const historicalPayment = await prisma.payment.findFirstOrThrow({ where: { venueId: s.venueId, orderId: historicalId } })
    const initial = await full()
    await refund(historicalId, s.payments[0].id, 10000, 'COMPLETED')
    await refund(s.order.id, historicalPayment.id, 10000, 'PENDING')
    const result = await read({ since: initial.meta.nextSince })
    expect(result.meta.mode).toBe('DELTA')
    const sale = result.sales.find(sale => sale.orderId === s.order.id)!
    expect(sale.payments.find(p => p.id === s.payments[0].id)!.remainingRefundableSaleCents).toBe(30000)
    expect(sale.payments.find(p => p.id === s.payments[1].id)!.remainingRefundableSaleCents).toBe(40000)
    expect(sale.lines[0]).toMatchObject({ returnedQtyOrder: 1, returnedCentsOrder: 10000, remainingQtyOrder: 1 })
    expect(result.removed).toContain(historicalId)
  })

  it('brings both sales of a real exchange with their original and new links', async () => {
    const initial = await full()
    const { exchange } = await createExchange(s.input())
    const result = await read({ since: initial.meta.nextSince })
    expect(result.meta.mode).toBe('DELTA')
    expect(result.sales.map(sale => sale.orderId).sort()).toEqual([s.order.id, exchange.newOrderId].sort())
    expect(result.sales.find(sale => sale.orderId === s.order.id)!.exchange).toMatchObject({
      asOriginalTotal: 1,
      asOriginal: [{ exchangeId: exchange.id }],
    })
    expect(result.sales.find(sale => sale.orderId === exchange.newOrderId)!.exchange.asNew).toMatchObject({ exchangeId: exchange.id })
    expect(result.removed).toEqual([])
  })

  it('brings both sales when only the exchange state changed after the watermark', async () => {
    const { exchange } = await createExchange(s.input())
    const initial = await full()
    await prisma.payment.updateMany({ where: { venueId: s.venueId }, data: { updatedAt: new Date(now.getTime() - 600000) } })
    await prisma.exchange.update({ where: { id: exchange.id }, data: { status: 'NEEDS_REVIEW' } })
    const result = await read({ since: initial.meta.nextSince })
    expect(result.meta).toMatchObject({ mode: 'DELTA', total: 2 })
    expect(result.sales.map(sale => sale.orderId).sort()).toEqual([s.order.id, exchange.newOrderId].sort())
    expect(result.sales.find(sale => sale.orderId === s.order.id)!.exchange.asOriginal[0]).toMatchObject({ status: 'NEEDS_REVIEW' })
  })

  it('removes a partial gift-balance sale cancelled with its real refunds', async () => {
    await prisma.payment.deleteMany({ where: { venueId: s.venueId } })
    await prisma.order.update({
      where: { id: s.order.id },
      data: { status: 'CONFIRMED', paymentStatus: 'PENDING', paidAmount: 0, remainingBalance: 800 },
    })
    const code = generateGiftCardCode()
    const card = await prisma.giftCard.create({
      data: {
        venueId: s.venueId,
        organizationId: s.organizationId,
        codeHash: hashGiftCardCode(code.normalized),
        codeEnc: encryptGiftCardCode(code.normalized),
        codeLast4: code.last4,
        pageToken: generateOpaqueToken(),
        initialAmount: 800,
        balance: 800,
        status: 'ACTIVE',
        activatedAt: new Date(),
        termsVersion: '2026-10-14',
        deliveryChannel: 'PRINTED',
      },
    })
    await prisma.giftCardActivity.create({
      data: { giftCardId: card.id, venueId: s.venueId, type: 'ACTIVATE', amount: 800, balanceAfter: 800 },
    })
    await payGiftCardBalanceOnOrder(s.venueId, s.order.id, {
      idempotencyKey: `${s.venueId}-gift`,
      proof: { kind: 'CODE', code: code.display },
      amount: new Prisma.Decimal(400),
      tip: new Prisma.Decimal(0),
      staffId: s.staffId,
      deviceId: null,
    })
    const initial = await full()
    expect(initial.sales).toEqual([])
    await returnGiftBalanceAndCancelOrder(s.venueId, s.order.id, { staffId: s.staffId, operationKey: `${s.venueId}-cancel` })
    const result = await read({ since: initial.meta.nextSince })
    expect(result.meta.mode).toBe('DELTA')
    expect(result.sales).toEqual([])
    expect(result.removed).toEqual([s.order.id])
    expect(await prisma.order.findUniqueOrThrow({ where: { id: s.order.id } })).toMatchObject({ status: 'CANCELLED' })
    expect(await prisma.payment.count({ where: { venueId: s.venueId, type: 'REFUND' } })).toBe(1)
  })

  it('keeps the existing rejection of cancelling an already paid sale through gift-balance cancellation', async () => {
    await expect(
      returnGiftBalanceAndCancelOrder(s.venueId, s.order.id, { staffId: s.staffId, operationKey: `${s.venueId}-cancel` }),
    ).rejects.toMatchObject({ code: 'GIFT_CARD_TENDER_NOT_ALLOWED' })
    expect(await prisma.payment.count({ where: { venueId: s.venueId, type: 'REFUND' } })).toBe(0)
  })

  it('brings a previously partial sale after a new cash payment makes it PAID', async () => {
    await prisma.payment.updateMany({ where: { venueId: s.venueId }, data: { amount: 200, netAmount: 200 } })
    await prisma.order.update({
      where: { id: s.order.id },
      data: { status: 'CONFIRMED', paymentStatus: 'PARTIAL', paidAmount: 400, remainingBalance: 400 },
    })
    const initial = await full()
    expect(initial.sales).toEqual([])
    await payCashOrder(s.venueId, s.order.id, { amount: 40000, tip: 0, staffId: s.staffId, idempotencyKey: `${s.venueId}-cash` })
    const result = await read({ since: initial.meta.nextSince })
    expect(result.meta.mode).toBe('DELTA')
    expect(result.sales[0]).toMatchObject({ orderId: s.order.id, paymentStatus: 'PAID' })
    expect(result.sales[0].payments).toHaveLength(3)
  })

  it('C11/C12 selects an existing capture promoted from PENDING to COMPLETED by updatedAt', async () => {
    await prisma.payment.updateMany({
      where: { venueId: s.venueId },
      data: { status: 'PENDING', updatedAt: new Date(now.getTime() - 600000) },
    })
    const initial = await full()
    const count = await prisma.payment.count({ where: { venueId: s.venueId } })
    // Exercise the persisted capture transition, not the bookkeeping PUT (which cannot capture).
    await prisma.payment.update({ where: { id: s.payments[0].id }, data: { status: 'COMPLETED' } })
    const result = await read({ since: initial.meta.nextSince })
    expect(result.meta).toMatchObject({ mode: 'DELTA', total: 1 })
    expect(result.sales[0].payments.map(p => p.id)).toEqual([s.payments[0].id])
    expect(await prisma.payment.count({ where: { venueId: s.venueId } })).toBe(count)
  })

  it('C12 still rejects an amount edit on a completed payment', async () => {
    await expect(updatePayment(s.venueId, s.payments[0].id, { amount: 399 })).rejects.toMatchObject({ code: 'PAYMENT_SETTLED_USE_REFUND' })
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: s.payments[0].id } })).amount.toFixed(2)).toBe('400.00')
  })

  it('C13 removes a sale leaving the venue window when midnight advances it by one day', async () => {
    const midnight = new Date(ws.getTime() + 29 * 86400000)
    const before = new Date(midnight.getTime() - 1)
    const [expired] = await seed(1, new Date(ws.getTime() - 1))
    const initial = await read({ now: before })
    expect(initial.sales.map(sale => sale.orderId)).toContain(expired)
    const result = await read({ since: initial.meta.nextSince, now: midnight })
    expect(result.meta).toMatchObject({ mode: 'DELTA', total: 1, windowStart: ws.toISOString() })
    expect(result.sales).toEqual([])
    expect(result.removed).toEqual([expired])
  })

  it('RB1 includes a late committed event inside the 120-second overlap but not one 200 seconds old', async () => {
    const initial = await full()
    const [late] = await seed(1, new Date(now.getTime() - 30000))
    const [tooOld] = await seed(1, new Date(now.getTime() - 200000))
    const result = await read({ since: initial.meta.nextSince })
    expect(result.meta).toMatchObject({ mode: 'DELTA', total: 1 })
    expect(result.sales.map(sale => sale.orderId)).toEqual([late])
    expect(result.sales.map(sale => sale.orderId)).not.toContain(tooOld)
  })

  it('C13 excludes a one-millisecond future accounting event until the next pass', async () => {
    const initial = await full()
    const [ahead] = await seed(1, new Date(now.getTime() + 1))
    const first = await read({ since: initial.meta.nextSince, now })
    expect(first.meta).toMatchObject({ mode: 'DELTA', total: 0 })
    expect(first.sales).toEqual([])
    const next = await read({ since: first.meta.nextSince, now: new Date(now.getTime() + 2) })
    expect(next.sales.map(sale => sale.orderId)).toEqual([ahead])
    expect(next.meta.total).toBe(1)
  })

  it('puts a refunded sale older than the window in removed without bringing it back', async () => {
    await prisma.order.update({ where: { id: s.order.id }, data: { createdAt: new Date(ws.getTime() - 1) } })
    const initial = await full()
    await issueRefund({ venueId: s.venueId, staffId: s.staffId, paymentId: s.payments[0].id, reason: 'RETURNED_GOODS', amount: 10000 })
    const result = await read({ since: initial.meta.nextSince })
    expect(result.meta.mode).toBe('DELTA')
    expect(result.sales).toEqual([])
    expect(result.removed).toEqual([s.order.id])
  })

  it('paginates five tied events in three pages with a frozen watermark, total and window', async () => {
    const initial = await full()
    const ids = await seed(5, new Date(now.getTime() - 1))
    const first = await read({ since: initial.meta.nextSince, limit: 2, now })
    const second = await read({ cursor: first.meta.nextCursor!, limit: 2, now: new Date(now.getTime() + 86400000) })
    const third = await read({ cursor: second.meta.nextCursor!, limit: 2 })
    expect([...first.sales, ...second.sales, ...third.sales].map(sale => sale.orderId).sort()).toEqual(ids.sort())
    expect([first.meta.hasMore, second.meta.hasMore, third.meta.hasMore]).toEqual([true, true, false])
    for (const p of [first, second, third]) {
      expect(p.meta).toMatchObject({ mode: 'DELTA', total: 5, nextSince: first.meta.nextSince, windowStart: ws.toISOString() })
      expect(p.sales.length + p.removed.length).toBeLessThanOrEqual(2)
    }
    expect(third.meta.nextCursor).toBeNull()
  })

  it('C14 advances from an entirely removed page using the last SQL event, not the last sale', async () => {
    const initial = await full()
    const ids = await seed(3, new Date(now.getTime() - 1))
    const payments = await prisma.payment.findMany({ take: 3, where: { venueId: s.venueId, orderId: { in: ids } }, orderBy: { id: 'asc' } })
    await prisma.order.updateMany({
      where: { venueId: s.venueId, id: { in: payments.slice(0, 2).map(p => p.orderId) } },
      data: { status: 'DELETED' },
    })
    const first = await read({ since: initial.meta.nextSince, limit: 2 })
    expect(first.sales).toEqual([])
    expect(first.removed).toEqual(payments.slice(0, 2).map(p => p.orderId))
    expect(first.meta.hasMore).toBe(true)
    expect(decodeSalesCursor(first.meta.nextCursor!)!.id).toBe(payments[1].id)
    const next = await read({ cursor: first.meta.nextCursor!, limit: 2 })
    expect(next.sales.map(sale => sale.orderId)).toEqual([payments[2].orderId])
    expect(next.meta).toMatchObject({ hasMore: false, total: 3 })
  })

  it('C10 removes oversized copies and keeps business refusals with the same policy as FULL', async () => {
    const initial = await full()
    const [oversized] = await seed(1, new Date(now.getTime() - 1))
    await prisma.orderItem.createMany({
      data: Array.from({ length: 200 }, () => ({
        orderId: oversized,
        productId: s.products[0].id,
        productName: 'Skirt',
        quantity: 1,
        unitPrice: 1,
        total: 1,
        taxAmount: 0,
      })),
    })
    await prisma.order.update({ where: { id: s.order.id }, data: { source: 'RAPPI' } })
    await prisma.payment.update({ where: { id: s.payments[0].id }, data: { updatedAt: new Date(now.getTime() - 1) } })
    const result = await read({ since: initial.meta.nextSince })
    const complete = await read()
    expect(result.meta.mode).toBe('DELTA')
    expect(result.removed).toEqual([oversized])
    expect(result.sales[0]).toMatchObject({ orderId: s.order.id, exchangeable: false })
    expect(result.sales[0]).toEqual(complete.sales.find(sale => sale.orderId === s.order.id))
    expect(result.sales.some(sale => result.removed.includes(sale.orderId))).toBe(false)
  })

  it('clamps a hostile limit to 100 events and keeps the total independently of the page', async () => {
    const initial = await full()
    await seed(101, new Date(now.getTime() - 1))
    const result = await read({ since: initial.meta.nextSince, limit: 500 })
    expect(result.meta).toMatchObject({ mode: 'DELTA', limit: 100, total: 101, hasMore: true })
    expect(result.sales).toHaveLength(100)
    const next = await read({ cursor: result.meta.nextCursor! })
    expect(next.sales).toHaveLength(1)
    expect(next.meta).toMatchObject({ total: 101, hasMore: false })
  })

  it.each([
    ['older than seven days', () => ({ v: 1, w: now.getTime() - 7 * 86400000 - 1, ws: ws.getTime() })],
    ['from copy version zero', () => ({ v: 0, w: now.getTime(), ws: ws.getTime() })],
    ['from ten minutes in the future', () => ({ v: 1, w: now.getTime() + 600000, ws: ws.getTime() })],
    ['with a later window', () => ({ v: 1, w: now.getTime(), ws: ws.getTime() + 86400000 })],
  ] as const)('RB4 resets a watermark %s to the first FULL page', async (_name, token) => {
    const result = await read({ since: encodeSalesSince(token()), now, limit: 1 })
    expect(result.meta).toMatchObject({ mode: 'FULL', reset: true, total: 1 })
    expect(result.sales.map(sale => sale.orderId)).toEqual([s.order.id])
  })

  it('RB4 resets a malformed watermark and rejects an invalid delta cursor date', async () => {
    expect((await read({ since: 'not-a-token' })).meta).toMatchObject({ mode: 'FULL', reset: true })
    const cursor = encodeSalesCursor({
      v: 1,
      m: 'D',
      t0: now.getTime(),
      ws: ws.getTime(),
      w: 1e20,
      ws0: ws.getTime(),
      total: 1,
      at: now.getTime(),
      id: 'id',
    })
    await expect(read({ cursor })).rejects.toMatchObject({ statusCode: 400 })
  })

  it('accepts the exact maximum age and future-skew boundaries and returns an empty delta', async () => {
    for (const w of [now.getTime() - 7 * 86400000, now.getTime() + 300000]) {
      const result = await read({ since: encodeSalesSince({ v: 1, w, ws: ws.getTime() }), now })
      expect(result.meta.mode).toBe('DELTA')
    }
    const result = await read({ since: (await full()).meta.nextSince })
    expect(result.meta).toMatchObject({ mode: 'DELTA', total: 0, hasMore: false, nextCursor: null })
    expect(result.sales).toEqual([])
    expect(decodeSalesSince(result.meta.nextSince)).not.toBeNull()
  })
})

async function refund(orderId: string, originalPaymentId: string, cents: number, status: 'COMPLETED' | 'PENDING') {
  return prisma.payment.create({
    data: {
      venueId: s.venueId,
      orderId,
      amount: new Prisma.Decimal(cents).div(100).neg(),
      netAmount: new Prisma.Decimal(cents).div(100).neg(),
      feeAmount: 0,
      feePercentage: 0,
      method: 'CASH',
      type: 'REFUND',
      status,
      processorData: {
        originalPaymentId,
        salesRefundCents: cents,
        tipRefundCents: 0,
        refundedItems: [{ orderItemId: s.order.items[0].id, quantity: 1, amountCents: cents }],
      },
    },
  })
}
