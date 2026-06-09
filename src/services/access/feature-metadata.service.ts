import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { getVenueBaseTier, PAID_PLAN_TIER_CODES, PREMIUM_ONLY_CODES } from '@/services/access/basePlan.service'

/**
 * Gate states that already grant the venue access to a feature. When the base
 * plan blanket grant applies we only "upgrade" features whose individual state
 * is NOT one of these — preserving the more informative à-la-carte state
 * (own trial / grace period / paid) when the venue happens to have its own
 * subscription too. This keeps the grant a pure UNION (never removes access).
 */
const ACCESS_GRANTING_STATES: ReadonlySet<FeatureGateState> = new Set<FeatureGateState>(['ACTIVE', 'TRIALING', 'GRACE_PERIOD'])

export type FeatureGateState = 'ACTIVE' | 'TRIALING' | 'LOCKED' | 'TRIAL_EXPIRED' | 'SUSPENDED' | 'GRACE_PERIOD'

export interface FeatureMetadata {
  code: string
  name: string
  description: string
  monthlyPrice: string
  currency: string
  trialDays: number
  state: FeatureGateState
  trialEndsAt: string | null
  stripePriceId: string | null
  checkoutUrl: string
}

interface VenueFeatureSnapshot {
  active: boolean
  endDate: Date | null
  suspendedAt: Date | null
  gracePeriodEndsAt: Date | null
}

const DEFAULT_FEATURE_CURRENCY = 'MXN'
const DEFAULT_FEATURE_TRIAL_DAYS = 14

export function resolveFeatureGateState(venueFeature: VenueFeatureSnapshot | null | undefined, now: Date = new Date()): FeatureGateState {
  if (!venueFeature) {
    return 'LOCKED'
  }

  if (venueFeature.suspendedAt) {
    return 'SUSPENDED'
  }

  if (venueFeature.gracePeriodEndsAt && venueFeature.gracePeriodEndsAt > now) {
    return 'GRACE_PERIOD'
  }

  if (venueFeature.endDate && venueFeature.endDate > now && venueFeature.active) {
    return 'TRIALING'
  }

  if (venueFeature.endDate && venueFeature.endDate <= now) {
    return 'TRIAL_EXPIRED'
  }

  if (venueFeature.active && !venueFeature.endDate) {
    return 'ACTIVE'
  }

  return 'LOCKED'
}

function buildFeatureCheckoutUrl(venueId: string): string {
  return `/api/v1/dashboard/venues/${venueId}/features`
}

export async function getFeatureMetadataForVenue(venueId: string): Promise<Record<string, FeatureMetadata>> {
  const [features, venueFeatures, baseTier] = await Promise.all([
    prisma.feature.findMany({
      where: { active: true },
      select: {
        code: true,
        name: true,
        description: true,
        monthlyPrice: true,
        stripePriceId: true,
      },
    }),
    prisma.venueFeature.findMany({
      where: { venueId },
      select: {
        active: true,
        endDate: true,
        suspendedAt: true,
        gracePeriodEndsAt: true,
        feature: {
          select: {
            code: true,
          },
        },
      },
    }),
    // Tier-aware blanket grant mirror: the venue's base tier (PREMIUM | PRO | null)
    // unlocks premium features in the payload too, so the dashboard UI matches what
    // the access gate allows at the API layer. PREMIUM unlocks ALL non-tier features;
    // PRO unlocks all non-tier features EXCEPT the Premium-only differentiators.
    getVenueBaseTier(venueId),
  ])

  const now = new Date()
  const venueFeatureByCode = new Map(
    venueFeatures.map(vf => [
      vf.feature.code,
      {
        active: vf.active,
        endDate: vf.endDate,
        suspendedAt: vf.suspendedAt,
        gracePeriodEndsAt: vf.gracePeriodEndsAt,
      },
    ]),
  )

  const isPlanTierCode = (code: string): boolean => (PAID_PLAN_TIER_CODES as readonly string[]).includes(code)
  const isPremiumOnlyCode = (code: string): boolean => (PREMIUM_ONLY_CODES as readonly string[]).includes(code)

  /**
   * Tier-aware blanket grant for a single non-tier feature code:
   *   - PREMIUM tier grants every non-tier feature.
   *   - PRO tier grants every non-tier feature EXCEPT the Premium-only differentiators.
   *   - no tier grants nothing.
   * The venue's OWN à-la-carte state (grandfather) is handled separately below — this
   * only decides the blanket grant from the base plan.
   */
  const tierGrants = (code: string): boolean => {
    if (isPlanTierCode(code)) return false // tier codes never self-grant via the blanket
    if (baseTier === 'PREMIUM') return true
    if (baseTier === 'PRO') return !isPremiumOnlyCode(code)
    return false
  }

  const featureMetadata = features.reduce<Record<string, FeatureMetadata>>((acc, feature) => {
    const venueFeature = venueFeatureByCode.get(feature.code)
    const individualState = resolveFeatureGateState(venueFeature, now)

    // UNION the tier-aware base-plan grant: the venue's base tier unlocks the features
    // its tier covers (PREMIUM = all; PRO = all except Premium-only differentiators).
    // Preserve the richer à-la-carte state when it already grants access (grandfather);
    // only upgrade non-access states (LOCKED / TRIAL_EXPIRED / SUSPENDED) to ACTIVE.
    const grantedByBasePlan = tierGrants(feature.code) && !ACCESS_GRANTING_STATES.has(individualState)
    const state: FeatureGateState = grantedByBasePlan ? 'ACTIVE' : individualState

    acc[feature.code] = {
      code: feature.code,
      name: feature.name,
      description: feature.description || feature.name,
      monthlyPrice: feature.monthlyPrice.toString(),
      currency: DEFAULT_FEATURE_CURRENCY,
      trialDays: DEFAULT_FEATURE_TRIAL_DAYS,
      state,
      trialEndsAt: state === 'TRIALING' && venueFeature?.endDate ? venueFeature.endDate.toISOString() : null,
      stripePriceId: feature.stripePriceId || null,
      checkoutUrl: buildFeatureCheckoutUrl(venueId),
    }

    return acc
  }, {})

  logger.debug('featureMetadataService.getFeatureMetadataForVenue: resolved metadata', {
    venueId,
    featureCount: Object.keys(featureMetadata).length,
  })

  return featureMetadata
}
