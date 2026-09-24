/**
 * Integration tests: `byPaymentMethodDetailed` of getSalesSummary (REAL PostgreSQL).
 *
 * Incident 2026-09-24 (Better Stack «Consulta gigante detectada»): the Informe de ventas of the POS
 * app (`GET /mobile/venues/:id/reports/sales-summary`, groupBy=paymentMethod by default) hydrated
 * ONE ROW PER PAYMENT of the range — 3,109 rows for a month of Testarudo — only to add them up in
 * JavaScript. The breakdown must be aggregated in the database instead.
 *
 * Two guards:
 *   1. No `payment.findMany` without `take` while computing the report (the query-guard contract).
 *   2. The aggregated breakdown equals, to the cent, what the OLD per-row algorithm produced — the
 *      oracle below replays it over the same seeded rows. The bucket rules include the JSON
 *      truthiness of `processorData.isInternational`, which only a real Postgres can evaluate.
 *
 * Run with:
 *   TEST_DATABASE_URL='postgresql://…/<a disposable test db>' \
 *     npx jest --selectProjects integration --testPathPattern sales-summary-payment-method-detailed
 */

import prisma from '@/utils/prismaClient'
import { bucketOf, getSalesSummary, PaymentMethodDetailedBreakdown } from '@/services/dashboard/sales-summary.dashboard.service'

const TZ = 'America/Mexico_City'
const FROM = new Date('2025-04-08T06:00:00.000Z')
const TO = new Date('2025-04-09T05:59:59.999Z')
const INSIDE = new Date('2025-04-08T18:00:00.000Z')
const BEFORE = new Date('2025-04-07T18:00:00.000Z')

const suffix = `pmdetail-${Date.now()}`

let orgId: string
let venueId: string
let otherVenueId: string
let providerId: string
let aggregatorId: string
let merchantA: string
let merchantB: string
let seq = 0

type Seed = {
  venue?: string
  method: 'CASH' | 'CREDIT_CARD' | 'DEBIT_CARD' | 'BANK_TRANSFER'
  amount: number
  tip?: number
  status?: 'COMPLETED' | 'PENDING'
  type?: 'REGULAR' | 'REFUND'
  cardBrand?: 'VISA' | 'MASTERCARD' | 'AMERICAN_EXPRESS'
  processorData?: unknown
  merchant?: string
  fee?: { charge: number; fixed?: number }
  at?: Date
}

async function seed(s: Seed) {
  const v = s.venue ?? venueId
  const at = s.at ?? INSIDE
  seq += 1
  const order = await prisma.order.create({
    data: {
      venueId: v,
      orderNumber: `PMD-${seq}-${suffix}`,
      createdAt: at,
      subtotal: Math.abs(s.amount),
      taxAmount: 0,
      discountAmount: 0,
      total: Math.abs(s.amount),
      status: 'COMPLETED',
      paymentStatus: 'PAID',
    },
    select: { id: true },
  })
  const payment = await prisma.payment.create({
    data: {
      venueId: v,
      orderId: order.id,
      amount: s.amount,
      tipAmount: s.tip ?? 0,
      method: s.method,
      status: s.status ?? 'COMPLETED',
      type: s.type ?? 'REGULAR',
      cardBrand: s.cardBrand,
      processorData: s.processorData === undefined ? undefined : (s.processorData as any),
      feePercentage: 0,
      feeAmount: 0,
      netAmount: s.amount,
      merchantAccountId: s.merchant,
      createdAt: at,
    },
    select: { id: true },
  })
  if (s.fee) {
    await prisma.transactionCost.create({
      data: {
        paymentId: payment.id,
        merchantAccountId: s.merchant ?? merchantA,
        transactionType: 'CREDIT',
        amount: s.amount,
        providerRate: 0,
        providerCostAmount: 0,
        venueRate: 0,
        venueChargeAmount: s.fee.charge,
        venueFixedFee: s.fee.fixed ?? 0,
        grossProfit: 0,
        profitMargin: 0,
        createdAt: at,
      },
    })
  }
}

/**
 * The pre-2026-09-24 algorithm: hydrate every row, classify it with bucketOf, add up in JS.
 * Used only as the oracle the aggregated implementation must match.
 */
