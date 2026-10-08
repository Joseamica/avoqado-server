import { prismaMock } from '../../../__helpers__/setup'
import { FEATURE_CATALOG } from '@/config/featureCatalog'
import type { BestOffers } from '@/services/launchCampaigns/hybridBestOffer'
import type { FeatureGridOffer } from '@/services/launchCampaigns/hybridFeatureGrid.service'
const tier = jest.fn()
const granted = jest.fn()
const bestOffers = jest.fn()
jest.mock('@/services/access/basePlan.service', () => ({
  ...jest.requireActual('@/services/access/basePlan.service'),
  getVenueBaseTier: (...args: unknown[]) => tier(...args),
  getVenueGrantedFeatureCodes: (...args: unknown[]) => granted(...args),
}))
jest.mock('@/services/launchCampaigns/hybridBestOffer', () => ({
  ...jest.requireActual('@/services/launchCampaigns/hybridBestOffer'),
  bestOffersByProduct: (...args: unknown[]) => bestOffers(...args),
}))
import { getHybridFeatureGrid } from '@/services/launchCampaigns/hybridFeatureGrid.service'
import logger from '@/config/logger'

const now = Date.now()
const orgCreatedAt = new Date(now - 86400000)
const view = (publicationId: string, price: number, overrides: Partial<FeatureGridOffer> = {}): FeatureGridOffer => ({
  publicationId,
  campaignId: `c_${publicationId}`,
  name: `Oferta ${publicationId}`,
  kind: 'FEATURES',
  planTier: null,
  price,
  listPrice: null,
  renewal: 'SAME_PRICE',
  renewalPrice: null,
  promotionCycles: null,
  includedFeatureCodes: [],
  ...overrides,
})
const offers = (best: [string, FeatureGridOffer][], list: [string, FeatureGridOffer][] = []): BestOffers => ({
  best: new Map(best) as BestOffers['best'],
  list: new Map(list) as BestOffers['list'],
})
const entry = (grid: Awaited<ReturnType<typeof getHybridFeatureGrid>>, code: string) =>
  grid.entries.find(e => e.featureCode === code || e.id === code)!

beforeEach(() => {
  process.env.HYBRID_BILLING_ENABLED = 'true'
  prismaMock.venue.findUnique.mockResolvedValue({
    seatCapExempt: false,
    organization: { id: 'org', createdAt: orgCreatedAt, seatCapExempt: false },
  })
  prismaMock.capabilityGrant.findMany.mockResolvedValue([])
  tier.mockReset().mockResolvedValue(null)
  granted.mockReset().mockResolvedValue([])
  bestOffers.mockReset().mockResolvedValue(offers([]))
})
afterEach(() => {
  delete process.env.HYBRID_BILLING_ENABLED
})

