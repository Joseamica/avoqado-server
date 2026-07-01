import prisma from '@/utils/prismaClient'
import { moduleService, MODULE_CODES } from '@/services/modules/module.service'

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
 * MUST mirror the PREMIUM tier's `includes` in the dashboard catalog
 * (avoqado-web-dashboard/src/config/plan-catalog.ts) by exact name — a mismatch
 * means the server blanket-grants to Pro something the catalog sells as Premium.
 * Codes without a Feature row are still valid here: the gate works off the code
 * string (the explicit-grant lookup simply finds nothing).
 */
export const PREMIUM_ONLY_CODES = [
  'CFDI',
  'INVENTORY_TRACKING',
  // 'ADVANCED_ANALYTICS' removed 2026-07-01: dead pay-per-feature code (deactivated as sellable
  // in Jan 2025, never gated any route/tool). Do NOT re-add from old docs — the Premium "analítica
  // predictiva" sales bullet is featureKeys copy, not a real code. See plan-catalog.ts PREMIUM.
  'COMMISSIONS',
  'ATTENDANCE_TRACKING',
  'SERIALIZED_INVENTORY',
  'AUTO_REORDER',
  'TRANSACTION_EXPORT',
] as const

/**
 * Free-tier codes (Feature.code): capabilities the FREE plan PROMISES (dashboard
 * catalog FREE `includes`), granted to EVERY venue regardless of plan — even with
 * no base plan at all. Without this, a brand-new Free venue gets 403 on routes the
 * pricing page says are included (e.g. the chatbot). Mirror plan-catalog.ts FREE.
 */
export const FREE_TIER_CODES = ['CHATBOT'] as const // AVAILABLE_BALANCE moved to PRO (founder: available balance = PRO)

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
 * Demo venue statuses (VenueStatus): venues that exist to SHOWCASE the product — the public
 * live demo and private onboarding trials. Demo venues must demonstrate every feature, so
 * they are exempt from plan-tier paywalls (a demo that 403s on Reservations sells nothing).
 */
export const DEMO_VENUE_STATUSES = ['LIVE_DEMO', 'TRIAL'] as const

/**
 * Whether the venue is EXEMPT from plan-tier gating entirely. True when the venue is either:
 *   - GRANDFATHERED ({@link Venue.seatCapExempt} === true — see {@link venueIsGrandfathered}), or
 *   - a DEMO venue ({@link Venue.status} in {@link DEMO_VENUE_STATUSES}: LIVE_DEMO / TRIAL),
 *     which must showcase every feature.
 * Single venue lookup (seatCapExempt + status). Returns false when the venue doesn't exist.
 * This is the short-circuit used by the feature-access middleware and {@link venueHasFeatureAccess}.
 */
export async function venueIsExemptFromPlanGating(venueId: string): Promise<boolean> {
  const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { seatCapExempt: true, status: true } })
  if (!venue) return false
  if (venue.seatCapExempt === true) return true
  return (DEMO_VENUE_STATUSES as readonly string[]).includes(venue.status as string)
}

/**
 * Plan tier as exposed to POS/mobile clients (the optional `plan.tier` field on the mobile
 * venue-settings payload). Maps {@link BaseTier} | null → client string: no active base plan
 * → 'FREE'. 'ENTERPRISE' is reserved — no enterprise base-plan Feature code exists today, so
 * it is never emitted yet; clients must still accept it (forward compatibility).
 */
export type ClientPlanTier = 'FREE' | 'PRO' | 'PREMIUM' | 'ENTERPRISE'

/** Plan info for client payloads — see {@link getVenuePlanInfo}. */
export interface VenuePlanInfo {
  tier: ClientPlanTier
  grandfathered: boolean
  exempt: boolean
}

/**
 * The venue's plan info as exposed to POS/mobile clients so they can gate UI by plan.
 * Composes the semantics of {@link getVenueBaseTier}, {@link venueIsGrandfathered} and
 * {@link venueIsExemptFromPlanGating} in exactly 2 indexed queries (one VenueFeature scan
 * + ONE Venue PK fetch shared by both flags, instead of the two separate venue lookups the
 * individual helpers would make):
 *   - `tier`: 'PREMIUM' / 'PRO' from the active base plan, 'FREE' when none.
 *   - `grandfathered`: {@link venueIsGrandfathered} semantics (Venue.seatCapExempt === true).
 *   - `exempt`: {@link venueIsExemptFromPlanGating} semantics (grandfathered OR demo status
 *     LIVE_DEMO / TRIAL) — what clients should actually use to skip ALL plan gating.
 * Nonexistent venue → { tier: 'FREE', grandfathered: false, exempt: false } (same false
 * defaults as the individual helpers).
 */
export async function getVenuePlanInfo(venueId: string): Promise<VenuePlanInfo> {
  const [tier, venue] = await Promise.all([
    getVenueBaseTier(venueId),
    prisma.venue.findUnique({ where: { id: venueId }, select: { seatCapExempt: true, status: true } }),
  ])
  const grandfathered = venue?.seatCapExempt === true
  const exempt = grandfathered || (venue != null && (DEMO_VENUE_STATUSES as readonly string[]).includes(venue.status as string))
  return { tier: tier ?? 'FREE', grandfathered, exempt }
}

