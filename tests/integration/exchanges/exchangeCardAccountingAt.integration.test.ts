import prisma from '@/utils/prismaClient'
import { createExchange, completeExchange } from '@/services/exchanges/exchange.service'
import * as clock from '@/services/exchanges/exchangeAccountingAt'
import { lockExistingOrderForPayment } from '@/services/shared/paymentShiftClaim'
import { writeRefundInTx } from '@/services/shared/writeRefundInTx'
import { seedCardSale } from './seedExchange'

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
  jest.restoreAllMocks()
  if (s) await s.cleanup()
})

it('uses one closing instant after a concurrent real refund across midnight, keeping the reserved Order and terminal dates', async () => {
  s = await seedCardSale({ provider: 'BLUMON', amounts: [350] })
  await prisma.orderItem.update({ where: { id: s.order.items[0].id }, data: { quantity: 2, unitPrice: 175 } })
  await prisma.product.update({ where: { id: s.products[3].id }, data: { price: 275 } })
  const reservedAt = new Date()
  reservedAt.setUTCDate(reservedAt.getUTCDate() - 1)
  reservedAt.setUTCHours(5, 59, 59, 900)
  await prisma.payment.updateMany({ where: { venueId: s.venueId }, data: { createdAt: new Date(reservedAt.getTime() - 3600000) } })
  jest.spyOn(clock, 'exchangeAccountingAt').mockResolvedValueOnce(reservedAt)
  const { exchange: e } = await createExchange(
    s.input(
      s.body({
        taken: [{ productId: s.products[3].id, quantity: 1 }],
        settlement: { kind: 'COLLECT', method: 'CARD_TERMINAL', expectedDifferenceCents: 10000 },
      }),
    ),
  )
  const card = await s.terminalCharge(e.newOrderId, 10000)
  let ready!: (pid: number) => void
  let release!: () => void
  const entered = new Promise<number>(r => {
    ready = r
  })
  const gate = new Promise<void>(r => {
    release = r
  })
  const refund = prisma.$transaction(
    async tx => {
      await lockExistingOrderForPayment(tx, { venueId: s.venueId, orderId: s.order.id })
      const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`
      ready(pid)
      await gate
      return writeRefundInTx(tx, {
        venueId: s.venueId,
        originalPaymentId: s.payments[0].id,
        salesRefundCents: 17500,
        tipRefundCents: 0,
        refundedItems: [{ orderItemId: s.order.items[0].id, quantity: 1, amountCents: 17500 }],
        reason: 'RETURNED_GOODS',
        staffId: s.staffId,
        tenderCommission: 'NONE',
        shift: 'CLAIM_LIVE',
      })
    },
    { timeout: 30000 },
  )
  const pid = await entered
  const closing = completeExchange({ venueId: s.venueId, exchangeId: e.id, actorStaffId: s.staffId })
  try {
    const deadline = Date.now() + 10000
    while (
      !(await prisma.$queryRaw<Array<{ pid: number }>>`SELECT pid FROM pg_stat_activity WHERE pg_blocking_pids(pid) @> ARRAY[${pid}::int]`)
        .length
    ) {
      if (Date.now() > deadline) throw new Error('Settlement did not wait for the refund lock')
      await new Promise(r => setTimeout(r, 10))
    }
  } finally {
    release()
  }
  const prior = await refund
  const done = await closing
  expect(done.status).toBe('COMPLETED')
  const row = await prisma.exchange.findUniqueOrThrow({ where: { id: e.id } })
  const refunded = await prisma.payment.findUniqueOrThrow({ where: { id: prior.refundPaymentId } })
  expect(row.createdAt.getTime()).toBeGreaterThan(refunded.createdAt.getTime())
  const payments = await prisma.payment.findMany({
    where: { venueId: s.venueId, id: { in: [...done.refundPaymentIds, ...done.paymentIds.filter(id => id !== card.id)] } },
    take: 10,
  })
  const links = await prisma.exchangeCreditLink.findMany({ where: { exchangeId: e.id }, take: 10 })
  const audit = await prisma.activityLog.findFirstOrThrow({ where: { entityId: e.id, action: 'EXCHANGE_CREATED' } })
  expect([...payments, ...links, audit].every(r => r.createdAt.getTime() === row.createdAt.getTime())).toBe(true)
  expect((await prisma.order.findUniqueOrThrow({ where: { id: e.newOrderId } })).createdAt).toEqual(reservedAt)
  expect((await prisma.payment.findUniqueOrThrow({ where: { id: card.id } })).createdAt).toEqual(card.createdAt)
})
