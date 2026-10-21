import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { getHybridFeatureGrid } from '@/services/launchCampaigns/hybridFeatureGrid.service'
import { bestOffersByProduct, eligibleOffersSql } from '@/services/launchCampaigns/hybridBestOffer'
import { hybridOfferBlocker } from '@/services/launchCampaigns/hybridOfferEligibility'
import { hybridOfferDefinition } from '@/services/launchCampaigns/hybridOffer.schema'
import { productKeyOf } from '@/services/launchCampaigns/hybridProduct'
import { hybridHash } from '@/services/launchCampaigns/hybridProvider'

const stamp = `${Date.now()}${process.pid}`
// Every campaign of this suite carries this code prefix (and every group this name prefix): a crashed run's leftovers are
// ended by it on the next run, so they never leak into other suites' grids on the shared disposable DB.
const PREFIX = 'BEST'
// Products no other suite prices on the shared disposable DB (CFDI, LOYALTY_PROGRAM, AUTO_REORDER… belong to others).
const MAIN = 'SERIALIZED_INVENTORY' // 101 promotions + its list (the plan's LOYALTY_PROGRAM)
const GROUPED = 'ATTENDANCE_TRACKING' // a list, a promotion generated from it and a manual one
const TIE = 'COMMISSIONS' // equal prices
const OURS = [MAIN, GROUPED, TIE]
const hour = 3600000
const day = 24 * hour
let staffId: string
let n = 0

type Renewal = { kind: 'SAME_PRICE' } | { kind: 'REPRICE'; price: number }
interface OfferInput {
  purpose?: 'LIST' | 'PROMOTION'
  renewal?: Renewal
  campaign?: Record<string, unknown>
  publication?: Record<string, unknown>
  pointer?: boolean
}

/** One campaign with its current publication, written directly: the grid reads rows, not the services that wrote them. */
async function offer(code: string, price: number, input: OfferInput = {}) {
  const id = `${stamp}${++n}`
  const purpose = input.purpose ?? 'PROMOTION'
  const renewal = input.renewal ?? { kind: 'SAME_PRICE' }
  const definition = {
    schemaVersion: 1,
    kind: 'FEATURES',
    featureCodes: [code],
    terms: {
      currency: 'MXN',
      interval: 'MONTHLY',
      price,
      taxIncluded: true,
      promotionCycles: renewal.kind === 'REPRICE' ? 3 : null,
      renewal,
    },
  }
  const campaign = await prisma.hybridCampaign.create({
    data: {
      code: `${PREFIX}${id}`,
      slug: `best-offer-${id}`,
      name: `Mejor oferta ${id}`,
      draftDefinition: definition,
      purpose,
      startsAt: new Date(Date.now() - day),
      endsAt: purpose === 'LIST' ? null : new Date(Date.now() + 7 * day),
      capacity: purpose === 'LIST' ? null : 10,
      listProductKey: purpose === 'LIST' ? `FEATURE:${code}` : null,
      audience: 'ALL',
      listed: true,
      status: 'ACTIVE',
      createdById: staffId,
      ...input.campaign,
    },
  })
  const publication = await prisma.hybridOfferPublication.create({
    data: {
      campaignId: campaign.id,
      version: 1,
      name: campaign.name,
      definition,
      definitionHash: hybridHash(definition),
      includedFeatureCodes: [code],
      createdById: staffId,
      stripeProductId: `prod_best_${id}`,
      stripePriceId: `price_best_${id}`,
      stripeRenewalPriceId: renewal.kind === 'REPRICE' ? `price_best_renewal_${id}` : null,
      ...input.publication,
    },
  })
  if (input.pointer !== false)
    await prisma.hybridCampaign.update({ where: { id: campaign.id }, data: { currentPublicationId: publication.id } })
  return { campaignId: campaign.id, publicationId: publication.id }
}
type Offer = Awaited<ReturnType<typeof offer>>

async function organization(name: string, createdAt: Date) {
  const org = await prisma.organization.create({
    data: { name: `${name} ${stamp}`, email: `best-${name}-${stamp}@example.test`, phone: '5550000000', createdAt },
  })
  const venue = await prisma.venue.create({
    data: {
      organizationId: org.id,
      name: `${name} ${stamp}`,
      slug: `best-${name}-${stamp}`,
      stripeCustomerId: `cus_best_${name}_${stamp}`,
    },
  })
  return { id: org.id, createdAt: org.createdAt, venueId: venue.id }
}
type Org = Awaited<ReturnType<typeof organization>>

