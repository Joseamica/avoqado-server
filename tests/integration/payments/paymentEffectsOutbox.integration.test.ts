/** Real PostgreSQL: durability, business dedupe and lease fencing are not mocked. */
import { randomUUID } from 'crypto'
import { PrismaClient } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import {
  enqueuePaymentEffect,
  enqueuePaymentCommissionInTx,
  claimPaymentEffects,
  runClaimedPaymentEffect,
  failClaimedPaymentEffect,
  PaymentEffectInput,
} from '@/services/tpv/paymentEffects.service'

const fixture = 'effect-outbox-' + randomUUID()
const epoch = new Date('2026-09-09T22:00:00Z')
let other: PrismaClient
let venueId: string
let staffId: string
let orderId: string
let paymentId: string

beforeAll(async () => {
  const url = new URL(process.env.TEST_DATABASE_URL ?? '')
  expect(['localhost', '127.0.0.1']).toContain(url.hostname)
  // La base de este trabajo en la Mac, o la de CI (`avoqado_*_test_*`): nunca otra.
  // 🔴 Con el prefijo ÚNICO de una sola sesión, estas suites fallaban SIEMPRE en CI
  // (su base es `avoqado_h1a_test_20260808`): 38 pruebas en rojo el 12-sep. La guarda
  // debe cerrar el paso a una base real, no a la del CI.
  expect(url.pathname).toMatch(/^\/(codex_testarudo_test_|avoqado_[a-z0-9]+_test_)/)
  other = new PrismaClient({ datasources: { db: { url: url.toString() } } })
  await prisma.organization.create({ data: { id: fixture, name: fixture, email: fixture + '@example.test', phone: '5500000000' } })
  venueId = (await prisma.venue.create({ data: { organizationId: fixture, name: fixture, slug: fixture } })).id
  staffId = (await prisma.staff.create({ data: { email: fixture + '@example.test', firstName: 'Effect', lastName: 'Fixture' } })).id
  await prisma.staffVenue.create({ data: { venueId, staffId, role: 'CASHIER' } })
})

beforeEach(async () => {
  await prisma.paymentEffect.deleteMany({ where: { venueId } })
  orderId = (
    await prisma.order.create({
      data: {
        venueId,
        orderNumber: randomUUID(),
        source: 'TPV',
        subtotal: 100,
        taxAmount: 0,
        total: 100,
        paidAmount: 100,
        remainingBalance: 0,
        paymentStatus: 'PAID',
        status: 'COMPLETED',
      },
    })
  ).id
  paymentId = (
    await prisma.payment.create({
      data: {
        venueId,
        orderId,
        amount: 100,
        feePercentage: 0,
        feeAmount: 0,
        netAmount: 100,
        tipAmount: 0,
        method: 'CASH',
        status: 'COMPLETED',
        processedById: staffId,
        source: 'TPV',
        splitType: 'FULLPAYMENT',
      },
    })
  ).id
})

afterAll(async () => {
  if (venueId) {
    await prisma.review.deleteMany({ where: { venueId } })
    await prisma.paymentEffect.deleteMany({ where: { venueId } })
    await prisma.commissionCalculation.deleteMany({ where: { venueId } })
    await prisma.commissionConfig.deleteMany({ where: { venueId } })
    await prisma.payment.deleteMany({ where: { venueId } })
    await prisma.order.deleteMany({ where: { venueId } })
    await prisma.product.deleteMany({ where: { venueId } })
    await prisma.menuCategory.deleteMany({ where: { venueId } })
    await prisma.staffVenue.deleteMany({ where: { venueId } })
    await prisma.venue.deleteMany({ where: { id: venueId } })
  }
  if (staffId) await prisma.staff.deleteMany({ where: { id: staffId } })
  await prisma.organization.deleteMany({ where: { id: fixture } })
  await other?.$disconnect()
})

const review = (): PaymentEffectInput => ({
  venueId,
  paymentId,
  orderId,
  kind: 'REVIEW',
  dedupeKey: `review:${paymentId}:v1`,
  payload: { rating: 5, servedById: staffId },
})
async function enqueue(input = review()) {
  await prisma.$transaction(tx => enqueuePaymentEffect(tx, input))
  // Clock belongs to test, not the host timezone or wall clock.
  await prisma.paymentEffect.updateMany({ where: { venueId }, data: { nextAttemptAt: epoch } })
}

