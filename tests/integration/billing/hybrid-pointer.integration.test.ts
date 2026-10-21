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
import {
  createHybridCampaign,
  updateHybridCampaign,
  publishHybridCampaign,
  getPublicHybridOffer,
  listPublicHybridOffers,
  getHybridCampaign,
  setHybridCampaignStatus,
} from '@/services/launchCampaigns/hybridCampaign.service'
import { createHybridQuote, acceptHybridQuote } from '@/services/launchCampaigns/hybridPurchase.service'

const stamp = `${Date.now()}${process.pid}`
const pick = ({ campaignId, name, definition, definitionHash, includedFeatureCodes, createdById }: any) => ({
  campaignId,
  name,
  definition,
  definitionHash,
  includedFeatureCodes,
  createdById,
})
const draft = (suffix: string) => ({
  code: `P${stamp}${suffix}`,
  slug: `pointer-${stamp}-${suffix.toLowerCase()}`,
  name: `Puntero ${stamp} ${suffix}`,
  startsAt: new Date(Date.now() - 86400000).toISOString(),
  endsAt: new Date(Date.now() + 7 * 86400000).toISOString(),
  audience: 'ALL',
  capacity: 5,
  listed: true,
  definition: {
    schemaVersion: 1,
    kind: 'FEATURES',
    featureCodes: ['CFDI'],
    terms: {
      currency: 'MXN',
      interval: 'MONTHLY',
      price: 149.9,
      taxIncluded: true,
      promotionCycles: null,
      renewal: { kind: 'SAME_PRICE' },
    },
  },
})
let staffId: string
let venueId: string
let campaignId: string
let slug: string
beforeAll(async () => {
  if (!/test|hybrid/i.test(new URL(process.env.TEST_DATABASE_URL!).pathname)) throw new Error('Disposable DB required')
  process.env.HYBRID_BILLING_ENABLED = 'true'
  staffId = (await prisma.staff.create({ data: { email: `pointer-${stamp}@example.test`, firstName: 'Hybrid', lastName: 'Test' } })).id
  const org = await prisma.organization.create({ data: { name: stamp, email: `pointer-${stamp}@example.test`, phone: '5550000000' } })
  venueId = (
    await prisma.venue.create({
      data: { organizationId: org.id, name: stamp, slug: `pointer-${stamp}`, stripeCustomerId: `cus_pointer_${stamp}` },
    })
  ).id
  const campaign = await createHybridCampaign(draft('A'), staffId)
  campaignId = campaign.id
  slug = campaign.slug
})
afterAll(async () => {
  // The disposable DB is shared: a listed offer left on sale would leak into other suites' public lists and grids.
  await prisma.hybridCampaign.updateMany({ where: { code: { startsWith: `P${stamp}` } }, data: { status: 'ENDED' } })
  delete process.env.HYBRID_BILLING_ENABLED
})

describe('the publication on sale is the explicit pointer', () => {
  it('readers follow currentPublicationId, not the highest version', async () => {
    const v1 = await publishHybridCampaign(campaignId, 1, staffId)
    await prisma.hybridOfferPublication.update({
      where: { id: v1.id },
      data: { stripePriceId: `price_p_${stamp}`, stripeProductId: `prod_p_${stamp}` },
    })
    await prisma.hybridCampaign.update({ where: { id: campaignId }, data: { status: 'ACTIVE' } })
    const v2 = await prisma.hybridOfferPublication.create({
      data: { ...pick(v1), id: undefined, version: 2, stripePriceId: null, stripeProductId: null } as never,
    })
    expect((await getPublicHybridOffer(slug)).id).toBe(v1.id)
    await expect(createHybridQuote(venueId, staffId, { lines: [{ publicationId: v2.id }] })).rejects.toMatchObject({
      code: 'HYBRID_OFFER_UNAVAILABLE',
    })
    await expect(createHybridQuote(venueId, staffId, { lines: [{ publicationId: v1.id }] })).resolves.toMatchObject({ status: 'QUOTED' })

    // Every other reader of "the offer on sale" follows the same pointer.
    expect((await getHybridCampaign(campaignId)).publications.map(p => p.id)).toEqual([v1.id])
    expect((await listPublicHybridOffers({ q: `Puntero ${stamp} A` })).items.map(item => item.id)).toEqual([v1.id])
    await expect(
      setHybridCampaignStatus(campaignId, { status: 'ACTIVE', expectedRevision: 2, publicationId: v2.id }, staffId),
    ).rejects.toMatchObject({ code: 'HYBRID_PUBLICATION_REQUIRED' })
    // The in-lock recheck of acceptance compares the pointer too: a higher version does not block the one on sale.
    const quote = await createHybridQuote(venueId, staffId, { lines: [{ publicationId: v1.id }] })
    await expect(
      acceptHybridQuote(venueId, staffId, quote.id, { quoteHash: quote.quoteHash, clientKey: `pointer-${stamp}` }),
    ).resolves.toMatchObject({ status: 'ACCEPTED' })
    expect(await prisma.hybridCampaign.findUniqueOrThrow({ where: { id: campaignId } })).toMatchObject({ reservedCount: 1 })
  })

  it('publishing again pauses the campaign and moves the pointer to the new publication', async () => {
    const input = draft('B')
    const campaign = await createHybridCampaign(input, staffId)
    const first = await publishHybridCampaign(campaign.id, 1, staffId)
    await updateHybridCampaign(campaign.id, { ...input, name: `Puntero ${stamp} B2`, expectedRevision: 2 }, staffId)
    const second = await publishHybridCampaign(campaign.id, 3, staffId)
    expect(second.id).not.toBe(first.id)
    expect(await prisma.hybridCampaign.findUniqueOrThrow({ where: { id: campaign.id } })).toMatchObject({
      status: 'PAUSED',
      revision: 4,
      currentPublicationId: second.id,
    })
    expect((await getHybridCampaign(campaign.id)).publications.map(p => p.id)).toEqual([second.id])
  })
})
