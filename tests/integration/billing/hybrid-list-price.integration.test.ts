import prisma from '@/utils/prismaClient'
// Preparing Stripe prices runs outside the transaction; the cases below control when it fails or resolves.
jest.mock('@/services/launchCampaigns/hybridPrices', () => ({ ensureHybridPublicationPrices: jest.fn(async () => undefined) }))
import { ensureHybridPublicationPrices } from '@/services/launchCampaigns/hybridPrices'
import { compileHybridPublication } from '@/services/launchCampaigns/hybridOffer.service'
import { hybridOfferDefinition } from '@/services/launchCampaigns/hybridOffer.schema'
import { assertPromotionBelowList } from '@/services/launchCampaigns/hybridPriceRule'
import { lockProducts, type ProductKey } from '@/services/launchCampaigns/hybridProduct'
import {
  LISTABLE_FEATURE_CODES,
  listPriceBoard,
  retryListPrice,
  saveListPrice,
  setListPriceStatus,
} from '@/services/launchCampaigns/hybridListPrice.service'

const prepare = ensureHybridPublicationPrices as jest.MockedFunction<typeof ensureHybridPublicationPrices>
const stamp = `${Date.now()}${process.pid}`
// Products no other suite prices. Their LIST rows (and the L_<code> codes they claim) are retired before and after the run.
const MAIN = 'BANK_RECONCILIATION'
const PAUSE = 'CASH_RECONCILIATION'
const EXPIRY = 'AREA_TICKETS'
const LOCKED = 'BANKING_HUB'
const RACE = 'OFFLINE_LAN_HUB'
const OURS = [MAIN, PAUSE, EXPIRY, LOCKED, RACE]
const hour = 3600000
let staffId: string

const list = (code: string) => prisma.hybridCampaign.findFirstOrThrow({ where: { purpose: 'LIST', listProductKey: `FEATURE:${code}` } })
const rev = async (code: string) => (await list(code)).revision
const priceOf = async (publicationId: string | null) =>
  hybridOfferDefinition.parse((await prisma.hybridOfferPublication.findUniqueOrThrow({ where: { id: publicationId! } })).definition).terms
    .price
const boardRow = async (code: string) => (await listPriceBoard()).find(row => row.productKey === `FEATURE:${code}`)!
const settle = <T>(promise: Promise<T>) =>
  promise.then(
    value => ({ value, error: null as unknown }),
    error => ({ value: null, error: error as unknown }),
  )

/** The next preparation hangs until released; `stalled()` resolves (with the release) once the service has called it. */
function stallNextPrepare() {
  let release!: () => void
  const calls = prepare.mock.calls.length
  prepare.mockImplementationOnce(() => new Promise<never>(resolve => (release = () => resolve(undefined as never))))
  return async () => {
    const deadline = Date.now() + 10000
    while (prepare.mock.calls.length === calls && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
    expect(prepare.mock.calls.length).toBe(calls + 1)
    return release
  }
}

/** Lists are never deleted (their publications cannot be): free the product key and the code/slug a new list would claim. */
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
  await prisma.hybridCampaign.updateMany({ where: { code: { startsWith: 'LPRICE' } }, data: { status: 'ENDED' } })
}

const featureAt = (code: string, price: number) =>
  compileHybridPublication({
    schemaVersion: 1,
    kind: 'FEATURES',
    featureCodes: [code],
    terms: { currency: 'MXN', interval: 'MONTHLY', price, taxIncluded: true, promotionCycles: null, renewal: { kind: 'SAME_PRICE' } },
  })

/** A single-function promotion with its pointer set, written straight to the DB. */
async function promotion(code: string, price: number, window: { startsAt: Date; endsAt: Date }, status: 'ACTIVE' | 'PAUSED' = 'ACTIVE') {
  const compiled = featureAt(code, price)
  const campaignCode = `LPRICE${stamp}${Math.random().toString(36).slice(2, 8)}`
  const campaign = await prisma.hybridCampaign.create({
    data: {
      code: campaignCode,
      slug: campaignCode.toLowerCase(),
      name: `Promo ${campaignCode}`,
      draftDefinition: compiled.definition,
      ...window,
      capacity: 5,
      audience: 'ALL',
      listed: false,
      purpose: 'PROMOTION',
      status,
      revision: 2,
      createdById: 'test:hybrid-list-price',
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
      createdById: 'test:hybrid-list-price',
    },
  })
  await prisma.hybridCampaign.update({ where: { id: campaign.id }, data: { currentPublicationId: publication.id } })
  return campaign.id
}

