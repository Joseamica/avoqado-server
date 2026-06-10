import prisma from '@/utils/prismaClient'

/**
 * Paid base-plan tier codes (Feature.code), highest tier last in conceptual order.
 * Both grant a paid-plan blanket unlock, but they differ in WHICH features they
 * unlock — see {@link PREMIUM_ONLY_CODES} and {@link getVenueBaseTier}:
 *   - PLAN_PREMIUM (top tier) unlocks ALL non-tier features.
 *   - PLAN_PRO unlocks all non-tier features EXCEPT the Premium-only differentiators.
 */
export const PAID_PLAN_TIER_CODES = ['PLAN_PRO', 'PLAN_PREMIUM'] as const

/**
 * Premium-only differentiators (Feature.code): features that require an active
 * PLAN_PREMIUM base plan. The PLAN_PRO tier does NOT blanket-grant these — a Pro
 * venue only gets them via its OWN explicit, active VenueFeature row (grandfather),
 * never from the tier grant.
 *
 * Keep this list tight: we enumerate ONLY the Premium-exclusive set (small), so Pro
 * keeps today's blanket behavior for everything else (lower regression risk than
 * enumerating Pro's full set). Every code here MUST exist as a real Feature row,
 * otherwise it silently mis-gates nothing (a non-existent code can never be the
 * featureCode passed in) — verified against the Feature table.
 */
export const PREMIUM_ONLY_CODES = ['CFDI', 'INVENTORY_TRACKING'] as const

export type BaseTier = 'PREMIUM' | 'PRO'

/** Active-window predicate shared by every base-plan query: active, not suspended, trial null/future. */
function isActiveWindow(vf: { active: boolean; suspendedAt: Date | null; endDate: Date | null }, now: Date = new Date()): boolean {
  if (!vf.active || vf.suspendedAt) return false
  if (vf.endDate && vf.endDate < now) return false // trial expired unpaid
  return true
}

/** Prisma `where` fragment for the active window (used by batch findMany queries). */
const activeWindowWhere = (now: Date) => ({ active: true, suspendedAt: null, OR: [{ endDate: null }, { endDate: { gte: now } }] })

/**
 * The venue's currently-entitled base tier, or null if none is active.
 * PREMIUM wins over PRO when both happen to be active. "Active" = active, not
 * suspended, trial (endDate) null or in the future — the same predicate used by
 * {@link venueHasActiveBasePlan}.
 */
export async function getVenueBaseTier(venueId: string): Promise<BaseTier | null> {
  const rows = await prisma.venueFeature.findMany({
    where: { venueId, feature: { code: { in: [...PAID_PLAN_TIER_CODES] } } },
    select: { active: true, suspendedAt: true, endDate: true, feature: { select: { code: true } } },
  })
  const now = new Date()
  let hasPro = false
  for (const r of rows) {
    if (!isActiveWindow(r, now)) continue
    if (r.feature.code === 'PLAN_PREMIUM') return 'PREMIUM' // top tier short-circuits
    if (r.feature.code === 'PLAN_PRO') hasPro = true
  }
  return hasPro ? 'PRO' : null
}

/**
 * True when the venue currently has ANY entitled paid base plan (PLAN_PRO or
 * PLAN_PREMIUM): an active, non-suspended VenueFeature whose trial (endDate) is
 * null or in the future. This is the binary "paid or trialing" gate. It does NOT
 * distinguish Pro from Premium — for feature-level gating use {@link venueHasFeatureAccess}
 * / {@link getVenueBaseTier}. Callers that only want "has a paid plan at all"
 * (the paid/locked binary) are unaffected by the Pro↔Premium split.
 */
export async function venueHasActiveBasePlan(venueId: string): Promise<boolean> {
  const vf = await prisma.venueFeature.findFirst({
    where: { venueId, feature: { code: { in: [...PAID_PLAN_TIER_CODES] } } },
    select: { active: true, suspendedAt: true, endDate: true },
  })
  if (!vf) return false
  return isActiveWindow(vf)
}

/**
 * Whether the venue is GRANDFATHERED — i.e. exempt from the tier monetization and operating
 * as it did before tiers. Reads {@link Venue.seatCapExempt} (the grandfather flag; the column
 * keeps its legacy name to avoid migration churn). A grandfathered venue is exempt from BOTH
 * the Free seat cap AND every feature paywall. Returns false when the venue doesn't exist.
 */
