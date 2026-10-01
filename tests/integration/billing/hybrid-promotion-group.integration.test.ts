import prisma from '@/utils/prismaClient'
jest.mock('@/services/access/inventarioDeObligaciones', () => ({
  inventarioDeObligaciones: jest.fn(async () => ({ vivas: [], detalle: {}, conCambiosProgramados: [] })),
}))
// A fake Stripe price book: the REAL `ensureHybridPublicationPrices` runs against it, so the amount it derives from each
// publication (Review Focus 3: $479.20 = 47920 cents) is observable on `prices.create`.
jest.mock('@/services/stripe.service', () => {
  const book = new Map<string, Record<string, unknown>>()
  return {
    stripe: {
      prices: {
        list: jest.fn(async ({ lookup_keys }: { lookup_keys: string[] }) => ({
          data: lookup_keys.flatMap(key => (book.has(key) ? [book.get(key)] : [])),
          has_more: false,
        })),
        create: jest.fn(async (params: Record<string, any>) => {
          const price = {
            id: `price_${params.lookup_key}`,
            active: true,
            unit_amount: params.unit_amount,
            currency: params.currency,
            tax_behavior: params.tax_behavior,
            recurring: { interval: 'month', interval_count: 1 },
            metadata: params.metadata,
            product: params.product ?? `prod_${params.metadata.publicationId}`,
          }
          book.set(params.lookup_key, price)
          return price
        }),
      },
      customers: { retrieve: jest.fn(async (id: string) => ({ id, balance: 0 })) },
      checkout: { sessions: { list: jest.fn(async () => ({ data: [], has_more: false })) } },
    },
    STRIPE_DENTRO_DEL_CANDADO: { timeout: 15000, maxNetworkRetries: 0 },
  }
})
import { stripe } from '@/services/stripe.service'
import { compileHybridPublication } from '@/services/launchCampaigns/hybridOffer.service'
import { hybridOfferDefinition } from '@/services/launchCampaigns/hybridOffer.schema'
import { saveListPrice } from '@/services/launchCampaigns/hybridListPrice.service'
import { acceptHybridQuote, createHybridQuote } from '@/services/launchCampaigns/hybridPurchase.service'
import {
  createPercentPromotion,
  previewPercentPromotion,
  recalculatePromotionGroup,
  setPromotionGroupStatus,
} from '@/services/launchCampaigns/hybridPromotionGroup.service'

const stamp = `${Date.now()}${process.pid}`
// Every group of this suite is named with this prefix: a crashed run's groups are ended by it, so their ACTIVE promotions
// never block a later run's list prices on the shared disposable DB.
const PREFIX = 'PGT '
// Products no other suite prices (CFDI, LOYALTY_PROGRAM and AUTO_REORDER belong to other suites); same roles as the plan.
const MAIN = 'ONLINE_ORDERING' // the plan's CFDI: list 599
const CHEAP = 'CUSTOMER_CAMPAIGNS' // the plan's LOYALTY_PROGRAM: list 20
const NO_LIST = 'REFERRAL_PROGRAM'
const DEPENDENT = 'UPSELL_AI' // requires UPSELL (the plan's AUTO_REORDER → INVENTORY_TRACKING)
const FOREVER = 'AI_ASSISTANT_BUBBLE'
const RACE = 'TABLE_SERVICE'
const FIRST = 'SCALE_INTEGRATION' // sorts before SECOND: the group locks and writes FIRST, then SECOND
const SECOND = 'VARIABLE_WEIGHT_BARCODE'
const OURS = [MAIN, CHEAP, NO_LIST, DEPENDENT, FOREVER, RACE, FIRST, SECOND]
const LISTS: Record<string, number> = {
  [MAIN]: 599,
  [CHEAP]: 20,
  [DEPENDENT]: 349,
  [FOREVER]: 199,
  [RACE]: 599,
  [FIRST]: 199,
  [SECOND]: 299,
}
const minute = 60000
let staffId: string
let venueId: string
let n = 0

const settle = <T>(promise: Promise<T>) =>
  promise.then(
    value => ({ value, error: null as unknown }),
    error => ({ value: null, error: error as unknown }),
  )