beforeAll(async () => {
  if (!/test|hybrid/i.test(new URL(process.env.TEST_DATABASE_URL!).pathname)) throw new Error('Disposable DB required')
  // Preparing and activating a LIST is catalog work: it never needs the sales flag (spec §4.2).
  delete process.env.HYBRID_BILLING_ENABLED
  await retire()
  staffId = (await prisma.staff.create({ data: { email: `list-price-${stamp}@example.test`, firstName: 'Hybrid', lastName: 'Test' } })).id
})
afterAll(async () => {
  await retire()
})

describe(`saving the list price of ${MAIN}`, () => {
  it('(1) the first price goes on sale with the sales flag closed, audited with before = null', async () => {
    const saved = await saveListPrice({ productKey: `FEATURE:${MAIN}`, price: 199, expectedRevision: null }, staffId)
    const row = await list(MAIN)
    expect(row).toMatchObject({
      status: 'ACTIVE',
      pendingPublicationId: null,
      code: `L_${MAIN}`,
      slug: 'lista-bank-reconciliation',
      audience: 'ALL',
      listed: true,
      endsAt: null,
      capacity: null,
    })
    const current = await prisma.hybridOfferPublication.findUniqueOrThrow({ where: { id: row.currentPublicationId! } })
    expect(current.campaignId).toBe(row.id)
    expect(await priceOf(current.id)).toBe(199)
    expect(prepare).toHaveBeenCalledWith(current.id)
    expect(saved).toMatchObject({
      productKey: `FEATURE:${MAIN}`,
      featureCode: MAIN,
      planTier: null,
      editable: true,
      notEditableReason: null,
      campaignId: row.id,
      revision: row.revision,
      status: 'ACTIVE',
      price: 199,
      pendingPrice: null,
    })
    const log = await prisma.activityLog.findFirstOrThrow({ where: { entityId: row.id, action: 'HYBRID_LIST_PRICE_SAVED' } })
    expect(log).toMatchObject({
      staffId,
      entity: 'HybridCampaign',
      data: { productKey: `FEATURE:${MAIN}`, before: null, after: 199, publicationId: current.id },
    })
    // A second «first price» from a stale screen is rejected: the list exists now.
    await expect(saveListPrice({ productKey: `FEATURE:${MAIN}`, price: 189, expectedRevision: null }, staffId)).rejects.toMatchObject({
      code: 'HYBRID_CAMPAIGN_STALE',
    })
  })

  it('(2) when preparing fails the old price keeps selling with the new one pending; retry moves the pointer', async () => {
    const before = await list(MAIN)
    prepare.mockRejectedValueOnce(new Error('stripe down'))
    const failed = await settle(saveListPrice({ productKey: `FEATURE:${MAIN}`, price: 249, expectedRevision: before.revision }, staffId))
    expect(failed.error).toMatchObject({
      statusCode: 409,
      code: 'HYBRID_LIST_PREPARING',
      message: 'No pudimos preparar el precio en Stripe. El precio anterior se sigue vendiendo; reintenta.',
      details: expect.objectContaining({ price: 199, pendingPrice: 249 }),
    })
    const pending = await list(MAIN)
    expect(pending.currentPublicationId).toBe(before.currentPublicationId)
    expect(await priceOf(pending.pendingPublicationId)).toBe(249)
    expect(await boardRow(MAIN)).toMatchObject({ price: 199, pendingPrice: 249, status: 'ACTIVE' })

    // A double-clicked «Reintentar»: both read the pending price, the first stalls in Stripe, the second finishes it.
    const stalled = stallNextPrepare()
    const first = settle(retryListPrice(`FEATURE:${MAIN}`, staffId))
    const release = await stalled()
    const retried = await retryListPrice(`FEATURE:${MAIN}`, staffId)
    expect(retried).toMatchObject({ price: 249, pendingPrice: null, status: 'ACTIVE' })
    release()
    expect(await first).toMatchObject({ error: null, value: expect.objectContaining({ price: 249, pendingPrice: null }) })
    const after = await list(MAIN)
    expect(after.currentPublicationId).toBe(pending.pendingPublicationId)
    expect(after.pendingPublicationId).toBeNull()
    const logs = await prisma.activityLog.findMany({
      where: { entityId: after.id, action: 'HYBRID_LIST_PRICE_SAVED' },
      orderBy: { createdAt: 'asc' },
      take: 10,
    })
    expect(logs.map(log => log.data)).toEqual([
      expect.objectContaining({ before: null, after: 199 }),
      expect.objectContaining({ before: 199, after: 249, publicationId: after.currentPublicationId }),
    ])
  })

  it('(3) a slow save overtaken by a newer one never moves the pointer back (Review Focus 3)', async () => {
    const stalled = stallNextPrepare()
    const slow = settle(saveListPrice({ productKey: `FEATURE:${MAIN}`, price: 279, expectedRevision: await rev(MAIN) }, staffId))
    const release = await stalled()

    await saveListPrice({ productKey: `FEATURE:${MAIN}`, price: 299, expectedRevision: await rev(MAIN) }, staffId)
    release()
    expect((await slow).error).toMatchObject({
      statusCode: 409,
      code: 'HYBRID_LIST_SUPERSEDED',
      message: 'Hay un cambio de precio más reciente.',
    })
    expect(await boardRow(MAIN)).toMatchObject({ price: 299, pendingPrice: null })
    // Nothing pending any more: a retry returns the row as it is.
    await expect(retryListPrice(`FEATURE:${MAIN}`, staffId)).resolves.toMatchObject({ price: 299, pendingPrice: null })
    expect(await priceOf((await list(MAIN)).currentPublicationId)).toBe(299)
  })

  it('(3b) «Reintentar» on a pending price someone replaced fails as superseded instead of publishing theirs (Codex C3)', async () => {
    const key = `FEATURE:${MAIN}`
    prepare.mockRejectedValueOnce(new Error('stripe down'))
    await settle(saveListPrice({ productKey: key, price: 249, expectedRevision: await rev(MAIN) }, staffId))
    const seenByA = await boardRow(MAIN)
    expect(seenByA).toMatchObject({ price: 299, pendingPrice: 249 })
    // B saves another price; Stripe fails again, so it stays pending too.
    prepare.mockRejectedValueOnce(new Error('stripe down'))
    await settle(saveListPrice({ productKey: key, price: 319, expectedRevision: await rev(MAIN) }, staffId))

    await expect(retryListPrice(key, staffId, seenByA.revision!)).rejects.toMatchObject({
      statusCode: 409,
      code: 'HYBRID_LIST_SUPERSEDED',
    })
    expect(await boardRow(MAIN)).toMatchObject({ price: 299, pendingPrice: 319 })
    // Retried from the row that shows B's price, it goes on sale; then back to 299 for the board case below.
    await expect(retryListPrice(key, staffId, (await boardRow(MAIN)).revision!)).resolves.toMatchObject({ price: 319, pendingPrice: null })
    await saveListPrice({ productKey: key, price: 299, expectedRevision: await rev(MAIN) }, staffId)
  })
})

