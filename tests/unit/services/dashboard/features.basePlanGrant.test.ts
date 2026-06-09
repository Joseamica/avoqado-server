import { prismaMock } from '@tests/__helpers__/setup'
import { getVenueFeatureStatus } from '@/services/dashboard/venueFeature.dashboard.service'

/**
 * Verifies the TIER-AWARE base-plan blanket grant is mirrored into the dashboard
 * paywall payload (getVenueFeatureStatus → GET /dashboard/venues/:venueId/features).
 *
 * This endpoint expresses "gate state" as a TWO-ARRAY partition rather than an
 * enum: `activeFeatures` (owned / unlocked, rendered with billing badge) vs
 * `availableFeatures` (locked upsell cards with a Subscribe button). The base
 * plan grant must therefore PROMOTE premium features the venue lacks à-la-carte
 * from `availableFeatures` into `activeFeatures` — but ONLY the ones the venue's
 * tier actually covers, mirroring the checkFeatureAccess middleware:
 *   - PREMIUM tier unlocks ALL non-tier features.
 *   - PRO tier unlocks all non-tier features EXCEPT the Premium-only
 *     differentiators (PREMIUM_ONLY_CODES = CFDI, INVENTORY_TRACKING).
 *   - no active tier unlocks nothing.
 * It is a pure UNION that never removes access a venue already has, and never
 * touches the plan-tier feature itself.
 *
 * Mock routing: getVenueBaseTier scans VenueFeature via findMany with a
 * `where.feature.code.in` filter; the historical-usage query is a findMany
 * WITHOUT that filter. We route findMany by the presence of that filter so the
 * tier scan returns the venue's PLAN_* rows and the history query returns [].
 */
