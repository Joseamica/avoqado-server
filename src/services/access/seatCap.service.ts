import { StaffRole } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { ForbiddenError } from '@/errors/AppError'
import { getVenueBaseTier } from './basePlan.service'

/**
 * Free-plan seat cap.
 *
 * Product rule: the Free tier allows at most {@link FREE_TIER_SEAT_CAP} ACTIVE users
 * per VENUE. Paid tiers (PLAN_PRO / PLAN_PREMIUM) are unlimited. The OWNER counts as
 * one of the seats. Platform support (StaffRole.SUPERADMIN) never counts and is never
 * blocked.
 *
 * Grandfathering: a venue with `seatCapExempt = true` is exempt forever (every venue
 * that existed at rollout is backfilled to true by the venue_seat_cap_exempt migration,
 * so the legacy venues already over the cap don't break). New venues default to false
 * and are enforced once they end up on the Free tier.
 *
 * This module only computes the cap and enforces it at invite / staff-creation time.
 * Reconciling an existing over-cap venue on DOWNGRADE is a separate, later task — not here.
 */

/** Max active (non-SUPERADMIN) StaffVenue rows allowed on the Free tier, per venue. */
export const FREE_TIER_SEAT_CAP = 2

/** Stable error code surfaced to clients when the Free-tier seat cap is reached. */
export const SEAT_CAP_REACHED_CODE = 'SEAT_CAP_REACHED'

/**
 * The venue's active-user cap, or `null` for unlimited.
 *   - `seatCapExempt` venue (grandfathered) → null (never enforced).
 *   - Paid tier (PLAN_PRO / PLAN_PREMIUM)    → null (unlimited).
 *   - Free / no active paid plan             → {@link FREE_TIER_SEAT_CAP}.
 *
 * Returns null (fail-open) when the venue can't be found — enforcement should never
 * block on a missing/ambiguous venue; the upstream flow will surface its own not-found.
 */
export async function getVenueSeatCap(venueId: string): Promise<number | null> {
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    select: { seatCapExempt: true },
  })

  // Unknown venue: don't manufacture a cap. Fail open.
  if (!venue) return null

  // Grandfathered: exempt forever.
  if (venue.seatCapExempt) return null

  // Otherwise the entitled base tier decides. A paid tier → unlimited; no paid tier → Free.
  const tier = await getVenueBaseTier(venueId)
  if (tier === 'PRO' || tier === 'PREMIUM') return null
  return FREE_TIER_SEAT_CAP
}

/**
 * Count of seats that count against the cap: ACTIVE StaffVenue rows for the venue,
 * EXCLUDING StaffRole.SUPERADMIN (support is exempt and never counted).
 */
export async function getActiveSeatCount(venueId: string): Promise<number> {
  return prisma.staffVenue.count({
    where: {
      venueId,
      active: true,
      role: { not: StaffRole.SUPERADMIN },
    },
  })
}

/**
 * Whether another seat can be added to the venue right now.
 *   - `cap === null` → unlimited → always allowed.
 *   - otherwise allowed only while `current < cap`.
 */
export async function canAddSeat(venueId: string): Promise<{ allowed: boolean; cap: number | null; current: number }> {
  const cap = await getVenueSeatCap(venueId)
  if (cap === null) {
    // Unlimited: no need to count for the decision (but report a count for callers that want it).
    const current = await getActiveSeatCount(venueId)
    return { allowed: true, cap: null, current }
  }
  const current = await getActiveSeatCount(venueId)
  return { allowed: current < cap, cap, current }
}

/**
 * Throws a 403 {@link ForbiddenError} (code {@link SEAT_CAP_REACHED_CODE}) when the venue
 * is at/over its Free-tier seat cap. No-op for exempt / paid (unlimited) venues, and for
 * Free venues still under the cap. Call this BEFORE creating a new StaffVenue for the venue.
 *
 * The message is user-facing Spanish (it surfaces raw to the dashboard).
 */
export async function assertCanAddSeat(venueId: string): Promise<void> {
  const { allowed, cap } = await canAddSeat(venueId)
  if (allowed) return
  throw new ForbiddenError(
    `Llegaste al límite de ${cap} usuarios del plan Gratis. Mejora a Pro para agregar usuarios ilimitados.`,
    SEAT_CAP_REACHED_CODE,
  )
}
