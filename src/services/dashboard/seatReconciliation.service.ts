/**
 * Seat Reconciliation Service — Pro→Free DOWNGRADE "choose who stays".
 *
 * Product rules (decided):
 *   - "Downgrade to Free" = cancel the paid base plan at PERIOD END (reusing the existing
 *     cancel-at-period-end mechanism in planState.service). The venue keeps Pro — all users
 *     active — until the paid period ends, THEN drops to Free.
 *   - The Free tier allows at most {@link FREE_TIER_SEAT_CAP} ACTIVE non-SUPERADMIN users per
 *     venue, and the OWNER is ALWAYS kept. If the venue has more than the cap at downgrade
 *     time, the owner picks which ≤ cap stay. That selection is captured NOW (persisted on
 *     Venue.pendingSeatReconciliation) but EXECUTED at period end: when the subscription
 *     actually ends, every non-selected StaffVenue is DEACTIVATED (active=false, endDate=now),
 *     never deleted — so it stays reactivatable.
 *   - Whoever still doesn't fit when the plan ends (people added after choosing, a plain cancel
 *     with no selection, an ownership change) is deactivated automatically — Shopify's model
 *     (founder, 2026-09-27): pending invitations first, then the users inactive the longest.
 *   - If the owner REACTIVATES the plan before period end, the pending reconciliation is
 *     cleared (nobody gets deactivated).
 *   - SUPERADMIN seats never count toward the cap and are never deactivated.
 *
 * This module owns the selection (preview / schedule / execute / clear). Hooking execution to
 * the actual paid→Free transition lives in the Stripe webhook (handleSubscriptionUpdated
 * 'canceled'/'unpaid' and handleSubscriptionDeleted); clearing on undo lives in
 * planState.reactivatePlan.
 */

import { InvitationStatus, StaffRole, type Prisma } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { BadRequestError } from '../../errors/AppError'
import { FREE_TIER_SEAT_CAP, getVenueSeatCap, getActiveSeatCount, getPendingInvitationCount } from '@/services/access/seatCap.service'
import { GRANDFATHER_SELECT, resolveGrandfathered } from '@/services/access/grandfather'
import { cancelPlan, type CancelPlanInput, type PlanState } from './planState.service'
import { writeLegacyActivityAuditTx } from '../activityAudit.service'
import { retrievePlanSubscription } from '../stripe.service'

/** Persisted shape of Venue.pendingSeatReconciliation. */
export interface PendingSeatReconciliation {
  /** StaffVenue ids the owner chose to keep ACTIVE on Free (OWNER always included). */
  keepStaffVenueIds: string[]
  /** ISO period end the cancellation lands on — when execution is expected to run. */
  scheduledFor: string
  /** ISO timestamp the selection was captured. */
  createdAt: string
}

/** One row in the downgrade preview: a member the owner may keep or drop. */
export interface DowngradePreviewStaff {
  staffVenueId: string
  staffId: string
  name: string
  email: string
  role: StaffRole
  isOwner: boolean
  /** Staff.lastLoginAt (proxy for "last active") — ISO, or null if never logged in. */
  lastActiveAt: string | null
}

export interface DowngradePreview {
  /** True when the venue has MORE active (cap-counting) seats than the Free cap allows. */
  required: boolean
  /** The Free-tier cap that will apply ({@link FREE_TIER_SEAT_CAP}). */
  cap: number
  /** How many cap-counting (active, non-SUPERADMIN) seats the venue has right now. */
  currentActive: number
  /** Max seats the owner may keep = the cap. */
  keepMax: number
  /** The cap-counting roster the owner picks from (OWNER row marked isOwner). */
  staff: DowngradePreviewStaff[]
}

/** The Free-tier cap a downgrade reconciles against (always {@link FREE_TIER_SEAT_CAP}). */
const DOWNGRADE_CAP = FREE_TIER_SEAT_CAP

/**
 * Find the venue's OWNER StaffVenue (active, non-SUPERADMIN). The OWNER is always kept on a
 * downgrade. Returns null if the venue has no OWNER StaffVenue (defensive — shouldn't happen).
 */
