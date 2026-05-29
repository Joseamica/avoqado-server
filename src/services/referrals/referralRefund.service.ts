import prisma from '@/utils/prismaClient'
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
 * Event handler called from the refund / cancellation webhook. Reverses
 * the qualification side effects, with one carefully scoped exception:
 *
 *   1. Find the QUALIFIED Referral attached to this order; if none,
 *      no-op (idempotent).
 *   2. Flip it to VOID with reason `ORDER_REFUNDED`.
 *   3. Decrement the referrer's `referralCount`.
 *   4. Re-derive their tier. If it dropped:
 *        a. If the previously-emitted reward is still UNREDEEMED, revoke
 *           the whole bundle (Discount + CouponCode + CustomerDiscount).
 *        b. If the referrer already cashed the reward in on a real order
 *           (CouponRedemption row exists), DO NOT revoke — the customer
 *           keeps what they earned and used. The tier drop is recorded
 *           in ActivityLog for audit, but the discount stays valid.
 *      Then persist the new (possibly null) tier on Customer.
 *   5. Always emit a `REFERRAL_TIER_REVERSED` ActivityLog with old + new
 *      tier so finance can reconcile.
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

  // Tier dropped — handle reward revocation
  if (referral.rewardDiscountId) {
    const redeemed = await isRewardRedeemed(referral.rewardDiscountId)
    if (!redeemed) {
      await revokeTierReward(referral.rewardDiscountId, 'TIER_REVERSED_BY_REFUND')
    }
    // If already redeemed: leave it. Customer keeps what they used.
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
      },
    },
  })
}
