import { prismaMock } from '@tests/__helpers__/setup'
import { getFeatureMetadataForVenue } from '@/services/access/feature-metadata.service'

/**
 * Tier-aware blanket grant in the /me/access feature-metadata payload.
 *
 * getFeatureMetadataForVenue resolves the venue's base tier (PREMIUM | PRO | null) and unlocks
 * features accordingly: PREMIUM unlocks ALL non-tier features; PRO unlocks all non-tier features
 * EXCEPT the Premium-only differentiators (CFDI, INVENTORY_TRACKING). The venue's own à-la-carte
 * grant still wins (grandfather).
 *
 * The service issues two venueFeature.findMany calls:
 *   - à-la-carte rows: where { venueId } (no feature filter)
 *   - tier scan (getVenueBaseTier): where { venueId, feature: { code: { in: [...] } } }
 * We route the mock by the presence of a `feature` filter in the `where`.
 */
describe('feature-metadata tier-aware blanket grant', () => {
  const CATALOG = [
    {
      code: 'CFDI', // Premium-only differentiator
      name: 'CFDI',
      description: 'Facturación',
      monthlyPrice: { toString: () => '0.00' },
      stripePriceId: null,
    },
    {
      code: 'LOYALTY_PROGRAM', // normal feature (granted by Pro or Premium)
      name: 'Loyalty',
      description: 'Loyalty',
      monthlyPrice: { toString: () => '599.00' },
      stripePriceId: 'price_loyalty',
    },
    {
      code: 'PLAN_PRO',
      name: 'Plan Pro',
      description: 'Base plan',
      monthlyPrice: { toString: () => '499.00' },
      stripePriceId: 'price_plan_pro',
    },
    {
      code: 'PLAN_PREMIUM',
      name: 'Plan Premium',
      description: 'Base plan',
      monthlyPrice: { toString: () => '1699.00' },
      stripePriceId: 'price_plan_premium',
    },
  ]

  const ACTIVE = { active: true, suspendedAt: null, endDate: null, gracePeriodEndsAt: null }

  /**
   * @param tierRows  tier VenueFeature rows (PLAN_*) the venue has
   * @param ownRows   à-la-carte VenueFeature rows by code (grandfather), each w/ snapshot fields
   */
  function mockVenue(tierRows: Array<{ code: string; snap: any }>, ownRows: Array<{ code: string; snap: any }> = []) {
    prismaMock.feature.findMany.mockResolvedValue(CATALOG as any)
    prismaMock.venueFeature.findMany.mockImplementation(async ({ where }: any) => {
      if (where?.feature?.code?.in) {
        // tier scan
        return tierRows.filter(t => where.feature.code.in.includes(t.code)).map(t => ({ ...t.snap, feature: { code: t.code } })) as any
      }
      // à-la-carte rows for the venue
      return ownRows.map(o => ({ ...o.snap, feature: { code: o.code } })) as any
    })
  }

  it('PRO tier: normal feature ACTIVE, Premium-only feature stays LOCKED', async () => {
    mockVenue([{ code: 'PLAN_PRO', snap: ACTIVE }])
    const md = await getFeatureMetadataForVenue('vPro')
    expect(md.LOYALTY_PROGRAM.state).toBe('ACTIVE')
    expect(md.CFDI.state).toBe('LOCKED') // Pro does NOT blanket-grant CFDI
  })

  it('PREMIUM tier: both normal and Premium-only features ACTIVE', async () => {
    mockVenue([{ code: 'PLAN_PREMIUM', snap: ACTIVE }])
    const md = await getFeatureMetadataForVenue('vPremium')
    expect(md.LOYALTY_PROGRAM.state).toBe('ACTIVE')
    expect(md.CFDI.state).toBe('ACTIVE')
  })

  it('PRO tier + own active CFDI grant (grandfather): CFDI ACTIVE', async () => {
    mockVenue([{ code: 'PLAN_PRO', snap: ACTIVE }], [{ code: 'CFDI', snap: ACTIVE }])
    const md = await getFeatureMetadataForVenue('vGrand')
    expect(md.CFDI.state).toBe('ACTIVE')
  })

  it('no plan: nothing blanket-granted (CFDI + normal both LOCKED)', async () => {
    mockVenue([])
    const md = await getFeatureMetadataForVenue('vNone')
    expect(md.CFDI.state).toBe('LOCKED')
    expect(md.LOYALTY_PROGRAM.state).toBe('LOCKED')
  })

  it('tier codes themselves are never blanket-upgraded', async () => {
    mockVenue([{ code: 'PLAN_PREMIUM', snap: ACTIVE }])
    const md = await getFeatureMetadataForVenue('vPremium')
    // PLAN_PRO / PLAN_PREMIUM have no own VenueFeature snapshot here → LOCKED, not force-ACTIVE.
    expect(md.PLAN_PRO.state).toBe('LOCKED')
    expect(md.PLAN_PREMIUM.state).toBe('LOCKED')
  })
})