it('(4) pausing takes the list off sale; a new price keeps it PAUSED, and resuming puts it back on sale', async () => {
  const key = `FEATURE:${PAUSE}`
  await saveListPrice({ productKey: key, price: 199, expectedRevision: null }, staffId)
  const paused = await setListPriceStatus({ productKey: key, status: 'PAUSED', expectedRevision: await rev(PAUSE) }, staffId)
  expect(paused).toMatchObject({ status: 'PAUSED', price: 199 })
  await expect(setListPriceStatus({ productKey: key, status: 'ACTIVE', expectedRevision: 1 }, staffId)).rejects.toMatchObject({
    code: 'HYBRID_CAMPAIGN_STALE',
  })

  // Finalizing never reactivates a list someone paused: only the first price activates.
  await expect(saveListPrice({ productKey: key, price: 179, expectedRevision: await rev(PAUSE) }, staffId)).resolves.toMatchObject({
    status: 'PAUSED',
    price: 179,
    pendingPrice: null,
  })
  expect(await priceOf((await list(PAUSE)).currentPublicationId)).toBe(179)

  const resumed = await setListPriceStatus({ productKey: key, status: 'ACTIVE', expectedRevision: await rev(PAUSE) }, staffId)
  expect(resumed).toMatchObject({ status: 'ACTIVE', price: 179 })
  const logs = await prisma.activityLog.findMany({
    where: { entityId: (await list(PAUSE)).id, action: 'HYBRID_LIST_STATUS_CHANGED' },
    orderBy: { createdAt: 'asc' },
    take: 10,
  })
  expect(logs.map(log => log.data)).toEqual([
    expect.objectContaining({ productKey: key, previous: 'ACTIVE', status: 'PAUSED' }),
    expect.objectContaining({ productKey: key, previous: 'PAUSED', status: 'ACTIVE' }),
  ])
})

