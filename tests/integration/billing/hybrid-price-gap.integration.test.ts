import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { hybridPeriodInvalid } from '@/services/launchCampaigns/hybridDelivery.service'
import { periodFundedSql, priceGapSummary, priceGapVenues } from '@/services/launchCampaigns/hybridPriceGap.service'
import { hybridHash } from '@/services/launchCampaigns/hybridProvider'

const stamp = `${Date.now()}${process.pid}`
// Campaign codes, Stripe item ids and subscription ids of this suite carry these prefixes: a crashed run's leftovers are
// retired by them on the next run (contracts and periods cannot be deleted, so they are ended instead).
const PREFIX = 'PRICEGAP'
const ITEM = 'si_gap_'
// Products no other suite prices on the shared disposable DB (CFDI, LOYALTY_PROGRAM, SERIALIZED_INVENTORY… belong to others).
const P = 'DELIVERY_CHANNELS' // the 13 cases of the brief, list 699
const Q = 'RESERVATIONS' // 101 rows (page clamp) + a REPRICE whose two amounts are equal, list 699
const NO_LIST = 'GAP_NO_LIST' // a function without a LIST: no notice
const OURS = [P, Q].map(code => `FEATURE:${code}`)
const hour = 3600000
const day = 24 * hour
const PERIOD_START = new Date(Date.now() - 5 * day)
const PERIOD_END = new Date(Date.now() + 25 * day)
let staffId: string
let n = 0
const next = () => `${stamp}_${++n}`

type Renewal = { kind: 'SAME_PRICE' } | { kind: 'REPRICE'; price: number } | { kind: 'END' }
type Definition = { terms: { renewal: Renewal } }
const terms = (price: number, renewal: Renewal = { kind: 'SAME_PRICE' }, promotionCycles: number | null = null) => ({
  currency: 'MXN',
  interval: 'MONTHLY',
  price,
  taxIncluded: true,
  promotionCycles,
  renewal,
})
const features = (code: string, t: ReturnType<typeof terms>) => ({ schemaVersion: 1, kind: 'FEATURES', featureCodes: [code], terms: t })

interface Pub {
  id: string
  stripePriceId: string
  stripeRenewalPriceId: string | null
  codes: string[]
}

async function campaign(purpose: 'LIST' | 'PROMOTION', listCode?: string) {
  const id = next()
  return prisma.hybridCampaign.create({
    data: {
      code: `${PREFIX}${id}`,
      slug: `price-gap-${id}`,
      name: `Tarifa anterior ${id}`,
      draftDefinition: {},
      purpose,
      startsAt: new Date(Date.now() - 400 * day),
      endsAt: purpose === 'LIST' ? null : new Date(Date.now() + 30 * day),
      capacity: purpose === 'LIST' ? null : 1000,
      listProductKey: purpose === 'LIST' ? `FEATURE:${listCode}` : null,
      audience: 'ALL',
      listed: false,
      status: 'ACTIVE',
      createdById: staffId,
    },
  })
}

async function publish(campaignId: string, version: number, definition: Definition, codes: string[]): Promise<Pub> {
  const id = next()
  const row = await prisma.hybridOfferPublication.create({
    data: {
      campaignId,
      version,
      name: `Tarifa anterior ${id}`,
      definition,
      definitionHash: hybridHash(definition),
      includedFeatureCodes: codes,
      createdById: staffId,
      stripeProductId: `prod_gap_${id}`,
      stripePriceId: `price_gap_${id}`,
      stripeRenewalPriceId: definition.terms.renewal.kind === 'REPRICE' ? `price_gap_renewal_${id}` : null,
    },
  })
  return { id: row.id, stripePriceId: row.stripePriceId!, stripeRenewalPriceId: row.stripeRenewalPriceId, codes }
}

async function promotion(definition: Definition, codes: string[]) {
  const row = await campaign('PROMOTION')
  const pub = await publish(row.id, 1, definition, codes)
  await prisma.hybridCampaign.update({ where: { id: row.id }, data: { currentPublicationId: pub.id } })
  return pub
}

async function venue(label: string) {
  const id = next()
  const org = await prisma.organization.create({
    data: { name: `Org ${label} ${id}`, email: `gap-${id}@example.test`, phone: '5550000000' },
  })
  const row = await prisma.venue.create({ data: { organizationId: org.id, name: `${label} ${id}`, slug: `gap-${id}`.replace(/_/g, '-') } })
  return { id: row.id, name: row.name, organizationName: org.name }
}