describe('durable payment effects', () => {
  it('commit survives new DB client and duplicate enqueue preserves original frozen payload', async () => {
    await enqueue()
    await enqueue({ ...review(), payload: { rating: 1, servedById: staffId } })
    expect(await other.paymentEffect.count({ where: { venueId } })).toBe(1)
    expect((await other.paymentEffect.findFirstOrThrow({ where: { venueId } })).payload).toMatchObject({ rating: 5 })
    const [claim] = await claimPaymentEffects({ now: epoch, db: other })
    expect(claim).toBeDefined()
    expect(await runClaimedPaymentEffect(claim, other)).toBe(true)
    expect(await other.review.findFirst({ where: { venueId, paymentId } })).toMatchObject({ overallRating: 5, servedById: staffId })
    expect(await other.paymentEffect.findFirst({ where: { venueId } })).toMatchObject({ status: 'DONE', attempts: 1 })
  })

  it('rollback leaves no obligation and cross-venue source cannot enqueue', async () => {
    await expect(
      prisma.$transaction(async tx => {
        await enqueuePaymentEffect(tx, review())
        throw new Error('ROLLBACK')
      }),
    ).rejects.toThrow('ROLLBACK')
    expect(await prisma.paymentEffect.count({ where: { venueId } })).toBe(0)
    await expect(prisma.$transaction(tx => enqueuePaymentEffect(tx, { ...review(), venueId: fixture }))).rejects.toThrow()
  })

  it('expired lease reclaims with new token and stale worker cannot repeat review or overwrite DONE', async () => {
    await enqueue()
    const [a] = await claimPaymentEffects({ now: epoch })
    expect(a).toBeDefined()
    const [b] = await claimPaymentEffects({ now: new Date(a.leaseUntil.getTime() + 1), db: other })
    expect(b.claimToken).not.toBe(a.claimToken)
    expect(b.attempts).toBe(2)
    expect(await runClaimedPaymentEffect(b, other)).toBe(true)
    expect(await runClaimedPaymentEffect(a)).toBe(false)
    expect(await failClaimedPaymentEffect(a, epoch, new Error('stale'))).toBe(false)
    expect(await prisma.review.count({ where: { venueId, paymentId } })).toBe(1)
    expect(await prisma.paymentEffect.findUnique({ where: { id: b.id } })).toMatchObject({ status: 'DONE', attempts: 2 })
  })

  it('an existing edited review is authoritative on replay', async () => {
    await prisma.review.create({ data: { venueId, paymentId, overallRating: 2, source: 'TPV', servedById: staffId } })
    await enqueue()
    const [claim] = await claimPaymentEffects({ now: epoch })
    expect(claim).toBeDefined()
    await runClaimedPaymentEffect(claim)
    expect(await prisma.review.findFirst({ where: { venueId, paymentId } })).toMatchObject({ overallRating: 2 })
    expect(await prisma.review.count({ where: { venueId, paymentId } })).toBe(1)
  })

  it('claim has a hard batch ceiling and stable ordering without losing the remaining obligations', async () => {
    for (let n = 0; n < 28; n++) await enqueue({ ...review(), dedupeKey: `review:${paymentId}:batch:${n}` })
    const claims = await claimPaymentEffects({ now: epoch, limit: 100000 })
    expect(claims).toHaveLength(25)
    expect(new Set(claims.map(row => row.id)).size).toBe(25)
    const remainder = await claimPaymentEffects({ now: epoch, db: other })
    expect(remainder).toHaveLength(3)
    expect(await prisma.paymentEffect.count({ where: { venueId, attempts: 1 } })).toBe(28)
  })

  it('a receipt obligation reuses the existing usable receipt on replay', async () => {
    const { generateDigitalReceipt } = await import('@/services/tpv/digitalReceipt.tpv.service')
    const receipt = await generateDigitalReceipt(paymentId)
    await enqueue({ ...review(), kind: 'RECEIPT', dedupeKey: `receipt:${paymentId}:v1`, payload: {} })
    const [claim] = await claimPaymentEffects({ now: epoch })
    expect(claim).toBeDefined()
    expect(await runClaimedPaymentEffect(claim)).toBe(true)
    expect(await runClaimedPaymentEffect(claim, other)).toBe(false)
    expect(await prisma.digitalReceipt.count({ where: { paymentId } })).toBe(1)
    expect((await prisma.digitalReceipt.findFirstOrThrow({ where: { paymentId } })).accessKey).toBe(receipt.accessKey)
  })

  it('referral replay consumes the committed paid-order hook and safely completes a no-referral order', async () => {
    await enqueue({ ...review(), kind: 'REFERRAL', dedupeKey: `referral:${orderId}:v1`, payload: {} })
    const [claim] = await claimPaymentEffects({ now: epoch })
    expect(await runClaimedPaymentEffect(claim)).toBe(true)
    expect(await runClaimedPaymentEffect(claim, other)).toBe(false)
    expect(await prisma.paymentEffect.findUnique({ where: { id: claim.id } })).toMatchObject({ status: 'DONE' })
    expect(await prisma.referral.count({ where: { qualifyingOrderId: orderId } })).toBe(0)
  })

  it('rollback after review execution before effect commit leaves both retryable', async () => {
    await enqueue()
    const [claim] = await claimPaymentEffects({ now: epoch })
    expect(claim).toBeDefined()
    const failing = new Proxy(prisma, {
      get(target, key) {
        if (key === '$transaction')
          return (action: (tx: any) => Promise<unknown>) =>
            target.$transaction(async tx => {
              await action(tx)
              throw new Error('COMMIT_INTERRUPTED')
            })
        return Reflect.get(target, key)
      },
    })
    await expect(runClaimedPaymentEffect(claim, failing)).rejects.toThrow('COMMIT_INTERRUPTED')
    expect(await prisma.review.count({ where: { venueId, paymentId } })).toBe(0)
    expect(await prisma.paymentEffect.findUnique({ where: { id: claim.id } })).toMatchObject({ status: 'PROCESSING' })
    expect(await runClaimedPaymentEffect(claim, other)).toBe(true)
    expect(await prisma.review.count({ where: { venueId, paymentId } })).toBe(1)
  })

  it('failure backs off, exposes exhausted work and never dumps processor payloads', async () => {
    await enqueue()
    await prisma.paymentEffect.updateMany({ where: { venueId }, data: { attempts: 5 } })
    const [claim] = await claimPaymentEffects({ now: epoch })
    expect(claim).toBeDefined()
    expect(await failClaimedPaymentEffect(claim, epoch, new Error('processor PAN secret-response'))).toBe(true)
    const row = await prisma.paymentEffect.findUniqueOrThrow({ where: { id: claim.id } })
    expect(row.status).toBe('DEAD_LETTER')
    expect(row.lastError).not.toContain('secret-response')
    expect(await claimPaymentEffects({ now: new Date(epoch.getTime() + 86400000) })).toHaveLength(0)
  })
})