async function oldAlgorithm(vId: string, merchantAccountId?: string): Promise<PaymentMethodDetailedBreakdown[]> {
  const dateFilter = { createdAt: { gte: FROM, lte: TO } }
  const mf = merchantAccountId ? { merchantAccountId } : {}
  const detail = await prisma.payment.findMany({
    where: { venueId: vId, ...dateFilter, status: 'COMPLETED', ...mf },
    select: { id: true, method: true, cardBrand: true, processorData: true, amount: true, tipAmount: true },
    take: 1000,
  })
  const fees = await prisma.transactionCost.findMany({
    where: { payment: { venueId: vId, ...dateFilter, status: 'COMPLETED', ...mf } },
    select: { paymentId: true, venueChargeAmount: true, venueFixedFee: true },
    take: 1000,
  })
  const refunds = await prisma.payment.findMany({
    where: { venueId: vId, ...dateFilter, type: 'REFUND', ...mf },
    select: { method: true, cardBrand: true, processorData: true, amount: true, tipAmount: true },
    take: 1000,
  })
  const feeMap = new Map(fees.map(f => [f.paymentId, Number(f.venueChargeAmount) + Number(f.venueFixedFee ?? 0)]))
  type Acc = { amount: number; count: number; tips: number; refunds: number; platformFees: number }
  const newAcc = (): Acc => ({ amount: 0, count: 0, tips: 0, refunds: 0, platformFees: 0 })
  const buckets = new Map<string, Acc>()
  const subs = new Map<string, Acc>()
  const ensure = (m: Map<string, Acc>, k: string) => {
    if (!m.has(k)) m.set(k, newAcc())
    return m.get(k)!
  }
  for (const r of detail) {
    const intl = !!(r.processorData as { isInternational?: boolean } | null)?.isInternational
    const { bucket, sub } = bucketOf(r.method, r.cardBrand, intl)
    const amt = Number(r.amount)
    const tip = Number(r.tipAmount)
    const fee = feeMap.get(r.id) ?? 0
    const b = ensure(buckets, bucket)
    b.amount += amt + tip
    b.tips += tip
    b.count += 1
    b.platformFees += fee
    if (sub) {
      const s = ensure(subs, sub)
      s.amount += amt + tip
      s.tips += tip
      s.count += 1
      s.platformFees += fee
    }
  }
  for (const r of refunds) {
    const intl = !!(r.processorData as { isInternational?: boolean } | null)?.isInternational
    ensure(buckets, bucketOf(r.method, r.cardBrand, intl).bucket).refunds += Math.abs(Number(r.amount) + Number(r.tipAmount))
  }
  const grand = Array.from(buckets.values()).reduce((a, b) => a + b.amount, 0)
  const pct = (p: number, w: number) => (w > 0 ? Number(((p / w) * 100).toFixed(1)) : 0)
  return ['CARD', 'CASH', 'OTHER', 'QR_LEGACY']
    .filter(k => buckets.has(k))
    .map(k => {
      const b = buckets.get(k)!
      const e: PaymentMethodDetailedBreakdown = {
        bucket: k as PaymentMethodDetailedBreakdown['bucket'],
        amount: b.amount,
        count: b.count,
        percentage: pct(b.amount, grand),
        tips: b.tips,
        refunds: b.refunds,
        platformFees: b.platformFees,
      }
      if (k === 'CARD') {
        const list = ['CREDIT', 'DEBIT', 'AMEX', 'INTERNATIONAL']
          .filter(sk => subs.has(sk))
          .map(sk => {
            const s = subs.get(sk)!
            return {
              type: sk as 'CREDIT' | 'DEBIT' | 'AMEX' | 'INTERNATIONAL',
              amount: s.amount,
              count: s.count,
              percentage: pct(s.amount, b.amount),
              platformFees: s.platformFees,
            }
          })
        if (list.length > 0) e.subBuckets = list
      }
      return e
    })
}

/** Money compared to the cent: the old JS float sums carry 1e-13 noise the SQL sums do not. */
const cents = (rows: PaymentMethodDetailedBreakdown[] | undefined) =>
  JSON.parse(JSON.stringify(rows ?? null), (_k, v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v))

