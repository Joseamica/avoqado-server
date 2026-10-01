import prisma from '@/utils/prismaClient'
// Activation prepares Stripe prices first; that call is not what this suite measures.
jest.mock('@/services/launchCampaigns/hybridPrices', () => ({ ensureHybridPublicationPrices: jest.fn(async () => undefined) }))
import { compileHybridPublication } from '@/services/launchCampaigns/hybridOffer.service'
import { hybridOfferDefinition } from '@/services/launchCampaigns/hybridOffer.schema'
import { createHybridCampaign, publishHybridCampaign, setHybridCampaignStatus } from '@/services/launchCampaigns/hybridCampaign.service'
import { lockProducts, productKeyOf, productKeySql, type ProductKey } from '@/services/launchCampaigns/hybridProduct'
import { assertPriceRuleForList, violatesListRule } from '@/services/launchCampaigns/hybridPriceRule'

const stamp = `${Date.now()}${process.pid}`
// Every LIST and group of this suite carries this author, and every promotion code starts with PRULE: a crashed run's rows
// are retired by those marks, so no list of this suite outlives it on the shared disposable DB.
const MARK = 'test:hybrid-price-rule'
// Products no other suite prices (CFDI belongs to the list-purchase and pointer suites).
const AUDIT = 'VENUE_AUDIT_LOG'
const NO_LIST = 'TRANSACTION_EXPORT'
const FIRST_LIST = 'PRICE_LABELS'
const RACE = 'GOOGLE_REVIEW_REDIRECT'
let staffId: string
let n = 0

const terms = (price: number, renewal: { kind: string; price?: number } = { kind: 'SAME_PRICE' }) => ({
  currency: 'MXN',
  interval: 'MONTHLY',
  price,
  taxIncluded: true,
  // A renewal that changes the price needs the cycles the promotional price lasts.
  promotionCycles: renewal.kind === 'SAME_PRICE' ? null : 3,
  renewal,
})
const feature = (code: string, price: number, renewal?: { kind: string; price?: number }) => ({
  schemaVersion: 1,
  kind: 'FEATURES',
  featureCodes: [code],
  terms: terms(price, renewal),
})
const plan = (planTier: 'PRO' | 'PREMIUM', price: number) => ({ schemaVersion: 1, kind: 'PLAN', planTier, terms: terms(price) })
const row = (id: string) => prisma.hybridCampaign.findUniqueOrThrow({ where: { id } })
const settle = <T>(promise: Promise<T>) =>
  promise.then(
    value => ({ value, error: null as unknown }),
    error => ({ value: null, error: error as unknown }),
  )

/** A list price not yet pointed at (the caller moves the pointer, the way Task 5's finalize will). */
async function listPublication(listId: string, definition: object) {
  const compiled = compileHybridPublication(definition)
  return prisma.hybridOfferPublication.create({
    data: {
      campaignId: listId,
      version: 1 + (await prisma.hybridOfferPublication.count({ where: { campaignId: listId } })),
      name: `Lista ${stamp}`,
      definition: compiled.definition,
      definitionHash: compiled.definitionHash,
      includedFeatureCodes: compiled.includedFeatureCodes,
      createdById: MARK,
    },
  })
}
const pointList = async (listId: string, definition: object) =>
  prisma.hybridCampaign.update({
    where: { id: listId },
    data: { currentPublicationId: (await listPublication(listId, definition)).id, revision: { increment: 1 } },
  })

/** A LIST on sale, written straight to the DB (`saveListPrice` is Task 5). */
async function createList(key: ProductKey, definition: object) {
  const code = `LRULE${stamp}${++n}`
  const list = await prisma.hybridCampaign.create({
    data: {
      code,
      slug: code.toLowerCase(),
      name: `Lista ${code}`,
      draftDefinition: compileHybridPublication(definition).definition,
      startsAt: new Date(Date.now() - 86400000),
      audience: 'ALL',
      listed: false,
      purpose: 'LIST',
      listProductKey: key,
      endsAt: null,
      capacity: null,
      status: 'ACTIVE',
      revision: 1,
      createdById: MARK,
    },
  })
  await pointList(list.id, definition)
  return list.id
}

