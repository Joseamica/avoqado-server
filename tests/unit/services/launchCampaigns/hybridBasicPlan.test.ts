jest.mock('@/services/launchCampaigns/hybridPrices', () => ({ ensureHybridPublicationPrices: jest.fn(async () => undefined) }))
import prisma from '@/utils/prismaClient'
import { saveBasicPlan, getBasicPlanRow } from '@/services/launchCampaigns/hybridListPrice.service'
import { getPublicBasicPlan, getPublicHybridOffer } from '@/services/launchCampaigns/hybridCampaign.service'
import { BASIC_PLAN_KEY } from '@/services/launchCampaigns/hybridProduct'

const db = prisma as any
const definition = (extra: object = {}) => ({
  schemaVersion: 1,
  kind: 'FEATURES',
  basicPlan: true,
  featureCodes: ['CFDI'],
  seatCap: null,
  terms: {
    currency: 'MXN',
    interval: 'MONTHLY',
    price: 578.84,
    taxIncluded: true,
    promotionCycles: null,
    renewal: { kind: 'SAME_PRICE' },
    ...extra,
  },
})
const basicList = (over: object = {}) => ({
  id: 'list1',
  purpose: 'LIST',
  listProductKey: BASIC_PLAN_KEY,
  slug: 'plan-basico',
  code: 'L_PLAN_BASICO',
  status: 'ACTIVE',
  startsAt: new Date(Date.now() - 1000),
  endsAt: null,
  capacity: null,
  reservedCount: 0,
  redeemedCount: 0,
  promotionGroupId: null,
  currentPublicationId: 'pub1',
  revision: 3,
  ...over,
})
const publication = {
  id: 'pub1',
  version: 2,
  name: 'Plan Básico',
  definition: definition(),
  definitionHash: 'h',
  includedFeatureCodes: ['CFDI'],
}

describe('public Plan Básico read', () => {
  it('priceWithoutTax is 499.00 for 578.84, with unlimited seats as null', async () => {
    db.hybridCampaign = { findFirst: jest.fn(async () => basicList()) }
    db.hybridOfferPublication = { findUnique: jest.fn(async () => publication) }
    expect(await getPublicBasicPlan()).toEqual({
      slug: 'plan-basico',
      name: 'Plan Básico',
      priceWithTax: '578.84',
      priceWithoutTax: '499.00',
      featureCodes: ['CFDI'],
      seatCap: null,
      trialDays: 30,
      publicationId: 'pub1',
    })
  })

  it('is null when nothing is published', async () => {
    db.hybridCampaign = { findFirst: jest.fn(async () => null) }
    expect(await getPublicBasicPlan()).toBeNull()
  })

  it("getPublicHybridOffer('plan-basico') answers with unlimited places; another LIST stays 404", async () => {
    db.hybridOfferPublication = { findUnique: jest.fn(async () => publication) }
    db.hybridCampaign = { findUnique: jest.fn(async () => basicList()) }
    await expect(getPublicHybridOffer('plan-basico')).resolves.toMatchObject({ slug: 'plan-basico', placesRemaining: null })
    db.hybridCampaign = { findUnique: jest.fn(async () => basicList({ listProductKey: 'FEATURE:CFDI', slug: 'lista-cfdi' })) }
    await expect(getPublicHybridOffer('lista-cfdi')).rejects.toMatchObject({ statusCode: 404 })
  })

  it('the Básico not published is 404', async () => {
    db.hybridCampaign = { findUnique: jest.fn(async () => basicList({ status: 'DRAFT' })) }
    await expect(getPublicHybridOffer('plan-basico')).rejects.toMatchObject({ statusCode: 404 })
  })
})

