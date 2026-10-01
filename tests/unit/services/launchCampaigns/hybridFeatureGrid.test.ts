import { prismaMock } from '../../../__helpers__/setup'
import { FEATURE_CATALOG } from '@/config/featureCatalog'
const tier = jest.fn()
const granted = jest.fn()
jest.mock('@/services/access/basePlan.service', () => ({
  ...jest.requireActual('@/services/access/basePlan.service'),
  getVenueBaseTier: (...args: unknown[]) => tier(...args),
  getVenueGrantedFeatureCodes: (...args: unknown[]) => granted(...args),
}))
import { getHybridFeatureGrid } from '@/services/launchCampaigns/hybridFeatureGrid.service'
import logger from '@/config/logger'

const now = Date.now()
const terms = (price: number) => ({
  currency: 'MXN',
  interval: 'MONTHLY',
  price,
  taxIncluded: true,
  promotionCycles: null,
  renewal: { kind: 'SAME_PRICE' },
})
function campaignRow(id: string, definition: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    id,
    status: 'ACTIVE',
    startsAt: new Date(now - 1000),
    endsAt: new Date(now + 86400000),
    capacity: 10,
    reservedCount: 0,
    redeemedCount: 0,
    audience: 'ALL',
    eligibleOrganizationIds: [],
    publications: [
      {
        id: `pub_${id}`,
        name: `Oferta ${id}`,
        definition: { schemaVersion: 1, ...definition },
        includedFeatureCodes: [],
        stripePriceId: `price_${id}`,
        stripeProductId: `prod_${id}`,
        stripeRenewalPriceId: null,
      },
    ],
    ...overrides,
  }
}
/** Each campaign points at its first publication unless overridden; the grid reads pointed publications in a second query. */
function mockOffers(rows: ReturnType<typeof campaignRow>[]) {
  prismaMock.hybridCampaign.findMany.mockResolvedValue(
    rows.map(({ publications, ...campaign }) => ({ currentPublicationId: publications[0]?.id ?? null, ...campaign })),
  )
  prismaMock.hybridOfferPublication.findMany.mockImplementation(async ({ where }: any) =>
    rows.flatMap(row => row.publications).filter(publication => where.id.in.includes(publication.id)),
  )
}
const entry = (grid: Awaited<ReturnType<typeof getHybridFeatureGrid>>, code: string) =>
  grid.entries.find(e => e.featureCode === code || e.id === code)!

beforeEach(() => {
  process.env.HYBRID_BILLING_ENABLED = 'true'
  prismaMock.venue.findUnique.mockResolvedValue({
    seatCapExempt: false,
    organization: { id: 'org', createdAt: new Date(now - 86400000), seatCapExempt: false },
  })
  prismaMock.capabilityGrant.findMany.mockResolvedValue([])
  prismaMock.hybridCampaign.findMany.mockResolvedValue([])
  tier.mockReset().mockResolvedValue(null)
  granted.mockReset().mockResolvedValue([])
})
afterEach(() => {
  delete process.env.HYBRID_BILLING_ENABLED
})