/** A promotion drafted through the editor; publishing and activating go through the services under test. */
async function promotion(definition: object) {
  const code = `PRULE${stamp}${++n}`
  return (
    await createHybridCampaign(
      {
        code,
        slug: code.toLowerCase(),
        name: `Regla ${code}`,
        startsAt: new Date(Date.now() - 86400000).toISOString(),
        endsAt: new Date(Date.now() + 7 * 86400000).toISOString(),
        capacity: 5,
        audience: 'ALL',
        listed: false,
        definition,
      },
      staffId,
    )
  ).id
}
const publish = async (id: string) => publishHybridCampaign(id, (await row(id)).revision, staffId)
async function activate(id: string) {
  const current = await row(id)
  return setHybridCampaignStatus(
    id,
    { status: 'ACTIVE', expectedRevision: current.revision, publicationId: current.currentPublicationId },
    staffId,
  )
}
const pause = async (id: string) => setHybridCampaignStatus(id, { status: 'PAUSED', expectedRevision: (await row(id)).revision }, staffId)

/** A promotion of a «% off» group, written straight to the DB (the generator is Task 7): ACTIVE with its pointer set. */
async function groupedPromotion(code: string, price: number) {
  const window = { startsAt: new Date(Date.now() - 86400000), endsAt: new Date(Date.now() + 7 * 86400000) }
  const group = await prisma.hybridPromotionGroup.create({
    data: {
      name: `20 % ${stamp}`,
      percentOff: 20,
      target: { kind: 'FEATURES', featureCodes: [code] },
      ...window,
      capacityPerFeature: 10,
      status: 'ACTIVE',
      createdById: MARK,
    },
  })
  const compiled = compileHybridPublication(feature(code, price))
  const campaignCode = `GRULE${stamp}${++n}`
  const campaign = await prisma.hybridCampaign.create({
    data: {
      code: campaignCode,
      slug: campaignCode.toLowerCase(),
      name: `Grupo ${campaignCode}`,
      draftDefinition: compiled.definition,
      ...window,
      capacity: 10,
      audience: 'ALL',
      listed: false,
      purpose: 'PROMOTION',
      promotionGroupId: group.id,
      status: 'ACTIVE',
      revision: 2,
      createdById: MARK,
    },
  })
  const publication = await prisma.hybridOfferPublication.create({
    data: {
      campaignId: campaign.id,
      version: 1,
      name: campaign.name,
      definition: compiled.definition,
      definitionHash: compiled.definitionHash,
      includedFeatureCodes: compiled.includedFeatureCodes,
      createdById: MARK,
    },
  })
  await prisma.hybridCampaign.update({ where: { id: campaign.id }, data: { currentPublicationId: publication.id } })
  return { campaign: campaign.id, name: campaign.name, group }
}

/** Publications and campaigns are never deleted: lists free their product key and stop selling, promotions end. */
async function retire() {
  const lists = await prisma.hybridCampaign.findMany({ where: { createdById: MARK, purpose: 'LIST' }, select: { id: true }, take: 50 })
  for (const { id } of lists)
    await prisma.hybridCampaign.update({ where: { id }, data: { listProductKey: `FEATURE:RETIRED_${id}`, status: 'PAUSED' } })
  await prisma.hybridCampaign.updateMany({
    where: { purpose: 'PROMOTION', OR: [{ createdById: MARK }, { code: { startsWith: 'PRULE' } }] },
    data: { status: 'ENDED' },
  })
  await prisma.hybridPromotionGroup.updateMany({ where: { createdById: MARK }, data: { status: 'ENDED' } })
}

beforeAll(async () => {
  if (!/test|hybrid/i.test(new URL(process.env.TEST_DATABASE_URL!).pathname)) throw new Error('Disposable DB required')
  process.env.HYBRID_BILLING_ENABLED = 'true'
  await retire()
  staffId = (await prisma.staff.create({ data: { email: `rule-${stamp}@example.test`, firstName: 'Hybrid', lastName: 'Test' } })).id
})
afterAll(async () => {
  await retire()
  delete process.env.HYBRID_BILLING_ENABLED
})

describe('productKeySql is the SQL twin of productKeyOf', () => {
  it.each([
    ['a plan', plan('PREMIUM', 999)],
    ['a single function', feature(AUDIT, 99)],
    ['several functions', { ...feature(AUDIT, 99), featureCodes: [AUDIT, NO_LIST] }],
    [
      'a choice bundle',
      { schemaVersion: 1, kind: 'CHOICE_BUNDLE', eligibleFeatureCodes: [AUDIT, NO_LIST], choiceCount: 1, terms: terms(99) },
    ],
  ])('agrees on %s', async (_label, input) => {
    const definition = hybridOfferDefinition.parse(input)
    const [result] = await prisma.$queryRaw<{ key: string | null }[]>`
      SELECT ${productKeySql('p')} AS key FROM (SELECT ${JSON.stringify(definition)}::jsonb AS definition) p`
    expect(result.key).toBe(productKeyOf(definition))
  })
})

