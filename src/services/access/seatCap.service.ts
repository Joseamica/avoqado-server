import { InvitationStatus, StaffRole } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { ForbiddenError } from '@/errors/AppError'
import { getVenueBaseTier } from './basePlan.service'

/**
 * Free-plan seat cap.
 *
 * Product rule: the Free tier allows at most {@link FREE_TIER_SEAT_CAP} users per VENUE,
 * where "users" = ACTIVE non-support StaffVenue rows PLUS OUTSTANDING (pending, not-yet-
 * expired) invitations — because an outstanding invite is a seat that's about to be filled.
 * Counting pending invites toward the cap stops a Free venue at 1 active user from blasting
 * out 5 invites that all pass the send-time check only to be 403'd one-by-one at accept time.
 * Paid tiers (PLAN_PRO / PLAN_PREMIUM) are unlimited. The OWNER counts as one of the seats.
 * Platform support (StaffRole.SUPERADMIN) never counts and is never blocked.
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
 * Count of OUTSTANDING invitations that each reserve a seat at this venue: status PENDING
 * (so NOT accepted / declined / revoked) AND not yet expired (`expiresAt > now`), targeting
 * THIS venueId, EXCLUDING StaffRole.SUPERADMIN invites (support is never counted — same as
 * active seats). Each such invite is a seat about to be filled, so it counts against the cap
 * at SEND time — that's what stops a Free venue from over-inviting.
 *
 * An EXPIRED-but-still-PENDING row (status PENDING, expiresAt in the past) does NOT count:
 * it can never be accepted (accept rejects expired invites) so it reserves nothing. The
 * dashboard already renders those as "EXPIRED".
 *
 * `excludeInvitationId` drops one specific invitation from the count. The accept flow uses it
 * to avoid double-counting the very invite being accepted: at accept time that invite is still
 * PENDING (it's marked ACCEPTED later in the same transaction), so without excluding it the
 * defense-in-depth accept-time check would count it once as a pending seat AND once as the
 * active seat it's about to become — an off-by-one that wrongly blocks a legitimate accept.
 */
export async function getPendingInvitationCount(venueId: string, opts: { excludeInvitationId?: string } = {}): Promise<number> {
  return prisma.invitation.count({
    where: {
      venueId,
      status: InvitationStatus.PENDING,
      expiresAt: { gt: new Date() }, // expired-but-pending reserves nothing — never counts
      role: { not: StaffRole.SUPERADMIN },
      ...(opts.excludeInvitationId ? { id: { not: opts.excludeInvitationId } } : {}),
    },
  })
}

/** Options shared by {@link canAddSeat} / {@link assertCanAddSeat}. */
export interface SeatCheckOptions {
  /**
   * Invitation id to EXCLUDE from the pending count — used by the accept flow so the invite
   * being accepted isn't counted as both a pending seat and the active seat it becomes
   * (off-by-one). See {@link getPendingInvitationCount}.
   */
  excludeInvitationId?: string
}

/**
 * Whether another seat can be added to the venue right now. Cap usage =
 * active seats + outstanding (pending) invitations.
 *   - `cap === null` → unlimited → always allowed.
 *   - otherwise allowed only while `current < cap` (current = active + pending).
 *
 * Returns the breakdown so callers can surface it.
 */
export async function canAddSeat(
  venueId: string,
  opts: SeatCheckOptions = {},
): Promise<{ allowed: boolean; cap: number | null; current: number; active: number; pending: number }> {
  const cap = await getVenueSeatCap(venueId)
  const [active, pending] = await Promise.all([
    getActiveSeatCount(venueId),
    getPendingInvitationCount(venueId, { excludeInvitationId: opts.excludeInvitationId }),
  ])
  const current = active + pending
  if (cap === null) {
    // Unlimited: always allowed (but still report the breakdown for callers that want it).
    return { allowed: true, cap: null, current, active, pending }
  }
  return { allowed: current < cap, cap, current, active, pending }
}

/**
 * Throws a 403 {@link ForbiddenError} (code {@link SEAT_CAP_REACHED_CODE}) when the venue
 * is at/over its Free-tier seat cap, counting active seats AND outstanding (pending)
 * invitations. No-op for exempt / paid (unlimited) venues, and for Free venues still under
 * the cap. Call this BEFORE creating a new StaffVenue OR a new Invitation for the venue.
 *
 * Pass `excludeInvitationId` from the accept flow so the invite being accepted is not counted
 * as both a pending seat and the active seat it becomes (off-by-one guard).
 *
 * The message is user-facing Spanish (it surfaces raw to the dashboard).
 */
export async function assertCanAddSeat(venueId: string, opts: SeatCheckOptions = {}): Promise<void> {
  const { allowed, cap } = await canAddSeat(venueId, opts)
  if (allowed) return
  throw new ForbiddenError(
    `Llegaste al límite de ${cap} usuarios del plan Gratis (incluye invitaciones pendientes). ` +
      `Mejora a Pro para agregar usuarios ilimitados.`,
    SEAT_CAP_REACHED_CODE,
  )
}