const campaign = (id: string) => prisma.hybridCampaign.findUniqueOrThrow({ where: { id } })
const group = (id: string) => prisma.hybridPromotionGroup.findUniqueOrThrow({ where: { id } })
const termsOf = async (campaignId: string) =>
  hybridOfferDefinition.parse(
    (await prisma.hybridOfferPublication.findUniqueOrThrow({ where: { id: (await campaign(campaignId)).currentPublicationId! } }))
      .definition,
  ).terms
const savePrice = async (code: string, price: number) =>
  saveListPrice(
    {
      productKey: `FEATURE:${code}`,
      price,
      expectedRevision:
        (await prisma.hybridCampaign.findFirst({ where: { purpose: 'LIST', listProductKey: `FEATURE:${code}` } }))?.revision ?? null,
    },
    staffId,
  )
const body = (featureCodes: string[], percentOff: number, promotionCycles: number | null, capacityPerFeature = 10) => ({
  name: `${PREFIX}${stamp} ${++n}`,
  percentOff,
  target: { kind: 'FEATURES', featureCodes },
  startsAt: new Date(Date.now() - minute).toISOString(),
  endsAt: new Date(Date.now() + 7 * 24 * 60 * minute).toISOString(),
  promotionCycles,
  capacityPerFeature,
})
const setStatus = async (groupId: string, status: 'ACTIVE' | 'PAUSED' | 'ENDED') =>
  setPromotionGroupStatus(groupId, { status, expectedRevision: (await group(groupId)).revision }, staffId)

async function waitsOnAdvisoryLock(other: Promise<unknown>) {
  let settled = false
  void other.finally(() => (settled = true))
  const deadline = Date.now() + 10000
  while (!settled && Date.now() < deadline) {
    const rows = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()
      AND wait_event_type = 'Lock' AND wait_event = 'advisory' AND query LIKE '%pg_advisory_xact_lock(hashtext(%'`
    if (Number(rows[0].count) > 0) return true
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return false
}

/**
 * Holds `precio:FEATURE:<code>` from another connection while `action` starts; once it waits on that lock, `meanwhile`
 * runs inside the holder (same transaction) and the holder commits. Both sides are settled before returning.
 */
async function whileHoldingProduct<T>(code: string, action: () => Promise<T>, meanwhile: (tx: any) => Promise<void> = async () => {}) {
  let release!: () => void
  let entered!: () => void
  const held = new Promise<void>(resolve => (release = resolve))
  const locked = new Promise<void>(resolve => (entered = resolve))
  const holder = settle(
    prisma.$transaction(
      async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`precio:FEATURE:${code}`}))`
        entered()
        await held
        await meanwhile(tx)
      },
      { timeout: 30000 },
    ),
  )
  await locked
  const result = settle(action())
  let waited = false
  try {
    waited = await waitsOnAdvisoryLock(result)
  } finally {
    release()
  }
  const [holderResult, actionResult] = await Promise.all([holder, result])
  expect(holderResult.error).toBeNull()
  return { waited, ...actionResult }
}

/** Lists are never deleted (their publications cannot be): free the product key; end every group of this suite. */
async function retire() {
  const rows = await prisma.hybridCampaign.findMany({
    where: {
      purpose: 'LIST',
      OR: [{ listProductKey: { in: OURS.map(code => `FEATURE:${code}`) } }, { code: { in: OURS.map(code => `L_${code}`) } }],
    },
    select: { id: true },
    take: 20,
  })
  for (const { id } of rows)
    await prisma.hybridCampaign.update({
      where: { id },
      data: { listProductKey: `FEATURE:RETIRED_${id}`, code: `RETIRED_${id}`, slug: `retired-${id}`, status: 'PAUSED' },
    })
  const groups = await prisma.hybridPromotionGroup.findMany({
    where: { name: { startsWith: PREFIX }, status: { not: 'ENDED' } },
    select: { id: true },
    take: 500,
  })
  const ids = groups.map(g => g.id)
  await prisma.hybridCampaign.updateMany({ where: { promotionGroupId: { in: ids } }, data: { status: 'ENDED' } })
  await prisma.hybridPromotionGroup.updateMany({ where: { id: { in: ids } }, data: { status: 'ENDED' } })
}