describe(`a promotion costs less than its list (${AUDIT} listed at 199)`, () => {
  const key: ProductKey = `FEATURE:${AUDIT}`
  let list: string
  let promo: string
  beforeAll(async () => {
    list = await createList(key, feature(AUDIT, 199))
  })

  it('(1) publishing at the list price, or renewing above it, is rejected and leaves nothing behind; below it publishes', async () => {
    const atList = await promotion(feature(AUDIT, 199))
    await expect(publish(atList)).rejects.toMatchObject({
      statusCode: 409,
      code: 'HYBRID_PRICE_ABOVE_LIST',
      message: 'Una promoción debe costar menos que su precio de lista (199) y renovar a lo más a ese precio.',
    })
    expect(await row(atList)).toMatchObject({ revision: 1, status: 'DRAFT', currentPublicationId: null })
    expect(await prisma.hybridOfferPublication.count({ where: { campaignId: atList } })).toBe(0)
    const renewsAbove = await promotion(feature(AUDIT, 149, { kind: 'REPRICE', price: 199.01 }))
    await expect(publish(renewsAbove)).rejects.toMatchObject({ code: 'HYBRID_PRICE_ABOVE_LIST' })
    const renewsAtList = await promotion(feature(AUDIT, 149, { kind: 'REPRICE', price: 199 }))
    await expect(publish(renewsAtList)).resolves.toMatchObject({ campaignId: renewsAtList })
    promo = await promotion(feature(AUDIT, 149))
    await expect(publish(promo)).resolves.toMatchObject({ campaignId: promo })
  })

  it('(5) lowering the list under ACTIVE promotions is rejected with each broken promotion as details', async () => {
    await activate(promo)
    const grouped = await groupedPromotion(AUDIT, 159.2)
    const failure = await settle(prisma.$transaction(tx => assertPriceRuleForList(tx, key, 129)))
    expect(failure.error).toMatchObject({ statusCode: 409, code: 'HYBRID_LIST_BREAKS_PROMOTIONS' })
    const details = (failure.error as { details: unknown[] }).details
    expect(details).toHaveLength(2)
    expect(details).toEqual(
      expect.arrayContaining([
        {
          campaignId: promo,
          campaignName: (await row(promo)).name,
          price: 149,
          renewalPrice: null,
          listPrice: 129,
          revision: (await row(promo)).revision,
          promotionGroupId: null,
          groupRevision: null,
        },
        {
          campaignId: grouped.campaign,
          campaignName: grouped.name,
          price: 159.2,
          renewalPrice: null,
          listPrice: 129,
          revision: 2,
          promotionGroupId: grouped.group.id,
          groupRevision: grouped.group.revision,
        },
      ]),
    )
    // Paused promotions and the published-but-paused ones never block; a list above every active price passes.
    await expect(prisma.$transaction(tx => assertPriceRuleForList(tx, key, 159.21))).resolves.toBeUndefined()
    await prisma.hybridCampaign.update({ where: { id: grouped.campaign }, data: { status: 'ENDED' } })
  })

  it('(4) reactivating a paused promotion after the list dropped below it is rejected, also with the list paused', async () => {
    await pause(promo)
    await pointList(list, feature(AUDIT, 129))
    await expect(activate(promo)).rejects.toMatchObject({ statusCode: 409, code: 'HYBRID_PRICE_ABOVE_LIST' })
    expect(await row(promo)).toMatchObject({ status: 'PAUSED' })
    // «Lista vigente» is the pointer whether the list sells or not: pausing a list never lifts the rule.
    await prisma.hybridCampaign.update({ where: { id: list }, data: { status: 'PAUSED' } })
    await expect(activate(promo)).rejects.toMatchObject({ code: 'HYBRID_PRICE_ABOVE_LIST' })
    expect(await row(promo)).toMatchObject({ status: 'PAUSED' })
  })
})

it('(2) a plan promotion is held to the plan list: Pro at 2,000 against a list of 1,158.84 is rejected', async () => {
  await createList('PLAN:PRO', plan('PRO', 1158.84))
  const above = await promotion(plan('PRO', 2000))
  await expect(publish(above)).rejects.toMatchObject({ code: 'HYBRID_PRICE_ABOVE_LIST' })
  const below = await promotion(plan('PRO', 999))
  await expect(publish(below)).resolves.toMatchObject({ campaignId: below })
})

it('(3) a promotion of a function without a list publishes and activates with no comparison', async () => {
  const promo = await promotion(feature(NO_LIST, 5000))
  await publish(promo)
  await expect(activate(promo)).resolves.toMatchObject({ status: 'ACTIVE' })
})

