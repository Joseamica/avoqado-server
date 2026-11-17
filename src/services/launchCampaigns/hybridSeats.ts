import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { getVenueSeatCap } from '@/services/access/seatCap.service'
import { PAID_PLAN_TIER_CODES } from '@/services/access/basePlan.service'
import {
  clearPendingReconciliation,
  executeSeatReconciliation,
  reactivateSeatCapDeactivated,
  reactivateSeatCapDeactivatedUpTo,
} from '@/services/dashboard/seatReconciliation.service'
import { retry, shouldRetryDbConnectionError } from '@/utils/retry'
import { hybridHash } from './hybridProvider'
import { activeBasicSeatCaps, BASIC_PLAN_DEFINITION_WHERE, isBasicPlanDefinition } from './basicPlanAccess'
import type { HybridQuoteSnapshot } from './hybridPurchase.service'

const SEATS_STEP = 'SEATS'

/**
 * The team after the FIRST paid invoice of a purchase, once (spec §4.3). A paid plan brings back whoever the Free cap
 * turned off; the pending selection is dropped only when this purchase replaced the classic plan it was scheduled on (a
 * functions-only purchase must not erase the owner's choice for that plan's downgrade). A replacement that leaves the
 * venue on Free applies the cap with the choice made at checkout. The SEATS row makes a replayed delivery skip this, so
 * that choice can never deactivate someone added later. A failure leaves no row: the next replay retries.
 */
export async function settleSeatsAfterHybridDelivery(
  venueId: string,
  purchaseId: string,
  quote: Pick<HybridQuoteSnapshot, 'replaces' | 'input'>,
): Promise<void> {
  const done = await prisma.hybridBillingOperation.findUnique({
    where: { purchaseId_step: { purchaseId, step: SEATS_STEP } },
    select: { resultHash: true },
  })
  if (done?.resultHash) return
  const cap = await getVenueSeatCap(venueId)
  let outcome: Record<string, number | boolean>
  if (cap === null) {
    const replacedClassicPlan =
      quote.replaces.length > 0 &&
      !!(await prisma.venueFeature.findFirst({
        where: { venueId, stripeSubscriptionId: { in: quote.replaces }, feature: { code: { in: [...PAID_PLAN_TIER_CODES] } } },
        select: { id: true },
      }))
    outcome = {
      reactivated: await reactivateSeatCapDeactivated(venueId),
      pendingCleared: replacedClassicPlan ? await clearPendingReconciliation(venueId) : false,
    }
  } else if (quote.replaces.length) {
    outcome = { deactivated: await executeSeatReconciliation(venueId, { keepStaffVenueIds: quote.input?.keepStaffVenueIds }) }
  } else {
    outcome = { unchanged: true }
  }
  const request = { cap, replaced: quote.replaces.length }
  await prisma.hybridBillingOperation.upsert({
    where: { purchaseId_step: { purchaseId, step: SEATS_STEP } },
    create: {
      purchaseId,
      step: SEATS_STEP,
      request,
      requestHash: hybridHash(request),
      status: 'OBSERVED',
      resultHash: hybridHash(outcome),
    },
    update: { status: 'OBSERVED', resultHash: hybridHash(outcome) },
  })
  logger.info('🪑 Hybrid delivery settled the team', { venueId, purchaseId, cap, ...outcome })
}

/**
 * The «who stays» choice from checkout, only while this purchase has not settled its team (no SEATS row). Once settled
 * it is stale: the owner may have changed the team since, and an explicit list is applied even when the team fits.
 */
export async function unsettledCheckoutSeatChoice(
  purchaseId: string,
  quote: Pick<HybridQuoteSnapshot, 'input'>,
): Promise<string[] | undefined> {
  const done = await prisma.hybridBillingOperation.findUnique({
    where: { purchaseId_step: { purchaseId, step: SEATS_STEP } },
    select: { resultHash: true },
  })
  return done?.resultHash ? undefined : quote.input?.keepStaffVenueIds
}

/**
 * A contract whose cancellation took effect ends at its paid boundary even while its subscription lives on for other
 * lines; nothing else marked it, so it looked live and the team was never settled. The cap runs FIRST: if it fails,
 * the contract stays open and the next sweep retries (spec §4.3).
 */
