import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import * as service from '@/services/exchanges/exchange.service'
import { generateAndStoreReceipt } from '@/services/dashboard/receipt.dashboard.service'
import { writeRefundInTx } from '@/services/shared/writeRefundInTx'
import { issueRefund } from '@/services/dashboard/refund.dashboard.service'
import { seedCardSale } from './seedExchange'
import { lockExistingOrderForPayment, ORDER_LOCK_WAIT_BUDGET } from '@/services/shared/paymentShiftClaim'
import { settleStandalonePaymentInTx } from '@/services/tpv/payment.tpv.service'
import { markExchangeChargeInTx } from '@/services/exchanges/exchangeCharge'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))
jest.mock('@/services/dashboard/receipt.dashboard.service', () => ({ generateAndStoreReceipt: jest.fn(async () => undefined) }))
jest.mock('@/services/shared/writeRefundInTx', () => ({
  ...jest.requireActual('@/services/shared/writeRefundInTx'),
  writeRefundInTx: jest.fn((...args: unknown[]) => jest.requireActual('@/services/shared/writeRefundInTx').writeRefundInTx(...args)),
}))
jest.setTimeout(90000)
type Seed = Awaited<ReturnType<typeof seedCardSale>>
let s: Seed
beforeAll(() =>
  expect(new URL(process.env.TEST_DATABASE_URL!).pathname).toMatch(
    /^\/avoqado_(?:cambio_(?:fix_|r5_)?test_\d{8}|h1a_test_\d{8}(?:_\d+)?)$/,
  ),
)
beforeEach(() => jest.clearAllMocks())
afterEach(async () => {
  jest.restoreAllMocks()
  if (s) await s.cleanup()
})
async function reserve(amounts = [350]) {
  s = await seedCardSale({ provider: 'BLUMON', amounts })
  await prisma.venue.update({ where: { id: s.venueId }, data: { seatCapExempt: true } })
  const credit = amounts.reduce((a, b) => a + b, 0)
  await prisma.product.update({ where: { id: s.products[3].id }, data: { price: new Prisma.Decimal(credit + 100) } })
  const input = s.input(
    s.body({
      taken: [{ productId: s.products[3].id, quantity: 1 }],
      settlement: { kind: 'COLLECT', method: 'CARD_TERMINAL', expectedDifferenceCents: 10000 },
    }),
  )
  const { exchange } = await service.createExchange(input)
  return { exchange, input }
}
const complete = (id: string) => service.completeExchange({ venueId: s.venueId, exchangeId: id, actorStaffId: s.staffId })
const stock = async () =>
  (await prisma.inventory.findMany({ where: { venueId: s.venueId }, take: 10, orderBy: { productId: 'asc' } })).map(i =>
    Number(i.currentStock),
  )