async function redeem(org: Org, campaignId: string, status: 'RESERVED' | 'RELEASED') {
  const purchase = await prisma.hybridPurchase.create({
    data: {
      venueId: org.venueId,
      quotedById: staffId,
      quote: {},
      quoteHash: `best_${org.id}`,
      quoteExpiresAt: new Date(Date.now() + hour),
    },
  })
  await prisma.hybridRedemption.create({ data: { campaignId, organizationId: org.id, purchaseId: purchase.id, status } })
}

/** Lists are never deleted (their publications cannot be): free the product key; end every campaign and group of this suite. */
async function retire() {
  const lists = await prisma.hybridCampaign.findMany({
    where: { purpose: 'LIST', listProductKey: { in: OURS.map(code => `FEATURE:${code}`) } },
    select: { id: true },
    take: 10,
  })
  for (const { id } of lists)
    await prisma.hybridCampaign.update({ where: { id }, data: { listProductKey: `FEATURE:RETIRED_${id}`, status: 'PAUSED' } })
  await prisma.hybridCampaign.updateMany({
    where: { code: { startsWith: PREFIX }, purpose: 'PROMOTION', status: { not: 'ENDED' } },
    data: { status: 'ENDED' },
  })
  await prisma.hybridPromotionGroup.updateMany({
    where: { name: { startsWith: PREFIX }, status: { not: 'ENDED' } },
    data: { status: 'ENDED' },
  })
}

/** What the purchase path decides for one campaign (observeHybridQuote): blocker, single use of a promotion, parent list. */
async function sellableInTypeScript(org: Org, now: Date, ids: string[]) {
  const sellable: string[] = []
  for (const campaign of await prisma.hybridCampaign.findMany({ where: { id: { in: ids } }, take: ids.length })) {
    if (!campaign.listed || !campaign.currentPublicationId) continue
    const publication = await prisma.hybridOfferPublication.findUniqueOrThrow({ where: { id: campaign.currentPublicationId } })
    const definition = hybridOfferDefinition.parse(publication.definition)
    const blocker = hybridOfferBlocker(
      { ...campaign, latestPublicationId: campaign.currentPublicationId },
      { ...publication, renewalKind: definition.terms.renewal.kind },
      org,
      now,
    )
    if (blocker) continue
    const redeemed =
      campaign.purpose !== 'LIST' &&
      (await prisma.hybridRedemption.count({ where: { campaignId: campaign.id, organizationId: org.id, status: { not: 'RELEASED' } } }))
    if (redeemed) continue
    const key = productKeyOf(definition)
    if (
      campaign.promotionGroupId &&
      (!key || !(await prisma.hybridCampaign.count({ where: { purpose: 'LIST', status: 'ACTIVE', listProductKey: key } })))
    )
      continue
    sellable.push(campaign.id)
  }
  return sellable.sort()
}

async function sellableInSql(org: Org, now: Date, ids: string[]) {
  const rows = await prisma.$queryRaw<{ id: string }[]>(
    Prisma.sql`SELECT c.id ${eligibleOffersSql(org, now)} AND c.id = ANY(${ids}::text[]) ORDER BY c.id`,
  )
  return rows.map(row => row.id).sort()
}

let oldOrg: Org // created 10 days ago, named by an ORGANIZATIONS audience, holds a RESERVED redemption of the cheapest
let newOrg: Org // created yesterday, its redemption of the cheapest was RELEASED
let edgeOrg: Org // created exactly when a NEW_ORGANIZATIONS campaign starts
let cheapest: Offer
let mainList: Offer
const tracked: string[] = []

beforeAll(async () => {
  if (!/test|hybrid/i.test(new URL(process.env.TEST_DATABASE_URL!).pathname)) throw new Error('Disposable DB required')
  process.env.HYBRID_BILLING_ENABLED = 'true'
  await retire()
  staffId = (await prisma.staff.create({ data: { email: `best-${stamp}@example.test`, firstName: 'Hybrid', lastName: 'Test' } })).id
  oldOrg = await organization('old', new Date(Date.now() - 10 * day))
  newOrg = await organization('new', new Date(Date.now() - day))
  edgeOrg = await organization('edge', new Date(Date.now() - 3 * day))
  // The cheapest promotion is the OLDEST of 101: a "newest 100, then cheapest" read never sees it.
  cheapest = await offer(MAIN, 120, { campaign: { createdAt: new Date(Date.now() - hour) } })
  for (let i = 0; i < 100; i++) await offer(MAIN, 150 + Math.round((i * 100) / 99))
  mainList = await offer(MAIN, 299, { purpose: 'LIST' })
  tracked.push(cheapest.campaignId, mainList.campaignId)
  await redeem(oldOrg, cheapest.campaignId, 'RESERVED')
  await redeem(newOrg, cheapest.campaignId, 'RELEASED')
}, 180000)