beforeAll(async () => {
  const org = await prisma.organization.create({
    data: { name: `PMD Org ${suffix}`, email: `${suffix}@example.test`, phone: '0000000000' },
    select: { id: true },
  })
  orgId = org.id
  venueId = (
    await prisma.venue.create({
      data: { organizationId: orgId, name: `pmd-${suffix}`, slug: `pmd-${suffix}`, timezone: TZ },
      select: { id: true },
    })
  ).id
  otherVenueId = (
    await prisma.venue.create({
      data: { organizationId: orgId, name: `pmd-other-${suffix}`, slug: `pmd-other-${suffix}`, timezone: TZ },
      select: { id: true },
    })
  ).id
  providerId = (
    await prisma.paymentProvider.create({
      data: { code: `PMD-${suffix}`, name: `P ${suffix}`, type: 'PAYMENT_PROCESSOR' },
      select: { id: true },
    })
  ).id
  aggregatorId = (await prisma.aggregator.create({ data: { name: `Agg ${suffix}`, baseFees: {} }, select: { id: true } })).id
  merchantA = (
    await prisma.merchantAccount.create({
      data: { providerId, externalMerchantId: `a-${suffix}`, credentialsEncrypted: {}, aggregatorId },
      select: { id: true },
    })
  ).id
  merchantB = (
    await prisma.merchantAccount.create({
      data: { providerId, externalMerchantId: `b-${suffix}`, credentialsEncrypted: {}, aggregatorId },
      select: { id: true },
    })
  ).id

  // CASH and OTHER
  await seed({ method: 'CASH', amount: 100.1, tip: 10.05 })
  await seed({ method: 'BANK_TRANSFER', amount: 60 })
  // CARD / CREDIT — no processorData, fee with a fixed part
  await seed({ method: 'CREDIT_CARD', amount: 200.33, tip: 20, cardBrand: 'VISA', merchant: merchantA, fee: { charge: 5.01, fixed: 1.5 } })
  // CARD / DEBIT — explicit false
  await seed({
    method: 'DEBIT_CARD',
    amount: 50,
    cardBrand: 'MASTERCARD',
    processorData: { isInternational: false },
    merchant: merchantA,
    fee: { charge: 1.25 },
  })
  // CARD / AMEX
  await seed({ method: 'CREDIT_CARD', amount: 300, cardBrand: 'AMERICAN_EXPRESS', merchant: merchantB, fee: { charge: 13.5 } })
  // CARD / INTERNATIONAL — boolean true, and the "true" string on an AMEX (international wins)
  await seed({
    method: 'DEBIT_CARD',
    amount: 80,
    cardBrand: 'VISA',
    processorData: { isInternational: true },
    merchant: merchantA,
    fee: { charge: 2.64 },
  })
  await seed({
    method: 'CREDIT_CARD',
    amount: 70,
    cardBrand: 'AMERICAN_EXPRESS',
    processorData: { isInternational: 'true' },
    merchant: merchantB,
  })
  // JS truthiness edges: "" and 0 are falsy (CREDIT); 1 and a non-empty object are truthy (INTERNATIONAL)
  await seed({ method: 'CREDIT_CARD', amount: 40, cardBrand: 'VISA', processorData: { isInternational: '' }, merchant: merchantA })
  await seed({ method: 'CREDIT_CARD', amount: 41, cardBrand: 'VISA', processorData: { isInternational: 0 }, merchant: merchantA })
  await seed({ method: 'CREDIT_CARD', amount: 42, cardBrand: 'VISA', processorData: { isInternational: 1 }, merchant: merchantA })
  await seed({
    method: 'CREDIT_CARD',
    amount: 43,
    cardBrand: 'VISA',
    processorData: { isInternational: { country: 'US' } },
    merchant: merchantA,
  })
  // Any non-empty string is truthy in JS — even "false" (a quirk of the old rule, kept as it was) → INTERNATIONAL
  await seed({ method: 'CREDIT_CARD', amount: 45, cardBrand: 'VISA', processorData: { isInternational: 'false' }, merchant: merchantA })
  // processorData that is not an object: JS reads `.isInternational` as undefined → CREDIT
  await seed({ method: 'CREDIT_CARD', amount: 44, cardBrand: 'VISA', processorData: ['x'], merchant: merchantA })
  // Excluded from the completed rows: PENDING, outside the range, other venue
  await seed({ method: 'CASH', amount: 30, status: 'PENDING' })
  await seed({ method: 'CASH', amount: 25, at: BEFORE })
  await seed({ venue: otherVenueId, method: 'CASH', amount: 999 })
  // Refunds: a COMPLETED card refund (also counted, negative, among the completed rows) and a PENDING cash one
  await seed({ method: 'CREDIT_CARD', amount: -50, tip: -5, type: 'REFUND', cardBrand: 'VISA', merchant: merchantA })
  await seed({ method: 'CASH', amount: -20, type: 'REFUND', status: 'PENDING' })
  // A refund stored POSITIVE in the same group: the magnitude is taken ROW BY ROW (|−20| + |10| = 30, not |−10|)
  await seed({ method: 'CASH', amount: 10, type: 'REFUND', status: 'PENDING' })
})

