import prisma from '@/utils/prismaClient'
import { ReferralRewardGrant } from '@prisma/client'
import { computeTier } from './referralQualification.service'

/**
 * Has the referrer already redeemed their tier reward on a real order?
 * We check via the CouponCode relation rather than CustomerDiscount
 * usage counters because CouponRedemption is the authoritative record
 * (one row per actual checkout) — counters can drift if the API layer
 * forgets to increment them.
 */
export async function isRewardRedeemed(discountId: string): Promise<boolean> {
  const redemption = await prisma.couponRedemption.findFirst({
    where: { couponCode: { discountId } },
  })
  return redemption !== null
}

/**
 * Soft-deactivate all three rows of a tier reward bundle in one
 * transaction. We use `active: false` rather than DELETE so the
 * historical record survives for analytics + dispute resolution.
 *
 * Only Discount carries the deactivation reason + timestamp; the
 * child rows just flip `active` to false because they inherit context
 * from the parent.
 */
export async function revokeTierReward(discountId: string, reason: string): Promise<void> {
  await prisma.$transaction(async tx => {
    await tx.discount.update({
      where: { id: discountId },
      data: {
        active: false,
        deactivatedReason: reason,
        deactivatedAt: new Date(),
      },
    })
    await tx.couponCode.updateMany({
      where: { discountId },
      data: { active: false },
    })
    await tx.customerDiscount.updateMany({
      where: { discountId },
      data: { active: false },
    })
  })
}

export interface OnOrderRefundedInput {
  orderId: string
  venueId: string
}

/**
 * Revoke a single `PERCENT_COUPON` grant per spec §6:
 *   - `status !== 'ISSUED'` (already REVOKED, or REDEEMED) → no-op, leave it.
 *   - `status === 'ISSUED'` and a CouponRedemption already exists (state
 *     drift — the coupon WAS used but nothing corrected the grant) →
 *     self-heal to REDEEMED. Do NOT touch the Discount/CouponCode; the
 *     customer keeps what they used.
 *   - `status === 'ISSUED'` and unredeemed → deactivate Discount +
 *     CouponCode (+ CustomerDiscount), grant → REVOKED.
 * Returns the grant id if it was REVOKED (for the ActivityLog summary).
 */
async function revokePercentCouponGrant(grant: ReferralRewardGrant, reason: string): Promise<string | null> {
  if (grant.status !== 'ISSUED') return null

  const redeemed = grant.discountId ? await isRewardRedeemed(grant.discountId) : false
  if (redeemed) {
    // Grant fell out of sync with reality (redeemed but never marked) —
    // keep the state truthful without clawing back an already-used reward.
    await prisma.referralRewardGrant.update({
      where: { id: grant.id },
      data: { status: 'REDEEMED' },
    })
    return null
  }

  if (grant.discountId) {
    await revokeTierReward(grant.discountId, reason)
  }
  await prisma.referralRewardGrant.update({
    where: { id: grant.id },
    data: { status: 'REVOKED', revokedAt: new Date(), revokeReason: reason },
  })
  return grant.id
}

/**
 * Revoke a single `PERMANENT_DISCOUNT` grant per spec §6. Usage is decided
 * via `OrderDiscount` — NOT `CouponRedemption` (a permanent discount has no
 * coupon to redeem, it just auto-applies on every order):
 *   - `status !== 'ISSUED'` → no-op.
 *   - Never applied (no `OrderDiscount` row references this Discount) →
 *     deactivate Discount + CustomerDiscount, grant → REVOKED.
 *   - Already applied at least once → STILL deactivate going forward (no
 *     retroactive clawback of the historical `OrderDiscount` rows) AND the
 *     grant → REVOKED with a reason documenting why — it must NEVER stay
 *     ISSUED (that would be a lie: the reward is gone, applied or not).
 */
async function revokePermanentDiscountGrant(grant: ReferralRewardGrant, reason: string): Promise<string | null> {
  if (grant.status !== 'ISSUED') return null

  const applied = grant.discountId ? await prisma.orderDiscount.findFirst({ where: { discountId: grant.discountId } }) : null
  const revokeReason = applied ? 'permanente ya consumido, desactivado sin clawback' : reason

  if (grant.discountId) {
    await revokeTierReward(grant.discountId, revokeReason)
  }
  await prisma.referralRewardGrant.update({
    where: { id: grant.id },
    data: { status: 'REVOKED', revokedAt: new Date(), revokeReason },
  })
  return grant.id
}