beforeAll(async () => {
  if (!/test|hybrid/i.test(new URL(process.env.TEST_DATABASE_URL!).pathname)) throw new Error('Disposable DB required')
  delete process.env.HYBRID_BILLING_ENABLED
  await retire()
  staffId = (await prisma.staff.create({ data: { email: `pgroup-${stamp}@example.test`, firstName: 'Hybrid', lastName: 'Test' } })).id
  const org = await prisma.organization.create({ data: { name: stamp, email: `pgroup-${stamp}@example.test`, phone: '5550000000' } })
  venueId = (
    await prisma.venue.create({
      data: { organizationId: org.id, name: stamp, slug: `pgroup-${stamp}`, stripeCustomerId: `cus_pgroup_${stamp}` },
    })
  ).id
  for (const [code, price] of Object.entries(LISTS)) await savePrice(code, price)
})
afterAll(async () => {
  await retire()
  delete process.env.HYBRID_BILLING_ENABLED
})

it('(1) the preview marks every function: on sale, under $10 (blocks) and without a list (omitted)', async () => {
  const input = body([MAIN, CHEAP, NO_LIST], 90, 3)
  const preview = await previewPercentPromotion(input)
  expect(preview).toEqual({
    creatable: false,
    rows: [
      { featureCode: CHEAP, name: expect.any(String), listPrice: 20, price: 2, renewalPrice: 20, status: 'BELOW_MINIMUM', requires: [] },
      { featureCode: MAIN, name: expect.any(String), listPrice: 599, price: 59.9, renewalPrice: 599, status: 'OK', requires: [] },
      { featureCode: NO_LIST, name: expect.any(String), listPrice: null, price: null, renewalPrice: null, status: 'NO_LIST', requires: [] },
    ],
  })
  // Never raised to $10 in silence: the % promised would change (spec §4.3).
  await expect(createPercentPromotion(input, staffId)).rejects.toMatchObject({ statusCode: 400, code: 'HYBRID_PROMOTION_BELOW_MINIMUM' })
  expect(await prisma.hybridPromotionGroup.count({ where: { name: input.name } })).toBe(0)
  // Nothing on sale at all is not a group either.
  await expect(createPercentPromotion(body([NO_LIST], 20, 3), staffId)).rejects.toMatchObject({ statusCode: 400 })
})