it('(5) only sellable functions take a list price here: base, plan (phase 2) and malformed prices are rejected', async () => {
  for (const productKey of ['FEATURE:BASE_POS', 'FEATURE:CHATBOT', 'FEATURE:WHITE_LABEL_DASHBOARD', 'PLAN:PRO', 'FEATURE:NOPE'])
    await expect(saveListPrice({ productKey, price: 199, expectedRevision: null }, staffId)).rejects.toMatchObject({
      statusCode: 400,
      code: 'HYBRID_LIST_NOT_EDITABLE',
    })
  await expect(saveListPrice({ productKey: `FEATURE:${EXPIRY}`, price: 9.99, expectedRevision: null }, staffId)).rejects.toMatchObject({
    statusCode: 400,
    message: expect.stringContaining('El precio mínimo es $10.00 MXN'),
  })
})

it('(6) an ACTIVE promotion whose window already ended never blocks a lower list; one still in its window does', async () => {
  const key = `FEATURE:${EXPIRY}`
  // One hour past its end: under the local America/Mexico_City session a bare NOW() would still read it as on sale.
  await promotion(EXPIRY, 300, { startsAt: new Date(Date.now() - 48 * hour), endsAt: new Date(Date.now() - hour) })
  const live = await promotion(EXPIRY, 300, { startsAt: new Date(Date.now() - 48 * hour), endsAt: new Date(Date.now() + hour) })
  const blocked = await settle(saveListPrice({ productKey: key, price: 199, expectedRevision: null }, staffId))
  expect(blocked.error).toMatchObject({
    code: 'HYBRID_LIST_BREAKS_PROMOTIONS',
    message:
      'Hay promociones activas que costarían lo mismo o más que este precio de lista, o que renovarían por encima de él. Páusalas antes de guardarlo.',
    details: [expect.objectContaining({ campaignId: live, price: 300, listPrice: 199 })],
  })
  expect(await prisma.hybridCampaign.count({ where: { purpose: 'LIST', listProductKey: key } })).toBe(0)

  await prisma.hybridCampaign.update({ where: { id: live }, data: { status: 'PAUSED' } })
  await expect(saveListPrice({ productKey: key, price: 199, expectedRevision: null }, staffId)).resolves.toMatchObject({
    status: 'ACTIVE',
    price: 199,
  })
})