interface ContractInput {
  venueId: string
  pub: Pub
  /** The contract's line amount in its period (composition). */
  amount: string
  /** The period's line is the renewal Price (the REPRICE already happened). */
  renewed?: boolean
  /** A line Price that belongs to no price of this contract's publication. */
  foreignPriceId?: string
  featureCodes?: string[]
  startsAt?: Date
  endedAt?: Date
  period?: false | { funded?: string; refunded?: string; disputed?: boolean }
  grant?: 'LIVE' | 'REVOKED' | false
  /** Join an existing subscription and its period WITHOUT a line of its own (the grant still points at that period). */
  shared?: { subscriptionId: string; periodId: string }
}

/** One contract with its purchase, period and grant, written directly: the report reads rows, not the services that wrote them. */
async function contract(input: ContractInput) {
  const id = next()
  const subscriptionId = input.shared?.subscriptionId ?? `sub_gap_${id}`
  const featureCodes = input.featureCodes ?? input.pub.codes
  const purchase = await prisma.hybridPurchase.create({
    data: {
      venueId: input.venueId,
      quotedById: staffId,
      quote: {},
      quoteHash: `gap_${id}`,
      quoteExpiresAt: new Date(Date.now() + hour),
      status: 'COMPLETED',
      ...(input.shared ? {} : { stripeSubscriptionId: subscriptionId }),
    },
  })
  const row = await prisma.hybridContract.create({
    data: {
      venueId: input.venueId,
      purchaseId: purchase.id,
      publicationId: input.pub.id,
      stripeSubscriptionId: subscriptionId,
      stripeItemId: `${ITEM}${id}`,
      featureCodes,
      startsAt: input.startsAt ?? new Date(Date.now() - 20 * day),
      endedAt: input.endedAt ?? null,
    },
  })
  let periodId = input.shared?.periodId
  if (!input.shared && input.period !== false) {
    const period = await prisma.hybridPaymentPeriod.create({
      data: {
        venueId: input.venueId,
        stripeSubscriptionId: subscriptionId,
        stripeInvoiceId: `in_gap_${id}`,
        startsAt: PERIOD_START,
        endsAt: PERIOD_END,
        fundedAmount: input.period?.funded ?? input.amount,
        refundedAmount: input.period?.refunded ?? '0',
        disputed: input.period?.disputed ?? false,
        composition: [
          {
            contractId: row.id,
            itemId: `${ITEM}${id}`,
            featureCodes,
            priceId: input.foreignPriceId ?? (input.renewed ? input.pub.stripeRenewalPriceId! : input.pub.stripePriceId),
            amount: input.amount,
          },
        ],
      },
    })
    periodId = period.id
  }
  if (periodId && input.grant !== false)
    await prisma.capabilityGrant.create({
      data: {
        venueId: input.venueId,
        featureCode: featureCodes[0],
        sourceId: `${periodId}:${row.id}`,
        contractId: row.id,
        paymentPeriodId: periodId,
        startsAt: PERIOD_START,
        endsAt: PERIOD_END,
        revokedAt: input.grant === 'REVOKED' ? new Date() : null,
      },
    })
  return { contractId: row.id, subscriptionId, periodId: periodId ?? null, startsAt: row.startsAt }
}

/** Free our list keys and end everything of this suite (publications, purchases and periods cannot be deleted). */
async function retire() {
  const lists = await prisma.hybridCampaign.findMany({
    where: { purpose: 'LIST', listProductKey: { in: OURS }, code: { startsWith: PREFIX } },
    select: { id: true },
    take: 10,
  })
  for (const { id } of lists)
    await prisma.hybridCampaign.update({ where: { id }, data: { listProductKey: `FEATURE:RETIRED_${id}`, status: 'PAUSED' } })
  await prisma.hybridCampaign.updateMany({
    where: { code: { startsWith: PREFIX }, purpose: 'PROMOTION', status: { not: 'ENDED' } },
    data: { status: 'ENDED' },
  })
  await prisma.capabilityGrant.updateMany({
    where: { contract: { stripeItemId: { startsWith: ITEM } }, revokedAt: null },
    data: { revokedAt: new Date() },
  })
  await prisma.hybridContract.updateMany({ where: { stripeItemId: { startsWith: ITEM }, endedAt: null }, data: { endedAt: new Date() } })
}