describe(`a 20 % group over ${MAIN} (list 599, 3 cycles)`, () => {
  let groupId: string
  let campaignId: string
  let redemptionId: string

  it('(2) creates one PAUSED promotion per function at 479.20 renewing to 599; activating sells it at 479.20', async () => {
    const created = await createPercentPromotion(body([MAIN], 20, 3, 7), staffId)
    groupId = created.groupId
    expect(created.campaignIds).toHaveLength(1)
    campaignId = created.campaignIds[0]
    const g = await group(groupId)
    expect(g).toMatchObject({ status: 'PAUSED', revision: 1, percentOff: 20, promotionCycles: 3, capacityPerFeature: 7 })
    const row = await campaign(campaignId)
    expect(row).toMatchObject({
      purpose: 'PROMOTION',
      promotionGroupId: groupId,
      listed: true,
      audience: 'ALL',
      capacity: 7,
      status: 'PAUSED',
      code: `G${groupId.toUpperCase()}_01`,
      slug: `promo-${groupId}-1`,
      startsAt: g.startsAt,
      endsAt: g.endsAt,
    })
    expect(row.code.length).toBeLessThanOrEqual(32)
    expect(await termsOf(campaignId)).toEqual({
      currency: 'MXN',
      interval: 'MONTHLY',
      price: 479.2,
      taxIncluded: true,
      promotionCycles: 3,
      renewal: { kind: 'REPRICE', price: 599 },
    })
    expect(await prisma.activityLog.findFirst({ where: { entityId: groupId, action: 'HYBRID_PROMOTION_GROUP_CREATED' } })).toMatchObject({
      staffId,
      entity: 'HybridPromotionGroup',
    })

    // The sales flag closes activating a promotion, as for a single campaign: nothing changes.
    await expect(setStatus(groupId, 'ACTIVE')).rejects.toMatchObject({ code: 'HYBRID_SALES_CLOSED' })
    expect(await group(groupId)).toMatchObject({ status: 'PAUSED', revision: 1 })

    process.env.HYBRID_BILLING_ENABLED = 'true'
    expect(await setStatus(groupId, 'ACTIVE')).toMatchObject({ id: groupId, status: 'ACTIVE', revision: 2 })
    expect(await campaign(campaignId)).toMatchObject({ status: 'ACTIVE' })
    const publicationId = (await campaign(campaignId)).currentPublicationId!
    // Stripe gets the same cents the publication promises, initial and renewal.
    expect(stripe.prices.create).toHaveBeenCalledWith(
      expect.objectContaining({ lookup_key: `hybrid_${publicationId}_initial`, unit_amount: 47920, currency: 'mxn' }),
      expect.anything(),
    )
    expect(stripe.prices.create).toHaveBeenCalledWith(
      expect.objectContaining({ lookup_key: `hybrid_${publicationId}_renewal`, unit_amount: 59900 }),
      expect.anything(),
    )
    const quote = await createHybridQuote(venueId, staffId, { lines: [{ publicationId }] })
    expect((quote.quote as any).total).toBe('479.20')
    expect(await acceptHybridQuote(venueId, staffId, quote.id, { quoteHash: quote.quoteHash, clientKey: `pgroup-${stamp}` })).toMatchObject(
      { status: 'ACCEPTED' },
    )
    expect(await campaign(campaignId)).toMatchObject({ reservedCount: 1, redeemedCount: 0 })
    redemptionId = (await prisma.hybridRedemption.findFirstOrThrow({ where: { campaignId } })).id
  })

  it('(3) pause → lower the list → recalculate → reactivate, keeping identity, capacity and redemptions', async () => {
    const active = await group(groupId)
    // With the group on sale, 450 breaks it (its renewal 599 > 450): blocked, with what pausing the group needs.
    const blocked = await settle(savePrice(MAIN, 450))
    expect(blocked.error).toMatchObject({
      code: 'HYBRID_LIST_BREAKS_PROMOTIONS',
      details: [expect.objectContaining({ campaignId, promotionGroupId: groupId, groupRevision: active.revision, renewalPrice: 599 })],
    })
    // Recalculating is never automatic and only on a paused group.
    await expect(recalculatePromotionGroup(groupId, active.revision, staffId)).rejects.toMatchObject({
      code: 'HYBRID_PROMOTION_GROUP_NOT_PAUSED',
    })
    expect(await setPromotionGroupStatus(groupId, { status: 'PAUSED', expectedRevision: active.revision }, staffId)).toMatchObject({
      status: 'PAUSED',
    })
    expect(await campaign(campaignId)).toMatchObject({ status: 'PAUSED' })
    await expect(savePrice(MAIN, 450)).resolves.toMatchObject({ price: 450 })

    const before = await campaign(campaignId)
    const paused = await group(groupId)
    await expect(recalculatePromotionGroup(groupId, paused.revision, staffId)).resolves.toMatchObject({
      id: groupId,
      status: 'PAUSED',
      revision: paused.revision + 1,
    })
    const after = await campaign(campaignId)
    expect(after.currentPublicationId).not.toBe(before.currentPublicationId)
    expect(after).toMatchObject({ id: campaignId, code: before.code, capacity: 7, reservedCount: 1, redeemedCount: 0, status: 'PAUSED' })
    expect(await termsOf(campaignId)).toMatchObject({ price: 360, promotionCycles: 3, renewal: { kind: 'REPRICE', price: 450 } })
    expect(await prisma.hybridRedemption.findUniqueOrThrow({ where: { id: redemptionId } })).toMatchObject({
      campaignId,
      status: 'RESERVED',
    })
    expect(await prisma.activityLog.findFirst({ where: { entityId: groupId, action: 'HYBRID_PROMOTION_GROUP_RECALCULATED' } })).toBeTruthy()

    // Reactivating checks the rule again (360 < 450, renews at 450 ≤ 450) and passes.
    expect(await setStatus(groupId, 'ACTIVE')).toMatchObject({ status: 'ACTIVE' })
    expect(await campaign(campaignId)).toMatchObject({ status: 'ACTIVE' })
    const logs = await prisma.activityLog.findMany({
      where: { entityId: groupId, action: 'HYBRID_PROMOTION_GROUP_STATUS_CHANGED' },
      take: 10,
    })
    expect(logs).toHaveLength(3)
  })
})