afterAll(async () => {
  await retire()
  delete process.env.HYBRID_BILLING_ENABLED
})

describe('the grid picks the exact cheapest offer per product', () => {
  it('finds the cheapest of 101 promotions even when it is the oldest, and exposes the list as price and alternative', async () => {
    const grid = await getHybridFeatureGrid(newOrg.venueId)
    const entry = grid.entries.find(e => e.featureCode === MAIN)!
    expect(entry.offer).toMatchObject({
      publicationId: cheapest.publicationId,
      campaignId: cheapest.campaignId,
      price: 120,
      listPrice: 299,
    })
    expect(entry.listOffer).toMatchObject({
      publicationId: mainList.publicationId,
      campaignId: mainList.campaignId,
      price: 299,
      listPrice: 299,
      renewal: 'SAME_PRICE',
      promotionCycles: null,
    })

    const { best, list } = await bestOffersByProduct(newOrg, new Date())
    expect(best.get(`FEATURE:${MAIN}`)).toMatchObject({ publicationId: cheapest.publicationId, price: 120, listPrice: 299 })
    expect(list.get(`FEATURE:${MAIN}`)).toMatchObject({ publicationId: mainList.publicationId, price: 299 })
  })

  it('an organization holding an unreleased redemption of a promotion does not get it; a released one does', async () => {
    const forOld = await bestOffersByProduct(oldOrg, new Date())
    expect(forOld.best.get(`FEATURE:${MAIN}`)).toMatchObject({ price: 150, listPrice: 299 })
    expect(forOld.best.get(`FEATURE:${MAIN}`)!.publicationId).not.toBe(cheapest.publicationId)
    // A list is bought again freely: the redemption of a promotion never hides it.
    expect(forOld.list.get(`FEATURE:${MAIN}`)).toMatchObject({ publicationId: mainList.publicationId })
    expect((await bestOffersByProduct(newOrg, new Date())).best.get(`FEATURE:${MAIN}`)).toMatchObject({ price: 120 })
  })

  it('pausing a list hides the promotions generated from it, never the manual ones', async () => {
    const group = await prisma.hybridPromotionGroup.create({
      data: {
        name: `${PREFIX} ${stamp}`,
        percentOff: 50,
        target: { kind: 'FEATURES', featureCodes: [GROUPED] },
        startsAt: new Date(Date.now() - day),
        endsAt: new Date(Date.now() + 7 * day),
        capacityPerFeature: 10,
        status: 'ACTIVE',
        createdById: staffId,
      },
    })
    const list = await offer(GROUPED, 399, { purpose: 'LIST' })
    const generated = await offer(GROUPED, 200, { campaign: { promotionGroupId: group.id } })
    const manual = await offer(GROUPED, 250)
    const ids = [list.campaignId, generated.campaignId, manual.campaignId]
    tracked.push(...ids)
    const key = `FEATURE:${GROUPED}` as const

    const before = await bestOffersByProduct(newOrg, new Date())
    expect(before.best.get(key)).toMatchObject({ publicationId: generated.publicationId, price: 200, listPrice: 399 })
    expect(before.list.get(key)).toMatchObject({ publicationId: list.publicationId, price: 399 })
    for (const org of [oldOrg, newOrg, edgeOrg]) {
      const now = new Date()
      expect(await sellableInSql(org, now, ids)).toEqual(await sellableInTypeScript(org, now, ids))
    }

    await prisma.hybridCampaign.update({ where: { id: list.campaignId }, data: { status: 'PAUSED' } })
    const after = await bestOffersByProduct(newOrg, new Date())
    expect(after.best.get(key)).toMatchObject({ publicationId: manual.publicationId, price: 250, listPrice: null })
    expect(after.list.has(key)).toBe(false)
    const entry = (await getHybridFeatureGrid(newOrg.venueId)).entries.find(e => e.featureCode === GROUPED)!
    expect(entry.offer).toMatchObject({ publicationId: manual.publicationId, listPrice: null })
    expect(entry.listOffer).toBeNull()
    for (const org of [oldOrg, newOrg, edgeOrg]) {
      const now = new Date()
      const sql = await sellableInSql(org, now, ids)
      expect(sql).toEqual(await sellableInTypeScript(org, now, ids))
      expect(sql).toEqual([manual.campaignId])
    }
  })

  it('on equal prices the newest promotion wins, and a list wins over promotions; the alternative is only another offer', async () => {
    const key = `FEATURE:${TIE}` as const
    const older = await offer(TIE, 300, { campaign: { createdAt: new Date(Date.now() - 2 * hour) } })
    const newer = await offer(TIE, 300, { campaign: { createdAt: new Date(Date.now() - hour) } })
    tracked.push(older.campaignId, newer.campaignId)
    expect((await bestOffersByProduct(newOrg, new Date())).best.get(key)).toMatchObject({ publicationId: newer.publicationId })

    const list = await offer(TIE, 300, { purpose: 'LIST' })
    tracked.push(list.campaignId)
    const { best } = await bestOffersByProduct(newOrg, new Date())
    expect(best.get(key)).toMatchObject({ publicationId: list.publicationId, listPrice: 300 })
    const entry = (await getHybridFeatureGrid(newOrg.venueId)).entries.find(e => e.featureCode === TIE)!
    expect(entry.offer).toMatchObject({ publicationId: list.publicationId, price: 300, listPrice: 300 })
    expect(entry.listOffer).toBeNull()
  })
})

