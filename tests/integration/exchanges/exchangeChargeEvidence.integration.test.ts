import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { exchangeChargeEvidence } from '@/services/exchanges/exchangeCharge'
import * as charge from '@/services/exchanges/exchangeCharge'
import { ensureExchangeCreditTender } from '@/services/exchanges/exchangeCreditTender'
import { seedCardSale } from './seedExchange'

jest.mock('@/communication/sockets/managers/socketManager', () => {
  const sm = { getServer: jest.fn(() => null), getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn() }
  return { __esModule: true, default: sm, socketManager: sm }
})
jest.mock('@/services/alerts/opsAlert.service', () => ({ sendOpsAlert: jest.fn() }))

let s: Awaited<ReturnType<typeof seedCardSale>>
beforeAll(async () => {
  expect(new URL(process.env.TEST_DATABASE_URL!).pathname).toMatch(/^\/avoqado_(?:cambio_(?:fix_|r5_)?test_\d{8}|h1a_test_\d{8}(?:_\d+)?)$/)
  s = await seedCardSale({ provider: 'BLUMON', amounts: [500] })
})
afterAll(async () => {
  if (s) await s.cleanup()
})
afterEach(() => jest.restoreAllMocks())
const evidence = (orderId: string) => exchangeChargeEvidence(prisma, s.venueId, orderId)
async function payment(orderId: string, overrides: Partial<Prisma.PaymentUncheckedCreateInput> = {}) {
  return prisma.payment.create({
    data: {
      venueId: s.venueId,
      orderId,
      amount: 100,
      tipAmount: 7,
      method: 'CREDIT_CARD',
      source: 'TPV',
      status: 'COMPLETED',
      type: null,
      feeAmount: 0,
      feePercentage: 0,
      netAmount: 100,
      ...overrides,
    },
  })
}

describe('exchange charge evidence', () => {
  it('returns absence only when there is neither money nor a request', async () => {
    const o = await s.newOrder()
    expect(await evidence(o.id)).toEqual({ kind: 'NOT_CHARGED', requestCount: 0, lastActivityAt: null })
  })
  it.each(['SENT', 'CANCEL_REQUESTED', 'UNKNOWN', 'TIMED_OUT'] as const)('%s stays unresolved, including AUTO_RELEASED', async status => {
    const o = await s.newOrder()
    const r = await s.seedRequest(o.id, { terminalId: o.id, status, failureCode: 'AUTO_RELEASED' })
    expect(await evidence(o.id)).toMatchObject({ kind: 'UNRESOLVED', requestId: r.requestId, positiveRequestId: null })
  })
  it.each([
    { status: 'FAILED' as const, failureCode: 'TPV_CONFIRMED_NO_CHARGE', resultJson: { outcomeEvidence: 'PROCESSOR_DECLINED' } },
    { status: 'CANCELLED' as const, cancelDisposition: 'ACCEPTED' },
  ])('accepts accredited negative evidence and preserves activity metadata (%j)', async overrides => {
    const o = await s.newOrder()
    const r = await s.seedRequest(o.id, overrides)
    expect(await evidence(o.id)).toEqual({ kind: 'NOT_CHARGED', requestCount: 1, lastActivityAt: r.updatedAt })
  })
  it.each(['PENDING', 'PROCESSING'] as const)('a %s payment forbids absence', async status => {
    const o = await s.newOrder()
    await payment(o.id, { status })
    expect(await evidence(o.id)).toMatchObject({ kind: 'UNRESOLVED', requestId: null })
  })
  it('aggregates captured and refunded sale amounts without tips, including NULL types, beyond twenty failed attempts', async () => {
    const o = await s.newOrder()
    await prisma.payment.createMany({
      data: Array.from({ length: 21 }, () => ({
        venueId: s.venueId,
        orderId: o.id,
        amount: 999,
        method: 'CREDIT_CARD' as const,
        status: 'FAILED' as const,
        feeAmount: 0,
        feePercentage: 0,
        netAmount: 999,
      })),
    })
    const first = await payment(o.id)
    const second = await payment(o.id, { amount: 25, status: 'REFUNDED' })
    expect(await evidence(o.id)).toEqual({
      kind: 'CHARGED',
      paymentIds: [first.id, second.id],
      chargedSaleCents: 12500,
      paymentCount: 2,
      exceedsPaymentLimit: false,
    })
  })
  it('returns the exact count and sum for fifty-one captures, with an explicit review limit', async () => {
    const o = await s.newOrder()
    for (let n = 0; n < 51; n++) await payment(o.id, { amount: 1.01 })
    expect(await evidence(o.id)).toMatchObject({ kind: 'CHARGED', chargedSaleCents: 5151, paymentCount: 51, exceedsPaymentLimit: true })
    expect(((await evidence(o.id)) as { paymentIds: string[] }).paymentIds).toHaveLength(51)
  })
  it('ignores refunds and exchange credit, but keeps ordinary money with a NULL tender', async () => {
    const o = await s.newOrder()
    const ec = await ensureExchangeCreditTender(prisma, s.venueId)
    await payment(o.id, { tenderTypeId: ec.id, method: 'OTHER' })
    await payment(o.id, { type: 'REFUND', amount: -100 })
    expect(await evidence(o.id)).toMatchObject({ kind: 'NOT_CHARGED' })
    await payment(o.id, { amount: 0.01 })
    expect(await evidence(o.id)).toMatchObject({ kind: 'CHARGED', chargedSaleCents: 1 })
  })
  it.each(['missing', 'other-order', 'other-venue', 'pending', 'refund', 'credit'] as const)(
    'keeps a positive request unresolved when its payment is %s, even behind twenty negatives',
    async variant => {
      const o = await s.newOrder()
      for (let n = 0; n < 21; n++) await s.seedRequest(o.id, { status: 'FAILED', failureCode: 'BANK_DECLINED' })
      const p =
        variant === 'missing'
          ? { id: 'missing' }
          : await payment(variant === 'other-order' ? s.order.id : o.id, {
              ...(variant === 'other-venue'
                ? {
                    venueId: (
                      await prisma.venue.create({
                        data: {
                          organizationId: s.organizationId,
                          name: 'Other venue',
                          slug: o.id,
                        },
                      })
                    ).id,
                  }
                : {}),
              ...(variant === 'pending' ? { status: 'PENDING' } : {}),
              ...(variant === 'refund' ? { type: 'REFUND' } : {}),
              ...(variant === 'credit' ? { tenderTypeId: (await ensureExchangeCreditTender(prisma, s.venueId)).id } : {}),
            })
      const r = await s.seedRequest(o.id, { status: 'COMPLETED', paymentId: p.id })
      expect(await evidence(o.id)).toMatchObject({ kind: 'UNRESOLVED', positiveRequestId: r.requestId })
      if (variant === 'other-venue') await prisma.payment.deleteMany({ where: { id: p.id } })
    },
  )
  it('propagates a read failure instead of certifying absence', async () => {
    const o = await s.newOrder()
    jest.spyOn(prisma.payment, 'aggregate').mockRejectedValueOnce(new Error('read failed'))
    await expect(evidence(o.id)).rejects.toThrow('read failed')
  })
})

