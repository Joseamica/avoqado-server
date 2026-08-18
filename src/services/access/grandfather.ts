/**
 * GRANDFATHERING — the single answer to "is this venue exempt from tier monetization?".
 *
 * The flag lives on TWO levels and both must be consulted:
 *   - `Venue.seatCapExempt`        — this specific venue was grandfathered.
 *   - `Organization.seatCapExempt` — the whole client is grandfathered, including every store
 *                                    it opens in the future.
 *
 * The org level exists because the per-venue flag cannot cover a store that does not exist yet.
 * The rollout migration backfilled every venue alive at the time; a legacy/white-label client's
 * later stores were each born on the Free tier, and the block only surfaced when someone tried
 * to invite the third employee — with the employee standing right there (PlayTelecom, 6 stores
 * opened over five weeks). Flagging the ORG makes every future store exempt at creation without
 * touching the seven separate code paths that create a venue.
 *
 * This module is deliberately PURE and dependency-free (no prisma, no config, no side effects)
 * so every gate can share it, and so a test that mocks a service module can never accidentally
 * strip the resolver out from under a caller.
 */

/**
 * Prisma `select` fragment for resolving the grandfather flag. ALWAYS spread this into the
 * select and pass the row to {@link resolveGrandfathered} instead of selecting `seatCapExempt`
 * by hand — a caller that reads only one of the two levels answers the question differently
 * from the rest of the platform, which is exactly the failure this pair exists to prevent.
 */
export const GRANDFATHER_SELECT = {
  seatCapExempt: true,
  organization: { select: { seatCapExempt: true } },
} as const

/** The venue shape {@link resolveGrandfathered} needs: own flag + the parent organization's. */
export interface GrandfatherSource {
  seatCapExempt?: boolean | null
  organization?: { seatCapExempt?: boolean | null } | null
}

/**
 * Whether a venue row is GRANDFATHERED: its OWN `Venue.seatCapExempt` is true, OR its
 * `Organization.seatCapExempt` is true.
 *
 * Tolerates a missing row and a missing organization (both → false). A grandfather check runs
 * inside gates that decide whether someone can work, so it must never throw.
 */
export function resolveGrandfathered(venue: GrandfatherSource | null | undefined): boolean {
  if (!venue) return false
  return venue.seatCapExempt === true || venue.organization?.seatCapExempt === true
}
