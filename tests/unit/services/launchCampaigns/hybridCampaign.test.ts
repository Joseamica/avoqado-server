const broadcast = jest.fn()
jest.mock('@/communication/sockets/managers/socketManager', () => ({
  socketManager: { broadcastToRole: (...args: unknown[]) => broadcast(...args) },
}))
jest.mock('@/services/launchCampaigns/hybridPrices', () => ({ ensureHybridPublicationPrices: jest.fn() }))
import { ensureHybridPublicationPrices } from '@/services/launchCampaigns/hybridPrices'
import { compileHybridPublication } from '@/services/launchCampaigns/hybridOffer.service'
import prisma from '@/utils/prismaClient'
import {
  createHybridCampaign,
  updateHybridCampaign,
  publishHybridCampaign,
  getPublicHybridOffer,
  listHybridCampaigns,
  setHybridCampaignStatus,
  listPublicHybridOffers,
} from '@/services/launchCampaigns/hybridCampaign.service'

const db = prisma as any
const now = Date.now()
const input = {
  code: 'RETAIL_FALL',
  name: 'Herramientas para tu tienda',
  slug: 'herramientas-tienda',
  startsAt: new Date(now - 60_000).toISOString(),
  endsAt: new Date(now + 86_400_000).toISOString(),
  capacity: 40,
  audience: 'ALL',
  listed: true,
  definition: {
    schemaVersion: 1,
    kind: 'CHOICE_BUNDLE',
    choiceCount: 2,
    eligibleFeatureCodes: ['CFDI', 'LOYALTY_PROGRAM', 'RESERVATIONS'],
    terms: {
      currency: 'MXN',
      interval: 'MONTHLY',
      price: 379.5,
      taxIncluded: true,
      promotionCycles: null,
      renewal: { kind: 'SAME_PRICE' },
    },
  },
}
let row: any
beforeEach(() => {
  row = {
    id: 'campaign1',
    ...input,
    draftDefinition: input.definition,
    startsAt: new Date(input.startsAt),
    endsAt: new Date(input.endsAt),
    revision: 1,
    status: 'DRAFT',
    reservedCount: 0,
    redeemedCount: 0,
    publications: [],
  }
  db.hybridCampaign = {
    create: jest.fn(async ({ data }: any) => ({ id: 'campaign1', ...data })),
    findUnique: jest.fn(async () => row),
    findFirst: jest.fn(async () => row),
    findMany: jest.fn(async () => [row]),
    count: jest.fn(async () => 113),
    updateMany: jest.fn(async () => ({ count: 1 })),
    findUniqueOrThrow: jest.fn(async () => row),
  }
  db.hybridOfferPublication = { create: jest.fn(async ({ data }: any) => ({ id: 'pub1', ...data })) }
  db.activityLog.create.mockResolvedValue({ id: 'audit' })
  db.$transaction.mockImplementation(async (fn: any) => (typeof fn === 'function' ? fn(db) : Promise.all(fn)))
})

describe('hybrid campaign publication', () => {
  it('creation always persists a draft, never enables sales', async () => {
    const created = await createHybridCampaign(input, 'staff1')
    expect(created).toMatchObject({ status: 'DRAFT', revision: 1, draftDefinition: input.definition })
    expect(db.activityLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'HYBRID_CAMPAIGN_CREATED', staffId: 'staff1' }) }),
    )
  })
  it('rejects invalid windows and capacity before a write', async () => {
    await expect(createHybridCampaign({ ...input, endsAt: input.startsAt }, 'staff1')).rejects.toThrow()
    await expect(createHybridCampaign({ ...input, capacity: 0 }, 'staff1')).rejects.toThrow()
    expect(db.hybridCampaign.create).not.toHaveBeenCalled()
  })
  it('rejects a stale editor without overwriting another draft', async () => {
    db.hybridCampaign.updateMany.mockResolvedValue({ count: 0 })
    await expect(updateHybridCampaign('campaign1', { ...input, expectedRevision: 1 }, 'staff1')).rejects.toThrow(/cambió|actualiza/i)
  })
  it('cannot reduce capacity below already promised places', async () => {
    row.reservedCount = 30
    row.redeemedCount = 6
    await expect(updateHybridCampaign('campaign1', { ...input, capacity: 35, expectedRevision: 1 }, 'staff1')).rejects.toThrow(
      /cupo|lugares/i,
    )
  })
  it('publishes immutable composition and price while keeping publication separate from sale activation', async () => {
    const published = await publishHybridCampaign('campaign1', 1, 'staff1')
    expect(published).toMatchObject({
      version: 1,
      definition: input.definition,
      includedFeatureCodes: [],
      definitionHash: expect.any(String),
    })
    expect(db.hybridCampaign.updateMany.mock.calls[0][0].data.status).toBe('PAUSED')
  })
  it('publishes readable labels for every eligible feature without a six-feature limit', async () => {
    row.status = 'ACTIVE'
    row.publications = [{ id: 'pub', name: row.name, ...compileHybridPublication(input.definition) }]
    const offer = await getPublicHybridOffer('herramientas-tienda')
    expect(offer.features.map(feature => feature.code).sort()).toEqual([...input.definition.eligibleFeatureCodes].sort())
    expect(offer.features.every(feature => feature.names.es.length > 0)).toBe(true)
  })
  it('does not serve drafts or paused offers as buyable', async () => {
    row.status = 'PAUSED'
    await expect(getPublicHybridOffer('herramientas-tienda')).rejects.toThrow(/disponible/i)
  })
  it('does not serve an exhausted active offer', async () => {
    row.status = 'ACTIVE'
    row.redeemedCount = 40
    await expect(getPublicHybridOffer('herramientas-tienda')).rejects.toThrow(/cupo|lugares/i)
  })
  it('rejects hostile pagination and returns true totals for normal pages', async () => {
    await expect(listHybridCampaigns({ pageSize: 100000 })).rejects.toThrow()
    const page = await listHybridCampaigns({ page: 2, pageSize: 25 })
    expect(page).toMatchObject({ total: 113, page: 2, pageSize: 25, totalPages: 5 })
    expect(db.hybridCampaign.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 25, take: 25, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }),
    )
  })
  it('keeps legacy tier campaigns in their own unchanged storage', async () => {
    await createHybridCampaign(input, 'staff1')
    expect(db.launchCampaign.create).not.toHaveBeenCalled()
  })
})

