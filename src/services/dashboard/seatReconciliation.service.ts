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
 *   - If the owner REACTIVATES the plan before period end, the pending reconciliation is
 *     cleared (nobody gets deactivated).
 *   - SUPERADMIN seats never count toward the cap and are never deactivated.
 *
 * This module owns the selection (preview / schedule / execute / clear). Hooking execution to
 * the actual paid→Free transition lives in the Stripe webhook (handleSubscriptionUpdated
 * 'canceled'/'unpaid' and handleSubscriptionDeleted); clearing on undo lives in
 * planState.reactivatePlan.
 */

import { StaffRole } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { BadRequestError } from '../../errors/AppError'
import { FREE_TIER_SEAT_CAP, getVenueSeatCap, getActiveSeatCount } from '@/services/access/seatCap.service'
import { cancelPlan, type PlanState } from './planState.service'
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
async function getCapCountingStaffVenues(venueId: string) {
  return prisma.staffVenue.findMany({
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
 * All validation messages are user-facing Spanish (they surface raw to the dashboard).
 */
export async function scheduleDowngradeToFree(venueId: string, keepStaffVenueIds: string[]): Promise<PlanState> {
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
    // Cap: can't keep more than the Free tier allows.
    if (keep.length > DOWNGRADE_CAP) {
      throw new BadRequestError(`Solo puedes conservar ${DOWNGRADE_CAP} usuarios en el plan Gratis.`)
    }
    // Every id must be an active, cap-counting StaffVenue of THIS venue.
    for (const id of keep) {
      if (!validIds.has(id)) {
        throw new BadRequestError('Uno de los usuarios seleccionados no pertenece a este venue o no está activo.')
      }
    }
    // The OWNER must always stay.
    if (!owner) {
      throw new BadRequestError('Este venue no tiene un propietario activo. Contacta a soporte.')
    }
    if (!keep.includes(owner.id)) {
      throw new BadRequestError('El propietario debe conservar su acceso. Inclúyelo en la selección.')
    }
  }

  // Schedule the drop to Free at period end (cancel-at-period-end). This also validates the
  // base plan + Stripe subscription exist and throws a Spanish BadRequestError if not.
  const planState = await cancelPlan(venueId)

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
 * Execute the pending seat reconciliation for a venue (called when the paid plan ACTUALLY
 * ends — Stripe canceled/deleted). For every ACTIVE non-SUPERADMIN StaffVenue NOT in
 * keepStaffVenueIds, set active=false + endDate=now; then clear pendingSeatReconciliation.
 *
 * Idempotent: a no-pending venue is a no-op, and once the field is cleared a second call does
 * nothing. SUPERADMIN seats are never touched. Logs how many seats were deactivated.
 *
 * @returns the number of seats deactivated.
 */
export async function executeSeatReconciliation(venueId: string): Promise<number> {
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    select: { pendingSeatReconciliation: true },
  })

  const pending = venue?.pendingSeatReconciliation as PendingSeatReconciliation | null | undefined
  if (!pending || !Array.isArray(pending.keepStaffVenueIds)) {
    // Nothing pending → idempotent no-op (already executed, or never scheduled, or empty skip).
    return 0
  }

  const keep = pending.keepStaffVenueIds
  const result = await prisma.staffVenue.updateMany({
    where: {
      venueId,
      active: true,
      role: { not: StaffRole.SUPERADMIN }, // never deactivate platform support
      id: { notIn: keep.length > 0 ? keep : ['__none__'] }, // notIn [] matches everything in Prisma — guard with a sentinel
    },
    // Mark these rows as "the seat cap turned this off" so a later RE-UPGRADE to Pro/Premium
    // can auto-reactivate EXACTLY them (reactivateSeatCapDeactivated) — never people who were
    // fired/quit (those rows keep deactivatedBySeatCap=false).
    data: { active: false, endDate: new Date(), deactivatedBySeatCap: true },
  })

  // Clear the field so a re-delivered webhook (or a manual re-run) is a safe no-op.
  await prisma.venue.update({
    where: { id: venueId },
    data: { pendingSeatReconciliation: null as unknown as object },
  })

  logger.info('🪑 Seat reconciliation executed: deactivated non-kept seats', {
    venueId,
    deactivated: result.count,
    kept: keep.length,
  })

  return result.count
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

/** Read-only helper for the MCP seat-status tool: the venue's cap, current count and exempt flag. */
export async function getVenueSeatStatus(venueId: string): Promise<{
  cap: number | null
  current: number
  allowed: boolean
  exempt: boolean
}> {
  const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { seatCapExempt: true } })
  const exempt = venue?.seatCapExempt ?? false
  const cap = await getVenueSeatCap(venueId)
  const current = await getActiveSeatCount(venueId)
  // Unlimited (cap null) is always allowed; otherwise allowed only while current < cap.
  const allowed = cap === null ? true : current < cap
  return { cap, current, allowed, exempt }
}

export default {
  getDowngradePreview,
  scheduleDowngradeToFree,
  executeSeatReconciliation,
  reactivateSeatCapDeactivated,
  clearPendingReconciliation,
  getVenueSeatStatus,
}