export async function endLapsedHybridContracts(venueId: string, purchaseId: string): Promise<number> {
  const now = new Date()
  const lapsed = await prisma.hybridContract.findMany({
    where: { purchaseId, venueId, endedAt: null, cancelAt: { lte: now } },
    select: { id: true, planTier: true, publication: { select: { definition: true } } },
    orderBy: { id: 'asc' },
    take: 9,
  })
  if (!lapsed.length) return 0
  if (lapsed.some(contract => contract.planTier || isBasicPlanDefinition(contract.publication.definition)))
    await executeSeatReconciliation(venueId)
  const contractIds = lapsed.map(contract => contract.id)
  await prisma.$transaction(async tx => {
    const ended = await tx.hybridContract.updateMany({ where: { id: { in: contractIds }, venueId, endedAt: null }, data: { endedAt: now } })
    if (ended.count)
      await tx.activityLog.create({
        data: {
          venueId,
          action: 'HYBRID_ACCESS_ENDED',
          entity: 'HybridPurchase',
          entityId: purchaseId,
          data: { contractIds, reason: 'RENEWAL_CANCELLED' },
        },
      })
  })
  return lapsed.length
}

/**
 * A paid Plan Básico period was delivered (every invoice, not only the first): the team follows its cap again. Checks
 * FIRST that a Básico grant covers now, so a replayed old invoice brings nobody back. The effective cap decides (a paid
 * plan or grandfathering above the Básico stays unlimited): unlimited → everyone the cap turned off comes back; finite →
 * trim to the cap if over it, then bring people back up to it. A pending downgrade selection is dropped first. All steps
 * are idempotent.
 *
 * @returns the number of seats reactivated.
 */
export async function restoreBasicSeats(venueId: string): Promise<number> {
  if (!(await activeBasicSeatCaps([venueId], new Date())).has(venueId)) return 0
  // The «who stays» choice of an earlier Pro→Free downgrade belongs to THAT downgrade, not to this paid Básico (final
  // review #4): a late Pro webhook must not apply it over the Básico's cap.
  await clearPendingReconciliation(venueId)
  const cap = await getVenueSeatCap(venueId)
  if (cap === null) return reactivateSeatCapDeactivated(venueId)
  await executeSeatReconciliation(venueId)
  return reactivateSeatCapDeactivatedUpTo(venueId, cap)
}

const LAPSE_WINDOW_MS = 7 * 24 * 3600 * 1000
const SWEEP_PAGE = 200
const SWEEP_MAX_PAGES = 10

/**
 * Daily: a Plan Básico whose last paid period ended without a renewal (past_due / unpaid) leaves its venue on Free's cap.
 * Reads venues with a Básico grant that ended in the last 7 days (so a few missed runs still catch them), pages of 200
 * by venueId, at most 10 pages per run; skips any venue a Básico still covers. Idempotent: the reconciliation changes
 * nothing once the team fits. A failing venue is logged and the rest go on.
 */
export async function sweepLapsedBasicSeats(now = new Date()): Promise<{ checked: number; reconciled: number; failed: number }> {
  const totals = { checked: 0, reconciled: 0, failed: 0 }
  let after: string | undefined
  for (let page = 0; page < SWEEP_MAX_PAGES; page++) {
    const rows = await retry(
      () =>
        prisma.capabilityGrant.groupBy({
          by: ['venueId'],
          where: {
            endsAt: { lte: now, gt: new Date(now.getTime() - LAPSE_WINDOW_MS) },
            contract: { publication: { definition: BASIC_PLAN_DEFINITION_WHERE } },
            ...(after ? { venueId: { gt: after } } : {}),
          },
          orderBy: { venueId: 'asc' },
          take: SWEEP_PAGE,
        }),
      { retries: 2, initialDelay: 1500, shouldRetry: shouldRetryDbConnectionError, context: 'basic-seat-sweep.groupBy' },
    )
    if (rows.length === 0) break
    const venueIds = rows.map(row => row.venueId)
    after = venueIds[venueIds.length - 1]
    totals.checked += venueIds.length
    const covered = await activeBasicSeatCaps(venueIds, now)
    for (const venueId of venueIds.filter(id => !covered.has(id))) {
      try {
        if ((await executeSeatReconciliation(venueId)) > 0) totals.reconciled += 1
      } catch (error) {
        totals.failed += 1
        logger.error('🪑 Lapsed Plan Básico: seat reconciliation failed', { venueId, error })
      }
    }
    if (rows.length < SWEEP_PAGE) break
  }
  if (totals.reconciled || totals.failed) logger.info('🪑 Lapsed Plan Básico seats swept', totals)
  return totals
}