afterAll(async () => {
  if (!orgId) return
  const venues = [venueId, otherVenueId].filter(Boolean)
  await prisma.transactionCost.deleteMany({ where: { payment: { venueId: { in: venues } } } })
  await prisma.payment.deleteMany({ where: { venueId: { in: venues } } })
  await prisma.order.deleteMany({ where: { venueId: { in: venues } } })
  await prisma.merchantAccount.deleteMany({ where: { id: { in: [merchantA, merchantB].filter(Boolean) } } })
  if (aggregatorId) await prisma.aggregator.deleteMany({ where: { id: aggregatorId } })
  if (providerId) await prisma.paymentProvider.deleteMany({ where: { id: providerId } })
  await prisma.venue.deleteMany({ where: { id: { in: venues } } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
})

const base = () => ({ startDate: FROM.toISOString(), endDate: TO.toISOString(), timezone: TZ, groupBy: 'paymentMethod' as const })

describe('getSalesSummary — byPaymentMethodDetailed is aggregated in the database', () => {
  it('never hydrates payments without a bound (no payment.findMany without take)', async () => {
    const spy = jest.spyOn(prisma.payment, 'findMany')
    try {
      await getSalesSummary(venueId, base())
      const unbounded = spy.mock.calls.filter(([args]) => (args as { take?: number } | undefined)?.take === undefined)
      expect(unbounded).toEqual([])
    } finally {
      spy.mockRestore()
    }
  })

  it('equals the old per-row algorithm to the cent', async () => {
    const r = await getSalesSummary(venueId, base())
    expect(cents(r.byPaymentMethodDetailed)).toEqual(cents(await oldAlgorithm(venueId)))
  })

  it('pins the bucket rules on the seeded data', async () => {
    const r = await getSalesSummary(venueId, base())
    // Compared to the cent: bucket = amount + tip is a JS float addition (100.1 + 10.05), as it always was.
    const detailed: PaymentMethodDetailedBreakdown[] = cents(r.byPaymentMethodDetailed)
    const card = detailed.find(b => b.bucket === 'CARD')
    const sub = (t: string) => card?.subBuckets?.find(s => s.type === t)
    // CREDIT: 220.33 (VISA+tip) + 40 ("") + 41 (0) + 44 (array) − 55 (completed refund) = 290.33 in 5 rows
    expect(sub('CREDIT')).toEqual(expect.objectContaining({ count: 5, amount: 290.33, platformFees: 6.51 }))
    expect(sub('DEBIT')).toEqual(expect.objectContaining({ count: 1, amount: 50, platformFees: 1.25 }))
    expect(sub('AMEX')).toEqual(expect.objectContaining({ count: 1, amount: 300, platformFees: 13.5 }))
    // INTERNATIONAL: 80 (true) + 70 ("true" on AMEX) + 42 (1) + 43 (object) + 45 ("false" — a non-empty string)
    expect(sub('INTERNATIONAL')).toEqual(expect.objectContaining({ count: 5, amount: 280, platformFees: 2.64 }))
    expect(card).toEqual(expect.objectContaining({ refunds: 55, tips: 15 }))
    const cash = detailed.find(b => b.bucket === 'CASH')
    expect(cash).toEqual(expect.objectContaining({ count: 1, amount: 110.15, tips: 10.05, refunds: 30, platformFees: 0 }))
    expect(detailed.find(b => b.bucket === 'OTHER')).toEqual(expect.objectContaining({ count: 1, amount: 60 }))
  })

  it('respects the merchant filter exactly like the old algorithm', async () => {
    const r = await getSalesSummary(venueId, { ...base(), merchantAccountId: merchantB })
    expect(cents(r.byPaymentMethodDetailed)).toEqual(cents(await oldAlgorithm(venueId, merchantB)))
    expect(r.byPaymentMethodDetailed?.map(b => b.bucket)).toEqual(['CARD'])
  })

  it('an empty range yields an empty breakdown, not an error', async () => {
    const r = await getSalesSummary(venueId, {
      ...base(),
      startDate: '2020-01-01T06:00:00.000Z',
      endDate: '2020-01-02T05:59:59.999Z',
    })
    expect(r.byPaymentMethodDetailed).toEqual([])
  })
})