it('(7) the FIRST list price of a function with manual promotions is held to the same rule', async () => {
  const promo = await promotion(feature(FIRST_LIST, 199))
  await publish(promo)
  await activate(promo)
  const failure = await settle(prisma.$transaction(tx => assertPriceRuleForList(tx, `FEATURE:${FIRST_LIST}`, 179)))
  expect(failure.error).toMatchObject({
    code: 'HYBRID_LIST_BREAKS_PROMOTIONS',
    details: [expect.objectContaining({ campaignId: promo, price: 199, listPrice: 179 })],
  })
})

/** True once another connection waits on a transaction advisory lock; false if `other` settles first or 10 s pass. */
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

it('(6) activating a promotion while its list drops never leaves an ACTIVE promotion at or above the list', async () => {
  const key: ProductKey = `FEATURE:${RACE}`
  const list = await createList(key, feature(RACE, 199))
  const promo = await promotion(feature(RACE, 149))
  await publish(promo)
  const lower = await listPublication(list, feature(RACE, 129))
  let activation: Promise<{ value: unknown; error: unknown }> | undefined
  let waited = false
  // The worst interleaving: the list side checks (no active promotion yet) and moves its pointer, then the activation
  // runs before that commit. Without the product lock the activation reads the old list (199) and both commit.
  const lowering = settle(
    prisma.$transaction(
      async tx => {
        await lockProducts(tx, [key])
        await assertPriceRuleForList(tx, key, 129)
        await tx.hybridCampaign.update({ where: { id: list }, data: { currentPublicationId: lower.id, revision: { increment: 1 } } })
        activation = settle(activate(promo))
        waited = await waitsOnAdvisoryLock(activation)
      },
      { timeout: 30000 },
    ),
  )
  const [lowered, activated] = await Promise.all([lowering, lowering.then(() => activation)])

  // The invariant, read straight from the rows: every ACTIVE promotion of the product against the list's pointer.
  const listNow = await row(list)
  const listPrice = hybridOfferDefinition.parse(
    (await prisma.hybridOfferPublication.findUniqueOrThrow({ where: { id: listNow.currentPublicationId! } })).definition,
  ).terms.price
  const active = await prisma.hybridCampaign.findMany({
    where: { purpose: 'PROMOTION', status: 'ACTIVE', code: { startsWith: `PRULE${stamp}` } },
    select: { currentPublicationId: true },
    take: 50,
  })
  const publications = await prisma.hybridOfferPublication.findMany({
    where: { id: { in: active.map(campaign => campaign.currentPublicationId!) } },
    select: { definition: true },
    take: 50,
  })
  const violating = publications
    .map(publication => hybridOfferDefinition.parse(publication.definition))
    .filter(definition => productKeyOf(definition) === key && violatesListRule(definition.terms, listPrice))
  expect(violating).toEqual([])

  // With the lock the activation waits, then reads the new list and refuses.
  expect(waited).toBe(true)
  expect(lowered.error).toBeNull()
  expect(listPrice).toBe(129)
  expect(activated?.error).toMatchObject({ code: 'HYBRID_PRICE_ABOVE_LIST' })
  expect(await row(promo)).toMatchObject({ status: 'PAUSED' })
})

// Cross-task invariant: every catalog writer takes its sorted `precio:` locks before writing any campaign row, so a
// writer holding the product (a list save pausing promotions) never deadlocks against a promotion holding its own row.
it.each([
  ['publishing', false],
  ['activating', true],
])('%s a promotion waits for its product lock while its campaign row is still free', async (_label, activating) => {
  const promo = await promotion(feature(NO_LIST, 100))
  if (activating) await publish(promo)
  let release!: () => void
  let entered!: () => void
  const held = new Promise<void>(resolve => (release = resolve))
  const locked = new Promise<void>(resolve => (entered = resolve))
  let rowFree = false
  const holder = settle(
    prisma.$transaction(
      async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`precio:FEATURE:${NO_LIST}`}))`
        entered()
        await held
        await tx.$queryRaw`SELECT id FROM "HybridCampaign" WHERE id = ${promo} FOR UPDATE NOWAIT`
        rowFree = true
      },
      { timeout: 30000 },
    ),
  )
  await locked
  const action = settle<unknown>(activating ? activate(promo) : publish(promo))
  let waited = false
  try {
    waited = await waitsOnAdvisoryLock(action)
  } finally {
    release()
  }
  // Settle both sides before asserting, so a failure never leaks a live transaction into the next test.
  const [holderResult, result] = await Promise.all([holder, action])
  expect(waited).toBe(true)
  expect(holderResult.error).toBeNull()
  expect(rowFree).toBe(true)
  expect(result.error).toBeNull()
})
