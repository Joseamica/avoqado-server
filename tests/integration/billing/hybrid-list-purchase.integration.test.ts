import prisma from '@/utils/prismaClient'
jest.mock('@/services/access/inventarioDeObligaciones', () => ({
  inventarioDeObligaciones: jest.fn(async () => ({ vivas: [], detalle: {}, conCambiosProgramados: [] })),
}))
jest.mock('@/services/stripe.service', () => ({
  stripe: {
    customers: { retrieve: jest.fn(async (id: string) => ({ id, balance: 0 })) },
    checkout: { sessions: { list: jest.fn(async () => ({ data: [], has_more: false })) } },
  },
  STRIPE_DENTRO_DEL_CANDADO: { timeout: 15000, maxNetworkRetries: 0 },
}))
// The real purchase rule (lock, pending purchase, compatibility) unless a race test swaps one call (see `raceAfterInLockRead`).
jest.mock('@/services/access/autorizarObligacionNueva', () => {
  const actual = jest.requireActual('@/services/access/autorizarObligacionNueva')
  return { autorizarObligacionNueva: jest.fn(actual.autorizarObligacionNueva) }
})
import type { Prisma } from '@prisma/client'
import { autorizarObligacionNueva } from '@/services/access/autorizarObligacionNueva'
import { inventarioDeObligaciones } from '@/services/access/inventarioDeObligaciones'
import { compileHybridPublication } from '@/services/launchCampaigns/hybridOffer.service'
import { getPublicHybridOffer, listHybridCampaigns, listPublicHybridOffers } from '@/services/launchCampaigns/hybridCampaign.service'
import { acceptHybridQuote, createHybridQuote } from '@/services/launchCampaigns/hybridPurchase.service'

const stamp = `${Date.now()}${process.pid}`
// Every catalog row of this suite carries this author: a crashed run's LIST would otherwise hold FEATURE:CFDI forever.
const MARK = 'test:hybrid-list-purchase'
let staffId: string
const venues: string[] = []
let listCampaign: string
let listPub: string
let promoCampaign: string
let promoPub: string

const cfdiAt = (price: number) => ({
  schemaVersion: 1,
  kind: 'FEATURES',
  featureCodes: ['CFDI'],
  terms: { currency: 'MXN', interval: 'MONTHLY', price, taxIncluded: true, promotionCycles: null, renewal: { kind: 'SAME_PRICE' } },
})

/** On sale, written straight to the DB (the «Precios» screen comes later): ACTIVE, priced in Stripe, pointer set. */
async function onSale(
  data: Pick<Prisma.HybridCampaignUncheckedCreateInput, 'code' | 'slug' | 'name' | 'purpose' | 'listProductKey' | 'promotionGroupId'> & {
    endsAt: Date | null
    capacity: number | null
  },
  price: number,
) {
  const compiled = compileHybridPublication(cfdiAt(price))
  const campaign = await prisma.hybridCampaign.create({
    data: {
      ...data,
      draftDefinition: compiled.definition,
      startsAt: new Date(Date.now() - 86400000),
      audience: 'ALL',
      listed: true,
      status: 'ACTIVE',
      revision: 2,
      createdById: MARK,
    },
  })
  const publication = await prisma.hybridOfferPublication.create({
    data: {
      campaignId: campaign.id,
      version: 1,
      name: data.name,
      definition: compiled.definition,
      definitionHash: compiled.definitionHash,
      includedFeatureCodes: compiled.includedFeatureCodes,
      stripePriceId: `price_${data.code}`,
      stripeProductId: `prod_${data.code}`,
      createdById: MARK,
    },
  })
  await prisma.hybridCampaign.update({ where: { id: campaign.id }, data: { currentPublicationId: publication.id } })
  return { campaign: campaign.id, publication: publication.id }
}

/**
 * Publications and purchases are immutable by trigger, so nothing is deleted: each list frees its product (one LIST per
 * product in the whole DB) and stops selling, and the promotions end, so no other suite's lists or grids see them.
 */
async function retireCatalog() {
  const lists = await prisma.hybridCampaign.findMany({ where: { createdById: MARK, purpose: 'LIST' }, select: { id: true }, take: 50 })
  for (const { id } of lists)
    await prisma.hybridCampaign.update({ where: { id }, data: { listProductKey: `FEATURE:RETIRED_${id}`, status: 'PAUSED' } })
  await prisma.hybridCampaign.updateMany({ where: { createdById: MARK, purpose: 'PROMOTION' }, data: { status: 'ENDED' } })
  await prisma.hybridPromotionGroup.updateMany({ where: { createdById: MARK }, data: { status: 'ENDED' } })
}

const pauseList = () =>
  prisma.hybridCampaign.update({ where: { id: listCampaign }, data: { status: 'PAUSED', revision: { increment: 1 } } })