export async function venueIsGrandfathered(venueId: string): Promise<boolean> {
  const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { seatCapExempt: true } })
  return venue?.seatCapExempt === true
}

/**
 * Whether a venue may use a specific feature — tier-aware mirror of the access gate so callers
 * OUTSIDE the HTTP middleware (e.g. the customer MCP) enforce the same paid-plan gating and
 * never bypass it. Resolution order:
 *   0. GRANDFATHERED venue ({@link Venue.seatCapExempt} === true) → true for ANY feature code
 *      (operates as before tiers; the same short-circuit point where superadmin is allowed in
 *      the middleware). Checked BEFORE the tier logic so legacy venues never hit a paywall.
 *   1. Own active VenueFeature for `featureCode` (active, !suspended, trial null/future) → true (grandfather; explicit grant ALWAYS wins, regardless of tier).
 *   2. Tier codes themselves are not self-granting here → false.
 *   3. PLAN_PREMIUM → true for any non-tier feature.
 *   4. PLAN_PRO → true for any non-tier feature EXCEPT a {@link PREMIUM_ONLY_CODES} differentiator.
 *   5. No active base plan → false.
 */
export async function venueHasFeatureAccess(venueId: string, featureCode: string): Promise<boolean> {
  // 0. Grandfathered venue → full feature access, no paywall (operates as before tiers).
  if (await venueIsGrandfathered(venueId)) return true

  const vf = await prisma.venueFeature.findFirst({
    where: { venueId, feature: { code: featureCode } },
    select: { active: true, endDate: true, suspendedAt: true },
  })
  // 1. Grandfather: the venue's own active grant for this code always wins.
  if (vf && isActiveWindow(vf)) return true

  // 2. Tier codes are not self-granting via the blanket logic.
  if ((PAID_PLAN_TIER_CODES as readonly string[]).includes(featureCode)) return false

  // 3-5. Otherwise the tier decides.
  const tier = await getVenueBaseTier(venueId)
  if (tier === 'PREMIUM') return true
  if (tier === 'PRO') return !(PREMIUM_ONLY_CODES as readonly string[]).includes(featureCode)
  return false
}

/**
 * Batch version of {@link venueHasFeatureAccess}: of the given venues, which ones may use
 * `featureCode`. Same tier-aware semantics, in a small constant number of queries (≤3
 * regardless of N):
 *   - venues with their OWN active VenueFeature for the code → entitled (grandfather).
 *   - venues with active PLAN_PREMIUM → entitled for any non-tier code.
 *   - venues with active PLAN_PRO → entitled ONLY IF the code is not a PREMIUM_ONLY_CODES differentiator.
 *   - tier codes themselves are not blanket-granted (only an own grant entitles them).
 * Use to scope a multi-venue read to only the entitled venues.
 */
export async function venuesWithFeatureAccess(venueIds: string[], featureCode: string): Promise<Set<string>> {
  if (venueIds.length === 0) return new Set()
  const now = new Date()
  const activeWindow = activeWindowWhere(now)

  // 1. Own active grant for the code (always entitles — grandfather).
  const withFeature = await prisma.venueFeature.findMany({
    where: { venueId: { in: venueIds }, feature: { code: featureCode }, ...activeWindow },
    select: { venueId: true },
  })
  const entitled = new Set(withFeature.map(v => v.venueId))

  // Tier codes are not blanket-granted: only an own grant (above) entitles them.
  if ((PAID_PLAN_TIER_CODES as readonly string[]).includes(featureCode)) return entitled

  const isPremiumOnly = (PREMIUM_ONLY_CODES as readonly string[]).includes(featureCode)

  // 2. Active PLAN_PREMIUM entitles any non-tier code.
  const withPremium = await prisma.venueFeature.findMany({
    where: { venueId: { in: venueIds }, feature: { code: 'PLAN_PREMIUM' }, ...activeWindow },
    select: { venueId: true },
  })
  for (const v of withPremium) entitled.add(v.venueId)

  // 3. Active PLAN_PRO entitles only non-Premium-only codes.
  if (!isPremiumOnly) {
    const withPro = await prisma.venueFeature.findMany({
      where: { venueId: { in: venueIds }, feature: { code: 'PLAN_PRO' }, ...activeWindow },
      select: { venueId: true },
    })
    for (const v of withPro) entitled.add(v.venueId)
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