async function findOwnerStaffVenue(venueId: string): Promise<{ id: string; staffId: string } | null> {
  const owner = await prisma.staffVenue.findFirst({
    where: { venueId, active: true, role: StaffRole.OWNER },
    select: { id: true, staffId: true },
    orderBy: { startDate: 'asc' }, // deterministic if (improbably) more than one OWNER row
  })
  return owner ? { id: owner.id, staffId: owner.staffId } : null
}

/** All ACTIVE, non-SUPERADMIN StaffVenue rows for the venue — the seats that count against the cap. */
async function getCapCountingStaffVenues(venueId: string, db: Pick<Prisma.TransactionClient, 'staffVenue'> = prisma) {
  return db.staffVenue.findMany({
    where: { venueId, active: true, role: { not: StaffRole.SUPERADMIN } },
    select: {
      id: true,
      staffId: true,
      role: true,
      staff: { select: { firstName: true, lastName: true, email: true, lastLoginAt: true } },
    },
    orderBy: [{ role: 'asc' }, { startDate: 'asc' }],
  })
}

/**
 * Preview the Pro→Free downgrade for a venue: whether a "choose who stays" selection is
 * required, the Free cap, the current active-seat count, and the roster the owner picks from
 * (OWNER row flagged). `required` is true only when currentActive > cap.
 */
export async function getDowngradePreview(venueId: string): Promise<DowngradePreview> {
  const [rows, owner, currentActive] = await Promise.all([
    getCapCountingStaffVenues(venueId),
    findOwnerStaffVenue(venueId),
    getActiveSeatCount(venueId),
  ])

  const ownerStaffVenueId = owner?.id ?? null
  const staff: DowngradePreviewStaff[] = rows.map(r => ({
    staffVenueId: r.id,
    staffId: r.staffId,
    name: `${r.staff.firstName} ${r.staff.lastName}`.trim(),
    email: r.staff.email,
    role: r.role,
    isOwner: r.id === ownerStaffVenueId,
    lastActiveAt: r.staff.lastLoginAt ? r.staff.lastLoginAt.toISOString() : null,
  }))

  return {
    required: currentActive > DOWNGRADE_CAP,
    cap: DOWNGRADE_CAP,
    currentActive,
    keepMax: DOWNGRADE_CAP,
    staff,
  }
}

/** Why this "who stays" selection can't be used on Free, or null when it can. Messages surface raw to the owner. */
function keepSelectionError(keep: string[], validIds: Set<string>, ownerId: string | null): string | null {
  if (keep.length > DOWNGRADE_CAP) return `Solo puedes conservar ${DOWNGRADE_CAP} usuarios en el plan Gratis.`
  if (keep.some(id => !validIds.has(id))) return 'Uno de los usuarios seleccionados no pertenece a este venue o no está activo.'
  if (!ownerId) return 'Este venue no tiene un propietario activo. Contacta a soporte.'
  if (!keep.includes(ownerId)) return 'El propietario debe conservar su acceso. Inclúyelo en la selección.'
  return null
}

/** Checks a "who stays" choice against the venue's current team (the hybrid checkout carries one, spec §4.1). */
export async function assertKeepSelection(venueId: string, keepStaffVenueIds: string[]): Promise<void> {
  const keep = Array.from(new Set(keepStaffVenueIds))
  const [rows, owner] = await Promise.all([getCapCountingStaffVenues(venueId), findOwnerStaffVenue(venueId)])
  const error = keepSelectionError(keep, new Set(rows.map(r => r.id)), owner?.id ?? null)
  if (error) throw new BadRequestError(error)
}

/**
 * Schedule a Pro→Free downgrade for a venue, capturing the "choose who stays" selection.
 *
 *   1. Validates the selection: every id is an ACTIVE non-SUPERADMIN StaffVenue of THIS venue;
 *      the OWNER's StaffVenue MUST be included; at most {@link FREE_TIER_SEAT_CAP} ids. If the
 *      venue is already at/under the cap (currentActive <= cap) no selection is needed — an
 *      empty list is allowed (skip).
 *   2. Schedules the drop to Free at period end via {@link cancelPlan} (cancel-at-period-end).
 *   3. Persists the selection on Venue.pendingSeatReconciliation with the Stripe period end.
 *
 * Returns the fresh PlanState (same envelope as cancel/reactivate).
 *
 * input carries the owner's cancellation reason and the actor; both reach Stripe and ActivityLog through cancelPlan.
 *
 * All validation messages are user-facing Spanish (they surface raw to the dashboard).
 */
