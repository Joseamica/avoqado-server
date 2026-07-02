/**
 * Golden regression test — Task 10.
 *
 * Proves the pre-Task-4 "one hardcoded PERCENT_COUPON per tier" behavior is
 * preserved bit-for-bit by the new configurable-rewards engine (Tasks 1-9),
 * for a venue whose `ReferralProgramConfig` is exactly the DATA MIGRATION's
 * backfill shape (prisma/migrations/20260702180007_referral_backfill/
 * migration.sql, step "a"): 3 `ReferralTierReward` rows — one per tier
 * level (1/2/3) — each `{ rewardType: PERCENT_COUPON, recurrence: ONE_TIME,
 * rewardQuantity: 1, active: true }`.
 *
 * Crossing TIER_1 for such a venue must emit EXACTLY ONE coupon bundle
 * (Discount + CustomerDiscount + CouponCode) whose shape matches the legacy
 * single-coupon behavior:
 *   - Discount: type PERCENTAGE, scope ORDER, maxUsesPerCustomer/
 *     maxTotalUses both 1, validUntil = now + rewardCouponExpiryDays,
 *     source REFERRAL_TIER, active true.
 *   - CouponCode: `{PREFIX}-TIER1-{LAST6_OF_CUSTOMER_ID_UPPER}`.
 *   - `Referral.rewardDiscountId` set to the newly-minted discount's id.
 *   - Tier-up email gated exactly as before: only sent when a
 *     PERCENT_COUPON reward was emitted AND the referrer has an email +
 *     `marketingConsent`.
 *
 * If any assertion here fails, the configurable-rewards rewrite regressed
 * the ONE customer-visible behavior every existing venue (all pre-Task-1,
 * backfilled to this exact shape) depends on today — treat a failure as a
 * real bug, not a test to "fix".
 */

import { prismaMock } from '@tests/__helpers__/setup'
import { onOrderPaid } from '@/services/referrals/referralQualification.service'
import { Prisma } from '@prisma/client'

jest.mock('@/services/referrals/referralCard.service', () => ({
  generateTierUpCard: jest.fn().mockResolvedValue(Buffer.from('fake-png')),
}))
jest.mock('@/services/email.service', () => ({
  sendReferralTierUpEmail: jest.fn().mockResolvedValue(undefined),
}))

const { generateTierUpCard } = require('@/services/referrals/referralCard.service')

const { sendReferralTierUpEmail } = require('@/services/email.service')

