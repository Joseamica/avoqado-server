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
  getHybridCampaign,
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
/** Stored publications; a campaign sells only the one its `currentPublicationId` points at. */
let pubs: any[]
const stored = (id: string, version = 1) => ({ id, version, name: input.name, ...compileHybridPublication(input.definition) })
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
    currentPublicationId: null,
  }
  pubs = []
  db.hybridCampaign = {
    create: jest.fn(async ({ data }: any) => ({ id: 'campaign1', ...data })),
    findUnique: jest.fn(async () => row),
    findFirst: jest.fn(async () => row),
    findMany: jest.fn(async () => [row]),
    count: jest.fn(async () => 113),
    update: jest.fn(async () => row),
    updateMany: jest.fn(async () => ({ count: 1 })),
    findUniqueOrThrow: jest.fn(async () => row),
  }
  db.hybridOfferPublication = {
    create: jest.fn(async ({ data }: any) => ({ id: 'pub1', ...data })),
    findUnique: jest.fn(async ({ where }: any) => pubs.find(pub => pub.id === where.id) ?? null),
    findMany: jest.fn(async ({ where }: any) => pubs.filter(pub => where.id.in.includes(pub.id))),
  }
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
    pubs = [stored('pub')]
    row.currentPublicationId = 'pub'
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
    pubs = [stored('pub')]
    row.currentPublicationId = 'pub'
    row.status = 'PAUSED'
    await setHybridCampaignStatus('campaign1', { status: 'ACTIVE', expectedRevision: 1, publicationId: 'pub' }, 'staff1')
    expect(ensureHybridPublicationPrices).toHaveBeenCalledWith('pub')
    expect(db.hybridCampaign.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'ACTIVE', revision: { increment: 1 } } }),
    )
  })
  it('does not activate an unpublished edit or bypass the rollout switch', async () => {
    pubs = [stored('pub')]
    row.currentPublicationId = 'pub'
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
    pubs = [stored('pub')]
    row.currentPublicationId = 'pub'
    const page = await listPublicHybridOffers({ page: 2, pageSize: 12 })
    expect(page).toMatchObject({ total: 113, page: 2, pageSize: 12 })
    expect(db.hybridCampaign.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 12,
        skip: 12,
        where: expect.objectContaining({ status: 'ACTIVE', listed: true, audience: { in: ['ALL', 'NEW_ORGANIZATIONS'] } }),
        select: expect.objectContaining({ currentPublicationId: true }),
      }),
    )
    expect(page.items).toHaveLength(1)
    expect(page.items[0]).not.toHaveProperty('draftDefinition')
    expect(page.items[0]).not.toHaveProperty('eligibleOrganizationIds')
  })
})

describe('the publication on sale is the explicit pointer, never the highest version', () => {
  afterEach(() => delete process.env.HYBRID_BILLING_ENABLED)
  it('publishing moves the pointer to the publication it just created', async () => {
    await publishHybridCampaign('campaign1', 1, 'staff1')
    expect(db.hybridCampaign.update).toHaveBeenCalledWith({ where: { id: 'campaign1' }, data: { currentPublicationId: 'pub1' } })
    expect(db.hybridOfferPublication.create.mock.invocationCallOrder[0]).toBeLessThan(db.hybridCampaign.update.mock.invocationCallOrder[0])
  })
  it('the public offer, the admin detail and activation read the pointer while a higher version exists', async () => {
    pubs = [stored('v1'), stored('v2', 2)]
    row.currentPublicationId = 'v1'
    row.status = 'ACTIVE'
    expect((await getPublicHybridOffer('herramientas-tienda')).id).toBe('v1')
    expect((await getHybridCampaign('campaign1')).publications.map(pub => pub.id)).toEqual(['v1'])
    process.env.HYBRID_BILLING_ENABLED = 'true'
    row.status = 'PAUSED'
    await expect(
      setHybridCampaignStatus('campaign1', { status: 'ACTIVE', expectedRevision: 1, publicationId: 'v2' }, 'staff1'),
    ).rejects.toMatchObject({ code: 'HYBRID_PUBLICATION_REQUIRED' })
    await setHybridCampaignStatus('campaign1', { status: 'ACTIVE', expectedRevision: 1, publicationId: 'v1' }, 'staff1')
    expect(ensureHybridPublicationPrices).toHaveBeenCalledWith('v1')
  })
  it('without a pointer nothing is on sale and the admin detail keeps an empty list', async () => {
    pubs = [stored('v1')]
    row.status = 'ACTIVE'
    await expect(getPublicHybridOffer('herramientas-tienda')).rejects.toThrow(/disponible/i)
    expect((await getHybridCampaign('campaign1')).publications).toEqual([])
  })
  it('the public list reads every pointer of the page in one bounded query', async () => {
    pubs = [stored('v1'), stored('v2', 2)]
    row.currentPublicationId = 'v1'
    db.hybridCampaign.findMany.mockResolvedValue([row, { ...row, id: 'campaign2', currentPublicationId: null }])
    const page = await listPublicHybridOffers({})
    expect(page.items.map(item => item.id)).toEqual(['v1'])
    expect(db.hybridOfferPublication.findMany).toHaveBeenCalledTimes(1)
    expect(db.hybridOfferPublication.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: ['v1'] } }, take: 1 }))
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