it('(3b) recalculating a «forever» group keeps SAME_PRICE (no renewal to the list)', async () => {
  const { groupId, campaignIds } = await createPercentPromotion(body([FOREVER], 10, null), staffId)
  expect(await termsOf(campaignIds[0])).toMatchObject({ price: 179.1, promotionCycles: null, renewal: { kind: 'SAME_PRICE' } })
  await savePrice(FOREVER, 249)
  await recalculatePromotionGroup(groupId, (await group(groupId)).revision, staffId)
  expect(await termsOf(campaignIds[0])).toEqual(
    expect.objectContaining({ price: 224.1, promotionCycles: null, renewal: { kind: 'SAME_PRICE' } }),
  )
})

it('(4) a dependent function is generated on its own, and the preview says what it requires', async () => {
  const input = body([DEPENDENT], 20, 3)
  expect((await previewPercentPromotion(input)).rows).toEqual([
    expect.objectContaining({ featureCode: DEPENDENT, status: 'OK', price: 279.2, requires: ['UPSELL'] }),
  ])
  const { campaignIds } = await createPercentPromotion(input, staffId)
  expect(await termsOf(campaignIds[0])).toMatchObject({ price: 279.2, renewal: { kind: 'REPRICE', price: 349 } })
})

it('(5) two overlapping groups created at once both finish, without a deadlock', async () => {
  const started = Date.now()
  const [left, right] = await Promise.all([
    settle(createPercentPromotion(body([MAIN, CHEAP], 10, null), staffId)),
    settle(createPercentPromotion(body([CHEAP, MAIN], 10, null), staffId)),
  ])
  expect(Date.now() - started).toBeLessThan(5000)
  expect(left.error).toBeNull()
  expect(right.error).toBeNull()
  // Ordinals follow the productKey order, whatever the order the functions were picked in.
  for (const result of [left, right]) {
    const rows = await prisma.hybridCampaign.findMany({
      where: { promotionGroupId: result.value!.groupId },
      orderBy: { code: 'asc' },
      select: { code: true, draftDefinition: true },
      take: 5,
    })
    expect(rows.map(r => (r.draftDefinition as any).featureCodes[0])).toEqual([CHEAP, MAIN])
  }
})

