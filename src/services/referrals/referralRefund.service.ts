import prisma from '@/utils/prismaClient'
import { Prisma, ReferralRewardGrant, ReferralTier } from '@prisma/client'
import { computeTier, tierToLevel } from './referralQualification.service'

type TxClient = Prisma.TransactionClient

/**
 * Has the referrer already redeemed their tier reward on a real order?
 * We check via the CouponCode relation rather than CustomerDiscount
 * usage counters because CouponRedemption is the authoritative record
 * (one row per actual checkout) — counters can drift if the API layer
 * forgets to increment them.
 *
 * Accepts an optional `tx` so callers inside `onOrderRefunded`'s
 * transaction can read through the SAME transaction client (default is
 * the top-level `prisma` for any standalone caller).
 */
export async function isRewardRedeemed(discountId: string, tx: TxClient | typeof prisma = prisma): Promise<boolean> {
  const redemption = await tx.couponRedemption.findFirst({
    where: { couponCode: { discountId } },
  })
  return redemption !== null
}

/**
 * Soft-deactivate all three rows of a tier reward bundle. We use
 * `active: false` rather than DELETE so the historical record survives
 * for analytics + dispute resolution.
 *
 * Only Discount carries the deactivation reason + timestamp; the child
 * rows just flip `active` to false because they inherit context from
 * the parent.
 *
 * Core logic runs against whatever `tx` it's given — callers that are
 * already inside a transaction (e.g. `onOrderRefunded`) MUST use this
 * directly so every write in the refund flow lands in ONE transaction.
 */
async function revokeTierRewardInTx(tx: TxClient, discountId: string, reason: string): Promise<void> {
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
}

/**
 * Standalone public wrapper — opens its own transaction. No caller
 * outside this file uses it today, but it stays exported (and tested
 * directly) for any future one-off caller that isn't already inside a
 * transaction. `onOrderRefunded` does NOT use this — it calls
 * `revokeTierRewardInTx` with its own `tx` so the whole refund flow
 * commits or rolls back together.
 */
export async function revokeTierReward(discountId: string, reason: string): Promise<void> {
  await prisma.$transaction(async tx => {
    await revokeTierRewardInTx(tx, discountId, reason)
  })
}

export interface OnOrderRefundedInput {
  orderId: string
  venueId: string
}

/**
 * `ReferralTier | null` → the plain Int level used to compare against
 * `ReferralRewardGrant.tierLevel`. `null` (no tier at all) is level 0,
 * so `{ tierLevel: { gt: 0 } }` correctly means "every grant, at any
 * level, must be revoked" when the referrer drops out of the program
 * entirely.
 */
