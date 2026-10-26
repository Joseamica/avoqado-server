import cuid from 'cuid'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import * as service from '@/services/exchanges/exchange.service'
import * as exchangeTx from '@/services/exchanges/exchangeTx'
import { ExchangeGenerationChanged } from '@/services/exchanges/exchangeSettle'
import { cancelOrderInTransaction, publishCancelledOrder } from '@/services/mobile/order.mobile.service'
import * as orderService from '@/services/mobile/order.mobile.service'
import { ORDER_LOCK_WAIT_BUDGET } from '@/services/shared/paymentShiftClaim'
import { seedCardSale } from './seedExchange'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))
jest.mock('@/communication/sockets/managers/socketManager', () => {
  const sm = { getServer: jest.fn(() => ({ sockets: { sockets: new Map() } })), getBroadcastingService: jest.fn(() => null) }
  return { __esModule: true, default: sm, socketManager: sm }
})
jest.mock('@/communication/sockets/terminal-registry', () => ({
  normalizeTerminalId: (id: string) => jest.requireActual('@/utils/terminalSerial').terminalIdentityKey(id),
  terminalRegistry: { getTerminal: jest.fn(), getAllTerminalIds: jest.fn(() => []) },
}))
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
async function reserve(amount = 350) {
  s = await seedCardSale({ provider: 'BLUMON', amounts: [amount] })
  await prisma.product.update({ where: { id: s.products[3].id }, data: { price: amount + 100 } })
  const input = s.input(
    s.body({
      taken: [{ productId: s.products[3].id, quantity: 1 }],
      settlement: { kind: 'COLLECT', method: 'CARD_TERMINAL', expectedDifferenceCents: 10000 },
    }),
  )
  return { ...(await service.createExchange(input)), input }
}
const cancel = (id: string) =>
  service.cancelExchange({ venueId: s.venueId, exchangeId: id, actorStaffId: s.staffId, origin: 'POS', reason: 'Customer left' })
const complete = (id: string) => service.completeExchange({ venueId: s.venueId, exchangeId: id, actorStaffId: s.staffId })
const row = (id: string) => prisma.exchange.findUniqueOrThrow({ where: { id } })
async function worker() {
  const { ExchangeCardSettlementJob } = await import('@/jobs/exchange-card-settlement.job')
  return new ExchangeCardSettlementJob()
}
async function decline(orderId: string) {
  return s.seedRequest(orderId, {
    status: 'FAILED',
    failureCode: 'TPV_CONFIRMED_NO_CHARGE',
    resultJson: { outcomeEvidence: 'PROCESSOR_DECLINED' },
  })
}
async function age(id: string, minutes: number) {
  await prisma.exchange.update({ where: { id }, data: { createdAt: new Date(Date.now() - minutes * 60000) } })
}
async function noReturnEffects(id: string) {
  expect(await prisma.payment.count({ where: { venueId: s.venueId, type: 'REFUND' } })).toBe(0)
  expect(await prisma.exchangeCreditLink.count({ where: { exchangeId: id } })).toBe(0)
  expect(await prisma.inventoryPosting.count({ where: { venueId: s.venueId } })).toBe(0)
}