describe('terminal charge stamp and released exchanges', () => {
  it('stamps the first captured charge and its result generation without replacing it on a second capture', async () => {
    const { order, exchange } = await s.pendingExchange(500)
    const p = await s.terminalCharge(order.id, 10000)
    const stamped = await prisma.exchange.findUniqueOrThrow({ where: { id: exchange.id } })
    expect(stamped).toMatchObject({ chargePaymentId: p.id, resultRevision: 1, result: { chargePaymentId: p.id } })
    const p2 = await s.terminalCharge(order.id, 10000)
    expect(p2.id).not.toBe(p.id)
    expect(await prisma.exchange.findUniqueOrThrow({ where: { id: exchange.id } })).toMatchObject({
      chargePaymentId: p.id,
      resultRevision: 1,
    })
  })
  it('keeps an ordinary terminal sale working without an exchange', async () => {
    const o = await s.newOrder()
    const p = await s.terminalCharge(o.id, 10000)
    expect(p.status).toBe('COMPLETED')
    expect(await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).toMatchObject({ paymentStatus: 'PAID', status: 'COMPLETED' })
  })
  it.each([
    ['CANCELLED', null, 'CANCELLED'],
    ['NEEDS_REVIEW', 'LATE_CHARGE_AFTER_RELEASE', 'CANCELLED'],
    ['PENDING_PAYMENT', null, 'CANCELLED'],
    ['PENDING_PAYMENT', null, 'DELETED'],
  ] as const)(
    'a late R=0 approval preserves %s/%s/%s and no sale effects, including its retry',
    async (status, reviewReason, orderStatus) => {
      const { order, exchange } = await s.pendingExchange()
      await prisma.order.update({ where: { id: order.id }, data: { status: orderStatus } })
      await prisma.exchange.update({ where: { id: exchange.id }, data: { status, reviewReason } })
      const customerBefore = await prisma.customer.findUniqueOrThrow({ where: { id: s.customer.id } })
      const postingsBefore = await prisma.inventoryPosting.count({ where: { venueId: s.venueId } })
      const inventory = () => prisma.inventory.findMany({ where: { venueId: s.venueId }, take: 10, orderBy: { id: 'asc' } })
      const inventoryBefore = await inventory()
      const p = await s.terminalCharge(order.id, 10000)
      const check = async () => {
        expect(await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({
          status: orderStatus,
          paymentStatus: 'PENDING',
        })
        expect(await prisma.inventoryPosting.count({ where: { venueId: s.venueId, orderId: order.id } })).toBe(0)
        expect(await prisma.inventoryPosting.count({ where: { venueId: s.venueId } })).toBe(postingsBefore)
        expect(await inventory()).toEqual(inventoryBefore)
        expect(await prisma.paymentEffect.count({ where: { paymentId: p.id, kind: { in: ['COMMISSION', 'REFERRAL'] } } })).toBe(0)
        expect(await prisma.paymentEffect.count({ where: { paymentId: p.id, kind: 'RECEIPT' } })).toBe(1)
        expect(await prisma.paymentEffect.count({ where: { paymentId: p.id, kind: 'TRANSACTION_COST' } })).toBe(1)
        expect(await prisma.customer.findUniqueOrThrow({ where: { id: s.customer.id } })).toMatchObject({
          loyaltyPoints: customerBefore.loyaltyPoints,
          totalSpent: customerBefore.totalSpent,
          totalVisits: customerBefore.totalVisits,
        })
        expect(await prisma.stampEvent.count({ where: { venueId: s.venueId, orderId: order.id } })).toBe(0)
      }
      await check()
      expect(
        (
          await s.terminalCharge(order.id, 10000, {
            idempotencyKey: p.idempotencyKey,
            referenceNumber: p.referenceNumber,
            authorizationNumber: p.authorizationNumber,
          })
        ).id,
      ).toBe(p.id)
      await check()
    },
  )
  it('keeps the capture when the stamp helper throws, without hiding the failure', async () => {
    const { order, exchange } = await s.pendingExchange(500)
    jest.spyOn(charge, 'markExchangeChargeInTx').mockRejectedValueOnce(new Error('stamp failed'))
    const p = await s.terminalCharge(order.id, 10000)
    expect(await prisma.payment.findUnique({ where: { id: p.id } })).toMatchObject({ status: 'COMPLETED' })
    expect(await prisma.exchange.findUniqueOrThrow({ where: { id: exchange.id } })).toMatchObject({ chargePaymentId: null })
    expect(logger.error).toHaveBeenCalledWith(
      '🚨 [Exchange] El sello del cargo no se escribió; lo encontrará el barrido',
      expect.objectContaining({ paymentId: p.id }),
    )
  })
  it('rolls back only a real PostgreSQL stamp UPDATE failure and commits money, shift and receipt obligations', async () => {
    const { order, exchange } = await s.pendingExchange()
    await prisma.order.update({ where: { id: order.id }, data: { status: 'CANCELLED' } })
    await prisma.exchange.update({ where: { id: exchange.id }, data: { status: 'CANCELLED' } })
    const constraint = `exchange_stamp_${exchange.id}`
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "Exchange" ADD CONSTRAINT "${constraint}" CHECK (id <> '${exchange.id}' OR "chargePaymentId" IS NULL)`,
    )
    try {
      const p = await s.terminalCharge(order.id, 10000)
      expect(p.status).toBe('COMPLETED')
      expect(await prisma.payment.findUnique({ where: { id: p.id } })).not.toBeNull()
      expect(await prisma.exchange.findUniqueOrThrow({ where: { id: exchange.id } })).toMatchObject({
        chargePaymentId: null,
        resultRevision: 0,
      })
      expect(logger.error).toHaveBeenCalledWith(
        '🚨 [Exchange] El sello del cargo no se escribió; lo encontrará el barrido',
        expect.objectContaining({ venueId: s.venueId, orderId: order.id, paymentId: p.id }),
      )
      expect(await evidence(order.id)).toMatchObject({ kind: 'CHARGED', chargedSaleCents: 10000 })
      expect(await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: 'CANCELLED' })
      expect(await prisma.paymentEffect.count({ where: { paymentId: p.id, kind: 'RECEIPT' } })).toBe(1)
      expect(await prisma.paymentEffect.count({ where: { paymentId: p.id, kind: { in: ['COMMISSION', 'REFERRAL'] } } })).toBe(0)
    } finally {
      await prisma.$executeRawUnsafe(`ALTER TABLE "Exchange" DROP CONSTRAINT "${constraint}"`)
    }
  })
})
