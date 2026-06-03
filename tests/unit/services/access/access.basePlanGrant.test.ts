import { prismaMock } from '@tests/__helpers__/setup'
import { getFeatureMetadataForVenue } from '@/services/access/feature-metadata.service'

/**
 * Verifies the base-plan blanket grant is mirrored into the /me/access payload
 * (getFeatureMetadataForVenue → access.featureMetadata). When a venue has an
 * active base plan, all premium features must resolve to an access-granting
 * state even without an individual à-la-carte VenueFeature row — so the
 * dashboard UI agrees with what checkFeatureAccess allows at the API layer.
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

  beforeEach(() => {
    prismaMock.feature.findMany.mockResolvedValue(PREMIUM_FEATURES as any)
    // No à-la-carte VenueFeature rows for this venue at all.
    prismaMock.venueFeature.findMany.mockResolvedValue([] as any)
  })

  it('unlocks a premium feature with NO à-la-carte row when the base plan is active', async () => {
    // venueHasActiveBasePlan() → true (active PLAN_PRO, paid, not suspended)
    prismaMock.venueFeature.findFirst.mockResolvedValue({
      active: true,
      suspendedAt: null,
      endDate: null,
    } as any)

    const metadata = await getFeatureMetadataForVenue('venue_with_plan')

    // INVENTORY had no VenueFeature row → would be LOCKED, but base plan grants it.
    expect(metadata.INVENTORY.state).toBe('ACTIVE')
  })

  it('does NOT unlock premium features when the base plan is inactive', async () => {
    // venueHasActiveBasePlan() → false (no PLAN_PRO row)
    prismaMock.venueFeature.findFirst.mockResolvedValue(null as any)

    const metadata = await getFeatureMetadataForVenue('venue_no_plan')

    // No base plan, no à-la-carte row → stays LOCKED.
    expect(metadata.INVENTORY.state).toBe('LOCKED')
  })

  it('never relabels the plan-tier feature itself via the blanket grant', async () => {
    // Base plan active, but PLAN_PRO has no separate VenueFeature row in this
    // (contrived) snapshot → it must keep its real à-la-carte state (LOCKED),
    // NOT be force-upgraded by the grant it represents.
    prismaMock.venueFeature.findFirst.mockResolvedValue({
      active: true,
      suspendedAt: null,
      endDate: null,
    } as any)

    const metadata = await getFeatureMetadataForVenue('venue_with_plan')

    expect(metadata.PLAN_PRO.state).toBe('LOCKED')
    // ...while a normal premium feature IS granted in the same call.
    expect(metadata.INVENTORY.state).toBe('ACTIVE')
  })
})
