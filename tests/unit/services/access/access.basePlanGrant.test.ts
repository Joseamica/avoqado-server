import { prismaMock } from '@tests/__helpers__/setup'
import { getFeatureMetadataForVenue } from '@/services/access/feature-metadata.service'

/**
 * Verifies the base-plan blanket grant is mirrored into the /me/access payload
 * (getFeatureMetadataForVenue → access.featureMetadata). When a venue has an
 * active base plan, the features its TIER covers must resolve to an access-granting
 * state even without an individual à-la-carte VenueFeature row — so the dashboard
 * UI agrees with what the access gate allows at the API layer.
 *
 * `INVENTORY` here is a generic NON-Premium-only feature, so an active PLAN_PRO tier
 * grants it (today's blanket behavior is preserved for Pro on non-differentiators).
 * The grant is now resolved via getVenueBaseTier, which scans the tier rows with a
 * venueFeature.findMany over the PLAN_* code list — so we mock that findMany by the
 * presence of a `feature.code.in` filter.
 */
describe('feature-metadata base-plan blanket grant', () => {
  const PREMIUM_FEATURES = [
    {
      code: 'INVENTORY',
      name: 'Inventory',
      description: 'Inventory tracking',
      monthlyPrice: { toString: () => '89.00' },
      stripePriceId: 'price_inventory',
    },
    {
      code: 'PLAN_PRO',
      name: 'Plan Pro',
      description: 'Base plan',
      monthlyPrice: { toString: () => '499.00' },
      stripePriceId: 'price_plan_pro',
    },
  ]

  const ACTIVE_PRO_TIER = [{ active: true, suspendedAt: null, endDate: null, feature: { code: 'PLAN_PRO' } }]

  /**
   * Route venueFeature.findMany: the tier scan (getVenueBaseTier) carries a
   * `feature.code.in` filter; the à-la-carte query has no `feature` filter.
   * `tierRows` describes the active PLAN_* rows the venue has.
   */
  function mockFindMany(tierRows: any[]) {
    prismaMock.venueFeature.findMany.mockImplementation(async ({ where }: any) => {
      if (where?.feature?.code?.in) return tierRows as any
      return [] as any // no à-la-carte rows for this venue
    })
  }

  beforeEach(() => {
    prismaMock.feature.findMany.mockResolvedValue(PREMIUM_FEATURES as any)
  })

  it('unlocks a tier-covered feature with NO à-la-carte row when the base plan is active', async () => {
    // getVenueBaseTier() → 'PRO' (active PLAN_PRO, paid, not suspended)
    mockFindMany(ACTIVE_PRO_TIER)

    const metadata = await getFeatureMetadataForVenue('venue_with_plan')

    // INVENTORY (non-Premium-only) had no VenueFeature row → would be LOCKED, but the PRO tier grants it.
    expect(metadata.INVENTORY.state).toBe('ACTIVE')
  })

  it('does NOT unlock features when the base plan is inactive', async () => {
    // getVenueBaseTier() → null (no PLAN_* row)
    mockFindMany([])

    const metadata = await getFeatureMetadataForVenue('venue_no_plan')

    // No base plan, no à-la-carte row → stays LOCKED.
    expect(metadata.INVENTORY.state).toBe('LOCKED')
  })

  it('never relabels the plan-tier feature itself via the blanket grant', async () => {
    // Base plan active, but PLAN_PRO has no separate à-la-carte VenueFeature row in this
    // (contrived) snapshot → it must keep its real state (LOCKED), NOT be force-upgraded
    // by the grant it represents.
    mockFindMany(ACTIVE_PRO_TIER)

    const metadata = await getFeatureMetadataForVenue('venue_with_plan')

    expect(metadata.PLAN_PRO.state).toBe('LOCKED')
    // ...while a normal tier-covered feature IS granted in the same call.
    expect(metadata.INVENTORY.state).toBe('ACTIVE')
  })
})