describe('settle card exchange by evidence', () => {
  it('retains A priority for the selected original payment when its credit fits in one slice', async () => {
    s = await seedCardSale({ provider: 'BLUMON', amounts: [150, 350] })
    await prisma.orderItem.update({ where: { id: s.order.items[0].id }, data: { quantity: 2, unitPrice: 250 } })
    await prisma.product.update({ where: { id: s.products[3].id }, data: { price: 350 } })
    const { exchange: e } = await service.createExchange(
      s.input(
        s.body({
          originalPaymentId: s.payments[1].id,
          taken: [{ productId: s.products[3].id, quantity: 1 }],
          settlement: { kind: 'COLLECT', method: 'CARD_TERMINAL', expectedDifferenceCents: 10000 },
        }),
      ),
    )
    await s.terminalCharge(e.newOrderId, 10000)
    const done = await complete(e.id)
    expect(done.settlement.sources).toEqual([expect.objectContaining({ originalPaymentId: s.payments[1].id, amountCents: 25000 })])
    expect(await prisma.exchangeCreditLink.findMany({ where: { exchangeId: e.id }, take: 10 })).toEqual([
      expect.objectContaining({ originPaymentId: s.payments[1].id }),
    ])
  })
  it('recovers the pending SALE posting of an already paid R=0 order without another charge or deduction', async () => {
    const { exchange: e } = await reserve([0])
    // Run the terminal's durable settlement core and stop before its post-commit continuation.
    const card = await prisma.$transaction(async tx => {
      await lockExistingOrderForPayment(tx, { venueId: s.venueId, orderId: e.newOrderId })
      const payment = await tx.payment.create({
        data: {
          venueId: s.venueId,
          orderId: e.newOrderId,
          shiftId: s.shift.id,
          processedById: s.staffId,
          amount: 100,
          tipAmount: 0,
          netAmount: 100,
          feeAmount: 0,
          feePercentage: 0,
          method: 'CREDIT_CARD',
          source: 'TPV',
          fundsFlow: 'AVOQADO_PROCESSED',
          status: 'COMPLETED',
          type: 'REGULAR',
        },
      })
      await settleStandalonePaymentInTx(tx, s.venueId, e.newOrderId, payment, s.staffId)
      await markExchangeChargeInTx(tx, { venueId: s.venueId, orderId: e.newOrderId, paymentId: payment.id })
      return payment
    }, ORDER_LOCK_WAIT_BUDGET)
    expect(await prisma.order.findUnique({ where: { id: e.newOrderId } })).toMatchObject({ paymentStatus: 'PAID' })
    expect(await prisma.inventoryPosting.findFirst({ where: { venueId: s.venueId, orderId: e.newOrderId } })).toMatchObject({
      status: 'PENDING',
    })
    const done = await complete(e.id)
    expect(done.paymentIds).toEqual([card.id])
    expect(await stock()).toEqual([11, 10, 10, 9, 10])
    expect(await prisma.inventoryPosting.count({ where: { venueId: s.venueId, status: 'APPLIED' } })).toBe(2)
  })
  it('uses the durable author for credit and the authenticated HTTP actor for the closing audit', async () => {
    const { exchange: e } = await reserve()
    await s.terminalCharge(e.newOrderId, 10000)
    const done = await service.completeExchange({ venueId: s.venueId, exchangeId: e.id, actorStaffId: s.seller.id })
    expect(await prisma.payment.findUnique({ where: { id: done.refundPaymentIds[0] } })).toMatchObject({ processedById: s.staffId })
    expect(await prisma.payment.findUnique({ where: { id: done.paymentIds[1] } })).toMatchObject({ processedById: s.staffId })
    expect(await prisma.activityLog.findFirst({ where: { entityId: e.id, action: 'EXCHANGE_CREATED' } })).toMatchObject({
      staffId: s.seller.id,
      data: { originalStaffId: s.staffId, origin: 'HTTP' },
    })
  })
  it('reviews a late charge after release without reopening, stock or a sale post-commit, including POST replay', async () => {
    const { exchange: e, input } = await reserve([0])
    await prisma.$transaction(async tx => {
      await tx.order.update({ where: { id: e.newOrderId }, data: { status: 'CANCELLED' } })
      await tx.exchange.update({
        where: { id: e.id },
        data: { status: 'CANCELLED', result: { ...e, status: 'CANCELLED' } as any, resultRevision: { increment: 1 } },
      })
    })
    const card = await s.terminalCharge(e.newOrderId, 10000)
    expect(await complete(e.id)).toMatchObject({
      status: 'NEEDS_REVIEW',
      reviewReason: 'LATE_CHARGE_AFTER_RELEASE',
      chargePaymentId: card.id,
    })
    expect((await service.createExchange(input)).exchange.status).toBe('NEEDS_REVIEW')
    expect(await prisma.order.findUnique({ where: { id: e.newOrderId } })).toMatchObject({ status: 'CANCELLED' })
    expect(await prisma.inventoryPosting.count({ where: { venueId: s.venueId } })).toBe(0)
    expect(await prisma.activityLog.count({ where: { entityId: e.id, action: 'EXCHANGE_NEEDS_REVIEW' } })).toBe(1)
    expect(await prisma.activityLog.count({ where: { entityId: e.id, action: 'EXCHANGE_CREATED' } })).toBe(0)
  })
  it('reviews changed grouped quantities even when their total still matches the frozen sale', async () => {
    const { exchange: e } = await reserve()
    await prisma.orderItem.update({ where: { id: e.lines.taken[0].newOrderItemIds[0] }, data: { quantity: 2, unitPrice: 225, total: 450 } })
    await s.terminalCharge(e.newOrderId, 10000)
    expect(await complete(e.id)).toMatchObject({ status: 'NEEDS_REVIEW', reviewReason: 'ORIGINAL_CHANGED_WHILE_PENDING' })
    expect(await prisma.exchangeCreditLink.count({ where: { exchangeId: e.id } })).toBe(0)
  })
  it('uses frozen prices and decided return eligibility after catalog and inventory configuration changes', async () => {
    const { exchange: e } = await reserve()
    await prisma.product.update({ where: { id: s.products[3].id }, data: { price: 900 } })
    await prisma.product.update({ where: { id: s.products[0].id }, data: { trackInventory: false } })
    await s.terminalCharge(e.newOrderId, 10000)
    expect(await complete(e.id)).toMatchObject({ status: 'COMPLETED', returnedCents: 35000, takenCents: 45000 })
    const returnPosting = await prisma.inventoryPosting.findFirstOrThrow({ where: { venueId: s.venueId, effectKind: 'CUSTOMER_RETURN' } })
    expect(returnPosting.payloadSnapshot).toMatchObject({
      lines: [{ productId: s.products[0].id, eligible: true, inventoryMethod: 'QUANTITY' }],
    })
  })
  it('closes V4 with the existing card, EC credit, return and sale exactly once; loyalty subtracts credit only once', async () => {
    const { exchange: e, input } = await reserve()
    const card = await s.terminalCharge(e.newOrderId, 10000)
    const done = await complete(e.id)
    expect(done).toMatchObject({ status: 'COMPLETED', chargePaymentId: card.id, returnedCents: 35000, takenCents: 45000 })
    expect(done.paymentIds).toContain(card.id)
    expect(done.paymentIds).toHaveLength(2)
    expect(done.refundPaymentIds).toHaveLength(1)
    expect(await prisma.exchangeCreditLink.count({ where: { exchangeId: e.id } })).toBe(1)
    const order = await prisma.order.findUniqueOrThrow({ where: { id: e.newOrderId } })
    expect(order.paymentStatus).toBe('PAID')
    expect(Number(order.paidAmount)).toBe(450)
    expect(await prisma.inventoryPosting.count({ where: { venueId: s.venueId, status: 'APPLIED' } })).toBe(2)
    expect(await stock()).toEqual([11, 10, 10, 9, 10])
    const customer = await prisma.customer.findUniqueOrThrow({ where: { id: s.customer.id } })
    expect([customer.loyaltyPoints, customer.totalVisits, Number(customer.totalSpent)]).toEqual([120, 3, 600])
    expect(await prisma.stampEvent.count({ where: { venueId: s.venueId } })).toBe(0)
    expect(jest.mocked(generateAndStoreReceipt).mock.calls.at(-1)?.[1]).toBe(card.id)
    expect((await service.createExchange(input)).exchange).toEqual(done)
    expect(await complete(e.id)).toEqual(done)
    expect(await prisma.activityLog.count({ where: { entityId: e.id, action: 'EXCHANGE_CREATED' } })).toBe(1)
  })
  it('double complete is one credit refund, one EC, one link and one audit', async () => {
    const { exchange: e } = await reserve()
    await s.terminalCharge(e.newOrderId, 10000)
    const [a, b] = await Promise.all([complete(e.id), complete(e.id)])
    expect(a).toEqual(b)
    expect(await prisma.payment.count({ where: { venueId: s.venueId, type: 'REFUND' } })).toBe(1)
    expect(await prisma.exchangeCreditLink.count({ where: { exchangeId: e.id } })).toBe(1)
    expect(await prisma.activityLog.count({ where: { entityId: e.id, action: 'EXCHANGE_CREATED' } })).toBe(1)
  })
  it('returns NOT_CHARGED, then UNRESOLVED with the blocking request without writing credit', async () => {
    const { exchange: e } = await reserve()
    await expect(complete(e.id)).rejects.toMatchObject({ code: 'EXCHANGE_NOT_CHARGED', statusCode: 409 })
    const r = await s.seedRequest(e.newOrderId)
    await expect(complete(e.id)).rejects.toMatchObject({
      code: 'EXCHANGE_CHARGE_UNRESOLVED',
      statusCode: 409,
      details: { requestId: r.requestId },
    })
    expect(await prisma.payment.count({ where: { venueId: s.venueId, type: 'REFUND' } })).toBe(0)
  })
  it.each(['request', 'payment'])('does not close a captured charge while another %s is in flight', async kind => {
    const { exchange: e } = await reserve()
    await s.terminalCharge(e.newOrderId, 10000)
    if (kind === 'request') await s.seedRequest(e.newOrderId)
    else
      await prisma.payment.create({
        data: {
          venueId: s.venueId,
          orderId: e.newOrderId,
          amount: 100,
          feePercentage: 0,
          feeAmount: 0,
          netAmount: 100,
          method: 'CREDIT_CARD',
          source: 'TPV',
          status: 'PROCESSING',
        },
      })
    await expect(complete(e.id)).rejects.toMatchObject({ code: 'EXCHANGE_CHARGE_UNRESOLVED' })
    expect(await prisma.exchangeCreditLink.count({ where: { exchangeId: e.id } })).toBe(0)
  })
  it.each(['amount', 'tip', 'refunded', 'other', 'double'])(
    'reviews invalid captured evidence (%s) without returning original stock',
    async kind => {
      const { exchange: e } = await reserve()
      const card = await s.terminalCharge(e.newOrderId, kind === 'amount' ? 5000 : 10000)
      if (kind === 'tip') await prisma.payment.update({ where: { id: card.id }, data: { tipAmount: 1 } })
      if (kind === 'refunded') await prisma.payment.update({ where: { id: card.id }, data: { status: 'REFUNDED' } })
      if (kind === 'other') await prisma.payment.update({ where: { id: card.id }, data: { method: 'BANK_TRANSFER' } })
      if (kind === 'double') await s.terminalCharge(e.newOrderId, 10000)
      expect(await complete(e.id)).toMatchObject({ status: 'NEEDS_REVIEW', reviewReason: 'CHARGE_AMOUNT_MISMATCH' })
      expect(await prisma.payment.count({ where: { venueId: s.venueId, type: 'REFUND' } })).toBe(0)
      expect((await stock())[0]).toBe(10)
    },
  )
  it('reviews a concurrently refunded original and applies only the replacement sale', async () => {
    const { exchange: e } = await reserve()
    await issueRefund({
      venueId: s.venueId,
      staffId: s.staffId,
      paymentId: s.payments[0].id,
      reason: 'RETURNED_GOODS',
      items: [{ orderItemId: s.order.items[0].id, quantity: 1 }],
    })
    await s.terminalCharge(e.newOrderId, 10000)
    expect(await complete(e.id)).toMatchObject({ status: 'NEEDS_REVIEW', reviewReason: 'ORIGINAL_CHANGED_WHILE_PENDING' })
    expect(await prisma.exchangeCreditLink.count({ where: { exchangeId: e.id } })).toBe(0)
    const order = await prisma.order.findUniqueOrThrow({ where: { id: e.newOrderId } })
    expect(Number(order.remainingBalance)).toBe(350)
  })
  it('rolls back the first credit slice when the second writer fails, keeping the captured charge and stamp', async () => {
    const { exchange: e } = await reserve([150, 200])
    const card = await s.terminalCharge(e.newOrderId, 10000)
    jest
      .mocked(writeRefundInTx)
      .mockImplementationOnce((...args) => jest.requireActual('@/services/shared/writeRefundInTx').writeRefundInTx(...args))
      .mockRejectedValueOnce(new Error('second slice failed'))
    await expect(complete(e.id)).rejects.toThrow('second slice failed')
    expect(await prisma.exchange.findUnique({ where: { id: e.id } })).toMatchObject({ status: 'PENDING_PAYMENT', chargePaymentId: card.id })
    expect(await prisma.payment.count({ where: { venueId: s.venueId, type: 'REFUND' } })).toBe(0)
    expect(await complete(e.id)).toMatchObject({ status: 'COMPLETED' })
  })
  it.each([false, true])(
    'R=0 closes concurrently with HTTP and a null-actor worker, even when already settled=%s',
    async alreadySettled => {
      const { exchange: e } = await reserve([0])
      const card = await s.terminalCharge(e.newOrderId, 10000)
      if (!alreadySettled)
        await prisma.order.update({
          where: { id: e.newOrderId },
          data: { paymentStatus: 'PENDING', status: 'CONFIRMED', remainingBalance: 100 },
        })
      const [done, worker] = await Promise.all([
        complete(e.id),
        service.settleExchangeCharge({ venueId: s.venueId, exchangeId: e.id, actorStaffId: null }),
      ])
      expect(done.status).toBe('COMPLETED')
      expect(worker.exchange).toEqual(done)
      expect(done.paymentIds).toEqual([card.id])
      expect(done.refundPaymentIds).toHaveLength(1)
      expect(await prisma.exchangeCreditLink.count({ where: { exchangeId: e.id } })).toBe(0)
      expect(await prisma.inventoryPosting.count({ where: { venueId: s.venueId } })).toBe(2)
      expect(await prisma.payment.count({ where: { venueId: s.venueId, orderId: e.newOrderId } })).toBe(1)
      expect(await prisma.order.findUnique({ where: { id: e.newOrderId } })).toMatchObject({ paymentStatus: 'PAID', shiftId: s.shift.id })
      expect(jest.mocked(generateAndStoreReceipt).mock.calls.at(-1)?.[1]).toBe(card.id)
    },
  )
})