export async function scheduleDowngradeToFree(
  venueId: string,
  keepStaffVenueIds: string[],
  input: CancelPlanInput = {},
): Promise<PlanState> {
  const keep = Array.from(new Set(keepStaffVenueIds ?? [])) // de-dupe defensively

  const [rows, owner, currentActive] = await Promise.all([
    getCapCountingStaffVenues(venueId),
    findOwnerStaffVenue(venueId),
    getActiveSeatCount(venueId),
  ])
  const validIds = new Set(rows.map(r => r.id))
  const selectionNeeded = currentActive > DOWNGRADE_CAP

  if (selectionNeeded) {
    // A real selection is required when over the cap (clearest message first).
    if (keep.length === 0) {
      throw new BadRequestError(`Debes elegir hasta ${DOWNGRADE_CAP} usuarios que conservarán su acceso.`)
    }
    const error = keepSelectionError(keep, validIds, owner?.id ?? null)
    if (error) throw new BadRequestError(error)
  }

  // Schedule the drop to Free at period end (cancel-at-period-end). This also validates the
  // base plan + Stripe subscription exist and throws a Spanish BadRequestError if not.
  const planState = await cancelPlan(venueId, input)

  // Resolve the period end the reconciliation will execute on. Prefer the just-refreshed
  // PlanState.currentPeriodEnd; fall back to a direct Stripe read; never let this block the
  // schedule (the webhook executes on the real transition regardless of this stored date).
  let scheduledFor = planState.currentPeriodEnd
  if (!scheduledFor && planState.stripeSubscriptionId) {
    try {
      const sub = await retrievePlanSubscription(planState.stripeSubscriptionId)
      scheduledFor = sub.currentPeriodEnd ? sub.currentPeriodEnd.toISOString() : null
    } catch (error) {
      logger.warn('scheduleDowngradeToFree: could not resolve period end from Stripe; persisting without it', {
        venueId,
        error: error instanceof Error ? error.message : 'Unknown error',
      })
    }
  }

  const pending: PendingSeatReconciliation = {
    keepStaffVenueIds: selectionNeeded ? keep : [],
    scheduledFor: scheduledFor ?? '',
    createdAt: new Date().toISOString(),
  }

  await prisma.venue.update({
    where: { id: venueId },
    data: { pendingSeatReconciliation: pending as unknown as object },
  })

  logger.info('🪑 Downgrade scheduled: pending seat reconciliation captured', {
    venueId,
    selectionNeeded,
    keepCount: pending.keepStaffVenueIds.length,
    currentActive,
    cap: DOWNGRADE_CAP,
    scheduledFor: pending.scheduledFor || null,
  })

  return planState
}

/**
 * Enforce the Free seat cap when the paid plan ACTUALLY ends (Stripe canceled/unpaid/deleted), whichever way it ended:
 * a downgrade with a "who stays" selection, a downgrade with nothing to choose, or a plain cancel.
 *
 * Rule (founder, 2026-09-27 — Shopify's model): whoever doesn't fit is deactivated automatically, in a fixed order.
 *   1. The owner's explicit selection goes first: anyone outside it is deactivated.
 *   2. The OWNER always stays (ownership can move after choosing; a locked-out owner can't even re-upgrade).
 *      SUPERADMIN never counts.
 *   3. Pending invitations lose their seat first (most recent first), then the users inactive the longest
 *      (never logged in first).
 * Deactivated = active:false + deactivatedBySeatCap, so a re-upgrade brings exactly them back. Nothing is deleted.
 * A venue that is still unlimited (another paid plan, or grandfathered) is left alone, pending selection included.
 * All writes and the audit row go in one transaction; a failure propagates (the webhook event stays FAILED and the
 * cron replays it). Idempotent: a second run finds the team within the cap and changes nothing.
 *
 * options.keepStaffVenueIds — an explicit "who stays" choice (a hybrid purchase carries one) that wins over the pending selection.
 *
 * @returns the number of seats deactivated.
 */
