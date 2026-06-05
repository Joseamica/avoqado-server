import prisma from '@/utils/prismaClient'

/** Paid plan tier codes that grant a blanket premium unlock. Phase 1: PLAN_PRO. */
export const PAID_PLAN_TIER_CODES = ['PLAN_PRO'] as const

/**
 * True when the venue currently has an entitled base plan: an active, non-
 * suspended PLAN_PRO VenueFeature whose trial (endDate) is null or in the
 * future. This is the binary "paid or trialing" gate that unlocks all premium
 * features (the blanket grant). When false, premium locks and the venue falls
 * back to the basic set.
 */
export async function venueHasActiveBasePlan(venueId: string): Promise<boolean> {
  const vf = await prisma.venueFeature.findFirst({
    where: { venueId, feature: { code: { in: [...PAID_PLAN_TIER_CODES] } } },
    select: { active: true, suspendedAt: true, endDate: true },
  })
  if (!vf || !vf.active || vf.suspendedAt) return false
  if (vf.endDate && vf.endDate < new Date()) return false // trial expired unpaid
  return true
}

/**
 * Whether a venue may use a specific premium feature — mirrors checkFeatureAccess so callers
 * OUTSIDE the HTTP middleware (e.g. the customer MCP) can enforce the same paid-plan gating and
 * not bypass it. True when the venue's own `VenueFeature` for `featureCode` is active (not
 * suspended, trial not expired), OR an active base plan blanket-grants it (for non-tier codes).
 */
export async function venueHasFeatureAccess(venueId: string, featureCode: string): Promise<boolean> {
  const vf = await prisma.venueFeature.findFirst({
    where: { venueId, feature: { code: featureCode } },
    select: { active: true, endDate: true, suspendedAt: true },
  })
  if (vf && vf.active && !vf.suspendedAt && (!vf.endDate || vf.endDate >= new Date())) return true
  if (!(PAID_PLAN_TIER_CODES as readonly string[]).includes(featureCode) && (await venueHasActiveBasePlan(venueId))) return true
  return false
}

/**
 * Batch version of {@link venueHasFeatureAccess}: of the given venues, which ones may use
 * `featureCode` (own active feature, OR active base plan for non-tier codes). Two queries
 * regardless of N. Use to scope a multi-venue read to only the entitled venues.
 */
export async function venuesWithFeatureAccess(venueIds: string[], featureCode: string): Promise<Set<string>> {
  if (venueIds.length === 0) return new Set()
  const now = new Date()
  const activeWindow = { active: true, suspendedAt: null, OR: [{ endDate: null }, { endDate: { gte: now } }] }

  const withFeature = await prisma.venueFeature.findMany({
    where: { venueId: { in: venueIds }, feature: { code: featureCode }, ...activeWindow },
    select: { venueId: true },
  })
  const entitled = new Set(withFeature.map(v => v.venueId))

  if (!(PAID_PLAN_TIER_CODES as readonly string[]).includes(featureCode)) {
    const withBasePlan = await prisma.venueFeature.findMany({
      where: { venueId: { in: venueIds }, feature: { code: { in: [...PAID_PLAN_TIER_CODES] } }, ...activeWindow },
      select: { venueId: true },
    })
    for (const v of withBasePlan) entitled.add(v.venueId)
  }
  return entitled
}

/** IVA rate baked into the inclusive Stripe price. base = gross / (1 + IVA_RATE). */
export const IVA_RATE = 0.16

export type PlanStateValue = 'none' | 'trial' | 'active' | 'canceling' | 'past_due' | 'suspended' | 'canceled'

/** The minimal VenueFeature fields derivePlanState needs. */
export interface DerivePlanFeatureInput {
  active: boolean
  endDate: Date | null
  suspendedAt: Date | null
  gracePeriodEndsAt: Date | null
}

/** The minimal Stripe subscription fields derivePlanState needs. */
export interface DerivePlanStripeInput {
  status: string
  cancelAtPeriodEnd: boolean
}

/**
 * Pure, side-effect-free derivation of the venue's base-plan lifecycle state.
 * Shared by the client plan endpoint (this plan) and the superadmin overview (Plan 2).
 * Order of checks is significant — see plan doc "derivePlanState logic".
 *
 * @param vf   PLAN_PRO VenueFeature row, or null if the venue never had it.
 * @param sub  Stripe subscription summary, or null (DB-only/comped trial, or no Stripe sub).
 */
export function derivePlanState(
  vf: DerivePlanFeatureInput | null,
  sub: DerivePlanStripeInput | null,
): { state: PlanStateValue; hasPlan: boolean } {
  if (!vf) return { state: 'none', hasPlan: false }

  const now = new Date()
  let state: PlanStateValue

  if (vf.suspendedAt) {
    state = 'suspended'
  } else if (!vf.active) {
    state = 'canceled'
  } else if ((vf.gracePeriodEndsAt && now < vf.gracePeriodEndsAt) || sub?.status === 'past_due') {
    state = 'past_due'
  } else if (vf.endDate && vf.endDate > now) {
    state = 'trial'
  } else if (sub?.cancelAtPeriodEnd === true) {
    state = 'canceling'
  } else {
    state = 'active'
  }

  return { state, hasPlan: true }
}