describe('feature grid', () => {
  it('lists all 40 catalog entries, in catalog order', async () => {
    const grid = await getHybridFeatureGrid('venue')
    expect(grid.entries.map(e => e.id)).toEqual(FEATURE_CATALOG.map(e => e.id))
    expect(grid.entries).toHaveLength(40)
  })

  it('with sales off shows every function without prices and never reads offers', async () => {
    delete process.env.HYBRID_BILLING_ENABLED
    const grid = await getHybridFeatureGrid('venue')
    expect(grid.purchasesEnabled).toBe(false)
    expect(grid.plans).toEqual({ PRO: null, PREMIUM: null })
    expect(grid.entries.every(e => e.offer === null)).toBe(true)
    expect(prismaMock.hybridCampaign.findMany).not.toHaveBeenCalled()
  })

  it('asks the database only for listed, live campaigns of this organization that it has not used, bounded', async () => {
    await getHybridFeatureGrid('venue')
    expect(prismaMock.hybridCampaign.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'ACTIVE',
          listed: true,
          OR: [
            { audience: 'ALL' },
            { audience: 'NEW_ORGANIZATIONS', startsAt: { lte: expect.any(Date) } },
            { audience: 'ORGANIZATIONS', eligibleOrganizationIds: { has: 'org' } },
          ],
          redemptions: { none: { organizationId: 'org', status: { not: 'RELEASED' } } },
        }),
        take: 100,
      }),
    )
  })

  it('attaches the cheapest single-function offer to its function and the cheapest plan offer per tier', async () => {
    mockOffers([
      campaignRow('a', { kind: 'FEATURES', featureCodes: ['RESERVATIONS'], terms: terms(199) }),
      campaignRow('b', { kind: 'FEATURES', featureCodes: ['RESERVATIONS'], terms: terms(149) }),
      campaignRow('c', { kind: 'FEATURES', featureCodes: ['RESERVATIONS', 'LOYALTY_PROGRAM'], terms: terms(99) }),
      campaignRow('d', { kind: 'CHOICE_BUNDLE', eligibleFeatureCodes: ['CFDI', 'PROMOTIONS'], choiceCount: 1, terms: terms(50) }),
      campaignRow('e', { kind: 'PLAN', planTier: 'PRO', terms: terms(999) }),
      campaignRow('f', { kind: 'PLAN', planTier: 'PREMIUM', terms: terms(1999) }),
    ])
    const grid = await getHybridFeatureGrid('venue')
    expect(entry(grid, 'RESERVATIONS').offer).toMatchObject({ publicationId: 'pub_b', price: 149, kind: 'FEATURES' })
    expect(entry(grid, 'LOYALTY_PROGRAM').offer).toBeNull()
    expect(entry(grid, 'CFDI').offer).toBeNull()
    expect(grid.plans.PRO).toMatchObject({ publicationId: 'pub_e', price: 999, planTier: 'PRO' })
    expect(grid.plans.PREMIUM).toMatchObject({ publicationId: 'pub_f', price: 1999 })
  })

  it('offers only the publication each campaign points at, read in one bounded query', async () => {
    mockOffers([
      campaignRow('a', { kind: 'FEATURES', featureCodes: ['RESERVATIONS'], terms: terms(199) }),
      // A cheaper stored publication is not on sale while its campaign points nowhere.
      campaignRow('b', { kind: 'FEATURES', featureCodes: ['RESERVATIONS'], terms: terms(99) }, { currentPublicationId: null }),
    ])
    const grid = await getHybridFeatureGrid('venue')
    expect(entry(grid, 'RESERVATIONS').offer).toMatchObject({ publicationId: 'pub_a', price: 199 })
    expect(prismaMock.hybridOfferPublication.findMany).toHaveBeenCalledTimes(1)
    expect(prismaMock.hybridOfferPublication.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['pub_a'] } }, take: 1 }),
    )
  })

  it('drops sold-out and not-yet-priced offers', async () => {
    mockOffers([
      campaignRow('full', { kind: 'FEATURES', featureCodes: ['RESERVATIONS'], terms: terms(99) }, { capacity: 1, redeemedCount: 1 }),
      campaignRow(
        'raw',
        { kind: 'PLAN', planTier: 'PRO', terms: terms(999) },
        {
          publications: [
            {
              id: 'pub_raw',
              name: 'Pro',
              definition: { schemaVersion: 1, kind: 'PLAN', planTier: 'PRO', terms: terms(999) },
              includedFeatureCodes: [],
              stripePriceId: null,
              stripeProductId: null,
              stripeRenewalPriceId: null,
            },
          ],
        },
      ),
    ])
    const grid = await getHybridFeatureGrid('venue')
    expect(entry(grid, 'RESERVATIONS').offer).toBeNull()
    expect(grid.plans.PRO).toBeNull()
  })

  it('skips a publication whose stored definition no longer parses, and says which one', async () => {
    ;(logger.warn as jest.Mock).mockClear()
    mockOffers([
      campaignRow('bad', { kind: 'NOT_A_KIND', featureCodes: ['RESERVATIONS'], terms: terms(9) }),
      campaignRow('good', { kind: 'FEATURES', featureCodes: ['RESERVATIONS'], terms: terms(149) }),
    ])
    const grid = await getHybridFeatureGrid('venue')
    expect(entry(grid, 'RESERVATIONS').offer).toMatchObject({ publicationId: 'pub_good', price: 149 })
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ campaignId: 'bad', publicationId: 'pub_bad' }))
  })

  it('says where each function comes from', async () => {
    tier.mockResolvedValue('PRO')
    granted.mockResolvedValue(['INVENTORY_TRACKING'])
    prismaMock.capabilityGrant.findMany.mockResolvedValue([
      { featureCode: 'CFDI', contract: { id: 'hc_fn', planTier: null, cancelAt: null, paidThrough: new Date(now + 86400000) } },
      { featureCode: 'AUTO_REORDER', contract: { id: 'hc_plan', planTier: 'PREMIUM', cancelAt: null, paidThrough: null } },
    ])
    const grid = await getHybridFeatureGrid('venue')
    expect(entry(grid, 'BASE_POS').access.source).toBe('FREE')
    expect(entry(grid, 'CHATBOT').access.source).toBe('FREE')
    expect(entry(grid, 'LOYALTY_PROGRAM').access.source).toBe('PLAN')
    expect(entry(grid, 'AUTO_REORDER').access).toMatchObject({ source: 'PLAN', contractId: 'hc_plan' })
    expect(entry(grid, 'CFDI').access).toMatchObject({ source: 'CONTRACT', contractId: 'hc_fn' })
    expect(entry(grid, 'INVENTORY_TRACKING').access.source).toBe('STANDALONE')
    expect(entry(grid, 'COMMISSIONS').access.source).toBe('NONE')
    expect(entry(grid, 'ENTERPRISE_API').access.source).toBe('NONE')
  })

  it('a contact-only function is never granted by a plan: quoted unless a contract covers it', async () => {
    tier.mockResolvedValue('PRO')
    const grid = await getHybridFeatureGrid('venue')
    expect(entry(grid, 'WHITE_LABEL_DASHBOARD').access.source).toBe('NONE')
    expect(entry(grid, 'MASTER_CATALOG').access.source).toBe('NONE')

    prismaMock.capabilityGrant.findMany.mockResolvedValue([
      { featureCode: 'WHITE_LABEL_DASHBOARD', contract: { id: 'hc_wl', planTier: 'PREMIUM', cancelAt: null, paidThrough: null } },
    ])
    const covered = await getHybridFeatureGrid('venue')
    expect(entry(covered, 'WHITE_LABEL_DASHBOARD').access).toMatchObject({ source: 'CONTRACT', contractId: 'hc_wl' })
  })

  it('a founder venue has everything', async () => {
    prismaMock.venue.findUnique.mockResolvedValue({
      seatCapExempt: true,
      organization: { id: 'org', createdAt: new Date(now), seatCapExempt: false },
    })
    const grid = await getHybridFeatureGrid('venue')
    expect(grid.entries.every(e => e.access.source === 'GRANDFATHERED')).toBe(true)
  })
})