it('(7) the board lists every catalog function plus both plans, each saying why it is not editable', async () => {
  const board = await listPriceBoard()
  expect(LISTABLE_FEATURE_CODES).toHaveLength(32)
  expect(board).toHaveLength(43)
  expect(board.filter(row => row.editable).map(row => row.featureCode)).toEqual(LISTABLE_FEATURE_CODES)
  const byKey = new Map(board.map(row => [row.productKey, row]))
  expect(byKey.get('FEATURE:AGGREGATOR_PASSES')).toMatchObject({ editable: true, notEditableReason: null })
  expect(byKey.get('FEATURE:BASE_POS')).toMatchObject({ editable: false, notEditableReason: 'SYSTEM', featureCode: null })
  expect(byKey.get('FEATURE:CHATBOT')).toMatchObject({ editable: false, notEditableReason: 'FREE' })
  expect(byKey.get('FEATURE:WHITE_LABEL_DASHBOARD')).toMatchObject({ editable: false, notEditableReason: 'CONTACT' })
  expect(byKey.get('FEATURE:ENTERPRISE_API')).toMatchObject({ editable: false, notEditableReason: 'CONTACT' })
  expect(byKey.get('PLAN:PRO')).toMatchObject({ editable: false, notEditableReason: 'PLAN_PHASE_2', planTier: 'PRO', featureCode: null })
  expect(byKey.get('PLAN:PREMIUM')).toMatchObject({ editable: false, notEditableReason: 'PLAN_PHASE_2', planTier: 'PREMIUM' })
  expect(byKey.get(`FEATURE:${MAIN}`)).toMatchObject({
    editable: true,
    name: 'Conciliación bancaria',
    category: 'money',
    minimumTier: 'PRO',
    status: 'ACTIVE',
    price: 299,
    pendingPrice: null,
    revision: await rev(MAIN),
  })
  expect(byKey.get('FEATURE:VARIABLE_WEIGHT_BARCODE')).toMatchObject({ editable: true, campaignId: null, status: null, price: null })
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

/** Runs `action` while another transaction holds the product lock; `whileWaiting` inspects the rows before it is released. */
async function underProductLock<T>(key: string, action: () => Promise<T>, whileWaiting: () => Promise<void>) {
  let release!: () => void
  let entered!: () => void
  const held = new Promise<void>(resolve => (release = resolve))
  const locked = new Promise<void>(resolve => (entered = resolve))
  const holder = settle(
    prisma.$transaction(
      async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'precio:' + key}))`
        entered()
        await held
      },
      { timeout: 30000 },
    ),
  )
  await locked
  const result = settle(action())
  let waited = false
  try {
    waited = await waitsOnAdvisoryLock(result)
    await whileWaiting()
  } finally {
    release()
  }
  // Settle both sides before asserting, so a failure never leaks a live transaction into the next test.
  const [holderResult, outcome] = await Promise.all([holder, result])
  expect(waited).toBe(true)
  expect(holderResult.error).toBeNull()
  if (outcome.error) throw outcome.error
  return outcome.value as T
}

it('(8) saving and pausing take the product lock before writing the list', async () => {
  const key = `FEATURE:${LOCKED}`
  const listRow = () => prisma.hybridCampaign.findFirst({ where: { purpose: 'LIST', listProductKey: key } })
  const saved = await underProductLock(
    key,
    () => saveListPrice({ productKey: key, price: 199, expectedRevision: null }, staffId),
    async () => expect(await listRow()).toBeNull(),
  )
  expect(saved).toMatchObject({ status: 'ACTIVE', price: 199 })
  const paused = await underProductLock(
    key,
    async () => setListPriceStatus({ productKey: key, status: 'PAUSED', expectedRevision: await rev(LOCKED) }, staffId),
    async () => expect(await listRow()).toMatchObject({ status: 'ACTIVE' }),
  )
  expect(paused).toMatchObject({ status: 'PAUSED' })
})

it('(9) a pending price finalizes under the product lock: a promotion activated meanwhile at or above it blocks it', async () => {
  const key: ProductKey = `FEATURE:${RACE}`
  await saveListPrice({ productKey: key, price: 299, expectedRevision: null }, staffId)
  const promo = await promotion(RACE, 260, { startsAt: new Date(Date.now() - hour), endsAt: new Date(Date.now() + 48 * hour) }, 'PAUSED')
  // Stall preparation: the new price (249) is pending outside any transaction, the list still sells at 299.
  const stalled = stallNextPrepare()
  const lowering = settle(saveListPrice({ productKey: key, price: 249, expectedRevision: await rev(RACE) }, staffId))
  const ready = await stalled()
  // The worst interleaving: an activation checks the promotion against the list on sale (299 → passes), then preparation
  // ends and finalize runs before the activation commits. Without finalize's lock it reads no ACTIVE promotion and commits 249.
  let finalizeWaited = false
  const activation = settle(
    prisma.$transaction(
      async tx => {
        await lockProducts(tx, [key])
        await assertPromotionBelowList(tx, featureAt(RACE, 260).definition)
        ready()
        finalizeWaited = await waitsOnAdvisoryLock(lowering)
        await tx.hybridCampaign.update({ where: { id: promo }, data: { status: 'ACTIVE' } })
      },
      { timeout: 30000 },
    ),
  )
  const [activated, lowered] = await Promise.all([activation, lowering])
  expect(finalizeWaited).toBe(true)
  expect(activated.error).toBeNull()
  expect(lowered.error).toMatchObject({ code: 'HYBRID_LIST_BREAKS_PROMOTIONS' })
  expect(await boardRow(RACE)).toMatchObject({ price: 299, pendingPrice: 249 })
})