function levelOf(tier: ReferralTier | null): number {
  return tier ? tierToLevel(tier) : 0
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
async function revokePercentCouponGrant(tx: TxClient, grant: ReferralRewardGrant, reason: string): Promise<string | null> {
  if (grant.status !== 'ISSUED') return null

  const redeemed = grant.discountId ? await isRewardRedeemed(grant.discountId, tx) : false
  if (redeemed) {
    // Grant fell out of sync with reality (redeemed but never marked) —
    // keep the state truthful without clawing back an already-used reward.
    await tx.referralRewardGrant.update({
      where: { id: grant.id },
      data: { status: 'REDEEMED' },
    })
    return null
  }

  if (grant.discountId) {
    await revokeTierRewardInTx(tx, grant.discountId, reason)
  }
  await tx.referralRewardGrant.update({
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
async function revokePermanentDiscountGrant(tx: TxClient, grant: ReferralRewardGrant, reason: string): Promise<string | null> {
  if (grant.status !== 'ISSUED') return null

  const applied = grant.discountId ? await tx.orderDiscount.findFirst({ where: { discountId: grant.discountId } }) : null
  const revokeReason = applied ? 'permanente ya consumido, desactivado sin clawback' : reason

  if (grant.discountId) {
    await revokeTierRewardInTx(tx, grant.discountId, revokeReason)
  }
  await tx.referralRewardGrant.update({
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
async function revokeFreeProductGrant(tx: TxClient, grant: ReferralRewardGrant, reason: string): Promise<string | null> {
  if (grant.status !== 'MANUAL_PENDING') return null

  await tx.referralRewardGrant.update({
    where: { id: grant.id },
    data: { status: 'REVOKED', revokedAt: new Date(), revokeReason: reason },
  })
  return grant.id
}

/**
 * Event handler called from the refund / cancellation webhook. Reverses
 * the qualification side effects, ALL inside one `prisma.$transaction`
 * (a mid-flow failure must never strand a deactivated Discount whose
 * grant still reads ISSUED, or a decremented count with no matching
 * grant revocation):
 *
 *   1. Find the QUALIFIED Referral attached to this order; if none,
 *      no-op (idempotent).
 *   2. Flip it to VOID with reason `ORDER_REFUNDED`.
 *   3. Decrement the referrer's `referralCount`.
 *   4. Re-derive their tier. If it did NOT drop, stop — no grant is
 *      touched (referralTier is a live projection of referralCount, per
 *      Task 5's design: if other referrals still support the tier, the
 *      rewards this one triggered stay untouched).
 *   5. If it DID drop, load every `ReferralRewardGrant` the referrer no
 *      longer qualifies for and revoke each per its own `rewardType` +
 *      `status` (spec §6 table):
 *        - PERCENT_COUPON     → `revokePercentCouponGrant`
 *        - PERMANENT_DISCOUNT → `revokePermanentDiscountGrant`
 *        - FREE_PRODUCT       → `revokeFreeProductGrant`
 *
 *      ⚠️ Grants are looked up by `customerId` + `tierLevel`, NOT by
 *      `referralId`. A grant's `referralId` records only the ONE
 *      referral whose tier-crossing originally triggered the mint — the
 *      order being refunded here is almost always a DIFFERENT referral
 *      belonging to the same referrer. Filtering by `referralId` would
 *      return `[]` for every refund except the exact referral that
 *      happened to trigger the unlock, silently leaking every other
 *      reward. Instead we scope by `{ customerId: referral
 *      .referrerCustomerId, tierLevel: { gt: levelOf(newTier) }, status:
 *      { in: ['ISSUED', 'MANUAL_PENDING'] } }`: every non-terminal grant
 *      for a level the customer no longer qualifies for gets revoked;
 *      grants for levels still supported by the (lowered) count are left
 *      alone. REDEEMED / REVOKED / MANUAL_FULFILLED are terminal and
 *      excluded by the status filter — the self-heal branch inside
 *      `revokePercentCouponGrant` still runs because ISSUED-but-actually-
 *      redeemed coupons are included by that same filter.
 *
 *      `ReferralTierUnlock` is NEVER deleted here (D11: a tier is earned
 *      once per lifetime — refund revokes the grants, not the unlock, so
 *      re-crossing the threshold later does not re-mint the reward).
 *   6. Persist the new (possibly null) tier on Customer.
 *   7. Always emit a `REFERRAL_TIER_REVERSED` ActivityLog with old + new
 *      tier + the list of revoked grant ids so finance can reconcile.
 */
export async function onOrderRefunded(input: OnOrderRefundedInput): Promise<void> {
  await prisma.$transaction(async tx => {
    const referral = await tx.referral.findFirst({
      where: { qualifyingOrderId: input.orderId, status: 'QUALIFIED' },
    })
    if (!referral) return

    await tx.referral.update({
      where: { id: referral.id },
      data: { status: 'VOID', voidedAt: new Date(), voidReason: 'ORDER_REFUNDED' },
    })

    const referrer = await tx.customer.update({
      where: { id: referral.referrerCustomerId },
      data: { referralCount: { decrement: 1 } },
    })

    const config = await tx.referralProgramConfig.findUnique({
      where: { venueId: input.venueId },
    })
    if (!config) return

    const newTier = computeTier(referrer.referralCount, config)
    if (newTier === referrer.referralTier) return

    // Tier dropped — revoke every grant the referrer no longer qualifies
    // for, scoped by customer + tier level (NOT referralId — see the
    // function doc above for why that would silently under-revoke).
    const grants = await tx.referralRewardGrant.findMany({
      where: {
        customerId: referral.referrerCustomerId,
        tierLevel: { gt: levelOf(newTier) },
        status: { in: ['ISSUED', 'MANUAL_PENDING'] },
      },
    })

    const revokedGrantIds: string[] = []
    for (const grant of grants) {
      let revokedId: string | null = null
      if (grant.rewardType === 'PERCENT_COUPON') {
        revokedId = await revokePercentCouponGrant(tx, grant, 'TIER_REVERSED_BY_REFUND')
      } else if (grant.rewardType === 'PERMANENT_DISCOUNT') {
        revokedId = await revokePermanentDiscountGrant(tx, grant, 'TIER_REVERSED_BY_REFUND')
      } else if (grant.rewardType === 'FREE_PRODUCT') {
        revokedId = await revokeFreeProductGrant(tx, grant, 'TIER_REVERSED_BY_REFUND')
      }
      if (revokedId) revokedGrantIds.push(revokedId)
    }

    await tx.customer.update({
      where: { id: referrer.id },
      data: {
        referralTier: newTier,
        tierUnlockedAt: newTier ? referrer.tierUnlockedAt : null,
      },
    })

    await tx.activityLog.create({
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
  })
}