describe('group status changes are atomic, under every product lock', () => {
  let groupId: string
  let first: string
  let second: string

  beforeAll(async () => {
    process.env.HYBRID_BILLING_ENABLED = 'true'
    const created = await createPercentPromotion(body([SECOND, FIRST], 10, null), staffId)
    groupId = created.groupId
    const rows = await prisma.hybridCampaign.findMany({ where: { promotionGroupId: groupId }, take: 5 })
    first = rows.find(r => (r.draftDefinition as any).featureCodes[0] === FIRST)!.id
    second = rows.find(r => (r.draftDefinition as any).featureCodes[0] === SECOND)!.id
  })

  it('(6) takes every product lock before writing any campaign row', async () => {
    const before = await group(groupId)
    let rowsFree = false
    const result = await whileHoldingProduct(
      FIRST,
      () => setPromotionGroupStatus(groupId, { status: 'PAUSED', expectedRevision: before.revision }, staffId),
      async tx => {
        await tx.$queryRaw`SELECT id FROM "HybridCampaign" WHERE id IN (${first}, ${second}) FOR UPDATE NOWAIT`
        await tx.$queryRaw`SELECT id FROM "HybridPromotionGroup" WHERE id = ${groupId} FOR UPDATE NOWAIT`
        rowsFree = true
      },
    )
    expect(result.waited).toBe(true)
    expect(rowsFree).toBe(true)
    expect(result.error).toBeNull()
    expect(await group(groupId)).toMatchObject({ status: 'PAUSED', revision: before.revision + 1 })
  })

  it('(7) a campaign that changes under the lock rolls back the campaigns already written and the group', async () => {
    const before = await group(groupId)
    const firstBefore = await campaign(first)
    // FIRST is written before SECOND; SECOND changes while the activation waits for its lock, so its write fails last.
    const result = await whileHoldingProduct(
      SECOND,
      () => setPromotionGroupStatus(groupId, { status: 'ACTIVE', expectedRevision: before.revision }, staffId),
      async tx => {
        await tx.hybridCampaign.update({ where: { id: second }, data: { revision: { increment: 1 } } })
      },
    )
    expect(result.waited).toBe(true)
    expect(result.error).toMatchObject({ code: 'HYBRID_CAMPAIGN_STALE' })
    expect(await campaign(first)).toMatchObject({ status: 'PAUSED', revision: firstBefore.revision })
    expect(await campaign(second)).toMatchObject({ status: 'PAUSED' })
    expect(await group(groupId)).toMatchObject({ status: 'PAUSED', revision: before.revision })
  })

  it('(8) one promotion breaking its list blocks the whole activation: no campaign and not the group change', async () => {
    // Paused promotions do not block a list save; activating them again is where the rule bites (269.10 ≥ 250).
    await savePrice(SECOND, 250)
    const before = await group(groupId)
    const revisions = await Promise.all([first, second].map(async id => (await campaign(id)).revision))
    await expect(setStatus(groupId, 'ACTIVE')).rejects.toMatchObject({ code: 'HYBRID_PRICE_ABOVE_LIST' })
    expect(await campaign(first)).toMatchObject({ status: 'PAUSED', revision: revisions[0] })
    expect(await campaign(second)).toMatchObject({ status: 'PAUSED', revision: revisions[1] })
    expect(await group(groupId)).toMatchObject({ status: 'PAUSED', revision: before.revision })
  })
})

describe('the price goes on sale as computed under the product lock, not as previewed', () => {
  /** A new current price for RACE's list, written by the lock holder (the way a list save finalizes). */
  const repriceList = (price: number) => async (tx: any) => {
    const current = await tx.hybridCampaign.findFirstOrThrow({ where: { purpose: 'LIST', listProductKey: `FEATURE:${RACE}` } })
    const compiled = compileHybridPublication({
      schemaVersion: 1,
      kind: 'FEATURES',
      featureCodes: [RACE],
      terms: { currency: 'MXN', interval: 'MONTHLY', price, taxIncluded: true, promotionCycles: null, renewal: { kind: 'SAME_PRICE' } },
    })
    const publication = await tx.hybridOfferPublication.create({
      data: {
        campaignId: current.id,
        version: 1000 + current.revision,
        name: current.name,
        definition: compiled.definition,
        definitionHash: compiled.definitionHash,
        includedFeatureCodes: compiled.includedFeatureCodes,
        createdById: staffId,
      },
    })
    await tx.hybridCampaign.update({
      where: { id: current.id },
      data: { currentPublicationId: publication.id, revision: { increment: 1 } },
    })
  }

  it('(9) a list lowered while the generator waits is the one discounted (500 → 400, renewing to 500)', async () => {
    const input = body([RACE], 20, 3)
    expect((await previewPercentPromotion(input)).rows[0]).toMatchObject({ listPrice: 599, price: 479.2 })
    const result = await whileHoldingProduct(RACE, () => createPercentPromotion(input, staffId), repriceList(500))
    expect(result.waited).toBe(true)
    expect(result.error).toBeNull()
    expect(await termsOf(result.value!.campaignIds[0])).toMatchObject({ price: 400, renewal: { kind: 'REPRICE', price: 500 } })
  })

  it('(10) a list lowered under $10 while the generator waits blocks it, and nothing is created', async () => {
    const input = body([RACE], 20, 3)
    const result = await whileHoldingProduct(RACE, () => createPercentPromotion(input, staffId), repriceList(12))
    expect(result.waited).toBe(true)
    expect(result.error).toMatchObject({ statusCode: 400, code: 'HYBRID_PROMOTION_BELOW_MINIMUM' })
    expect(await prisma.hybridPromotionGroup.count({ where: { name: input.name } })).toBe(0)
  })
})