describe('the SQL selection is the purchase eligibility (hybridOfferBlocker), row by row', () => {
  it('agrees for every audience, window, capacity, Stripe readiness, pointer and redemption case', async () => {
    const at = (ms: number) => new Date(Date.now() + ms)
    const rows = {
      all: await offer(MAIN, 290),
      organizations: await offer(MAIN, 290, { campaign: { audience: 'ORGANIZATIONS', eligibleOrganizationIds: [oldOrg.id] } }),
      newOrganizations: await offer(MAIN, 290, { campaign: { audience: 'NEW_ORGANIZATIONS', startsAt: at(-5 * day) } }),
      newOrganizationsEdge: await offer(MAIN, 290, { campaign: { audience: 'NEW_ORGANIZATIONS', startsAt: edgeOrg.createdAt } }),
      future: await offer(MAIN, 290, { campaign: { startsAt: at(hour) } }),
      expired: await offer(MAIN, 290, { campaign: { startsAt: at(-3 * day), endsAt: at(-day) } }),
      full: await offer(MAIN, 290, { campaign: { capacity: 2, reservedCount: 1, redeemedCount: 1 } }),
      unpriced: await offer(MAIN, 290, { publication: { stripePriceId: null } }),
      noProduct: await offer(MAIN, 290, { publication: { stripeProductId: null } }),
      repricePending: await offer(MAIN, 290, { renewal: { kind: 'REPRICE', price: 299 }, publication: { stripeRenewalPriceId: null } }),
      repriceReady: await offer(MAIN, 290, { renewal: { kind: 'REPRICE', price: 299 } }),
      paused: await offer(MAIN, 290, { campaign: { status: 'PAUSED' } }),
      unlisted: await offer(MAIN, 290, { campaign: { listed: false } }),
      noPointer: await offer(MAIN, 290, { pointer: false }),
    }
    const ids = [...tracked, ...Object.values(rows).map(row => row.campaignId)]
    const now = new Date()
    const expected = (org: Org) =>
      [
        rows.all,
        rows.repriceReady,
        mainList,
        ...(org === oldOrg ? [rows.organizations] : [rows.newOrganizations, rows.newOrganizationsEdge, cheapest]),
      ]
        .map(row => row.campaignId)
        .sort()

    for (const org of [oldOrg, newOrg, edgeOrg]) {
      const sql = await sellableInSql(org, now, ids)
      expect(sql).toEqual(await sellableInTypeScript(org, now, ids))
      // Not a vacuous agreement: every case above lands where the purchase path puts it.
      expect(sql.filter(id => !tracked.includes(id) || id === cheapest.campaignId || id === mainList.campaignId)).toEqual(expected(org))
    }
  })
})