describe('feature grid', () => {
  it('lists all 42 catalog entries, in catalog order', async () => {
    const grid = await getHybridFeatureGrid('venue')
    expect(grid.entries.map(e => e.id)).toEqual(FEATURE_CATALOG.map(e => e.id))
    expect(grid.entries).toHaveLength(42)
  })

  it('with sales off shows every function without prices and never reads offers', async () => {
    delete process.env.HYBRID_BILLING_ENABLED
    const grid = await getHybridFeatureGrid('venue')
    expect(grid.purchasesEnabled).toBe(false)
    expect(grid.plans).toEqual({ PRO: null, PREMIUM: null })
    expect(grid.planListOffers).toEqual({ PRO: null, PREMIUM: null })
    expect(grid.entries.every(e => e.offer === null && e.listOffer === null)).toBe(true)
    expect(bestOffers).not.toHaveBeenCalled()
  })

  it('asks for the best offers of this organization once, at one instant', async () => {
    await getHybridFeatureGrid('venue')
    expect(bestOffers).toHaveBeenCalledTimes(1)
    expect(bestOffers).toHaveBeenCalledWith(expect.objectContaining({ id: 'org', createdAt: orgCreatedAt }), expect.any(Date))
  })

  it('attaches the best offer of each product to its function and to its plan tier', async () => {
    bestOffers.mockResolvedValue(
      offers([
        ['FEATURE:RESERVATIONS', view('pub_b', 149)],
        ['PLAN:PRO', view('pub_e', 999, { kind: 'PLAN', planTier: 'PRO' })],
        ['PLAN:PREMIUM', view('pub_f', 1999, { kind: 'PLAN', planTier: 'PREMIUM' })],
      ]),
    )
    const grid = await getHybridFeatureGrid('venue')
    expect(entry(grid, 'RESERVATIONS').offer).toMatchObject({ publicationId: 'pub_b', price: 149, kind: 'FEATURES' })
    expect(entry(grid, 'LOYALTY_PROGRAM').offer).toBeNull()
    expect(entry(grid, 'CFDI').offer).toBeNull()
    expect(grid.plans.PRO).toMatchObject({ publicationId: 'pub_e', price: 999, planTier: 'PRO' })
    expect(grid.plans.PREMIUM).toMatchObject({ publicationId: 'pub_f', price: 1999 })
  })

  it('exposes the list as the alternative of a promotion, its price on the offer, and the plan lists', async () => {
    const promotion = view('pub_promo', 479.2, { listPrice: 599, renewal: 'REPRICE', renewalPrice: 599, promotionCycles: 3 })
    const list = view('pub_list', 599, { listPrice: 599 })
    const proList = view('pub_pro_list', 1158.84, { kind: 'PLAN', planTier: 'PRO', listPrice: 1158.84 })
    bestOffers.mockResolvedValue(
      offers(
        [
          ['FEATURE:CFDI', promotion],
          ['PLAN:PRO', proList],
        ],
        [
          ['FEATURE:CFDI', list],
          ['PLAN:PRO', proList],
        ],
      ),
    )
    const grid = await getHybridFeatureGrid('venue')
    expect(entry(grid, 'CFDI').offer).toEqual(promotion)
    expect(entry(grid, 'CFDI').offer!.listPrice).toBe(599)
    expect(entry(grid, 'CFDI').listOffer).toEqual(list)
    expect(grid.planListOffers).toEqual({ PRO: proList, PREMIUM: null })
    expect(grid.plans.PRO).toEqual(proList)
  })

  it('a list that is already the best offer is not repeated as its own alternative', async () => {
    const list = view('pub_list', 599, { listPrice: 599 })
    bestOffers.mockResolvedValue(offers([['FEATURE:CFDI', list]], [['FEATURE:CFDI', list]]))
    const grid = await getHybridFeatureGrid('venue')
    expect(entry(grid, 'CFDI').offer).toEqual(list)
    expect(entry(grid, 'CFDI').listOffer).toBeNull()
    expect(entry(grid, 'RESERVATIONS').listOffer).toBeNull()
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

describe('bestOffersByProduct', () => {
  const { bestOffersByProduct } = jest.requireActual<typeof import('@/services/launchCampaigns/hybridBestOffer')>(
    '@/services/launchCampaigns/hybridBestOffer',
  )
  const terms = (price: number) => ({
    currency: 'MXN',
    interval: 'MONTHLY',
    price,
    taxIncluded: true,
    promotionCycles: null,
    renewal: { kind: 'SAME_PRICE' },
  })
  const row = (publicationId: string, productKey: string, definition: Record<string, unknown>) => ({
    campaignId: `c_${publicationId}`,
    publicationId,
    name: `Oferta ${publicationId}`,
    definition: { schemaVersion: 1, ...definition },
    includedFeatureCodes: [],
    productKey,
  })

  it('maps each row to its product, prices every offer against the active list, and skips what no longer parses', async () => {
    ;(logger.warn as jest.Mock).mockClear()
    prismaMock.$queryRaw
      .mockResolvedValueOnce([
        row('pub_promo', 'FEATURE:CFDI', { kind: 'FEATURES', featureCodes: ['CFDI'], terms: terms(479.2) }),
        row('pub_plan', 'PLAN:PRO', { kind: 'PLAN', planTier: 'PRO', terms: terms(999) }),
        row('pub_bad', 'FEATURE:RESERVATIONS', { kind: 'FEATURES', featureCodes: ['RESERVATIONS'], terms: terms(1) }),
      ])
      .mockResolvedValueOnce([row('pub_list', 'FEATURE:CFDI', { kind: 'FEATURES', featureCodes: ['CFDI'], terms: terms(599) })])
    const { best, list } = await bestOffersByProduct({ id: 'org', createdAt: orgCreatedAt }, new Date(now))
    expect(best.get('FEATURE:CFDI')).toMatchObject({ publicationId: 'pub_promo', campaignId: 'c_pub_promo', price: 479.2, listPrice: 599 })
    expect(best.get('PLAN:PRO')).toMatchObject({ kind: 'PLAN', planTier: 'PRO', price: 999, listPrice: null })
    expect(best.has('FEATURE:RESERVATIONS')).toBe(false)
    expect(list.get('FEATURE:CFDI')).toMatchObject({ publicationId: 'pub_list', price: 599, listPrice: 599 })
    expect(logger.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ campaignId: 'c_pub_bad', publicationId: 'pub_bad' }),
    )
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(2)
  })
})