const quoteOf = (venue: number, publicationId: string) => createHybridQuote(venues[venue], staffId, { lines: [{ publicationId }] })
const accept = (venue: number, quote: { id: string; quoteHash: string }, key: string) =>
  acceptHybridQuote(venues[venue], staffId, quote.id, { quoteHash: quote.quoteHash, clientKey: `${key}-${stamp}` })
const statusOf = async (purchaseId: string) => (await prisma.hybridPurchase.findUniqueOrThrow({ where: { id: purchaseId } })).status
const campaignRow = (id: string) => prisma.hybridCampaign.findUniqueOrThrow({ where: { id } })

/**
 * The next acceptance runs its callback in a plain transaction, and `act` commits from ANOTHER connection right after the
 * callback re-reads the campaign under the lock: from there on, only the conditional write can still notice the change.
 */
function raceAfterInLockRead(act: () => Promise<unknown>) {
  jest.mocked(autorizarObligacionNueva).mockImplementationOnce(async (venueId, _customerId, _intent, create) => {
    const inventory = await inventarioDeObligaciones(venueId)
    return prisma.$transaction(async tx => {
      let pending = true
      const campaigns = new Proxy(tx.hybridCampaign, {
        get(delegate, prop) {
          const value = Reflect.get(delegate, prop)
          if (prop !== 'findUniqueOrThrow') return typeof value === 'function' ? value.bind(delegate) : value
          return async (args: Prisma.HybridCampaignFindUniqueOrThrowArgs) => {
            const row = await delegate.findUniqueOrThrow(args)
            if (pending) {
              pending = false
              await act()
            }
            return row
          }
        },
      })
      const client = new Proxy(tx, {
        get(target, prop) {
          if (prop === 'hybridCampaign') return campaigns
          const value = Reflect.get(target, prop)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
      return create(client, inventory)
    })
  })
}

beforeAll(async () => {
  if (!/test|hybrid/i.test(new URL(process.env.TEST_DATABASE_URL!).pathname)) throw new Error('Disposable DB required')
  process.env.HYBRID_BILLING_ENABLED = 'true'
  await retireCatalog()
  staffId = (await prisma.staff.create({ data: { email: `list-${stamp}@example.test`, firstName: 'Hybrid', lastName: 'Test' } })).id
  for (let i = 0; i < 9; i++) {
    const org = await prisma.organization.create({ data: { name: stamp, email: `list-${stamp}-${i}@example.test`, phone: '5550000000' } })
    const venue = await prisma.venue.create({
      data: { organizationId: org.id, name: stamp, slug: `list-${stamp}-${i}`, stripeCustomerId: `cus_list_${stamp}_${i}` },
    })
    venues.push(venue.id)
  }
  const list = await onSale(
    {
      code: `LP${stamp}`,
      slug: `lp-${stamp}`,
      name: `Lista CFDI ${stamp}`,
      purpose: 'LIST',
      listProductKey: 'FEATURE:CFDI',
      endsAt: null,
      capacity: null,
    },
    199,
  )
  listCampaign = list.campaign
  listPub = list.publication
  const endsAt = new Date(Date.now() + 7 * 86400000)
  const group = await prisma.hybridPromotionGroup.create({
    data: {
      name: `20 % ${stamp}`,
      percentOff: 20,
      target: { kind: 'FEATURES', featureCodes: ['CFDI'] },
      startsAt: new Date(Date.now() - 86400000),
      endsAt,
      capacityPerFeature: 10,
      status: 'ACTIVE',
      createdById: MARK,
    },
  })
  const promo = await onSale(
    {
      code: `GP${stamp}`,
      slug: `gp-${stamp}`,
      name: `Promoción CFDI ${stamp}`,
      purpose: 'PROMOTION',
      promotionGroupId: group.id,
      endsAt,
      capacity: 10,
    },
    159.2,
  )
  promoCampaign = promo.campaign
  promoPub = promo.publication
})
// Each test starts from the list on sale at its first price, whatever the previous one paused or republished.
afterEach(() =>
  prisma.hybridCampaign.update({
    where: { id: listCampaign },
    data: { status: 'ACTIVE', currentPublicationId: listPub, revision: { increment: 1 } },
  }),
)
afterAll(async () => {
  await retireCatalog()
  delete process.env.HYBRID_BILLING_ENABLED
})

describe('buying a LIST: no redemption, no capacity, still serialized', () => {
  it('a LIST purchase creates no redemption and holds no capacity', async () => {
    const quote = await quoteOf(0, listPub)
    // A LIST has no end date: only the five-minute review window bounds the quote.
    expect(quote.quoteExpiresAt.getTime()).toBeGreaterThan(Date.now() + 4 * 60000)
    await expect(accept(0, quote, 'list')).resolves.toMatchObject({ status: 'ACCEPTED' })
    expect(await prisma.hybridRedemption.count({ where: { campaignId: listCampaign } })).toBe(0)
    expect(await campaignRow(listCampaign)).toMatchObject({ reservedCount: 0, redeemedCount: 0 })
  })

  it('two tabs accepting the same list function end in a single accepted purchase', async () => {
    const quotes = [await quoteOf(1, listPub), await quoteOf(1, listPub)]
    const results = await Promise.allSettled(quotes.map((quote, i) => accept(1, quote, `tab-${i}`)))
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(await prisma.hybridPurchase.count({ where: { venueId: venues[1], status: 'ACCEPTED' } })).toBe(1)
    expect(await campaignRow(listCampaign)).toMatchObject({ reservedCount: 0, redeemedCount: 0 })
  })

  it('(a) pausing the list before accepting fails the old quote', async () => {
    const quote = await quoteOf(2, listPub)
    await pauseList()
    await expect(accept(2, quote, 'a')).rejects.toMatchObject({ code: 'HYBRID_OFFER_UNAVAILABLE' })
    expect(await statusOf(quote.id)).toBe('QUOTED')
  })

  it('(b) a pause committed between the in-lock re-read and the conditional write fails the acceptance', async () => {
    const quote = await quoteOf(3, listPub)
    raceAfterInLockRead(pauseList)
    await expect(accept(3, quote, 'b')).rejects.toMatchObject({ code: 'HYBRID_OFFER_UNAVAILABLE' })
    expect(await statusOf(quote.id)).toBe('QUOTED')
    expect(await campaignRow(listCampaign)).toMatchObject({ status: 'PAUSED' })
  })

  it('(c) accepting and then pausing is a valid outcome: the purchase stays accepted and the list paused', async () => {
    const quote = await quoteOf(4, listPub)
    await expect(accept(4, quote, 'c')).resolves.toMatchObject({ status: 'ACCEPTED' })
    await pauseList()
    expect(await statusOf(quote.id)).toBe('ACCEPTED')
    expect(await campaignRow(listCampaign)).toMatchObject({ status: 'PAUSED', reservedCount: 0, redeemedCount: 0 })
  })

  it('(d) a new list price published between the in-lock re-read and the conditional write fails the acceptance', async () => {
    const quote = await quoteOf(5, listPub)
    raceAfterInLockRead(async () => {
      const compiled = compileHybridPublication(cfdiAt(249))
      const next = await prisma.hybridOfferPublication.create({
        data: {
          campaignId: listCampaign,
          version: 2,
          name: `Lista CFDI ${stamp}`,
          definition: compiled.definition,
          definitionHash: compiled.definitionHash,
          includedFeatureCodes: compiled.includedFeatureCodes,
          createdById: MARK,
        },
      })
      await prisma.hybridCampaign.update({
        where: { id: listCampaign },
        data: { currentPublicationId: next.id, revision: { increment: 1 } },
      })
    })
    await expect(accept(5, quote, 'd')).rejects.toMatchObject({ code: 'HYBRID_OFFER_UNAVAILABLE' })
    expect(await statusOf(quote.id)).toBe('QUOTED')
    expect(await prisma.hybridPurchase.count({ where: { venueId: venues[5], status: 'ACCEPTED' } })).toBe(0)
  })
})

describe('a generated promotion sells only while its parent LIST does', () => {
  it('reserves its place while the list is on sale; once the list is paused, its own link no longer quotes', async () => {
    const quote = await quoteOf(6, promoPub)
    await expect(accept(6, quote, 'promo')).resolves.toMatchObject({ status: 'ACCEPTED' })
    expect(await campaignRow(promoCampaign)).toMatchObject({ reservedCount: 1 })
    await pauseList()
    await expect(quoteOf(7, promoPub)).rejects.toMatchObject({ code: 'HYBRID_OFFER_UNAVAILABLE' })
  })

  it('pausing the list between the in-lock re-read and the write cancels the acceptance without taking a place', async () => {
    const quote = await quoteOf(8, promoPub)
    const before = await campaignRow(promoCampaign)
    raceAfterInLockRead(pauseList)
    await expect(accept(8, quote, 'promo-race')).rejects.toMatchObject({ code: 'HYBRID_OFFER_UNAVAILABLE' })
    expect(await statusOf(quote.id)).toBe('QUOTED')
    expect((await campaignRow(promoCampaign)).reservedCount).toBe(before.reservedCount)
    expect(await prisma.hybridRedemption.count({ where: { purchaseId: quote.id } })).toBe(0)
  })
})

it('a LIST never shows in the public list, the public detail or the superadmin campaign list', async () => {
  const offers = await listPublicHybridOffers({ q: `Lista CFDI ${stamp}` })
  expect(offers.items.find(item => item.id === listPub)).toBeUndefined()
  const admin = await listHybridCampaigns({ q: `LP${stamp}` })
  expect(admin.items.find(item => item.id === listCampaign)).toBeUndefined()
  expect(admin.total).toBe(0)
  await expect(getPublicHybridOffer(`lp-${stamp}`)).rejects.toMatchObject({ statusCode: 404 })
})
