import prisma from '@/utils/prismaClient'
import { createExchange, completeExchange, cancelExchange, settleExchangeCharge } from '@/services/exchanges/exchange.service'
import { issueRefund } from '@/services/dashboard/refund.dashboard.service'
import { settleCustomerBalance } from '@/services/dashboard/customer.dashboard.service'
import { seedCardSale } from './seedExchange'
import { barreraDeFila } from '../commission/_mundoComisiones'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))
jest.mock('@/services/dashboard/receipt.dashboard.service', () => ({ generateAndStoreReceipt: jest.fn(async () => undefined) }))
jest.setTimeout(90000)
let s: Awaited<ReturnType<typeof seedCardSale>>
beforeAll(() =>
  expect(new URL(process.env.TEST_DATABASE_URL!).pathname).toMatch(
    /^\/avoqado_(?:cambio_(?:fix_|r5_)?test_\d{8}|h1a_test_\d{8}(?:_\d+)?)$/,
  ),
)
afterEach(async () => {
  if (s) await s.cleanup()
})
const close = (id: string) => completeExchange({ venueId: s.venueId, exchangeId: id, actorStaffId: s.staffId })

it.each([false, true])('serializes cancel against terminal registration with a real Order wait (charge first=%s)', async chargeFirst => {
  const { exchange: e } = await reserve()
  const barrier = await barreraDeFila('Order', e.newOrderId)
  const cancelling = () => cancelExchange({ venueId: s.venueId, exchangeId: e.id, actorStaffId: s.staffId, origin: 'POS' })
  const charging = () => s.terminalCharge(e.newOrderId, 10000)
  const first = Promise.allSettled([chargeFirst ? charging() : cancelling()])
  let second: ReturnType<typeof Promise.allSettled> | undefined
  try {
    await barrier.esperarA(1)
    second = Promise.allSettled([chargeFirst ? cancelling() : charging()])
    await barrier.esperarA(2)
  } finally {
    await barrier.soltar()
  }
  const results = [...(await first), ...(await second!)]
  expect(results.map(r => (r.status === 'rejected' ? String(r.reason) : '')).join(' ')).not.toMatch(/40P01|deadlock/i)
  const cancelled = results[chargeFirst ? 1 : 0]
  const charged = results[chargeFirst ? 0 : 1]
  expect(charged.status).toBe('fulfilled')
  if (cancelled.status === 'rejected') expect(cancelled.reason).toMatchObject({ code: 'EXCHANGE_CHARGE_EXISTS' })
  await settleExchangeCharge({ venueId: s.venueId, exchangeId: e.id, actorStaffId: null })
  const exchange = await prisma.exchange.findUniqueOrThrow({ where: { id: e.id } })
  if (cancelled.status === 'fulfilled') {
    expect(exchange).toMatchObject({ status: 'NEEDS_REVIEW', reviewReason: 'LATE_CHARGE_AFTER_RELEASE' })
    expect(await prisma.order.findUnique({ where: { id: e.newOrderId } })).toMatchObject({ status: 'CANCELLED' })
    expect(await prisma.inventoryPosting.count({ where: { venueId: s.venueId } })).toBe(0)
  } else expect(exchange.status).toBe('COMPLETED')
})
async function reserve(chain = false) {
  s = await seedCardSale({ provider: 'BLUMON', amounts: [700] })
  await prisma.orderItem.update({ where: { id: s.order.items[0].id }, data: { quantity: 2, unitPrice: 350 } })
  await prisma.payment.update({
    where: { id: s.payments[0].id },
    data: { method: 'CASH', fundsFlow: 'CASH_DRAWER', merchantAccountId: null },
  })
  await prisma.product.updateMany({ where: { venueId: s.venueId }, data: { price: 350 } })
  let paymentId = s.payments[0].id,
    itemId = s.order.items[0].id
  if (chain)
    for (const product of s.products.slice(1, 3)) {
      const { exchange } = await createExchange(
        s.input(
          s.body({
            originalPaymentId: paymentId,
            returned: [{ orderItemId: itemId, quantity: 1, restock: true, reason: 'SIZE' }],
            taken: [{ productId: product.id, quantity: 1 }],
          }),
        ),
      )
      paymentId = exchange.paymentIds[0]
      itemId = exchange.lines.taken[0].newOrderItemIds[0]
    }
  await prisma.product.update({ where: { id: s.products[3].id }, data: { price: 450 } })
  const { exchange } = await createExchange(
    s.input(
      s.body({
        originalPaymentId: paymentId,
        returned: [{ orderItemId: itemId, quantity: 1, restock: true, reason: 'SIZE' }],
        taken: [{ productId: s.products[3].id, quantity: 1 }],
        settlement: { kind: 'COLLECT', method: 'CARD_TERMINAL', expectedDifferenceCents: 10000 },
      }),
    ),
  )
  return { exchange, paymentId }
}

