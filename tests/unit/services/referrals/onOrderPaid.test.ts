/**
 * onOrderPaid tests — Task 5 (atomic per-order claim + lifetime unlock guard)
 *
 * Covers the spec §5 seven-step flow, ALL inside one `prisma.$transaction`:
 *   1. CAS claim by ORDER (`Referral.updateMany` PENDING → QUALIFIED,
 *      `count === 0` → no-op — idempotent against duplicate webhooks and
 *      concurrent retries for the SAME order).
 *   2. Re-fetch the claimed referral.
 *   3. Increment `Customer.referralCount`.
 *   4. Recompute tier — no NEW tier crossed → commit as-is.
 *   5. `ReferralTierUnlock` guard (`createMany({ skipDuplicates: true })`,
 *      `count === 0` → level already earned once in this customer's
 *      lifetime, e.g. re-crossing after a refund revoked the prior
 *      grants — skip emission, do NOT re-mint).
 *   6. `Customer.referralTier` kept in sync with the live count either way.
 *   7. `ActivityLog` REFERRAL_TIER_UNLOCKED (grants: [] + alreadyUnlocked:
 *      true when the guard skipped).
 *
 * Uses the SHARED `prismaMock` (tests/__helpers__/setup.ts) instead of a
 * local `jest.mock`, because the CAS-claim + unlock-guard rewrite needs
 * `referral.updateMany`/`referral.findFirst` and `referralProgramConfig`
 * — added to the shared registry as part of this task (they were missing
 * before; Task 4's `referralQualification.service.test.ts` used its own
 * minimal local mock and never needed them).
 */

import { prismaMock } from '@tests/__helpers__/setup'
import { onOrderPaid } from '@/services/referrals/referralQualification.service'