async function commissionConfig(categoryIds: string[] = []) {
  await prisma.commissionConfig.updateMany({ where: { venueId }, data: { active: false } })
  return prisma.commissionConfig.create({
    data: {
      venueId,
      name: 'Frozen rule',
      createdById: staffId,
      recipient: 'PROCESSOR',
      defaultRate: 0.1,
      categoryIds,
      filterByCategories: categoryIds.length > 0,
      effectiveFrom: new Date('2020-01-01T00:00:00Z'),
    },
  })
}
async function enqueueCommission(id = paymentId) {
  await prisma.$transaction(tx => enqueuePaymentCommissionInTx(tx, id))
  await prisma.paymentEffect.updateMany({ where: { venueId }, data: { nextAttemptAt: epoch } })
}

describe('frozen commission obligations', () => {
  it('applies the committed rate and recipient after configuration changes, exactly once', async () => {
    const config = await commissionConfig()
    await enqueueCommission()
    expect(await prisma.paymentEffect.count({ where: { venueId, kind: 'COMMISSION' } })).toBe(1)
    await prisma.commissionConfig.update({ where: { id: config.id }, data: { defaultRate: 0.75, active: false } })
    const [claim] = await claimPaymentEffects({ now: epoch })
    expect(await runClaimedPaymentEffect(claim)).toBe(true)
    expect(await runClaimedPaymentEffect(claim, other)).toBe(false)
    const rows = await prisma.commissionCalculation.findMany({ where: { venueId, paymentId }, take: 10 })
    expect(rows).toHaveLength(1)
    expect(Number(rows[0].effectiveRate)).toBe(0.1)
    expect(Number(rows[0].netCommission)).toBe(10)
    expect(rows[0].staffId).toBe(staffId)
  })

  it('reserves category base against pending obligations across split payments before either worker runs', async () => {
    const category = await prisma.menuCategory.create({ data: { venueId, name: 'Category', slug: randomUUID() } })
    const product = await prisma.product.create({
      data: { venueId, categoryId: category.id, name: 'Product', sku: randomUUID(), price: 100, taxRate: 0 },
    })
    await prisma.orderItem.create({ data: { orderId, productId: product.id, quantity: 1, unitPrice: 100, taxAmount: 0, total: 100 } })
    const config = await commissionConfig([category.id])
    await prisma.payment.update({ where: { id: paymentId }, data: { amount: 40 } })
    await enqueueCommission()
    const second = await prisma.payment.create({
      data: {
        venueId,
        orderId,
        amount: 60,
        feePercentage: 0,
        feeAmount: 0,
        netAmount: 60,
        tipAmount: 0,
        method: 'CASH',
        status: 'COMPLETED',
        processedById: staffId,
        source: 'TPV',
        splitType: 'FULLPAYMENT',
      },
    })
    await enqueueCommission(second.id)
    const claims = await claimPaymentEffects({ now: epoch })
    expect(claims.length).toBeGreaterThan(0)
    for (const claim of claims) await runClaimedPaymentEffect(claim)
    const total = await prisma.commissionCalculation.aggregate({
      where: { venueId, orderId, configId: config.id },
      _sum: { baseAmount: true, netCommission: true },
    })
    expect(Number(total._sum.baseAmount)).toBe(100)
    expect(Number(total._sum.netCommission)).toBe(10)
  })

  it('tier snapshot includes pending commission base and never creates a venue module while reading goals', async () => {
    const config = await commissionConfig()
    await prisma.commissionConfig.update({ where: { id: config.id }, data: { calcType: 'TIERED' } })
    await prisma.commissionTier.createMany({
      data: [
        {
          configId: config.id,
          tierLevel: 1,
          tierName: 'Base',
          tierType: 'BY_AMOUNT',
          tierPeriod: 'MONTHLY',
          minThreshold: 0,
          maxThreshold: 100,
          rate: 0.1,
        },
        { configId: config.id, tierLevel: 2, tierName: 'Next', tierType: 'BY_AMOUNT', tierPeriod: 'MONTHLY', minThreshold: 100, rate: 0.2 },
      ],
    })
    const modulesBefore = await prisma.venueModule.count({ where: { venueId } })
    await enqueueCommission()
    expect(await prisma.venueModule.count({ where: { venueId } })).toBe(modulesBefore)
    const second = await prisma.payment.create({
      data: {
        venueId,
        orderId,
        amount: 100,
        tipAmount: 0,
        method: 'CASH',
        feePercentage: 0,
        feeAmount: 0,
        netAmount: 100,
        status: 'COMPLETED',
        processedById: staffId,
      },
    })
    await enqueueCommission(second.id)
    const effect = await prisma.paymentEffect.findFirstOrThrow({ where: { venueId, paymentId: second.id, kind: 'COMMISSION' } })
    expect(effect.payload).toMatchObject({ effectiveRate: 0.2, tier: 2 })
  })

  it('a failed optional commission policy snapshot leaves a visible recovery obligation without aborting financial commit', async () => {
    const service = await import('@/services/dashboard/commission/commission-calculation.service')
    const failing = jest.spyOn(service, 'freezePaymentCommissionInTx').mockRejectedValueOnce(new Error('POLICY_FAILURE secret-payload'))
    try {
      await expect(prisma.$transaction(tx => enqueuePaymentCommissionInTx(tx, paymentId))).resolves.toBeUndefined()
      const obligation = await prisma.paymentEffect.findFirstOrThrow({ where: { venueId, paymentId, kind: 'COMMISSION' } })
      expect(obligation.payload).toMatchObject({ policyError: 'COMMISSION_SNAPSHOT_REQUIRES_REVIEW' })
      expect(JSON.stringify(obligation.payload)).not.toContain('secret-payload')
      expect(obligation.status).toBe('PENDING')
      expect(await prisma.payment.findUnique({ where: { id: paymentId } })).toMatchObject({ status: 'COMPLETED' })
    } finally {
      failing.mockRestore()
    }
  })

  it('preserves the public manual-review reason from enqueue through exhausted retries', async () => {
    const service = await import('@/services/dashboard/commission/commission-calculation.service')
    const failing = jest.spyOn(service, 'freezePaymentCommissionInTx').mockRejectedValueOnce(new Error('private policy error'))
    try {
      await enqueueCommission()
    } finally {
      failing.mockRestore()
    }
    const obligation = await prisma.paymentEffect.findFirstOrThrow({ where: { venueId, paymentId, kind: 'COMMISSION' } })
    expect(obligation.lastError).toBe('COMMISSION_SNAPSHOT_REQUIRES_REVIEW')
    await prisma.paymentEffect.update({ where: { id: obligation.id }, data: { attempts: 5 } })
    const claim = (await claimPaymentEffects({ now: epoch })).find(row => row.id === obligation.id)!
    await failClaimedPaymentEffect(claim, epoch, new Error('private processor details'))
    expect(await prisma.paymentEffect.findUnique({ where: { id: obligation.id } })).toMatchObject({
      status: 'DEAD_LETTER',
      lastError: 'COMMISSION_SNAPSHOT_REQUIRES_REVIEW',
    })
  })

  it('does not invent a commission if the payment had no active configuration when committed', async () => {
    await prisma.commissionConfig.updateMany({ where: { venueId }, data: { active: false } })
    await enqueueCommission()
    await commissionConfig()
    expect(await prisma.paymentEffect.count({ where: { venueId, kind: 'COMMISSION' } })).toBe(0)
    expect(await prisma.commissionCalculation.count({ where: { venueId, paymentId } })).toBe(0)
  })
})