it.each(['CHAIN', 'DIRECT'] as const)(
  'serializes three generations against a %s refund on their cash roots with real PostgreSQL waits',
  async kind => {
    const { exchange: e, paymentId } = await reserve(true)
    await s.terminalCharge(e.newOrderId, 10000)
    const barrier = await barreraDeFila('Order', s.order.id)
    const closing = Promise.allSettled([close(e.id)])
    let refund: ReturnType<typeof Promise.allSettled> | undefined
    try {
      await barrier.esperarA(1)
      refund = Promise.allSettled([
        issueRefund({
          venueId: s.venueId,
          paymentId: kind === 'CHAIN' ? paymentId : s.payments[0].id,
          staffId: s.staffId,
          reason: 'RETURNED_GOODS',
          amount: 1,
        }),
      ])
      await barrier.esperarA(2)
    } finally {
      await barrier.soltar()
    }
    const results = [...(await closing), ...(await refund!)]
    expect(results.map(r => (r.status === 'rejected' ? String(r.reason) : '')).join(' ')).not.toMatch(/40P01|deadlock/i)
    expect(results[0].status).toBe('fulfilled')
    const row = await prisma.exchange.findUniqueOrThrow({ where: { id: e.id } })
    expect(['COMPLETED', 'NEEDS_REVIEW']).toContain(row.status)
    expect(
      await prisma.activityLog.count({ where: { entityId: e.id, action: { in: ['EXCHANGE_CREATED', 'EXCHANGE_NEEDS_REVIEW'] } } }),
    ).toBe(1)
  },
)

it('waits for the terminal registration on the new sale before reading charge evidence', async () => {
  const { exchange: e } = await reserve()
  const barrier = await barreraDeFila('Order', e.newOrderId)
  const charging = Promise.allSettled([s.terminalCharge(e.newOrderId, 10000)])
  let closing: ReturnType<typeof Promise.allSettled> | undefined
  try {
    await barrier.esperarA(1)
    closing = Promise.allSettled([close(e.id)])
    await barrier.esperarA(2)
  } finally {
    await barrier.soltar()
  }
  const results = [...(await charging), ...(await closing!)]
  expect(results.map(r => (r.status === 'rejected' ? String(r.reason) : r.status))).toEqual(['fulfilled', 'fulfilled'])
  expect(await prisma.exchange.findUnique({ where: { id: e.id } })).toMatchObject({ status: 'COMPLETED' })
})

it.each([false, true])(
  'keeps the new Order lock key stable while two customer settlements already saw N and U (equal dates=%s)',
  async tied => {
    const { exchange: e } = await reserve()
    await s.terminalCharge(e.newOrderId, 10000)
    const originalDate = (await prisma.order.findUniqueOrThrow({ where: { id: e.newOrderId } })).createdAt
    const u = await s.newOrder(25)
    await prisma.order.update({
      where: { id: u.id },
      data: {
        createdAt: tied ? originalDate : new Date(originalDate.getTime() + 1),
        orderCustomers: { create: { customerId: s.customer.id, isPrimary: true } },
      },
    })
    const barrier = await barreraDeFila('Order', u.id)
    const first = Promise.allSettled([settleCustomerBalance(s.venueId, s.customer.id, 'test', s.staffId)])
    let second: ReturnType<typeof Promise.allSettled> | undefined
    try {
      await barrier.esperarA(1)
      second = Promise.allSettled([settleCustomerBalance(s.venueId, s.customer.id, 'test', s.staffId)])
      await barrier.esperarA(2)
      // Both lists were read before closing; U is never part of the exchange's lock set.
      expect((await close(e.id)).status).toBe('COMPLETED')
    } finally {
      await barrier.soltar()
    }
    const results = [...(await first), ...(await second!)]
    expect(results.map(r => (r.status === 'rejected' ? String(r.reason) : r.status))).toEqual(['fulfilled', 'fulfilled'])
    expect((await prisma.order.findUniqueOrThrow({ where: { id: e.newOrderId } })).createdAt).toEqual(originalDate)
    expect(await prisma.payment.count({ where: { venueId: s.venueId, orderId: u.id } })).toBe(1)
  },
)