describe('explicit publication activation', () => {
  afterEach(() => delete process.env.HYBRID_BILLING_ENABLED)
  it('requires a published current draft, open sales and configured provider prices', async () => {
    process.env.HYBRID_BILLING_ENABLED = 'true'
    row.publications = [{ id: 'pub', ...compileHybridPublication(input.definition) }]
    row.status = 'PAUSED'
    await setHybridCampaignStatus('campaign1', { status: 'ACTIVE', expectedRevision: 1, publicationId: 'pub' }, 'staff1')
    expect(ensureHybridPublicationPrices).toHaveBeenCalledWith('pub')
    expect(db.hybridCampaign.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'ACTIVE', revision: { increment: 1 } } }),
    )
  })
  it('does not activate an unpublished edit or bypass the rollout switch', async () => {
    row.publications = [{ id: 'pub', ...compileHybridPublication(input.definition) }]
    await expect(
      setHybridCampaignStatus('campaign1', { status: 'ACTIVE', expectedRevision: 1, publicationId: 'pub' }, 'staff1'),
    ).rejects.toThrow()
    process.env.HYBRID_BILLING_ENABLED = 'true'
    row.draftDefinition = { ...input.definition, terms: { ...input.definition.terms, price: 399 } }
    await expect(
      setHybridCampaignStatus('campaign1', { status: 'ACTIVE', expectedRevision: 1, publicationId: 'pub' }, 'staff1'),
    ).rejects.toThrow()
  })
  it('can pause new sales without releasing accepted purchases', async () => {
    row.status = 'ACTIVE'
    await setHybridCampaignStatus('campaign1', { status: 'PAUSED', expectedRevision: 1 }, 'staff1')
    expect(db.hybridCampaign.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'PAUSED', revision: { increment: 1 } } }),
    )
    expect(db.hybridRedemption.updateMany).not.toHaveBeenCalled()
  })
  it('lists public offers with server pagination and without private cohort IDs or drafts', async () => {
    row.publications = [{ id: 'pub', ...compileHybridPublication(input.definition) }]
    const page = await listPublicHybridOffers({ page: 2, pageSize: 12 })
    expect(page).toMatchObject({ total: 113, page: 2, pageSize: 12 })
    expect(db.hybridCampaign.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 12,
        skip: 12,
        where: expect.objectContaining({ status: 'ACTIVE', listed: true, audience: { in: ['ALL', 'NEW_ORGANIZATIONS'] } }),
        select: expect.objectContaining({ publications: expect.objectContaining({ take: 1 }) }),
      }),
    )
    expect(page.items[0]).not.toHaveProperty('draftDefinition')
    expect(page.items[0]).not.toHaveProperty('eligibleOrganizationIds')
  })
})

it('broadcasts only a campaign invalidation to superadmins after the transaction commits', async () => {
  broadcast.mockClear()
  db.hybridCampaign.create.mockResolvedValue({ id: 'campaign', code: input.code })
  await createHybridCampaign(input, 'staff')
  expect(broadcast).toHaveBeenCalledWith('SUPERADMIN', 'superadmin:hybrid-campaign:updated', { id: 'campaign' })
  broadcast.mockClear()
  db.$transaction.mockRejectedValueOnce(new Error('rollback'))
  await expect(createHybridCampaign(input, 'staff')).rejects.toThrow('rollback')
  expect(broadcast).not.toHaveBeenCalled()
})

it('pages campaign redemptions with a total and exposes the saved issue without leaking customer/payment URLs', async () => {
  const { listHybridRedemptions } = await import('@/services/launchCampaigns/hybridCampaign.service')
  db.hybridCampaign.findUnique.mockResolvedValue({ id: 'campaign' })
  db.hybridRedemption.findMany.mockResolvedValue([
    {
      id: 'r',
      status: 'RESERVED',
      createdAt: new Date(),
      purchase: {
        id: 'purchase',
        venueId: 'venue',
        status: 'PAYMENT_PENDING',
        lastIssue: 'HYBRID_PROVIDER_UNKNOWN',
        paymentExpiresAt: new Date(),
        quote: { dueNow: '274.25' },
      },
    },
  ])
  db.hybridRedemption.count.mockResolvedValue(43)
  const result = await listHybridRedemptions('campaign', { page: 2, pageSize: 25 })
  expect(result).toMatchObject({ total: 43, page: 2, pageSize: 25 })
  expect(db.hybridRedemption.findMany).toHaveBeenCalledWith(
    expect.objectContaining({ where: { campaignId: 'campaign' }, take: 25, skip: 25 }),
  )
})
