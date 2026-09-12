/** Round-one review regressions: real PostgreSQL, only random local fixture tenants. */
import { randomUUID } from 'crypto'
import { Prisma, PrismaClient } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import {
  enqueuePaymentEffect,
  enqueuePaymentCommissionInTx,
  claimPaymentEffects,
  runClaimedPaymentEffect,
} from '@/services/tpv/paymentEffects.service'
import { createCommissionForPayment, createRefundCommission } from '@/services/dashboard/commission/commission-calculation.service'
import { onOrderPaid } from '@/services/referrals/referralQualification.service'
import { onOrderRefunded } from '@/services/referrals/referralRefund.service'
import { recordRefund } from '@/services/tpv/refund.tpv.service'
import { postCashRefundToDrawer } from '@/services/shared/cashDrawerPosting'

jest.mock('@/services/shared/cashDrawerPosting', () => ({ postCashRefundToDrawer: jest.fn().mockResolvedValue(undefined) }))
jest.mock('@/communication/rabbitmq/publisher', () => ({ publishCommand: jest.fn() }))
jest.mock('@/communication/sockets/managers/socketManager', () => {
  const manager = { broadcastToVenue: jest.fn(), getServer: jest.fn() }
  return { __esModule: true, default: manager, socketManager: manager }
})

jest.setTimeout(30000)
let other: PrismaClient<{ log: [{ emit: 'event'; level: 'query' }] }>
let organizationId: string, venueId: string, staffId: string, orderId: string, paymentId: string
let statements: string[] = []
const epoch = new Date('2026-09-09T22:00:00Z')