export async function executeSeatReconciliation(venueId: string, options: { keepStaffVenueIds?: string[] } = {}): Promise<number> {
  // Still unlimited (another paid plan covers it, or grandfathered): nothing to enforce. The pending selection is left
  // alone: a late webhook of an OLDER subscription must not wipe the owner's choice for a later downgrade.
  const cap = await getVenueSeatCap(venueId)
  if (cap === null) return 0

  // All or nothing, audit row included: separate writes used to leave people deactivated with no audit row, and the
  // retry then had nothing left to record. A failure propagates, so the webhook event stays FAILED and the cron replays it.
  const outcome = await prisma.$transaction(async tx => {
    // Lock the venue's pending invitations FIRST, before reading the team: a concurrent accept either committed before
    // this point (its new seat shows up in the read below) or waits for this transaction and then finds its invitation
    // no longer PENDING. Reading the team first let an accept slip in between, uncounted (Codex, 28-sep).
    await tx.$queryRaw`SELECT "id" FROM "Invitation" WHERE "venueId" = ${venueId} AND "status" = 'PENDING' FOR UPDATE`

    const venue = await tx.venue.findUnique({ where: { id: venueId }, select: { pendingSeatReconciliation: true } })
    const pending = venue?.pendingSeatReconciliation as PendingSeatReconciliation | null | undefined
    const rows = await getCapCountingStaffVenues(venueId, tx)
    // An explicit choice (the one a hybrid checkout carried) wins over the pending one; empty means "none given".
    const keep = options.keepStaffVenueIds?.length
      ? options.keepStaffVenueIds
      : Array.isArray(pending?.keepStaffVenueIds)
        ? pending.keepStaffVenueIds
        : []
    const owners = rows.filter(r => r.role === StaffRole.OWNER)
    const others = rows.filter(r => r.role !== StaffRole.OWNER)
    const outsideSelection = keep.length > 0 ? others.filter(r => !keep.includes(r.id)) : []
    const candidates = keep.length > 0 ? others.filter(r => keep.includes(r.id)) : others
    // Most recently active first, never-logged-in last; the id breaks ties so the outcome never depends on row order.
    const lastSeen = (r: (typeof rows)[number]) => r.staff.lastLoginAt?.getTime() ?? -Infinity
    const ranked = [...candidates].sort((a, b) => lastSeen(b) - lastSeen(a) || a.id.localeCompare(b.id))
    const room = Math.max(0, cap - owners.length)
    const toDeactivate = [...outsideSelection, ...ranked.slice(room)].map(r => r.id)

    let deactivated = 0
    if (toDeactivate.length > 0) {
      const result = await tx.staffVenue.updateMany({
        where: { venueId, active: true, id: { in: toDeactivate }, role: { notIn: [StaffRole.SUPERADMIN, StaffRole.OWNER] } },
        // Mark these rows as "the seat cap turned this off" so a later RE-UPGRADE to Pro/Premium
        // can auto-reactivate EXACTLY them (reactivateSeatCapDeactivated) — never people who were
        // fired/quit (those rows keep deactivatedBySeatCap=false).
        // DELIBERATE: pin is KEPT here (every baja path clears it instead) — these people
        // didn't leave; on re-upgrade they come back and must keep their TPV PIN. If the
        // venue reassigns the PIN meanwhile, the grant path frees it from this inactive row.
        // (Allowlisted in tests/unit/services/staffvenue-baja-libera-pin.test.ts.)
        data: { active: false, endDate: new Date(), deactivatedBySeatCap: true },
      })
      deactivated = result.count
    }

    // Pending invitations lose their seat first: the oldest keep whatever room the active team left, the rest are revoked.
    const seatsLeft = room - Math.min(room, ranked.length)
    const pendingInvites = {
      venueId,
      status: InvitationStatus.PENDING,
      expiresAt: { gt: new Date() },
      role: { not: StaffRole.SUPERADMIN },
    }
    const stillFit =
      seatsLeft > 0
        ? await tx.invitation.findMany({
            where: pendingInvites,
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            take: seatsLeft,
            select: { id: true },
          })
        : []
    const revoked = await tx.invitation.updateMany({
      where: stillFit.length > 0 ? { ...pendingInvites, id: { notIn: stillFit.map(i => i.id) } } : pendingInvites,
      data: { status: InvitationStatus.REVOKED },
    })

    // Cleared once handled, so a re-delivered webhook (or a manual re-run) is a safe no-op.
    if (pending) await tx.venue.update({ where: { id: venueId }, data: { pendingSeatReconciliation: null as unknown as object } })

    if (deactivated > 0 || revoked.count > 0) {
      await writeLegacyActivityAuditTx(tx, {
        venueId,
        action: 'SEAT_CAP_ENFORCED',
        entity: 'Venue',
        entityId: venueId,
        data: { cap, deactivatedStaffVenueIds: toDeactivate, revokedInvitations: revoked.count, explicitSelection: keep.length > 0 },
      })
    }
    return { deactivated, revokedInvitations: revoked.count, explicitSelection: keep.length > 0 }
  })

  if (outcome.deactivated > 0 || outcome.revokedInvitations > 0) {
    logger.info('🪑 Free seat cap enforced on the paid→Free transition', { venueId, cap, ...outcome })
  }

  return outcome.deactivated
}