describe('card exchange outcomes (E2)', () => {
  it('declined then cancel preserves reservation dates, audits atomically and rejects a later new authorization with a tombstone', async () => {
    const { exchange: e } = await reserve()
    await decline(e.newOrderId)
    const before = await row(e.id)
    const orderBefore = await prisma.order.findUniqueOrThrow({ where: { id: e.newOrderId } })
    const result = await cancel(e.id)
    expect(result.status).toBe('CANCELLED')
    const after = await row(e.id)
    expect(after.createdAt).toEqual(before.createdAt)
    expect(after.resultRevision).toBe(before.resultRevision + 1)
    expect(after.updatedAt.getTime()).toBeGreaterThanOrEqual(before.updatedAt.getTime())
    expect(await prisma.order.findUnique({ where: { id: e.newOrderId } })).toMatchObject({
      status: 'CANCELLED',
      createdAt: orderBefore.createdAt,
    })
    expect(await prisma.activityLog.findFirst({ where: { entityId: e.id, action: 'EXCHANGE_CANCELLED' } })).toMatchObject({
      staffId: s.staffId,
      data: { origin: 'POS', requestCount: 1, reason: 'Customer left' },
    })
    await noReturnEffects(e.id)
    const { terminalPaymentService } = await import('@/services/terminal-payment.service')
    const requestId = cuid()
    const { terminalRegistry } = await import('@/communication/sockets/terminal-registry')
    jest
      .mocked(terminalRegistry.getTerminal)
      .mockReturnValue({ terminalId: s.terminal.serialNumber, venueId: s.venueId, socketId: 'test', terminalPaymentAckVersion: 0 } as any)
    await expect(
      terminalPaymentService.sendPaymentToTerminal({
        venueId: s.venueId,
        terminalId: s.terminal.serialNumber,
        orderId: e.newOrderId,
        amountCents: 10000,
        tipCents: 0,
        requestId,
        requestedBy: s.staffId,
      }),
    ).rejects.toMatchObject({ code: 'ORDER_CANCELLED_NO_NEW_CHARGE' })
    expect(await prisma.terminalPaymentRequest.findUnique({ where: { requestId } })).toMatchObject({
      failureCode: 'REJECTED_ORDER_CANCELLED',
    })
  })
  it('RFD1: cancel requested does not mean no charge; a subsequent approval still completes the reserved exchange', async () => {
    const { exchange: e } = await reserve()
    const r = await s.seedRequest(e.newOrderId, { status: 'CANCEL_REQUESTED' })
    const before = await row(e.id)
    await expect(cancel(e.id)).rejects.toMatchObject({
      statusCode: 409,
      code: 'EXCHANGE_CHARGE_UNRESOLVED',
      details: { requestId: r.requestId },
    })
    expect(await row(e.id)).toEqual(before)
    await s.terminalCharge(e.newOrderId, 10000, { terminalPaymentRequestId: r.requestId })
    expect(await prisma.terminalPaymentRequest.findUnique({ where: { id: r.id } })).toMatchObject({ status: 'COMPLETED' })
    expect((await complete(e.id)).status).toBe('COMPLETED')
  })
  it('after UNRESOLVED the same request resolves BANK_DECLINED and cancel releases it', async () => {
    const { exchange: e } = await reserve()
    const r = await s.seedRequest(e.newOrderId)
    await expect(cancel(e.id)).rejects.toMatchObject({ code: 'EXCHANGE_CHARGE_UNRESOLVED' })
    await prisma.terminalPaymentRequest.update({
      where: { id: r.id },
      data: { status: 'FAILED', failureCode: 'BANK_DECLINED', resultJson: { outcomeEvidence: 'PROCESSOR_DECLINED' } },
    })
    expect((await cancel(e.id)).status).toBe('CANCELLED')
  })
  it('RFD2: a dead tablet is closed by the job with null actor and the durable author', async () => {
    const { exchange: e } = await reserve()
    await s.terminalCharge(e.newOrderId, 10000)
    const job = await worker()
    const [first, overlapping] = await Promise.all([job.run(), job.run()])
    expect(first).toMatchObject({ settled: 1 })
    expect(overlapping).toEqual({ settled: 0, reviewed: 0, released: 0 })
    expect((await row(e.id)).status).toBe('COMPLETED')
    expect(await prisma.activityLog.findFirst({ where: { entityId: e.id, action: 'EXCHANGE_CREATED' } })).toMatchObject({
      staffId: null,
      data: { origin: 'SWEEP', originalStaffId: s.staffId },
    })
  })
  it('cancel after charge returns the settled exchange in the 409 without cancelling the new sale', async () => {
    const { exchange: e } = await reserve()
    await s.terminalCharge(e.newOrderId, 10000)
    await expect(cancel(e.id)).rejects.toMatchObject({
      code: 'EXCHANGE_CHARGE_EXISTS',
      statusCode: 409,
      details: { exchange: { status: 'COMPLETED' } },
    })
    expect(await prisma.order.findUnique({ where: { id: e.newOrderId } })).toMatchObject({ paymentStatus: 'PAID' })
    await expect(cancel(e.id)).rejects.toMatchObject({ code: 'EXCHANGE_ALREADY_SETTLED', statusCode: 409 })
  })
  it('late charge after release is reviewed without reopening, returning stock or losing the charge', async () => {
    const { exchange: e } = await reserve(0)
    await decline(e.newOrderId)
    await cancel(e.id)
    const card = await s.terminalCharge(e.newOrderId, 10000)
    expect(await (await worker()).run()).toMatchObject({ reviewed: 1 })
    expect(await row(e.id)).toMatchObject({ status: 'NEEDS_REVIEW', reviewReason: 'LATE_CHARGE_AFTER_RELEASE', chargePaymentId: card.id })
    expect(await prisma.order.findUnique({ where: { id: e.newOrderId } })).toMatchObject({ status: 'CANCELLED' })
    await noReturnEffects(e.id)
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('🚨'), expect.objectContaining({ exchangeId: e.id }))
  })
  it.each(['sweep', 'complete'] as const)(
    'late charge after the new sale is deleted is reviewed by %s without credit, stock effects or reopening',
    async path => {
      const { exchange: e } = await reserve()
      await decline(e.newOrderId)
      // Mirror the dashboard's soft deletion, which leaves the exchange pending.
      await prisma.$transaction(async tx => {
        await tx.order.update({ where: { id: e.newOrderId, venueId: s.venueId }, data: { status: 'DELETED', version: { increment: 1 } } })
        await tx.activityLog.create({
          data: {
            venueId: s.venueId,
            staffId: s.staffId,
            entity: 'Order',
            entityId: e.newOrderId,
            action: 'ORDER_UPDATED',
            data: { status: 'DELETED', reason: 'Customer left before the card charge was confirmed' },
          },
        })
      })
      const card = await s.terminalCharge(e.newOrderId, 10000)
      expect((await row(e.id)).status).toBe('PENDING_PAYMENT')
      expect(await prisma.order.findUnique({ where: { id: e.newOrderId } })).toMatchObject({ status: 'DELETED' })
      await noReturnEffects(e.id)
      if (path === 'sweep') expect(await (await worker()).run()).toMatchObject({ reviewed: 1 })
      else expect((await complete(e.id)).status).toBe('NEEDS_REVIEW')
      expect(await row(e.id)).toMatchObject({ status: 'NEEDS_REVIEW', reviewReason: 'LATE_CHARGE_AFTER_RELEASE', chargePaymentId: card.id })
      expect(await prisma.order.findUnique({ where: { id: e.newOrderId } })).toMatchObject({ status: 'DELETED' })
      await noReturnEffects(e.id)
      expect(await prisma.payment.count({ where: { venueId: s.venueId, tenderType: { is: { systemKind: 'EXCHANGE_CREDIT' } } } })).toBe(0)
      const savedCharge = await prisma.payment.findUniqueOrThrow({ where: { id: card.id, venueId: s.venueId } })
      expect(savedCharge).toMatchObject({ orderId: e.newOrderId, status: 'COMPLETED' })
      expect(savedCharge.amount.toNumber()).toBe(100)
    },
  )
  it.each(['UNKNOWN', 'TIMED_OUT'] as const)('never releases an hour-old unresolved %s request, including AUTO_RELEASED', async status => {
    const { exchange: e } = await reserve()
    await age(e.id, 61)
    await s.seedRequest(e.newOrderId, { status, failureCode: status === 'TIMED_OUT' ? 'AUTO_RELEASED' : 'ACK_TIMEOUT' })
    expect(await (await worker()).run()).toEqual({ settled: 0, reviewed: 0, released: 0 })
    expect((await row(e.id)).status).toBe('PENDING_PAYMENT')
  })
  it('releases with no request at 30 minutes but not 29; resolved requests need 10 minutes after their last activity', async () => {
    const { exchange: e } = await reserve()
    const job = await worker()
    await age(e.id, 29)
    expect((await job.run()).released).toBe(0)
    await age(e.id, 30)
    expect((await job.run()).released).toBe(1)
    const other = await s.pendingExchange()
    const r = await decline(other.order.id)
    await age(other.exchange.id, 61)
    await prisma.terminalPaymentRequest.update({ where: { id: r.id }, data: { updatedAt: new Date(Date.now() - 9 * 60000) } })
    expect((await (await worker()).run()).released).toBe(0)
    await prisma.terminalPaymentRequest.update({ where: { id: r.id }, data: { updatedAt: new Date(Date.now() - 10 * 60000) } })
    expect((await (await worker()).run()).released).toBe(1)
    expect(await prisma.activityLog.findFirst({ where: { entityId: other.exchange.id, action: 'EXCHANGE_CANCELLED' } })).toMatchObject({
      staffId: null,
      data: { origin: 'SWEEP', requestCount: 1 },
    })
  })
  it('cancel twice returns the same CANCELLED result and only one cancellation audit', async () => {
    const { exchange: e } = await reserve()
    expect(await cancel(e.id)).toEqual(await cancel(e.id))
    expect(await prisma.activityLog.count({ where: { entityId: e.id, action: 'EXCHANGE_CANCELLED' } })).toBe(1)
  })
  it('does not invent a charge if another cancellation wins after the guard rollback', async () => {
    const { exchange: e } = await reserve()
    const request = await s.seedRequest(e.newOrderId, { status: 'UNKNOWN' })
    const actual = orderService.executeExchangeInTransaction
    jest.spyOn(orderService, 'executeExchangeInTransaction').mockImplementationOnce(async input => {
      await prisma.terminalPaymentRequest.update({ where: { id: request.id }, data: { status: 'FAILED', failureCode: 'BANK_DECLINED' } })
      expect((await cancel(e.id)).status).toBe('CANCELLED')
      return actual(input)
    })
    expect((await cancel(e.id)).status).toBe('CANCELLED')
    expect(await prisma.payment.count({ where: { venueId: s.venueId, orderId: e.newOrderId } })).toBe(0)
  })
  it('an already cancelled new order is released by evidence without cancelling it again', async () => {
    const { exchange: e } = await reserve()
    const removed = await prisma.$transaction(
      tx => cancelOrderInTransaction(tx, s.venueId, e.newOrderId, 'List cancel', s.staffId),
      ORDER_LOCK_WAIT_BUDGET,
    )
    await publishCancelledOrder(s.venueId, removed, s.staffId)
    await age(e.id, 31)
    const cancelOrder = jest.spyOn(require('@/services/mobile/order.mobile.service'), 'cancelOrderInTransaction')
    expect((await (await worker()).run()).released).toBe(1)
    expect(cancelOrder).not.toHaveBeenCalled()
    expect((await row(e.id)).status).toBe('CANCELLED')
  })
  it('rolls the entire cancellation back if the in-transaction audit fails', async () => {
    const { exchange: e } = await reserve()
    const fn = `task6_${cuid()}`
    await prisma.$executeRawUnsafe(
      `CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."entityId" = '${e.id}' AND NEW.action = 'EXCHANGE_CANCELLED' THEN RAISE EXCEPTION 'task6 audit failure'; END IF; RETURN NEW; END $$`,
    )
    await prisma.$executeRawUnsafe(`CREATE TRIGGER ${fn} BEFORE INSERT ON "ActivityLog" FOR EACH ROW EXECUTE FUNCTION ${fn}()`)
    try {
      await expect(cancel(e.id)).rejects.toThrow('task6 audit failure')
      expect((await row(e.id)).status).toBe('PENDING_PAYMENT')
      expect(await prisma.order.findUnique({ where: { id: e.newOrderId } })).toMatchObject({ status: 'CONFIRMED' })
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER ${fn} ON "ActivityLog"`)
      await prisma.$executeRawUnsafe(`DROP FUNCTION ${fn}()`)
    }
  })
  it('m1: exhausted generation retries become an actionable 409 after exactly three attempts', async () => {
    const { exchange: e } = await reserve()
    const prepare = jest.spyOn(exchangeTx, 'prepareExchangeInTx').mockRejectedValue(new ExchangeGenerationChanged())
    await expect(complete(e.id)).rejects.toMatchObject({
      statusCode: 409,
      code: 'EXCHANGE_RETRY_CONFLICT',
      message: 'El cambio se movió mientras lo cerrábamos. Intenta de nuevo.',
    })
    expect(prepare).toHaveBeenCalledTimes(3)
  })
})

describe('finite card sweep (C13)', () => {
  it('advances beyond 50 uncertain rows, including tied dates, and revisits the head after a full cycle', async () => {
    const { exchange: e } = await reserve()
    await s.terminalCharge(e.newOrderId, 10000)
    const tie = new Date(Date.now() - 3600000)
    const uncertain: string[] = []
    for (let i = 0; i < 50; i++) {
      const p = await s.pendingExchange()
      await s.seedRequest(p.order.id, { status: 'UNKNOWN', terminalId: cuid() })
      uncertain.push(p.exchange.id)
    }
    const lastId = cuid()
    await prisma.exchange.update({ where: { id: e.id }, data: { id: lastId, result: { ...e, id: lastId } as any } })
    e.id = lastId
    expect([...uncertain, e.id].sort().at(-1)).toBe(e.id)
    await prisma.exchange.updateMany({ where: { venueId: s.venueId, id: { in: uncertain } }, data: { createdAt: tie } })
    await prisma.exchange.update({ where: { id: e.id }, data: { createdAt: tie } })
    const job = await worker()
    expect((await job.run()).settled).toBe(0)
    expect((await row(e.id)).status).toBe('PENDING_PAYMENT')
    expect((await (await worker()).run()).settled).toBe(0)
    expect((await job.run()).settled).toBe(1)
    await prisma.terminalPaymentRequest.updateMany({
      where: { venueId: s.venueId },
      data: { status: 'FAILED', failureCode: 'BANK_DECLINED', resultJson: { outcomeEvidence: 'PROCESSOR_DECLINED' }, updatedAt: tie },
    })
    // The page shorter than 50 ends the cycle; the next tick returns to its head.
    expect((await job.run()).released).toBe(50)
  })
  it('a candidate failure does not stop the next candidate and the failed row is revisited on a later cycle', async () => {
    const { exchange: e } = await reserve()
    const other = await s.pendingExchange()
    await age(e.id, 61)
    await age(other.exchange.id, 60)
    const settle = jest.spyOn(service, 'settleExchangeCharge')
    settle.mockRejectedValueOnce(new Error('task6 candidate failure'))
    const job = await worker()
    expect((await job.run()).released).toBe(1)
    expect((await row(e.id)).status).toBe('PENDING_PAYMENT')
    expect((await row(other.exchange.id)).status).toBe('CANCELLED')
    expect((await job.run()).released).toBe(1)
  })
  it('stops at the time budget without skipping unattempted rows and alternates the first lane', async () => {
    const { exchange: e } = await reserve()
    const other = await s.pendingExchange()
    await age(e.id, 61)
    await age(other.exchange.id, 60)
    const released = await s.pendingExchange()
    await service.cancelExchange({ venueId: s.venueId, exchangeId: released.exchange.id, actorStaffId: s.staffId, origin: 'POS' })
    const late = await s.terminalCharge(released.order.id, 10000)
    const actual = service.settleExchangeCharge
    let spent = false
    const clock = Date.now()
    jest.spyOn(Date, 'now').mockImplementation(() => clock + (spent ? 20001 : 0))
    const calls: string[] = []
    jest.spyOn(service, 'settleExchangeCharge').mockImplementation(async input => {
      calls.push(input.exchangeId)
      const result = await actual(input)
      spent = true
      return result
    })
    const job = await worker()
    await job.run()
    expect(calls).toEqual([e.id])
    spent = false
    await job.run()
    expect(calls).toEqual([e.id, released.exchange.id])
    expect(await row(released.exchange.id)).toMatchObject({ status: 'NEEDS_REVIEW', chargePaymentId: late.id })
    spent = false
    await job.run()
    expect(calls).toContain(other.exchange.id)
  })
  it('a query failure keeps its cursor and a restarted instance begins from the head', async () => {
    const { exchange: e } = await reserve()
    await age(e.id, 61)
    const job = await worker()
    const query = prisma.$queryRaw.bind(prisma)
    jest.spyOn(prisma, '$queryRaw').mockImplementationOnce((() => {
      throw new Error('task6 selector failure')
    }) as any)
    await job.run()
    jest.mocked(prisma.$queryRaw).mockImplementation(query)
    await job.run()
    expect((await row(e.id)).status).toBe('CANCELLED')
    expect(await (await worker()).run()).toEqual({ settled: 0, reviewed: 0, released: 0 })
  })
  it('a real PostgreSQL stamp failure after cancellation is recovered without seal by a restarted job', async () => {
    const { exchange: e } = await reserve(0)
    await decline(e.newOrderId)
    await cancel(e.id)
    const before = await row(e.id)
    const fn = `task6_${cuid()}`
    await prisma.$executeRawUnsafe(
      `CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = '${e.id}' AND OLD."chargePaymentId" IS NULL AND NEW."chargePaymentId" IS NOT NULL THEN RAISE EXCEPTION 'task6 stamp failure'; END IF; RETURN NEW; END $$`,
    )
    await prisma.$executeRawUnsafe(`CREATE TRIGGER ${fn} BEFORE UPDATE ON "Exchange" FOR EACH ROW EXECUTE FUNCTION ${fn}()`)
    let card: Awaited<ReturnType<typeof s.terminalCharge>>
    try {
      card = await s.terminalCharge(e.newOrderId, 10000)
      expect(await row(e.id)).toMatchObject({ status: 'CANCELLED', chargePaymentId: null, resultRevision: before.resultRevision })
      expect(await prisma.payment.findUnique({ where: { id: card.id } })).toMatchObject({ status: 'COMPLETED' })
      await noReturnEffects(e.id)
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER ${fn} ON "Exchange"`)
      await prisma.$executeRawUnsafe(`DROP FUNCTION ${fn}()`)
    }
    expect((await (await worker()).run()).reviewed).toBe(1)
    expect(await row(e.id)).toMatchObject({
      status: 'NEEDS_REVIEW',
      reviewReason: 'LATE_CHARGE_AFTER_RELEASE',
      chargePaymentId: card!.id,
      createdAt: before.createdAt,
    })
    expect(await prisma.order.findUnique({ where: { id: e.newOrderId } })).toMatchObject({ status: 'CANCELLED' })
    await noReturnEffects(e.id)
  })
  it('a positive request without an accredited Payment remains protected in both lanes', async () => {
    const { exchange: e } = await reserve()
    await age(e.id, 61)
    const r = await s.seedRequest(e.newOrderId, { status: 'COMPLETED', paymentId: cuid() })
    await expect(cancel(e.id)).rejects.toMatchObject({ code: 'EXCHANGE_CHARGE_UNRESOLVED', details: { requestId: r.requestId } })
    expect(await (await worker()).run()).toEqual({ settled: 0, reviewed: 0, released: 0 })
    await prisma.exchange.update({ where: { id: e.id }, data: { status: 'CANCELLED', result: { ...e, status: 'CANCELLED' } as any } })
    const settle = jest.spyOn(service, 'settleExchangeCharge')
    expect(await (await worker()).run()).toEqual({ settled: 0, reviewed: 0, released: 0 })
    expect(settle).toHaveBeenCalledWith({ venueId: s.venueId, exchangeId: e.id, actorStaffId: null })
    expect((await row(e.id)).status).toBe('CANCELLED')
    await noReturnEffects(e.id)
  })
})
