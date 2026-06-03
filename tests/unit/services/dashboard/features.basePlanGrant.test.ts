import { prismaMock } from '@tests/__helpers__/setup'
import { getVenueFeatureStatus } from '@/services/dashboard/venueFeature.dashboard.service'

/**
 * Verifies the base-plan blanket grant is mirrored into the dashboard paywall
 * payload (getVenueFeatureStatus → GET /dashboard/venues/:venueId/features).
 *
 * This endpoint expresses "gate state" as a TWO-ARRAY partition rather than an
 * enum: `activeFeatures` (owned / unlocked, rendered with billing badge) vs
 * `availableFeatures` (locked upsell cards with a Subscribe button). The base
 * plan grant must therefore PROMOTE premium features the venue lacks à-la-carte
 * from `availableFeatures` into `activeFeatures` when PLAN_PRO is active — a pure
 * UNION that never removes access a venue already has, and never touches the
 * plan-tier feature itself.
 */
describe('getVenueFeatureStatus base-plan blanket grant', () => {
  const VENUE_ID = 'venue_baseplan'

  const PREMIUM_FEATURE = {
    id: 'feat_inventory',
    code: 'INVENTORY',
    name: 'Inventory',
    description: 'Inventory tracking',
    monthlyPrice: '89.00',
    stripeProductId: 'prod_inv',
    stripePriceId: 'price_inv',
    active: true,
  }

  const PLAN_TIER_FEATURE = {
    id: 'feat_plan_pro',
    code: 'PLAN_PRO',
    name: 'Plan Pro',
    description: 'Base plan',
    monthlyPrice: '499.00',
    stripeProductId: 'prod_plan_pro',
    stripePriceId: 'price_plan_pro',
    active: true,
  }

  beforeEach(() => {
    // Venue with NO à-la-carte VenueFeature rows and no Stripe payment method
    // (so the Stripe paymentMethods.retrieve branch is skipped entirely).
    prismaMock.venue.findUnique.mockResolvedValue({
      id: VENUE_ID,
      name: 'Test Venue',
      stripeCustomerId: null,
      stripePaymentMethodId: null,
      features: [],
    } as any)
    // All active platform features.
    prismaMock.feature.findMany.mockResolvedValue([PREMIUM_FEATURE, PLAN_TIER_FEATURE] as any)
    // No historical (canceled) VenueFeature rows.
    prismaMock.venueFeature.findMany.mockResolvedValue([] as any)
  })

  it('promotes a premium feature with NO à-la-carte row into activeFeatures when the base plan is active', async () => {
    // venueHasActiveBasePlan() → true (active PLAN_PRO, paid, not suspended)
    prismaMock.venueFeature.findFirst.mockResolvedValue({
      active: true,
      suspendedAt: null,
      endDate: null,
    } as any)

    const status = await getVenueFeatureStatus(VENUE_ID)

    const inventoryActive = status.activeFeatures.find(f => f.feature.code === 'INVENTORY')
    expect(inventoryActive).toBeDefined()
    expect(inventoryActive?.active).toBe(true)
    // Synthesized grant carries the marker + no Stripe subscription.
    expect((inventoryActive as any)?.grantedByBasePlan).toBe(true)
    expect(inventoryActive?.stripeSubscriptionId).toBeNull()
    // ...and it is no longer offered as a locked upsell card.
    expect(status.availableFeatures.find(f => f.code === 'INVENTORY')).toBeUndefined()
  })

  it('leaves the premium feature LOCKED (in availableFeatures) when the base plan is inactive', async () => {
    // venueHasActiveBasePlan() → false (no PLAN_PRO row)
    prismaMock.venueFeature.findFirst.mockResolvedValue(null as any)

    const status = await getVenueFeatureStatus(VENUE_ID)

    expect(status.activeFeatures.find(f => f.feature.code === 'INVENTORY')).toBeUndefined()
    const inventoryAvailable = status.availableFeatures.find(f => f.code === 'INVENTORY')
    expect(inventoryAvailable).toBeDefined()
  })

  it('never force-promotes the plan-tier feature itself via the blanket grant', async () => {
    // Base plan active, but PLAN_PRO has no separate active VenueFeature row in
    // this snapshot → it must stay in availableFeatures (its real state), NOT be
    // unlocked by the grant it represents. A normal premium feature IS promoted.
    prismaMock.venueFeature.findFirst.mockResolvedValue({
      active: true,
      suspendedAt: null,
      endDate: null,
    } as any)

    const status = await getVenueFeatureStatus(VENUE_ID)

    expect(status.activeFeatures.find(f => f.feature.code === 'PLAN_PRO')).toBeUndefined()
    expect(status.availableFeatures.find(f => f.code === 'PLAN_PRO')).toBeDefined()
    // Sanity: the union still granted the real premium feature in the same call.
    expect(status.activeFeatures.find(f => f.feature.code === 'INVENTORY')).toBeDefined()
  })

  it('preserves an existing à-la-carte active feature untouched (pure UNION, no duplication)', async () => {
    // Venue already owns INVENTORY à-la-carte (real VenueFeature row, trialing).
    const trialEnd = new Date(Date.now() + 7 * 86400000)
    prismaMock.venue.findUnique.mockResolvedValue({
      id: VENUE_ID,
      name: 'Test Venue',
      stripeCustomerId: 'cus_1',
      stripePaymentMethodId: null,
      features: [
        {
          id: 'vf_inventory',
          venueId: VENUE_ID,
          featureId: PREMIUM_FEATURE.id,
          feature: PREMIUM_FEATURE,
          active: true,
          monthlyPrice: '89.00',
          startDate: new Date(),
          endDate: trialEnd,
          stripeSubscriptionId: 'sub_inv',
          stripePriceId: 'price_inv',
        },
      ],
    } as any)
    // Base plan ALSO active.
    prismaMock.venueFeature.findFirst.mockResolvedValue({
      active: true,
      suspendedAt: null,
      endDate: null,
    } as any)

    const status = await getVenueFeatureStatus(VENUE_ID)

    // Exactly one INVENTORY entry, the original à-la-carte one (not duplicated,
    // not relabeled by the grant). Its trial endDate + real subscription survive.
    const inventoryEntries = status.activeFeatures.filter(f => f.feature.code === 'INVENTORY')
    expect(inventoryEntries).toHaveLength(1)
    expect(inventoryEntries[0].id).toBe('vf_inventory')
    expect(inventoryEntries[0].stripeSubscriptionId).toBe('sub_inv')
    expect(inventoryEntries[0].endDate).toEqual(trialEnd)
    expect((inventoryEntries[0] as any).grantedByBasePlan).toBeUndefined()
  })
})