/**
 * RE-UPGRADE auto-reactivation (Pro/Premium): reactivate every StaffVenue this venue's Free-tier
 * seat cap previously deactivated (deactivatedBySeatCap = true). Paid tiers are unlimited, so ALL
 * cap-deactivated seats come back: set active=true, endDate=null, and clear the flag.
 *
 * Only touches rows the CAP turned off — people who were fired/quit (deactivatedBySeatCap=false)
 * are never reactivated. Idempotent: no matching rows → returns 0, no-op. Safe to re-run (the
 * flag is cleared on success, so a second call matches nothing). Called when a base-plan
 * subscription becomes active again (Stripe webhook).
 *
 * @returns the number of seats reactivated.
 */
export async function reactivateSeatCapDeactivated(venueId: string): Promise<number> {
  const result = await prisma.staffVenue.updateMany({
    where: { venueId, deactivatedBySeatCap: true },
    data: { active: true, endDate: null, deactivatedBySeatCap: false },
  })

  if (result.count > 0) {
    logger.info('🪑 Seat-cap-deactivated seats reactivated on re-upgrade to paid plan', {
      venueId,
      reactivated: result.count,
    })
  }

  return result.count
}

/**
 * Cancel a pending seat reconciliation (used when the owner REACTIVATES the plan before period
 * end — nobody should be deactivated). Idempotent: a no-pending venue is a no-op.
 *
 * @returns true if a pending reconciliation was cleared, false if there was none.
 */
export async function clearPendingReconciliation(venueId: string): Promise<boolean> {
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    select: { pendingSeatReconciliation: true },
  })
  if (!venue?.pendingSeatReconciliation) return false

  await prisma.venue.update({
    where: { id: venueId },
    data: { pendingSeatReconciliation: null as unknown as object },
  })

  logger.info('🪑 Pending seat reconciliation cleared (downgrade undone)', { venueId })
  return true
}

/**
 * Read-only helper for the MCP seat-status tool + the dashboard's plan/seat-status endpoint:
 * the venue's cap, its usage breakdown, whether one more seat can be added, and the exempt flag.
 *
 * Cap usage `current = active + pending`, where `pending` = outstanding (PENDING, not-yet-expired)
 * invitations that each reserve a seat. The legacy fields (`cap` / `current` / `allowed` / `exempt`)
 * are unchanged in meaning except that `current` now includes pending invites; `active` / `pending`
 * are additive so existing callers keep working.
 */
export async function getVenueSeatStatus(venueId: string): Promise<{
  cap: number | null
  active: number
  pending: number
  current: number
  allowed: boolean
  exempt: boolean
}> {
  const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { ...GRANDFATHER_SELECT } })
  // Exempt by the venue's own flag OR its organization's — same resolver the cap itself uses,
  // so this status can never disagree with the gate it is reporting on.
  const exempt = resolveGrandfathered(venue)
  const [cap, active, pending] = await Promise.all([
    getVenueSeatCap(venueId),
    getActiveSeatCount(venueId),
    getPendingInvitationCount(venueId),
  ])
  const current = active + pending
  // Unlimited (cap null) is always allowed; otherwise allowed only while current < cap.
  const allowed = cap === null ? true : current < cap
  return { cap, active, pending, current, allowed, exempt }
}

export default {
  getDowngradePreview,
  scheduleDowngradeToFree,
  executeSeatReconciliation,
  reactivateSeatCapDeactivated,
  clearPendingReconciliation,
  getVenueSeatStatus,
  assertKeepSelection,
}