/**
 * Revoke a single `FREE_PRODUCT` grant per spec §6:
 *   - `MANUAL_PENDING` (staff hasn't handed it over yet) → REVOKED.
 *   - `MANUAL_FULFILLED` (already handed over) → left alone, nothing to
 *     claw back from a physical product already given.
 */
async function revokeFreeProductGrant(grant: ReferralRewardGrant, reason: string): Promise<string | null> {
  if (grant.status !== 'MANUAL_PENDING') return null

  await prisma.referralRewardGrant.update({
    where: { id: grant.id },
    data: { status: 'REVOKED', revokedAt: new Date(), revokeReason: reason },
  })
  return grant.id
}

/**
 * Event handler called from the refund / cancellation webhook. Reverses
 * the qualification side effects:
 *
 *   1. Find the QUALIFIED Referral attached to this order; if none,
 *      no-op (idempotent).
 *   2. Flip it to VOID with reason `ORDER_REFUNDED`.
 *   3. Decrement the referrer's `referralCount`.
 *   4. Re-derive their tier. If it did NOT drop, stop — no grant is
 *      touched (referralTier is a live projection of referralCount, per
 *      Task 5's design: if other referrals still support the tier, the
 *      rewards this one triggered stay untouched).
 *   5. If it DID drop, load every `ReferralRewardGrant` this referral's
 *      tier-crossing emitted (`referralId: referral.id`) and revoke each
 *      per its own `rewardType` + `status` (spec §6 table):
 *        - PERCENT_COUPON     → `revokePercentCouponGrant`
 *        - PERMANENT_DISCOUNT → `revokePermanentDiscountGrant`
 *        - FREE_PRODUCT       → `revokeFreeProductGrant`
 *      `ReferralTierUnlock` is NEVER deleted here (D11: a tier is earned
 *      once per lifetime — refund revokes the grants, not the unlock, so
 *      re-crossing the threshold later does not re-mint the reward).
 *   6. Persist the new (possibly null) tier on Customer.
 *   7. Always emit a `REFERRAL_TIER_REVERSED` ActivityLog with old + new
 *      tier + the list of revoked grant ids so finance can reconcile.
 */
export async function onOrderRefunded(input: OnOrderRefundedInput): Promise<void> {
  const referral = await prisma.referral.findFirst({
    where: { qualifyingOrderId: input.orderId, status: 'QUALIFIED' },
  })
  if (!referral) return

  await prisma.referral.update({
    where: { id: referral.id },
    data: { status: 'VOID', voidedAt: new Date(), voidReason: 'ORDER_REFUNDED' },
  })

  const referrer = await prisma.customer.update({
    where: { id: referral.referrerCustomerId },
    data: { referralCount: { decrement: 1 } },
  })

  const config = await prisma.referralProgramConfig.findUnique({
    where: { venueId: input.venueId },
  })
  if (!config) return

  const newTier = computeTier(referrer.referralCount, config)
  if (newTier === referrer.referralTier) return

  // Tier dropped — revoke every grant this referral's tier-crossing
  // emitted, each per its own type/status (spec §6).
  const grants = await prisma.referralRewardGrant.findMany({
    where: { referralId: referral.id },
  })

  const revokedGrantIds: string[] = []
  for (const grant of grants) {
    let revokedId: string | null = null
    if (grant.rewardType === 'PERCENT_COUPON') {
      revokedId = await revokePercentCouponGrant(grant, 'TIER_REVERSED_BY_REFUND')
    } else if (grant.rewardType === 'PERMANENT_DISCOUNT') {
      revokedId = await revokePermanentDiscountGrant(grant, 'TIER_REVERSED_BY_REFUND')
    } else if (grant.rewardType === 'FREE_PRODUCT') {
      revokedId = await revokeFreeProductGrant(grant, 'TIER_REVERSED_BY_REFUND')
    }
    if (revokedId) revokedGrantIds.push(revokedId)
  }

  await prisma.customer.update({
    where: { id: referrer.id },
    data: {
      referralTier: newTier,
      tierUnlockedAt: newTier ? referrer.tierUnlockedAt : null,
    },
  })

  await prisma.activityLog.create({
    data: {
      venueId: input.venueId,
      action: 'REFERRAL_TIER_REVERSED',
      entity: 'Customer',
      entityId: referrer.id,
      data: {
        previousTier: referrer.referralTier,
        newTier,
        triggeringReferralId: referral.id,
        refundedOrderId: input.orderId,
        revokedGrantIds,
      },
    },
  })
}
