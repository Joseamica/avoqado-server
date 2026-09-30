import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { getVenueSeatCap } from '@/services/access/seatCap.service'
import { PAID_PLAN_TIER_CODES } from '@/services/access/basePlan.service'
import {
  clearPendingReconciliation,
  executeSeatReconciliation,
  reactivateSeatCapDeactivated,
} from '@/services/dashboard/seatReconciliation.service'
import { hybridHash } from './hybridProvider'
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
    select: { id: true, planTier: true },
    orderBy: { id: 'asc' },
    take: 9,
  })
  if (!lapsed.length) return 0
  if (lapsed.some(contract => contract.planTier)) await executeSeatReconciliation(venueId)
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
