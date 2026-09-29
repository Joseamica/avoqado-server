import prisma from '@/utils/prismaClient'
import { grantedCapabilityCodes, hasCapabilityGrant, venuesWithCapabilityGrant } from '@/services/access/capabilityGrants.service'
import { createHybridCampaign, updateHybridCampaign, publishHybridCampaign } from '@/services/launchCampaigns/hybridCampaign.service'

const stamp = `${Date.now()}${process.pid}`
let venueId: string
let otherVenueId: string
let staffId: string
const draft = (suffix: string) => ({
  code: `H${stamp}_${suffix}`,
  slug: `hybrid-${stamp}-${suffix.toLowerCase()}`,
  name: 'Oferta de prueba aislada',
  startsAt: new Date(Date.now() - 60000).toISOString(),
  endsAt: new Date(Date.now() + 86400000).toISOString(),
  capacity: 2,
  audience: 'ALL',
  listed: false,
  definition: {
    schemaVersion: 1,
    kind: 'FEATURES',
    featureCodes: ['CFDI'],
    terms: {
      currency: 'MXN',
      interval: 'MONTHLY',
      price: 179.9,
      taxIncluded: true,
      promotionCycles: null,
      renewal: { kind: 'SAME_PRICE' },
    },
  },
})

beforeAll(async () => {
  const url = new URL(process.env.TEST_DATABASE_URL!)
  if (!/test|hybrid/i.test(url.pathname)) throw new Error('This suite requires an explicitly named disposable test database.')
  const org = await prisma.organization.create({
    data: { name: `Hybrid ${stamp}`, email: `hybrid-${stamp}@example.test`, phone: '5550000000' },
  })
  const staff = await prisma.staff.create({ data: { email: `hybrid-${stamp}@example.test`, firstName: 'Hybrid', lastName: 'Test' } })
  staffId = staff.id
  venueId = (await prisma.venue.create({ data: { name: 'Hybrid A', slug: `hybrid-a-${stamp}`, organizationId: org.id } })).id
  otherVenueId = (await prisma.venue.create({ data: { name: 'Hybrid B', slug: `hybrid-b-${stamp}`, organizationId: org.id } })).id
})

describe('hybrid catalog PostgreSQL invariants', () => {
  it('filters expired, future, revoked and foreign grants while preserving overlapping origins', async () => {
    const now = Date.now()
    const current = { startsAt: new Date(now - 60000), endsAt: new Date(now + 60000), featureCode: 'CFDI', venueId }
    await prisma.capabilityGrant.createMany({
      data: [
        { ...current, sourceId: 'source-a' },
        { ...current, sourceId: 'source-b' },
        {
          ...current,
          sourceId: 'expired',
          featureCode: 'LOYALTY_PROGRAM',
          startsAt: new Date(now - 120000),
          endsAt: new Date(now - 60000),
        },
        { ...current, sourceId: 'future', featureCode: 'RESERVATIONS', startsAt: new Date(now + 30000) },
        { ...current, sourceId: 'revoked', featureCode: 'PROMOTIONS', revokedAt: new Date(now - 1000) },
        { ...current, sourceId: 'foreign', featureCode: 'UPSELL', venueId: otherVenueId },
      ],
    })
    await expect(grantedCapabilityCodes(venueId)).resolves.toEqual(['CFDI'])
    await prisma.capabilityGrant.updateMany({ where: { venueId, sourceId: 'source-a' }, data: { revokedAt: new Date() } })
    await expect(hasCapabilityGrant(venueId, 'CFDI')).resolves.toBe(true)
    await expect(venuesWithCapabilityGrant([venueId, otherVenueId], 'CFDI')).resolves.toEqual([venueId])
    await expect(hasCapabilityGrant(venueId, 'UPSELL')).resolves.toBe(false)
  })

  it('rejects an inverted grant lifetime in PostgreSQL', async () => {
    await expect(
      prisma.capabilityGrant.create({
        data: { venueId, featureCode: 'CFDI', sourceId: 'bad-window', startsAt: new Date(), endsAt: new Date(Date.now() - 1000) },
      }),
    ).rejects.toThrow()
  })

  it('publishes once under concurrent requests and freezes terms against later SQL writers', async () => {
    const campaign = await createHybridCampaign(draft('PUB'), staffId)
    const results = await Promise.allSettled([
      publishHybridCampaign(campaign.id, 1, staffId),
      publishHybridCampaign(campaign.id, 1, staffId),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const publication = await prisma.hybridOfferPublication.findFirstOrThrow({ where: { campaignId: campaign.id } })
    await expect(
      prisma.hybridOfferPublication.update({ where: { id: publication.id }, data: { definition: { price: 1 } } }),
    ).rejects.toThrow(/immutable/i)
    const saved = await prisma.hybridOfferPublication.findUniqueOrThrow({ where: { id: publication.id } })
    expect(saved.definition).toMatchObject({ terms: { price: 179.9 }, featureCodes: ['CFDI'] })
    expect(await prisma.activityLog.count({ where: { entityId: campaign.id, action: 'HYBRID_OFFER_PUBLISHED' } })).toBe(1)
  })

  it('a failing audit (second write) rolls back the campaign', async () => {
    const input = draft('ROLLBACK')
    await expect(createHybridCampaign(input, 'missing-staff')).rejects.toThrow()
    expect(await prisma.hybridCampaign.count({ where: { code: input.code } })).toBe(0)
  })

  it('concurrent draft edits cannot overwrite each other', async () => {
    const input = draft('EDIT')
    const campaign = await createHybridCampaign(input, staffId)
    const edits = await Promise.allSettled([
      updateHybridCampaign(campaign.id, { ...input, name: 'Primera versión', expectedRevision: 1 }, staffId),
      updateHybridCampaign(campaign.id, { ...input, name: 'Segunda versión', expectedRevision: 1 }, staffId),
    ])
    expect(edits.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(await prisma.hybridCampaign.findUnique({ where: { id: campaign.id } })).toMatchObject({ revision: 2 })
  })
})