describe('onOrderPaid', () => {
  const claimedReferral = { id: 'ref_1', status: 'QUALIFIED', referrerCustomerId: 'cust_ref' }
  const baseConfig = {
    id: 'config_1',
    tier1ReferralsRequired: 7,
    tier2ReferralsRequired: 12,
    tier3ReferralsRequired: 20,
    rewardCouponExpiryDays: 90,
    codePrefix: 'MINDFORM',
  }

  // ---- NEW FEATURE TESTS (Task 5) ----

  it('claims the referral by qualifyingOrderId; second run is a no-op', async () => {
    prismaMock.referral.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 })
    prismaMock.referral.findFirst.mockResolvedValue(claimedReferral)
    prismaMock.customer.update.mockResolvedValue({
      id: 'cust_ref',
      firstName: 'Jose',
      lastName: 'P',
      referralCount: 3, // below tier1 (7) — no tier crossed, keeps this test focused on the claim
      referralTier: null,
    })
    prismaMock.referralProgramConfig.findUnique.mockResolvedValue(baseConfig)

    await onOrderPaid({ orderId: 'o1', venueId: 'v1' }) // count 1 → processes
    await onOrderPaid({ orderId: 'o1', venueId: 'v1' }) // count 0 → aborts

    expect(prismaMock.referral.updateMany).toHaveBeenCalledTimes(2)
    expect(prismaMock.referral.updateMany).toHaveBeenCalledWith({
      where: { qualifyingOrderId: 'o1', status: 'PENDING' },
      data: { status: 'QUALIFIED', qualifiedAt: expect.any(Date) },
    })
    // Second call's claim.count === 0 must short-circuit BEFORE re-fetching
    // or incrementing — only one referral.findFirst / customer.update pair.
    expect(prismaMock.referral.findFirst).toHaveBeenCalledTimes(1)
    expect(prismaMock.customer.update).toHaveBeenCalledTimes(1) // a single increment
  })

  it('aborts emission if the tier unlock already exists (createMany count 0), but keeps the claim + increment', async () => {
    prismaMock.referral.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.referral.findFirst.mockResolvedValue(claimedReferral)
    prismaMock.customer.update.mockResolvedValue({
      id: 'cust_ref',
      firstName: 'Jose',
      lastName: 'P',
      referralCount: 7, // crosses tier1
      referralTier: null,
    })
    prismaMock.referralProgramConfig.findUnique.mockResolvedValue(baseConfig)
    prismaMock.referralTierUnlock.createMany.mockResolvedValueOnce({ count: 0 }) // already unlocked before (e.g. post-refund re-cross)

    await onOrderPaid({ orderId: 'o2', venueId: 'v1' })

    expect(prismaMock.referralRewardGrant.createMany).not.toHaveBeenCalled()
    expect(prismaMock.discount.create).not.toHaveBeenCalled()
    // The claim + increment still land — only emission is skipped.
    expect(prismaMock.customer.update).toHaveBeenCalledWith({
      where: { id: 'cust_ref' },
      data: { referralCount: { increment: 1 } },
    })
  })

  it('design decision: keeps Customer.referralTier in sync with the live count even when the unlock guard skips emission', async () => {
    prismaMock.referral.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.referral.findFirst.mockResolvedValue(claimedReferral)
    prismaMock.customer.update.mockResolvedValue({
      id: 'cust_ref',
      firstName: 'Jose',
      lastName: 'P',
      referralCount: 7,
      referralTier: null, // e.g. a refund previously reset this to null even though the level was already earned once
    })
    prismaMock.referralProgramConfig.findUnique.mockResolvedValue(baseConfig)
    prismaMock.referralTierUnlock.createMany.mockResolvedValueOnce({ count: 0 })

    await onOrderPaid({ orderId: 'o3', venueId: 'v1' })

    // Step 6 still runs: the tier FIELD reflects the currently-justified
    // tier, decoupled from ReferralTierUnlock's "earned once" bookkeeping.
    expect(prismaMock.customer.update).toHaveBeenCalledWith({
      where: { id: 'cust_ref' },
      data: { referralTier: 'TIER_1', tierUnlockedAt: expect.any(Date), tierUpModalSeenAt: null },
    })
    expect(prismaMock.activityLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'REFERRAL_TIER_UNLOCKED',
          data: expect.objectContaining({ tier: 'TIER_1', alreadyUnlocked: true, grants: [] }),
        }),
      }),
    )
  })

  it('emits tier rewards as grants + writes ActivityLog (alreadyUnlocked: false) on a FRESH unlock', async () => {
    prismaMock.referral.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.referral.findFirst.mockResolvedValue(claimedReferral)
    prismaMock.customer.update.mockResolvedValue({
      id: 'cust_ref',
      firstName: 'Jose',
      lastName: 'P',
      referralCount: 7,
      referralTier: null,
    })
    prismaMock.referralProgramConfig.findUnique.mockResolvedValue(baseConfig)
    prismaMock.referralTierUnlock.createMany.mockResolvedValueOnce({ count: 1 }) // fresh unlock
    prismaMock.referralTierReward.findMany.mockResolvedValueOnce([
      { id: 'tr_1', rewardType: 'PERCENT_COUPON', rewardPercent: 15, rewardProductId: null, rewardQuantity: 1 },
    ])
    prismaMock.referralRewardGrant.createMany.mockResolvedValueOnce({ count: 1 })
    prismaMock.referralRewardGrant.findFirst.mockResolvedValueOnce({ id: 'grant_1', tierRewardId: 'tr_1' })
    prismaMock.discount.create.mockResolvedValueOnce({ id: 'disc_1' })
    prismaMock.customerDiscount.create.mockResolvedValueOnce({ id: 'cd_1' })
    prismaMock.couponCode.create.mockResolvedValueOnce({ id: 'cc_1', code: 'MINDFORM-TIER1-ABCDEF' })
    prismaMock.referralRewardGrant.update.mockResolvedValueOnce({
      id: 'grant_1',
      tierRewardId: 'tr_1',
      rewardType: 'PERCENT_COUPON',
      rewardPercent: 15,
      status: 'ISSUED',
      discountId: 'disc_1',
      couponCodeId: 'cc_1',
    })

    await onOrderPaid({ orderId: 'o4', venueId: 'v1' })

    expect(prismaMock.referralTierUnlock.createMany).toHaveBeenCalledWith({
      data: [{ customerId: 'cust_ref', tierLevel: 1, unlockedByReferralId: 'ref_1' }],
      skipDuplicates: true,
    })
    expect(prismaMock.discount.create).toHaveBeenCalled()
    expect(prismaMock.referral.update).toHaveBeenCalledWith({
      where: { id: 'ref_1' },
      data: { rewardDiscountId: 'disc_1' },
    })
    expect(prismaMock.activityLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'REFERRAL_TIER_UNLOCKED',
          data: expect.objectContaining({
            tier: 'TIER_1',
            alreadyUnlocked: false,
            grants: [expect.objectContaining({ grantId: 'grant_1', rewardType: 'PERCENT_COUPON', status: 'ISSUED' })],
          }),
        }),
      }),
    )
  })

  // ---- REGRESSION TESTS (behavior preserved from Task 4 / pre-Task-5) ----

  it('does nothing when there is no PENDING Referral for this order', async () => {
    prismaMock.referral.updateMany.mockResolvedValue({ count: 0 })

    await onOrderPaid({ orderId: 'o5', venueId: 'v1' })

    expect(prismaMock.referral.findFirst).not.toHaveBeenCalled()
    expect(prismaMock.customer.update).not.toHaveBeenCalled()
  })

  it('marks the Referral QUALIFIED (via CAS) and increments referrer count when no tier is crossed', async () => {
    prismaMock.referral.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.referral.findFirst.mockResolvedValue(claimedReferral)
    prismaMock.customer.update.mockResolvedValue({
      id: 'cust_ref',
      firstName: 'Jose',
      lastName: 'P',
      referralCount: 3,
      referralTier: null,
    })
    prismaMock.referralProgramConfig.findUnique.mockResolvedValue(baseConfig)

    await onOrderPaid({ orderId: 'o6', venueId: 'v1' })

    expect(prismaMock.referral.findFirst).toHaveBeenCalledWith({
      where: { qualifyingOrderId: 'o6', status: 'QUALIFIED' },
    })
    expect(prismaMock.customer.update).toHaveBeenCalledWith({
      where: { id: 'cust_ref' },
      data: { referralCount: { increment: 1 } },
    })
    // Below tier1 (3 < 7) — no reward machinery touched.
    expect(prismaMock.referralTierUnlock.createMany).not.toHaveBeenCalled()
    expect(prismaMock.discount.create).not.toHaveBeenCalled()
  })

  it('does NOT emit any reward when below threshold', async () => {
    prismaMock.referral.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.referral.findFirst.mockResolvedValue(claimedReferral)
    prismaMock.customer.update.mockResolvedValue({
      id: 'cust_ref',
      firstName: 'X',
      lastName: 'Y',
      referralCount: 6,
      referralTier: null,
    })
    prismaMock.referralProgramConfig.findUnique.mockResolvedValue(baseConfig)

    await onOrderPaid({ orderId: 'o7', venueId: 'v1' })

    expect(prismaMock.discount.create).not.toHaveBeenCalled()
    expect(prismaMock.referralTierReward.findMany).not.toHaveBeenCalled()
  })

  it('does NOT set rewardDiscountId when the tier only grants FREE_PRODUCT (no discount emitted)', async () => {
    prismaMock.referral.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.referral.findFirst.mockResolvedValue(claimedReferral)
    prismaMock.customer.update.mockResolvedValue({
      id: 'cust_ref',
      firstName: 'Jose',
      lastName: 'P',
      referralCount: 7,
      referralTier: null,
    })
    prismaMock.referralProgramConfig.findUnique.mockResolvedValue(baseConfig)
    prismaMock.referralTierUnlock.createMany.mockResolvedValueOnce({ count: 1 })
    prismaMock.referralTierReward.findMany.mockResolvedValueOnce([
      { id: 'tr_3', rewardType: 'FREE_PRODUCT', rewardPercent: null, rewardProductId: 'prod_1', rewardQuantity: 1 },
    ])
    prismaMock.referralRewardGrant.createMany.mockResolvedValueOnce({ count: 1 })
    prismaMock.referralRewardGrant.findFirst.mockResolvedValueOnce({
      id: 'grant_3',
      tierRewardId: 'tr_3',
      rewardType: 'FREE_PRODUCT',
      status: 'MANUAL_PENDING',
    })

    await onOrderPaid({ orderId: 'o8', venueId: 'v1' })

    expect(prismaMock.discount.create).not.toHaveBeenCalled()
    // Only the QUALIFIED-transition write to referral — no second `update`
    // setting rewardDiscountId, since nothing minted a Discount.
    expect(prismaMock.referral.update).not.toHaveBeenCalled()
    expect(prismaMock.activityLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          data: expect.objectContaining({
            grants: [expect.objectContaining({ rewardType: 'FREE_PRODUCT', status: 'MANUAL_PENDING', discountId: null })],
          }),
        }),
      }),
    )
  })
})