beforeAll(async () => {
  const url = new URL(process.env.TEST_DATABASE_URL ?? '')
  expect(['localhost', '127.0.0.1']).toContain(url.hostname)
  // La base de este trabajo en la Mac, o la de CI (`avoqado_*_test_*`): nunca otra.
  // 🔴 Con el prefijo ÚNICO de una sola sesión, estas suites fallaban SIEMPRE en CI
  // (su base es `avoqado_h1a_test_20260808`): 38 pruebas en rojo el 12-sep. La guarda
  // debe cerrar el paso a una base real, no a la del CI.
  expect(url.pathname).toMatch(/^\/(codex_testarudo_test_|avoqado_[a-z0-9]+_test_)/)
  other = new PrismaClient({ datasources: { db: { url: url.toString() } }, log: [{ emit: 'event', level: 'query' }] })
  other.$on('query', event => statements.push(event.query))
})
beforeEach(async () => {
  organizationId = 'effect-review-' + randomUUID()
  await prisma.organization.create({
    data: { id: organizationId, name: organizationId, email: organizationId + '@example.test', phone: '5500000000' },
  })
  venueId = (await prisma.venue.create({ data: { organizationId, name: organizationId, slug: organizationId } })).id
  staffId = (await prisma.staff.create({ data: { email: organizationId + '@example.test', firstName: 'Review', lastName: 'Fixture' } })).id
  await prisma.staffVenue.create({ data: { staffId, venueId, role: 'CASHIER' } })
  orderId = (
    await prisma.order.create({
      data: {
        venueId,
        orderNumber: randomUUID(),
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
  paymentId = (await prisma.payment.create({ data: paymentData(100) })).id
})
afterEach(async () => {
  await prisma.referralRewardGrant.deleteMany({ where: { venueId } })
  await prisma.referral.deleteMany({ where: { venueId } })
  await prisma.couponCode.deleteMany({ where: { discount: { venueId } } })
  await prisma.customerDiscount.deleteMany({ where: { discount: { venueId } } })
  await prisma.discount.deleteMany({ where: { venueId } })
  await prisma.referralProgramConfig.deleteMany({ where: { venueId } })
  await prisma.paymentEffect.deleteMany({ where: { venueId } })
  await prisma.commissionCalculation.deleteMany({ where: { venueId } })
  await prisma.commissionConfig.deleteMany({ where: { venueId } })
  await prisma.payment.deleteMany({ where: { venueId } })
  await prisma.order.deleteMany({ where: { venueId } })
  await prisma.product.deleteMany({ where: { venueId } })
  await prisma.menuCategory.deleteMany({ where: { venueId } })
  await prisma.customer.deleteMany({ where: { venueId } })
  await prisma.venueModule.deleteMany({ where: { venueId } })
  await prisma.staffVenue.deleteMany({ where: { venueId } })
  await prisma.venue.delete({ where: { id: venueId } })
  await prisma.staff.delete({ where: { id: staffId } })
  await prisma.organization.delete({ where: { id: organizationId } })
})
afterAll(async () => {
  await other.$disconnect()
})

function paymentData(amount: number): Prisma.PaymentUncheckedCreateInput {
  return {
    venueId,
    orderId,
    amount,
    tipAmount: 0,
    method: 'CASH',
    status: 'COMPLETED',
    feePercentage: 0,
    feeAmount: 0,
    netAmount: amount,
    processedById: staffId,
  }
}
function refundData(): Prisma.PaymentUncheckedCreateInput {
  return { ...paymentData(-100), type: 'REFUND', processorData: { originalPaymentId: paymentId } }
}
async function config(extra: Partial<Prisma.CommissionConfigUncheckedCreateInput> = {}) {
  return prisma.commissionConfig.create({
    data: {
      venueId,
      name: 'Snapshot rule',
      createdById: staffId,
      recipient: 'PROCESSOR',
      defaultRate: 0.1,
      categoryIds: [],
      effectiveFrom: new Date('2020-01-01T00:00:00Z'),
      ...extra,
    },
  })
}
async function plan(id = paymentId) {
  await prisma.$transaction(tx => enqueuePaymentCommissionInTx(tx, id))
}
async function drain() {
  await prisma.paymentEffect.updateMany({ where: { venueId }, data: { nextAttemptAt: epoch } })
  for (const claim of await claimPaymentEffects({ now: epoch })) await runClaimedPaymentEffect(claim)
}
async function tieredConfig() {
  const rule = await config({ calcType: 'TIERED' })
  await prisma.commissionTier.createMany({
    data: [
      {
        configId: rule.id,
        tierLevel: 1,
        tierName: 'Base',
        tierType: 'BY_AMOUNT',
        tierPeriod: 'MONTHLY',
        minThreshold: 0,
        maxThreshold: 100,
        rate: 0.1,
      },
      { configId: rule.id, tierLevel: 2, tierName: 'Next', tierType: 'BY_AMOUNT', tierPeriod: 'MONTHLY', minThreshold: 100, rate: 0.2 },
    ],
  })
  return rule
}
async function goal(rules: unknown[]) {
  const module = await prisma.module.upsert({
    where: { code: 'COMMISSIONS' },
    update: {},
    create: { code: 'COMMISSIONS', name: 'Commissions', defaultConfig: {} },
  })
  await prisma.venueModule.create({
    data: { venueId, moduleId: module.id, enabledBy: 'fixture', enabled: true, config: { salesGoals: rules } as Prisma.InputJsonValue },
  })
}
function goalRule(staff: string | null, period = 'MONTHLY') {
  return {
    id: randomUUID(),
    staffId: staff,
    goal: 100,
    goalType: 'AMOUNT',
    period,
    active: true,
    createdAt: epoch.toISOString(),
    updatedAt: epoch.toISOString(),
  }
}
async function categoryItem(amount: number) {
  const category = await prisma.menuCategory.create({ data: { venueId, name: 'Category', slug: randomUUID() } })
  const product = await prisma.product.create({
    data: { venueId, categoryId: category.id, name: 'Item', sku: randomUUID(), price: amount, taxRate: 0 },
  })
  await prisma.orderItem.create({ data: { orderId, productId: product.id, quantity: 1, unitPrice: amount, taxAmount: 0, total: amount } })
  return category.id
}
async function referral() {
  const program = await prisma.referralProgramConfig.create({
    data: { venueId, active: true, tier1ReferralsRequired: 1, tier2ReferralsRequired: 2, tier3ReferralsRequired: 3, codePrefix: 'REVIEW' },
  })
  await prisma.referralTierReward.create({ data: { configId: program.id, tierLevel: 1, rewardType: 'PERCENT_COUPON', rewardPercent: 15 } })
  const referrer = await prisma.customer.create({ data: { venueId, firstName: 'Referrer', marketingConsent: false } })
  const referred = await prisma.customer.create({ data: { venueId, firstName: 'Referred', marketingConsent: false } })
  const row = await prisma.referral.create({
    data: { venueId, referrerCustomerId: referrer.id, referredCustomerId: referred.id, qualifyingOrderId: orderId },
  })
  await prisma.$transaction(tx =>
    enqueuePaymentEffect(tx, {
      venueId,
      orderId,
      paymentId,
      kind: 'REFERRAL',
      dedupeKey: 'referral:' + orderId,
      payload: { expectsSettlement: true },
    }),
  )
  return { row, referrer }
}

it('refund before commission delivery reverses the frozen original once, including replay', async () => {
  await config()
  await plan()
  const refund = await prisma.payment.create({ data: refundData() })
  await createRefundCommission(refund.id, paymentId)
  await drain()
  const firstDelivery = await prisma.commissionCalculation.aggregate({ where: { venueId, orderId }, _sum: { netCommission: true } })
  expect(Number(firstDelivery._sum.netCommission)).toBe(0)
  await createRefundCommission(refund.id, paymentId)
  await drain()
  const rows = await prisma.commissionCalculation.findMany({ where: { venueId, orderId }, take: 10 })
  expect(rows).toHaveLength(2)
  expect(rows.filter(row => row.paymentId === refund.id)).toHaveLength(1)
  expect(rows.every(row => row.staffId === staffId && Number(row.effectiveRate) === 0.1)).toBe(true)
  expect(rows.reduce((total, row) => total + Number(row.netCommission), 0)).toBe(0)
})

it('an earlier category plan in the same payment contributes to the later goal-based rate', async () => {
  const firstCategory = await categoryItem(20)
  const secondCategory = await categoryItem(20)
  const first = await config({ categoryIds: [firstCategory], filterByCategories: true, priority: 2 })
  const second = await config({
    categoryIds: [secondCategory],
    filterByCategories: true,
    priority: 1,
    useGoalAsTier: true,
    goalBonusRate: 0.2,
  })
  await goal([goalRule(staffId)])
  await prisma.commissionCalculation.create({
    data: {
      venueId,
      staffId,
      configId: first.id,
      baseAmount: 90,
      effectiveRate: 0.1,
      grossCommission: 9,
      netCommission: 9,
      calcType: 'PERCENTAGE',
    },
  })
  await plan()
  const plans = await prisma.paymentEffect.findMany({ where: { venueId, paymentId, kind: 'COMMISSION' }, take: 10 })
  expect(plans.find(row => (row.payload as any).configId === second.id)?.payload).toMatchObject({ effectiveRate: 0.2 })
})

it('legacy payment-link commission production sees earlier pending TPV tier progress', async () => {
  await tieredConfig()
  await plan()
  const second = await prisma.payment.create({ data: paymentData(100) })
  await createCommissionForPayment(second.id)
  expect(await prisma.commissionCalculation.findFirst({ where: { venueId, paymentId: second.id } })).toMatchObject({ tier: 2 })
  expect(Number((await prisma.commissionCalculation.findFirstOrThrow({ where: { venueId, paymentId: second.id } })).effectiveRate)).toBe(
    0.2,
  )
})

it('goal policy lookup does not run report sales aggregates for unrelated active goals', async () => {
  await config({ useGoalAsTier: true, goalBonusRate: 0.2 })
  await goal([...Array.from({ length: 12 }, () => goalRule(null, 'DAILY')), goalRule(null)])
  statements = []
  await other.$transaction(tx => enqueuePaymentCommissionInTx(tx, paymentId))
  expect(await prisma.paymentEffect.count({ where: { venueId, paymentId, kind: 'COMMISSION' } })).toBe(1)
  expect(statements.filter(sql => /SUM\(/i.test(sql) && sql.includes('"Payment"'))).toHaveLength(0)
})

it('real PostgreSQL statement failure rolls back to savepoint and still commits the captured payment and recovery obligation', async () => {
  const service = await import('@/services/dashboard/commission/commission-calculation.service')
  const failure = jest.spyOn(service, 'freezePaymentCommissionInTx').mockImplementationOnce(async tx => {
    await tx.$queryRawUnsafe('SELECT 1 / 0')
    return []
  })
  let capturedId = ''
  try {
    await prisma.$transaction(async tx => {
      capturedId = (await tx.payment.create({ data: paymentData(100) })).id
      await enqueuePaymentCommissionInTx(tx, capturedId)
    })
  } finally {
    failure.mockRestore()
  }
  expect(await prisma.payment.findUnique({ where: { id: capturedId } })).toMatchObject({ status: 'COMPLETED' })
  expect(await prisma.paymentEffect.findFirst({ where: { paymentId: capturedId, venueId } })).toMatchObject({
    lastError: 'COMMISSION_SNAPSHOT_REQUIRES_REVIEW',
  })
})

it('full refund before pending referral delivery voids it without qualifying or issuing a reward', async () => {
  const { row, referrer } = await referral()
  await prisma.payment.create({ data: refundData() })
  await onOrderRefunded({ venueId, orderId })
  await drain()
  expect(await prisma.referral.findUnique({ where: { id: row.id } })).toMatchObject({ status: 'VOID', voidReason: 'ORDER_REFUNDED' })
  expect(await prisma.customer.findUnique({ where: { id: referrer.id } })).toMatchObject({ referralCount: 0 })
  expect(await prisma.referralRewardGrant.count({ where: { venueId, customerId: referrer.id } })).toBe(0)
})

it('a delivered actual referral coupon is revoked by full refund once and never reminted on replay', async () => {
  const { row, referrer } = await referral()
  await drain()
  expect(await prisma.referral.findUnique({ where: { id: row.id } })).toMatchObject({ status: 'QUALIFIED' })
  const issued = await prisma.referralRewardGrant.findFirstOrThrow({ where: { venueId, customerId: referrer.id } })
  expect(issued.status).toBe('ISSUED')
  expect(await prisma.discount.findUnique({ where: { id: issued.discountId! } })).toMatchObject({ active: true })
  await prisma.payment.create({ data: refundData() })
  await onOrderRefunded({ venueId, orderId })
  await onOrderRefunded({ venueId, orderId })
  await onOrderPaid({ venueId, orderId })
  expect(await prisma.customer.findUnique({ where: { id: referrer.id } })).toMatchObject({ referralCount: 0 })
  expect(await prisma.referralRewardGrant.findUnique({ where: { id: issued.id } })).toMatchObject({ status: 'REVOKED' })
  expect(await prisma.discount.findUnique({ where: { id: issued.discountId! } })).toMatchObject({ active: false })
  expect(await prisma.referralRewardGrant.count({ where: { venueId, customerId: referrer.id } })).toBe(1)
})

it('qualification waits behind the refund order lock and cannot reward the sale being fully reversed', async () => {
  const { row, referrer } = await referral()
  let release!: () => void
  let locked!: () => void
  const releaseGate = new Promise<void>(done => {
    release = done
  })
  const lockGate = new Promise<void>(done => {
    locked = done
  })
  const refund = other.$transaction(
    async tx => {
      await tx.$queryRawUnsafe('SELECT id FROM "Order" WHERE id = $1 FOR UPDATE', orderId)
      locked()
      await releaseGate
      await tx.payment.create({ data: refundData() })
    },
    { timeout: 15000 },
  )
  await lockGate
  let pidReady!: (pid: number) => void
  const pidGate = new Promise<number>(done => {
    pidReady = done
  })
  const originalTransaction = prisma.$transaction.bind(prisma) as any
  const spy = jest.spyOn(prisma, '$transaction').mockImplementationOnce(((action: any) =>
    originalTransaction(async (tx: any) => {
      pidReady((await tx.$queryRawUnsafe('SELECT pg_backend_pid() AS pid'))[0].pid)
      return action(tx)
    })) as any)
  let finished = false
  const qualification = onOrderPaid({ venueId, orderId }).finally(() => {
    finished = true
  })
  let observedLock = false
  try {
    const pid = await pidGate
    const deadline = Date.now() + 5000
    while (!finished && Date.now() < deadline) {
      const activity = await other.$queryRawUnsafe<Array<{ wait_event_type: string | null }>>(
        'SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1',
        pid,
      )
      if (activity[0]?.wait_event_type === 'Lock') {
        observedLock = true
        break
      }
      await new Promise(done => setTimeout(done, 25))
    }
    expect(observedLock).toBe(true)
  } finally {
    spy.mockRestore()
    release()
    await refund
    await qualification
  }
  await onOrderRefunded({ venueId, orderId })
  expect(await prisma.referral.findUnique({ where: { id: row.id } })).toMatchObject({ status: 'VOID' })
  expect(await prisma.referralRewardGrant.count({ where: { venueId, customerId: referrer.id } })).toBe(0)
})

it('refund financial commit includes pending commission reversal and referral reconciliation before post-commit hooks', async () => {
  await config()
  await plan()
  await referral()
  let reached!: (id: string) => void
  let release!: () => void
  const gate = new Promise<string>(done => {
    reached = done
  })
  const continueHook = new Promise<void>(done => {
    release = done
  })
  ;(postCashRefundToDrawer as jest.Mock).mockImplementationOnce(async ({ refundPaymentId }) => {
    reached(refundPaymentId)
    await continueHook
  })
  const registration = recordRefund(
    venueId,
    {
      venueId,
      originalPaymentId: paymentId,
      originalOrderId: orderId,
      amount: 10000,
      reason: 'CUSTOMER_REQUEST',
      authorizationNumber: 'TEST-REFUND-ONLY',
      referenceNumber: randomUUID(),
      isPartialRefund: false,
      currency: 'MXN',
      processor: 'angelpay',
      idempotencyKey: randomUUID(),
    },
    staffId,
  )
  try {
    const refundId = await Promise.race([
      gate,
      registration.then(() => {
        throw new Error('Refund ended without reaching post-commit boundary')
      }),
    ])
    const refund = await prisma.payment.findUniqueOrThrow({ where: { id: refundId } })
    expect(refund.processorData).toMatchObject({ originalPaymentId: paymentId })
    expect(Number(refund.amount)).toBe(-100)
    const obligations = await prisma.paymentEffect.findMany({ where: { venueId, paymentId: refundId }, take: 10 })
    expect(obligations.map(row => row.kind).sort()).toEqual(['COMMISSION', 'REFERRAL'])
  } finally {
    release()
    await registration
  }
})