describe('saveBasicPlan', () => {
  const base = { name: 'Plan Básico', featureCodes: ['CFDI'], price: 578.84, seatCap: null, expectedRevision: null }

  it('rejects a non-CONFIGURABLE or unknown function with a Spanish 400', async () => {
    await expect(saveBasicPlan({ ...base, featureCodes: ['NO_EXISTE'] }, 's1')).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('NO_EXISTE'),
    })
  })

  it('an old expectedRevision is a 409 and nothing is created', async () => {
    const create = jest.fn()
    db.$transaction = jest.fn(async (fn: any) =>
      fn({
        $executeRaw: jest.fn(),
        hybridCampaign: { findFirst: jest.fn(async () => ({ id: 'list1', revision: 5 })), create },
      }),
    )
    await expect(saveBasicPlan({ ...base, expectedRevision: 4 }, 's1')).rejects.toMatchObject({
      statusCode: 409,
      code: 'HYBRID_CAMPAIGN_STALE',
    })
    expect(create).not.toHaveBeenCalled()
  })

  it('creates the single LIST PLAN:BASICO (code, slug) and logs HYBRID_BASIC_PLAN_SAVED, without the list-price rule', async () => {
    const create = jest.fn(async ({ data }: any) => ({ id: 'list1', revision: 1, ...data }))
    const tx = {
      $executeRaw: jest.fn(),
      $queryRaw: jest.fn(async () => {
        throw new Error('the list-price rule must not run for the Básico')
      }),
      hybridCampaign: {
        findFirst: jest.fn(async () => null),
        create,
        updateMany: jest.fn(async () => ({ count: 1 })),
        findUniqueOrThrow: jest.fn(async () => ({ id: 'list1', currentPublicationId: null, status: 'DRAFT' })),
      },
      hybridOfferPublication: {
        create: jest.fn(async () => ({ id: 'pub1' })),
        findUniqueOrThrow: jest.fn(async () => ({ definition: definition() })),
      },
      activityLog: { create: jest.fn() },
    }
    db.$transaction = jest.fn(async (fn: any) => fn(tx))
    db.hybridCampaign.findMany = jest.fn(async () => [
      {
        id: 'list1',
        listProductKey: BASIC_PLAN_KEY,
        revision: 3,
        status: 'ACTIVE',
        currentPublicationId: 'pub1',
        pendingPublicationId: null,
      },
    ])
    db.hybridOfferPublication = { findMany: jest.fn(async () => [{ id: 'pub1', definition: definition() }]) }
    db.activityLog = { create: jest.fn() }
    db.$queryRaw = jest.fn(async () => [])
    const row = await saveBasicPlan(base, 's1')
    expect(create.mock.calls[0][0].data).toMatchObject({
      purpose: 'LIST',
      listProductKey: 'PLAN:BASICO',
      code: 'L_PLAN_BASICO',
      slug: 'plan-basico',
      name: 'Plan Básico',
    })
    expect(row.price).toBe(578.84)
    expect(db.activityLog.create.mock.calls[0][0].data).toMatchObject({
      staffId: 's1',
      action: 'HYBRID_BASIC_PLAN_SAVED',
      entity: 'HybridCampaign',
      data: { price: 578.84, featureCodes: ['CFDI'], seatCap: null },
    })
  })
})

describe('getBasicPlanRow', () => {
  it('returns featureCodes, seatCap and name from the CURRENT publication (not the draft)', async () => {
    db.hybridCampaign = {
      findMany: jest.fn(async () => [basicList({ pendingPublicationId: null })]),
      findUnique: jest.fn(async () => ({ currentPublicationId: 'pub1' })),
    }
    db.hybridOfferPublication = {
      findMany: jest.fn(async () => [{ id: 'pub1', definition: definition({ price: 578.84 }) }]),
      findUnique: jest.fn(async () => ({
        name: 'Plan Básico',
        definition: { ...definition(), featureCodes: ['CFDI', 'LOYALTY_PROGRAM'], seatCap: 5 },
      })),
    }
    db.$queryRaw = jest.fn(async () => [])
    const row = await getBasicPlanRow()
    expect(row).toMatchObject({
      campaignId: 'list1',
      price: 578.84,
      featureCodes: ['CFDI', 'LOYALTY_PROGRAM'],
      seatCap: 5,
      campaignName: 'Plan Básico',
    })
    expect(db.hybridOfferPublication.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'pub1' } }))
  })
  it('without a saved Básico the row has no extras', async () => {
    db.hybridCampaign = { findMany: jest.fn(async () => []) }
    db.hybridOfferPublication = { findMany: jest.fn(async () => []) }
    db.$queryRaw = jest.fn(async () => [])
    const row = await getBasicPlanRow()
    expect(row.campaignId).toBeNull()
    expect(row.featureCodes).toBeUndefined()
  })
})