/** A start whose day exists in every month, so «start + N months» has one obvious answer in the test. */
function safeStart(daysAgo: number) {
  const date = new Date(Date.now() - daysAgo * day)
  date.setUTCDate(Math.min(date.getUTCDate(), 28))
  return date
}
const plusMonths = (date: Date, months: number) =>
  new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth() + months,
      date.getUTCDate(),
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds(),
    ),
  )

type Venue = Awaited<ReturnType<typeof venue>>
interface Counted {
  contractId: string
  venue: Venue
  gap: number
  reason: string
}
const counted: Counted[] = [] // P rows the venues list must return
const v: Record<string, Venue> = {}
let tempStart: Date
let endStart: Date
let equalPromo: Pub
let equalA: Awaited<ReturnType<typeof contract>>
let equalB: Awaited<ReturnType<typeof contract>>

beforeAll(async () => {
  if (!/test|hybrid/i.test(new URL(process.env.TEST_DATABASE_URL!).pathname)) throw new Error('Disposable DB required')
  await retire()
  staffId = (await prisma.staff.create({ data: { email: `gap-${stamp}@example.test`, firstName: 'Hybrid', lastName: 'Test' } })).id

  // P: a LIST that went 799 → 599 → 699 (current), and the promotions of the five reasons.
  const listP = await campaign('LIST', P)
  const list799 = await publish(listP.id, 1, features(P, terms(799)), [P])
  const list599 = await publish(listP.id, 2, features(P, terms(599)), [P])
  const list699 = await publish(listP.id, 3, features(P, terms(699)), [P])
  await prisma.hybridCampaign.update({ where: { id: listP.id }, data: { currentPublicationId: list699.id } })
  const forever = await promotion(features(P, terms(479.2)), [P])
  const temporary = await promotion(features(P, terms(479.2, { kind: 'REPRICE', price: 599 }, 3)), [P])
  const ending = await promotion(features(P, terms(300, { kind: 'END' }, 2)), [P])
  const choiceOfOne = { schemaVersion: 1, kind: 'CHOICE_BUNDLE', eligibleFeatureCodes: [P, Q], choiceCount: 1, terms: terms(400) }
  const bundle = await promotion(choiceOfOne, [P, Q])
  for (const label of [
    'Old',
    'Forever',
    'Temporary',
    'Renewed',
    'Ending',
    'Equal',
    'Above',
    'Bundle',
    'Ended',
    'Refunded',
    'Disputed',
    'NoPeriod',
    'Twice',
    'Revoked',
    'ForeignPrice',
    'NoList',
  ])
    v[label] = await venue(label)
  const count = async (venueKey: string, gap: number, reason: string, input: Omit<ContractInput, 'venueId'>) => {
    const row = await contract({ venueId: v[venueKey].id, ...input })
    counted.push({ contractId: row.contractId, venue: v[venueKey], gap, reason })
    return row
  }
  tempStart = safeStart(10)
  endStart = safeStart(12)
  // 1-5: the five reasons.
  await count('Old', 100, 'OLD_LIST', { pub: list599, amount: '599.00' })
  const foreverRow = await count('Forever', 219.8, 'PROMO_FOREVER', { pub: forever, amount: '479.20' })
  await count('Temporary', 219.8, 'PROMO_TEMPORARY', { pub: temporary, amount: '479.20', startsAt: tempStart })
  await count('Renewed', 100, 'RENEWED_OLD_LIST', { pub: temporary, amount: '599.00', renewed: true })
  await count('Ending', 399, 'PROMO_ENDING', { pub: ending, amount: '300.00', startsAt: endStart })
  // 6: equal to the list.
  await contract({ venueId: v.Equal.id, pub: list699, amount: '699.00' })
  // 12b: rides on Forever's subscription with the SAME Price and a live grant, but no line of its own in the period.
  await contract({
    venueId: v.Forever.id,
    pub: forever,
    amount: '479.20',
    shared: { subscriptionId: foreverRow.subscriptionId, periodId: foreverRow.periodId! },
  })
  // 7: pays more than today's list (the 799 before a drop).
  await contract({ venueId: v.Above.id, pub: list799, amount: '799.00' })
  // 8: a CHOICE_BUNDLE of one code.
  await contract({ venueId: v.Bundle.id, pub: bundle, amount: '400.00', featureCodes: [P] })
  // 9: replaced (ended), although its period still covers today and its grant is live.
  await contract({ venueId: v.Ended.id, pub: forever, amount: '479.20', endedAt: new Date(Date.now() - hour) })
  // 10: fully refunded.
  await contract({ venueId: v.Refunded.id, pub: forever, amount: '479.20', period: { refunded: '479.20' } })
  // 11: open dispute.
  await contract({ venueId: v.Disputed.id, pub: forever, amount: '479.20', period: { disputed: true } })
  // 12a: accepted, never charged: no period, no grant.
  await contract({ venueId: v.NoPeriod.id, pub: forever, amount: '479.20', period: false })
  // 13: two contracts of the same venue.
  await count('Twice', 100, 'OLD_LIST', { pub: list599, amount: '599.00' })
  await count('Twice', 219.8, 'PROMO_FOREVER', { pub: forever, amount: '479.20' })
  // Access revoked (grant), everything else counts.
  await contract({ venueId: v.Revoked.id, pub: forever, amount: '479.20', grant: 'REVOKED' })
  // Its period line carries a Price of another publication: not this contract's rate.
  await contract({ venueId: v.ForeignPrice.id, pub: forever, amount: '479.20', foreignPriceId: temporary.stripePriceId })
  // A function without a LIST.
  const noList = await promotion(features(NO_LIST, terms(100)), [NO_LIST])
  await contract({ venueId: v.NoList.id, pub: noList, amount: '100.00' })

  // Q: 101 contracts at 479.20 on one venue (bulk) + a REPRICE whose initial and renewal amounts are equal (500 → 500).
  const listQ = await campaign('LIST', Q)
  const listQ699 = await publish(listQ.id, 1, features(Q, terms(699)), [Q])
  await prisma.hybridCampaign.update({ where: { id: listQ.id }, data: { currentPublicationId: listQ699.id } })
  const bulkPromo = await promotion(features(Q, terms(479.2)), [Q])
  equalPromo = await promotion(features(Q, terms(500, { kind: 'REPRICE', price: 500 }, 3)), [Q])
  v.Bulk = await venue('Bulk')
  v.EqualA = await venue('EqualA')
  v.EqualB = await venue('EqualB')
  const bulk = Array.from({ length: 101 }, (_, i) => `gapbulk${stamp}x${String(i).padStart(3, '0')}`)
  const bulkStart = new Date(Date.now() - 20 * day)
  await prisma.hybridPurchase.createMany({
    data: bulk.map(id => ({
      id: `p${id}`,
      venueId: v.Bulk.id,
      quotedById: staffId,
      quote: {},
      quoteHash: id,
      quoteExpiresAt: new Date(Date.now() + hour),
      status: 'COMPLETED',
      stripeSubscriptionId: `sub_gap_${id}`,
    })),
  })
  await prisma.hybridContract.createMany({
    data: bulk.map(id => ({
      id: `k${id}`,
      venueId: v.Bulk.id,
      purchaseId: `p${id}`,
      publicationId: bulkPromo.id,
      stripeSubscriptionId: `sub_gap_${id}`,
      stripeItemId: `${ITEM}${id}`,
      featureCodes: [Q],
      startsAt: bulkStart,
    })),
  })
  await prisma.hybridPaymentPeriod.createMany({
    data: bulk.map(id => ({
      id: `pp${id}`,
      venueId: v.Bulk.id,
      stripeSubscriptionId: `sub_gap_${id}`,
      stripeInvoiceId: `in_gap_${id}`,
      startsAt: PERIOD_START,
      endsAt: PERIOD_END,
      fundedAmount: '479.20',
      composition: [
        { contractId: `k${id}`, itemId: `${ITEM}${id}`, featureCodes: [Q], priceId: bulkPromo.stripePriceId, amount: '479.20' },
      ],
    })),
  })
  await prisma.capabilityGrant.createMany({
    data: bulk.map(id => ({
      venueId: v.Bulk.id,
      featureCode: Q,
      sourceId: `pp${id}:k${id}`,
      contractId: `k${id}`,
      paymentPeriodId: `pp${id}`,
      startsAt: PERIOD_START,
      endsAt: PERIOD_END,
    })),
  })
  equalA = await contract({ venueId: v.EqualA.id, pub: equalPromo, amount: '500.00', startsAt: tempStart })
  equalB = await contract({ venueId: v.EqualB.id, pub: equalPromo, amount: '500.00', renewed: true })
}, 240000)