describe('getVenueFeatureStatus tier-aware base-plan blanket grant', () => {
  const VENUE_ID = 'venue_baseplan'

  // Premium-only differentiator (CFDI). Pro must NOT blanket-grant this.
  const PREMIUM_ONLY_FEATURE = {
    id: 'feat_cfdi',
    code: 'CFDI',
    name: 'Facturación CFDI',
    description: 'CFDI 4.0 invoicing',
    monthlyPrice: '0.00',
    stripeProductId: 'prod_cfdi',
    stripePriceId: 'price_cfdi',
    active: true,
  }

  // Normal premium feature — granted by BOTH Pro and Premium tiers.
  const NORMAL_FEATURE = {
    id: 'feat_loyalty',
    code: 'LOYALTY_PROGRAM',
    name: 'Loyalty',
    description: 'Loyalty program',
    monthlyPrice: '599.00',
    stripeProductId: 'prod_loyalty',
    stripePriceId: 'price_loyalty',
    active: true,
  }

  const PLAN_PRO_FEATURE = {
    id: 'feat_plan_pro',
    code: 'PLAN_PRO',
    name: 'Plan Pro',
    description: 'Base plan',
    monthlyPrice: '499.00',
    stripeProductId: 'prod_plan_pro',
    stripePriceId: 'price_plan_pro',
    active: true,
  }

  const PLAN_PREMIUM_FEATURE = {
    id: 'feat_plan_premium',
    code: 'PLAN_PREMIUM',
    name: 'Plan Premium',
    description: 'Base plan',
    monthlyPrice: '1699.00',
    stripeProductId: 'prod_plan_premium',
    stripePriceId: 'price_plan_premium',
    active: true,
  }

  const CATALOG = [PREMIUM_ONLY_FEATURE, NORMAL_FEATURE, PLAN_PRO_FEATURE, PLAN_PREMIUM_FEATURE]

  /** Active-window VenueFeature snapshot fields getVenueBaseTier reads. */
  const ACTIVE_TIER_SNAP = { active: true, suspendedAt: null, endDate: null }

  /**
   * Wire the prisma mocks for a venue with NO à-la-carte VenueFeature rows.
   * @param tierCodes  PLAN_* codes the venue currently has active (the tier scan result)
   */
  function mockVenueWithTier(tierCodes: string[]) {
    prismaMock.venue.findUnique.mockResolvedValue({
      id: VENUE_ID,
      name: 'Test Venue',
      stripeCustomerId: null,
      stripePaymentMethodId: null,
      features: [],
    } as any)
    prismaMock.feature.findMany.mockResolvedValue(CATALOG as any)
    prismaMock.venueFeature.findMany.mockImplementation(async ({ where }: any) => {
      if (where?.feature?.code?.in) {
        // getVenueBaseTier tier scan → only the venue's active PLAN_* rows.
        return tierCodes
          .filter(code => where.feature.code.in.includes(code))
          .map(code => ({ ...ACTIVE_TIER_SNAP, feature: { code } })) as any
      }
      // Historical (canceled) usage query → none.
      return [] as any
    })
  }

  it('PRO tier: promotes a NORMAL premium feature but does NOT promote a Premium-only feature (CFDI)', async () => {
    mockVenueWithTier(['PLAN_PRO'])

    const status = await getVenueFeatureStatus(VENUE_ID)

    // Normal feature is granted-by-plan and removed from the locked upsell list.
    const loyaltyActive = status.activeFeatures.find(f => f.feature.code === 'LOYALTY_PROGRAM')
    expect(loyaltyActive).toBeDefined()
    expect((loyaltyActive as any)?.grantedByBasePlan).toBe(true)
    expect(loyaltyActive?.stripeSubscriptionId).toBeNull()
    expect(status.availableFeatures.find(f => f.code === 'LOYALTY_PROGRAM')).toBeUndefined()

    // REGRESSION: Pro must NOT synthesize CFDI (Premium-only) as grantedByBasePlan —
    // the access middleware 403s it, so the paywall must keep it as a locked upsell.
    expect(status.activeFeatures.find(f => f.feature.code === 'CFDI')).toBeUndefined()
    expect(status.availableFeatures.find(f => f.code === 'CFDI')).toBeDefined()
  })

  it('PREMIUM tier: promotes BOTH the normal feature and the Premium-only feature (CFDI)', async () => {
    mockVenueWithTier(['PLAN_PREMIUM'])

    const status = await getVenueFeatureStatus(VENUE_ID)

    const loyaltyActive = status.activeFeatures.find(f => f.feature.code === 'LOYALTY_PROGRAM')
    expect(loyaltyActive).toBeDefined()
    expect((loyaltyActive as any)?.grantedByBasePlan).toBe(true)

    // Premium DOES blanket-grant CFDI.
    const cfdiActive = status.activeFeatures.find(f => f.feature.code === 'CFDI')
    expect(cfdiActive).toBeDefined()
    expect((cfdiActive as any)?.grantedByBasePlan).toBe(true)
    expect(cfdiActive?.stripeSubscriptionId).toBeNull()
    expect(status.availableFeatures.find(f => f.code === 'CFDI')).toBeUndefined()
  })

  it('leaves every premium feature LOCKED (in availableFeatures) when there is no active base plan', async () => {
    mockVenueWithTier([]) // no PLAN_* rows → tier null

    const status = await getVenueFeatureStatus(VENUE_ID)

    expect(status.activeFeatures.find(f => f.feature.code === 'LOYALTY_PROGRAM')).toBeUndefined()
    expect(status.activeFeatures.find(f => f.feature.code === 'CFDI')).toBeUndefined()
    expect(status.availableFeatures.find(f => f.code === 'LOYALTY_PROGRAM')).toBeDefined()
    expect(status.availableFeatures.find(f => f.code === 'CFDI')).toBeDefined()
  })

  it('never force-promotes the plan-tier feature itself via the blanket grant', async () => {
    mockVenueWithTier(['PLAN_PREMIUM'])

    const status = await getVenueFeatureStatus(VENUE_ID)

    // The PLAN_* catalog entries have no own active VenueFeature row in `venue.features`
    // here, so they must stay in availableFeatures — the grant they represent must not
    // unlock the tier code itself.
    expect(status.activeFeatures.find(f => f.feature.code === 'PLAN_PRO')).toBeUndefined()
    expect(status.activeFeatures.find(f => f.feature.code === 'PLAN_PREMIUM')).toBeUndefined()
    expect(status.availableFeatures.find(f => f.code === 'PLAN_PRO')).toBeDefined()
    expect(status.availableFeatures.find(f => f.code === 'PLAN_PREMIUM')).toBeDefined()
    // Sanity: the union still granted a real premium feature in the same call.
    expect(status.activeFeatures.find(f => f.feature.code === 'LOYALTY_PROGRAM')).toBeDefined()
  })

  it('PRO tier + own active CFDI grant (grandfather): CFDI stays in activeFeatures as a real à-la-carte row', async () => {
    // REGRESSION guard for the "explicit grants always show" rule: a PRO venue that
    // grandfathered CFDI à-la-carte must still see CFDI as owned (its REAL VenueFeature
    // row), even though the tier-aware blanket grant would NOT synthesize it for Pro.
    const trialEnd = new Date(Date.now() + 7 * 86400000)
    prismaMock.venue.findUnique.mockResolvedValue({
      id: VENUE_ID,
      name: 'Test Venue',
      stripeCustomerId: 'cus_1',
      stripePaymentMethodId: null,
      features: [
        {
          id: 'vf_cfdi',
          venueId: VENUE_ID,
          featureId: PREMIUM_ONLY_FEATURE.id,
          feature: PREMIUM_ONLY_FEATURE,
          active: true,
          monthlyPrice: '0.00',
          startDate: new Date(),
          endDate: trialEnd,
          stripeSubscriptionId: 'sub_cfdi',
          stripePriceId: 'price_cfdi',
        },
      ],
    } as any)
    prismaMock.feature.findMany.mockResolvedValue(CATALOG as any)
    prismaMock.venueFeature.findMany.mockImplementation(async ({ where }: any) => {
      if (where?.feature?.code?.in) {
        // Tier scan → active PLAN_PRO.
        return where.feature.code.in.includes('PLAN_PRO') ? [{ ...ACTIVE_TIER_SNAP, feature: { code: 'PLAN_PRO' } }] : ([] as any)
      }
      return [] as any
    })

    const status = await getVenueFeatureStatus(VENUE_ID)

    // Exactly one CFDI entry, the original à-la-carte one (not duplicated, not relabeled,
    // not dropped just because Pro doesn't blanket-grant it). Its trial + real sub survive.
    const cfdiEntries = status.activeFeatures.filter(f => f.feature.code === 'CFDI')
    expect(cfdiEntries).toHaveLength(1)
    expect(cfdiEntries[0].id).toBe('vf_cfdi')
    expect(cfdiEntries[0].stripeSubscriptionId).toBe('sub_cfdi')
    expect(cfdiEntries[0].endDate).toEqual(trialEnd)
    expect((cfdiEntries[0] as any).grantedByBasePlan).toBeUndefined()
    // ...and CFDI is not offered as a locked upsell card.
    expect(status.availableFeatures.find(f => f.code === 'CFDI')).toBeUndefined()
  })
})