describe('referral rewards — golden regression (legacy 3-tier PERCENT_COUPON backfill shape)', () => {
  const NOW = new Date('2026-07-02T12:00:00.000Z')

  const claimedReferral = { id: 'ref_gold', status: 'QUALIFIED', referrerCustomerId: 'cust_gold123' }

  // Exactly the backfill migration's shape for tier1ReferralsRequired etc.
  const backfillConfig = {
    id: 'config_gold',
    tier1ReferralsRequired: 7,
    tier2ReferralsRequired: 12,
    tier3ReferralsRequired: 20,
    rewardCouponExpiryDays: 90,
    codePrefix: 'MINDFORM',
  }

  // Exactly ONE active ReferralTierReward for tier 1 — the backfill inserts
  // one row per level, PERCENT_COUPON / ONE_TIME / rewardQuantity 1.
  const tier1BackfillReward = {
    id: 'tr_tier1_backfill',
    rewardType: 'PERCENT_COUPON',
    recurrence: 'ONE_TIME',
    rewardPercent: 15,
    rewardProductId: null,
    rewardQuantity: 1,
  }

  function setupFreshTier1Crossing() {
    prismaMock.referral.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.referral.findFirst.mockResolvedValue(claimedReferral)
    prismaMock.customer.update.mockResolvedValue({
      id: 'cust_gold123',
      firstName: 'Ana',
      lastName: 'Referrer',
      referralCount: 7, // exactly the tier1 threshold — the crossing order
      referralTier: null,
    })
    prismaMock.referralProgramConfig.findUnique.mockResolvedValue(backfillConfig)
    prismaMock.referralTierUnlock.createMany.mockResolvedValueOnce({ count: 1 }) // fresh unlock
    prismaMock.referralTierReward.findMany.mockResolvedValueOnce([tier1BackfillReward])
    prismaMock.referralRewardGrant.createMany.mockResolvedValueOnce({ count: 1 })
    prismaMock.referralRewardGrant.findFirst.mockResolvedValueOnce({ id: 'grant_gold', tierRewardId: 'tr_tier1_backfill' })
    prismaMock.discount.create.mockResolvedValueOnce({ id: 'disc_gold' })
    prismaMock.customerDiscount.create.mockResolvedValueOnce({ id: 'cd_gold' })
    prismaMock.couponCode.create.mockResolvedValueOnce({ id: 'cc_gold', code: 'MINDFORM-TIER1-OLD123' })
    prismaMock.referralRewardGrant.update.mockResolvedValueOnce({
      id: 'grant_gold',
      tierRewardId: 'tr_tier1_backfill',
      rewardType: 'PERCENT_COUPON',
      rewardPercent: 15,
      status: 'ISSUED',
      discountId: 'disc_gold',
      couponCodeId: 'cc_gold',
    })
  }

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW)
  })

  afterEach(() => {
    jest.useRealTimers()
    jest.clearAllMocks()
  })

  // ---- GOLDEN REGRESSION: exact payload shape ----

  it('crossing tier 1 emits EXACTLY one coupon bundle matching the legacy Discount/CouponCode shape', async () => {
    setupFreshTier1Crossing()
    prismaMock.customer.findUnique.mockResolvedValue(undefined) // no email lookup needed for this assertion

    await onOrderPaid({ orderId: 'order_gold', venueId: 'venue_gold' })

    // Exactly one lookup, scoped to tier 1 of this config, and exactly one
    // grant claimed — the backfill shape has only 1 active reward per tier,
    // so no fan-out into multiple bundles.
    expect(prismaMock.referralTierReward.findMany).toHaveBeenCalledWith({
      where: { configId: 'config_gold', tierLevel: 1, active: true },
      orderBy: { createdAt: 'asc' },
    })
    expect(prismaMock.referralRewardGrant.createMany).toHaveBeenCalledTimes(1)
    expect(prismaMock.discount.create).toHaveBeenCalledTimes(1)
    expect(prismaMock.couponCode.create).toHaveBeenCalledTimes(1)
    expect(prismaMock.customerDiscount.create).toHaveBeenCalledTimes(1)

    const expectedValidUntil = new Date(NOW)
    expectedValidUntil.setDate(expectedValidUntil.getDate() + backfillConfig.rewardCouponExpiryDays)

    // --- Discount payload: exact legacy shape ---
    const discountCall = (prismaMock.discount.create as jest.Mock).mock.calls[0][0]
    expect(discountCall.data.venueId).toBe('venue_gold')
    expect(discountCall.data.type).toBe('PERCENTAGE')
    expect(discountCall.data.scope).toBe('ORDER')
    expect(discountCall.data.maxUsesPerCustomer).toBe(1)
    expect(discountCall.data.maxTotalUses).toBe(1)
    expect(discountCall.data.active).toBe(true)
    expect(discountCall.data.source).toBe('REFERRAL_TIER')
    expect(discountCall.data.isAutomatic).toBeUndefined() // one-time coupon, NOT auto-applied
    expect(discountCall.data.value).toBeInstanceOf(Prisma.Decimal)
    expect((discountCall.data.value as Prisma.Decimal).toNumber()).toBe(15)
    expect(discountCall.data.validUntil).toEqual(expectedValidUntil)

    // --- CustomerDiscount payload ---
    expect(prismaMock.customerDiscount.create).toHaveBeenCalledWith({
      data: {
        customerId: 'cust_gold123',
        discountId: 'disc_gold',
        active: true,
        validUntil: expectedValidUntil,
        maxUses: 1,
      },
    })

    // --- CouponCode shape: {PREFIX}-TIER1-{LAST6 of customer id, upper} ---
    // customer.id 'cust_gold123' → last 6 chars uppercased = 'OLD123'.
    const couponCall = (prismaMock.couponCode.create as jest.Mock).mock.calls[0][0]
    expect(couponCall.data.discountId).toBe('disc_gold')
    expect(couponCall.data.code).toBe('MINDFORM-TIER1-OLD123')
    expect(couponCall.data.maxUses).toBe(1)
    expect(couponCall.data.maxUsesPerCustomer).toBe(1)
    expect(couponCall.data.active).toBe(true)
    expect(couponCall.data.validUntil).toEqual(expectedValidUntil)
  })

  // ---- REGRESSION: rewardDiscountId + email gating preserved ----

  it('sets Referral.rewardDiscountId to the newly-minted discount id', async () => {
    setupFreshTier1Crossing()
    prismaMock.customer.findUnique.mockResolvedValue(undefined)

    await onOrderPaid({ orderId: 'order_gold_2', venueId: 'venue_gold' })

    expect(prismaMock.referral.update).toHaveBeenCalledWith({
      where: { id: 'ref_gold' },
      data: { rewardDiscountId: 'disc_gold' },
    })
  })

  it('does NOT send the tier-up email when the referrer has no marketingConsent (gated as before)', async () => {
    setupFreshTier1Crossing()
    prismaMock.customer.findUnique.mockResolvedValue({
      email: 'ana@example.com',
      firstName: 'Ana',
      lastName: 'Referrer',
      marketingConsent: false,
    })

    await onOrderPaid({ orderId: 'order_gold_3', venueId: 'venue_gold' })

    expect(generateTierUpCard).not.toHaveBeenCalled()
    expect(sendReferralTierUpEmail).not.toHaveBeenCalled()
  })

  it('does NOT send the tier-up email when the referrer has no email on file (gated as before)', async () => {
    setupFreshTier1Crossing()
    prismaMock.customer.findUnique.mockResolvedValue({
      email: null,
      firstName: 'Ana',
      lastName: 'Referrer',
      marketingConsent: true,
    })

    await onOrderPaid({ orderId: 'order_gold_4', venueId: 'venue_gold' })

    expect(generateTierUpCard).not.toHaveBeenCalled()
    expect(sendReferralTierUpEmail).not.toHaveBeenCalled()
  })

  it('DOES send the tier-up email with the coupon code when email + marketingConsent are both present (gated as before)', async () => {
    setupFreshTier1Crossing()
    prismaMock.customer.findUnique.mockResolvedValue({
      email: 'ana@example.com',
      firstName: 'Ana',
      lastName: 'Referrer',
      marketingConsent: true,
    })
    prismaMock.venue.findUnique.mockResolvedValue({ name: 'Mindform Studio' })

    await onOrderPaid({ orderId: 'order_gold_5', venueId: 'venue_gold' })

    expect(generateTierUpCard).toHaveBeenCalledWith(
      expect.objectContaining({
        tier: 'TIER_1',
        rewardPercent: 15,
        couponCode: 'MINDFORM-TIER1-OLD123',
        validDays: 90,
      }),
    )
    expect(sendReferralTierUpEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'ana@example.com',
        tier: 'TIER_1',
        rewardPercent: 15,
        couponCode: 'MINDFORM-TIER1-OLD123',
        validDays: 90,
      }),
    )
  })
})