afterAll(async () => {
  await retire()
})

const rowOf = (rows: Awaited<ReturnType<typeof priceGapSummary>>, key: string) => rows.filter(row => row.productKey === key)

describe('price gap notice (spec §6.3)', () => {
  it('sums only rates below the list, counts venues once, and keeps above-list and bundles on their own lines', async () => {
    const rows = await priceGapSummary()
    expect(rowOf(rows, `FEATURE:${P}`)).toEqual([
      // Old 100 + Forever 219.80 + Temporary 219.80 + Renewed 100 + Ending 399 + Twice (100 + 219.80)
      { productKey: `FEATURE:${P}`, venues: 6, monthlyGap: '1358.40', aboveListVenues: 1, bundleVenues: 1 },
    ])
    expect(rowOf(rows, `FEATURE:${Q}`)).toEqual([
      // 101 × 219.80 + 2 × 199
      { productKey: `FEATURE:${Q}`, venues: 3, monthlyGap: '22597.80', aboveListVenues: 0, bundleVenues: 0 },
    ])
  })

  it('a function without a LIST has no notice', async () => {
    const rows = await priceGapSummary()
    expect(rowOf(rows, `FEATURE:${NO_LIST}`)).toEqual([])
  })

  it('lists who pays less, by gap then contract, with the reason and when it changes', async () => {
    const { items, total } = await priceGapVenues(`FEATURE:${P}`, 1, 100)
    const expected = [...counted].sort((a, b) => b.gap - a.gap || (a.contractId < b.contractId ? -1 : 1))
    expect(total).toBe(7)
    expect(items.map(item => [item.contractId, item.venueId, item.reason])).toEqual(
      expected.map(row => [row.contractId, row.venue.id, row.reason]),
    )
    const byReason = (reason: string, venueId: string) => items.find(item => item.reason === reason && item.venueId === venueId)!
    expect(byReason('OLD_LIST', v.Old.id)).toEqual({
      contractId: counted.find(row => row.venue === v.Old)!.contractId,
      venueId: v.Old.id,
      venueName: v.Old.name,
      organizationName: v.Old.organizationName,
      rate: '599.00',
      listPrice: '699.00',
      gap: '100.00',
      since: expect.any(String),
      reason: 'OLD_LIST',
      reasonUntil: null,
    })
    expect(byReason('PROMO_FOREVER', v.Forever.id)).toMatchObject({ rate: '479.20', gap: '219.80', reasonUntil: null })
    expect(byReason('PROMO_TEMPORARY', v.Temporary.id)).toMatchObject({
      rate: '479.20',
      gap: '219.80',
      since: tempStart.toISOString(),
      reasonUntil: plusMonths(tempStart, 3).toISOString(),
    })
    expect(byReason('RENEWED_OLD_LIST', v.Renewed.id)).toMatchObject({ rate: '599.00', gap: '100.00', reasonUntil: null })
    expect(byReason('PROMO_ENDING', v.Ending.id)).toMatchObject({
      rate: '300.00',
      gap: '399.00',
      reasonUntil: plusMonths(endStart, 2).toISOString(),
    })
    for (const excluded of ['Equal', 'Above', 'Bundle', 'Ended', 'Refunded', 'Disputed', 'NoPeriod', 'Revoked', 'ForeignPrice'])
      expect(items.some(item => item.venueId === v[excluded].id)).toBe(false)
  })

  it('pages with an exact total, and a page past the end is empty', async () => {
    const all = (await priceGapVenues(`FEATURE:${P}`, 1, 100)).items
    const pages = await Promise.all([1, 2, 3, 4].map(page => priceGapVenues(`FEATURE:${P}`, page, 3)))
    expect(pages.map(page => page.total)).toEqual([7, 7, 7, 7])
    expect(pages.map(page => page.items.length)).toEqual([3, 3, 1, 0])
    expect(pages.flatMap(page => page.items)).toEqual(all)
    expect(await priceGapVenues('FEATURE:UNKNOWN_PRODUCT', 1, 10)).toEqual({ items: [], total: 0 })
  })

  it('clamps a non-finite or huge page at the source: an empty page with the exact total, never an error', async () => {
    for (const page of [Infinity, 1e12]) expect(await priceGapVenues(`FEATURE:${P}`, page, 3)).toEqual({ items: [], total: 7 })
    expect(await priceGapVenues(`FEATURE:${P}`, NaN, 3)).toEqual(await priceGapVenues(`FEATURE:${P}`, 1, 3))
  })

  it('clamps a hostile page size to 100 and a page below 1 to the first, keeping the total exact', async () => {
    const hostile = await priceGapVenues(`FEATURE:${Q}`, 0, 10_000)
    expect(hostile.total).toBe(103)
    expect(hostile.items).toHaveLength(100)
    expect(hostile.items.every(item => item.gap === '219.80')).toBe(true)
    expect(hostile).toEqual(await priceGapVenues(`FEATURE:${Q}`, 1, 100))
    const second = await priceGapVenues(`FEATURE:${Q}`, 2, 100)
    expect(second.total).toBe(103)
    expect(second.items.map(item => item.gap)).toEqual(['219.80', '199.00', '199.00'])
  })

  it('decides the REPRICE phase by Price, not by amount (both amounts equal)', async () => {
    const { items } = await priceGapVenues(`FEATURE:${Q}`, 2, 100)
    expect(items.find(item => item.venueId === v.EqualA.id)).toMatchObject({
      rate: '500.00',
      gap: '199.00',
      reason: 'PROMO_TEMPORARY',
      reasonUntil: plusMonths(equalA.startsAt, 3).toISOString(),
    })
    expect(items.find(item => item.venueId === v.EqualB.id)).toMatchObject({
      rate: '500.00',
      gap: '199.00',
      reason: 'RENEWED_OLD_LIST',
      reasonUntil: null,
    })
    expect(equalB.contractId).not.toBe(equalA.contractId)
    expect(equalPromo.stripeRenewalPriceId).not.toBe(equalPromo.stripePriceId)
  })

  it('«financed» in SQL agrees with the delivery: healthy, refunded, disputed, under-funded and the boundaries', async () => {
    const parity = await venue('Parity')
    const cases = [
      { name: 'healthy', funded: '600.00', refunded: '0.00', disputed: false, expected: true },
      { name: 'refunded', funded: '500.00', refunded: '500.00', disputed: false, expected: false },
      { name: 'disputed', funded: '500.00', refunded: '0.00', disputed: true, expected: false },
      { name: 'under-funded', funded: '499.99', refunded: '0.00', disputed: false, expected: false },
      { name: 'exactly funded, partly refunded', funded: '500.00', refunded: '100.00', disputed: false, expected: true },
      { name: 'refunded one cent short', funded: '500.00', refunded: '499.99', disputed: false, expected: true },
    ]
    const ids: string[] = []
    for (const row of cases) {
      const id = next()
      const period = await prisma.hybridPaymentPeriod.create({
        data: {
          venueId: parity.id,
          stripeSubscriptionId: `sub_gap_${id}`,
          stripeInvoiceId: `in_gap_${id}`,
          startsAt: PERIOD_START,
          endsAt: PERIOD_END,
          fundedAmount: row.funded,
          refundedAmount: row.refunded,
          disputed: row.disputed,
          composition: [
            { contractId: `x${id}`, itemId: `${ITEM}${id}a`, featureCodes: [P], priceId: `price_gap_${id}a`, amount: '300.00' },
            { contractId: `y${id}`, itemId: `${ITEM}${id}b`, featureCodes: [Q], priceId: `price_gap_${id}b`, amount: '200.00' },
          ],
        },
      })
      ids.push(period.id)
    }
    const sql = await prisma.$queryRaw<{ id: string; funded: boolean }[]>(
      Prisma.sql`SELECT pp.id, ${periodFundedSql('pp')} AS funded FROM "HybridPaymentPeriod" pp WHERE pp.id = ANY(${ids}::text[])`,
    )
    const stored = await prisma.hybridPaymentPeriod.findMany({ where: { id: { in: ids } }, take: ids.length })
    for (const [index, id] of ids.entries()) {
      const period = stored.find(row => row.id === id)!
      // The delivery's own computation (hybridDelivery.service): expected = sum of the composition amounts.
      const composition = period.composition as Array<{ amount: string }>
      const expected = composition.reduce((sum, line) => sum.add(line.amount), new Prisma.Decimal(0))
      const delivery = !hybridPeriodInvalid(
        { funded: period.fundedAmount, refunded: period.refundedAmount, disputed: period.disputed },
        expected,
      )
      const inSql = sql.find(row => row.id === id)!.funded
      expect({ name: cases[index].name, delivery, inSql }).toEqual({
        name: cases[index].name,
        delivery: cases[index].expected,
        inSql: cases[index].expected,
      })
    }
    await prisma.hybridPaymentPeriod.deleteMany({ where: { id: { in: ids } } }) // no grant points at them
  })
})