/**
 * Whether a venue may use a specific feature — tier-aware mirror of the access gate so callers
 * OUTSIDE the HTTP middleware (e.g. the customer MCP) enforce the same paid-plan gating and
 * never bypass it. Resolution order:
 *   0. EXEMPT venue (GRANDFATHERED {@link Venue.seatCapExempt} === true, OR demo-status
 *      LIVE_DEMO / TRIAL — see {@link venueIsExemptFromPlanGating}) → true for ANY feature code
 *      (operates as before tiers / showcases everything; the same short-circuit point where
 *      superadmin is allowed in the middleware). Checked BEFORE the tier logic so legacy and
 *      demo venues never hit a paywall.
 *   1. Own active VenueFeature for `featureCode` (active, !suspended, trial null/future) → true (grandfather; explicit grant ALWAYS wins, regardless of tier).
 *   2. Tier codes themselves are not self-granting here → false.
 *   3. PLAN_PREMIUM → true for any non-tier feature.
 *   4. PLAN_PRO → true for any non-tier feature EXCEPT a {@link PREMIUM_ONLY_CODES} differentiator.
 *   5. No active base plan → false.
 */
export async function venueHasFeatureAccess(venueId: string, featureCode: string): Promise<boolean> {
  // 0. Exempt venue (grandfathered OR demo-status) → full feature access, no paywall.
  if (await venueIsExemptFromPlanGating(venueId)) return true

  const vf = await prisma.venueFeature.findFirst({
    where: { venueId, feature: { code: featureCode } },
    select: { active: true, endDate: true, suspendedAt: true },
  })
  // 1. Grandfather: the venue's own active grant for this code always wins.
  if (vf && isActiveWindow(vf)) return true

  // 2. Tier codes are not self-granting via the blanket logic.
  if ((PAID_PLAN_TIER_CODES as readonly string[]).includes(featureCode)) return false

  // 2.5. Free-tier promises are granted to everyone (even venues with no plan).
  if ((FREE_TIER_CODES as readonly string[]).includes(featureCode)) return true

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

  // 0. EXEMPT venues (GRANDFATHERED Venue.seatCapExempt OR demo status LIVE_DEMO/TRIAL) → entitled
  //    for ANY feature code, exactly like the single-venue venueHasFeatureAccess short-circuit
  //    (venueIsExemptFromPlanGating). WITHOUT this, the batch gate wrongly blocks grandfathered
  //    venues — they carry no PLAN_PRO/PLAN_PREMIUM row, so they fell through to "not entitled"
  //    (the prod incident where a grandfathered PlayTelecom venue was told sales_comparison
  //    "requiere plan PRO" via the MCP). Checked FIRST so legacy/demo venues never hit a paywall.
  const venuesForExemption = await prisma.venue.findMany({
    where: { id: { in: venueIds } },
    select: { id: true, seatCapExempt: true, status: true },
  })
  const entitled = new Set(
    venuesForExemption
      .filter(v => v.seatCapExempt === true || (DEMO_VENUE_STATUSES as readonly string[]).includes(v.status as string))
      .map(v => v.id),
  )

  // 1. Own active grant for the code (always entitles — grandfather à-la-carte).
  const withFeature = await prisma.venueFeature.findMany({
    where: { venueId: { in: venueIds }, feature: { code: featureCode }, ...activeWindow },
    select: { venueId: true },
  })
  for (const v of withFeature) entitled.add(v.venueId)

  // Tier codes are not blanket-granted: only an own grant (or exemption above) entitles them.
  if ((PAID_PLAN_TIER_CODES as readonly string[]).includes(featureCode)) return entitled

  // Free-tier promises entitle every venue (even with no plan).
  if ((FREE_TIER_CODES as readonly string[]).includes(featureCode)) return new Set(venueIds)

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

/**
 * COMMISSIONS is DUAL-GRANTED — the one differentiator that lives in BOTH gating systems:
 *   - Module grant: `VenueModule`/`OrganizationModule` 'COMMISSIONS' (legacy + white-label
 *     orgs, e.g. PlayTelecom stores get it org-wide) — resolved via
 *     {@link moduleService.isModuleEnabled} (includes the org-level fallback).
 *   - Tier grant: PREMIUM-only differentiator via {@link venueHasFeatureAccess}
 *     (grandfathered/demo → own VenueFeature grant → PLAN_PREMIUM blanket).
 * Access = module enabled OR tier access. The dashboard commission routes AND the customer-MCP
 * commission tools must BOTH resolve through these helpers so the two planes never disagree
 * (see `.claude/rules/feature-gating.md` — crossing Module/Feature resolvers fails silently).
 */
export async function venueHasCommissionsAccess(venueId: string): Promise<boolean> {
  if (await moduleService.isModuleEnabled(venueId, MODULE_CODES.COMMISSIONS)) return true
  return venueHasFeatureAccess(venueId, 'COMMISSIONS')
}

/**
 * Batch version of {@link venueHasCommissionsAccess}: of the given venues, which ones may use
 * commissions (module grant OR tier access). Tier side is the ≤3-query batch resolver; the
 * module side only checks the venues the tier didn't already entitle.
 */
export async function venuesWithCommissionsAccess(venueIds: string[]): Promise<Set<string>> {
  if (venueIds.length === 0) return new Set()
  const entitled = await venuesWithFeatureAccess(venueIds, 'COMMISSIONS')
  const rest = venueIds.filter(id => !entitled.has(id))
  const moduleFlags = await Promise.all(rest.map(id => moduleService.isModuleEnabled(id, MODULE_CODES.COMMISSIONS)))
  rest.forEach((id, i) => {
    if (moduleFlags[i]) entitled.add(id)
  })
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
