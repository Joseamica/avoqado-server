/**
 * referralQualification.service tests — Phase B3, Task 12 → evolved Task 4
 *
 * Closes the "happy path" loop: when an Order linked to a PENDING
 * Referral is paid, the referrer's count is incremented and — if a
 * tier threshold is crossed — every ACTIVE `ReferralTierReward` for
 * that tier is emitted as a `ReferralRewardGrant` (Task 4), replacing
 * the old single-coupon `emitTierReward`.
 *
 * Schema notes:
 *   - No `Coupon` model. PERCENT_COUPON is modeled as Discount (parent)
 *     plus CustomerDiscount (referrer's entitlement) plus CouponCode
 *     (shareable code).
 *   - DiscountType enum value is `PERCENTAGE` (not `PERCENT`).
 *   - ActivityLog's JSON payload column is `data` (inner), wrapped by
 *     Prisma's `data:` create argument (outer).
 *   - `ReferralRewardGrant` idempotency is `@@unique([customerId, tierLevel,
 *     tierRewardId])`, claimed via `createMany({ skipDuplicates: true })` +
 *     `count` — NEVER a try/catch around a P2002 (a constraint violation
 *     aborts the whole Postgres transaction).
 */

import { computeTier, emitTierRewards, onOrderPaid, tierToLevel } from '@/services/referrals/referralQualification.service'
import prisma from '@/utils/prismaClient'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    $transaction: jest.fn(),
    referral: { findFirst: jest.fn(), update: jest.fn() },
    customer: { update: jest.fn(), findUnique: jest.fn() },
    referralProgramConfig: { findUnique: jest.fn() },
    referralTierReward: { findMany: jest.fn() },
    referralRewardGrant: { createMany: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
    venue: { findUnique: jest.fn() },
    discount: { create: jest.fn() },
    customerDiscount: { create: jest.fn() },
    couponCode: { create: jest.fn() },
    activityLog: { create: jest.fn() },
  },
}))

const mockedPrisma = prisma as any

describe('computeTier', () => {
  const config = {
    tier1ReferralsRequired: 7,
    tier2ReferralsRequired: 12,
    tier3ReferralsRequired: 20,
  } as any

  it('returns null when count below tier1', () => {
    expect(computeTier(0, config)).toBeNull()
    expect(computeTier(6, config)).toBeNull()
  })

  it('returns TIER_1 at exactly 7', () => {
    expect(computeTier(7, config)).toBe('TIER_1')
  })

  it('returns TIER_2 at 12', () => {
    expect(computeTier(12, config)).toBe('TIER_2')
  })

  it('returns TIER_3 at 20+', () => {
    expect(computeTier(20, config)).toBe('TIER_3')
    expect(computeTier(99, config)).toBe('TIER_3')
  })

  it('returns highest applicable tier when count skips levels', () => {
    expect(computeTier(15, config)).toBe('TIER_2')
  })
})

describe('tierToLevel', () => {
  it('maps ReferralTier enum values to their plain Int level', () => {
    expect(tierToLevel('TIER_1')).toBe(1)
    expect(tierToLevel('TIER_2')).toBe(2)
    expect(tierToLevel('TIER_3')).toBe(3)
  })
})

describe('emitTierRewards', () => {
  const config = {
    id: 'config_1',
    rewardCouponExpiryDays: 90,
    codePrefix: 'MINDFORM',
  } as any
  const customer = { id: 'cust_abc123', firstName: 'Jose', lastName: 'P' }
  const baseInput = { venueId: 'venue_1', customer, tierLevel: 1, config, referralId: 'ref_1' }

  beforeEach(() => {
    jest.clearAllMocks()
  })

  // ---- NEW FEATURE TESTS (Task 4) ----

  it('PERCENT_COUPON emits Discount+CustomerDiscount+CouponCode and an ISSUED grant', async () => {
    mockedPrisma.referralTierReward.findMany.mockResolvedValue([
      { id: 'tr_1', rewardType: 'PERCENT_COUPON', rewardPercent: 15, rewardProductId: null, rewardQuantity: 1 },
    ])
    mockedPrisma.referralRewardGrant.createMany.mockResolvedValue({ count: 1 })
    mockedPrisma.referralRewardGrant.findFirst.mockResolvedValue({ id: 'grant_1', tierRewardId: 'tr_1' })
    mockedPrisma.discount.create.mockResolvedValue({ id: 'disc_1', value: 15 })
    mockedPrisma.customerDiscount.create.mockResolvedValue({ id: 'cd_1' })
    mockedPrisma.couponCode.create.mockResolvedValue({ id: 'cc_1', code: 'MINDFORM-TIER1-C123' })
    mockedPrisma.referralRewardGrant.update.mockResolvedValue({
      id: 'grant_1',
      status: 'ISSUED',
      discountId: 'disc_1',
      couponCodeId: 'cc_1',
    })

    const result = await emitTierRewards(mockedPrisma, baseInput)

    expect(mockedPrisma.referralRewardGrant.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [expect.objectContaining({ customerId: 'cust_abc123', tierLevel: 1, tierRewardId: 'tr_1', status: 'ISSUED' })],
        skipDuplicates: true,
      }),
    )
    expect(mockedPrisma.discount.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          venueId: 'venue_1',
          value: expect.anything(),
          scope: 'ORDER',
          maxUsesPerCustomer: 1,
          maxTotalUses: 1,
          active: true,
          source: 'REFERRAL_TIER',
        }),
      }),
    )
    expect(mockedPrisma.customerDiscount.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ customerId: 'cust_abc123', discountId: 'disc_1', active: true }),
      }),
    )
    expect(mockedPrisma.couponCode.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ discountId: 'disc_1', code: expect.stringMatching(/^MINDFORM-TIER1-/), active: true }),
      }),
    )
    expect(mockedPrisma.referralRewardGrant.update).toHaveBeenCalledWith({
      where: { id: 'grant_1' },
      data: { discountId: 'disc_1', couponCodeId: 'cc_1' },
    })
    expect(result).toHaveLength(1)
    expect(result[0].grant.status).toBe('ISSUED')
    expect(result[0].couponCode?.code).toMatch(/^MINDFORM-TIER1-/)
  })

  it('PERMANENT_DISCOUNT emits an isAutomatic Discount with no validUntil/usage caps', async () => {
    mockedPrisma.referralTierReward.findMany.mockResolvedValue([
      { id: 'tr_2', rewardType: 'PERMANENT_DISCOUNT', rewardPercent: 5, rewardProductId: null, rewardQuantity: 1 },
    ])
    mockedPrisma.referralRewardGrant.createMany.mockResolvedValue({ count: 1 })
    mockedPrisma.referralRewardGrant.findFirst.mockResolvedValue({ id: 'grant_2', tierRewardId: 'tr_2' })
    mockedPrisma.discount.create.mockResolvedValue({ id: 'disc_2', value: 5, isAutomatic: true })
    mockedPrisma.customerDiscount.create.mockResolvedValue({ id: 'cd_2' })
    mockedPrisma.referralRewardGrant.update.mockResolvedValue({ id: 'grant_2', status: 'ISSUED', discountId: 'disc_2' })

    const result = await emitTierRewards(mockedPrisma, baseInput)

    expect(mockedPrisma.discount.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          isAutomatic: true,
          validUntil: null,
          maxUsesPerCustomer: null,
          maxTotalUses: null,
          source: 'REFERRAL_TIER',
        }),
      }),
    )
    expect(mockedPrisma.couponCode.create).not.toHaveBeenCalled()
    expect(mockedPrisma.customerDiscount.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ validUntil: null, maxUses: null }) }),
    )
    expect(mockedPrisma.referralRewardGrant.update).toHaveBeenCalledWith({
      where: { id: 'grant_2' },
      data: { discountId: 'disc_2' },
    })
    expect(result[0].discount?.id).toBe('disc_2')
    expect(result[0].couponCode).toBeUndefined()
  })

  it('FREE_PRODUCT emits NO discount, only a MANUAL_PENDING grant', async () => {
    mockedPrisma.referralTierReward.findMany.mockResolvedValue([
      { id: 'tr_3', rewardType: 'FREE_PRODUCT', rewardPercent: null, rewardProductId: 'prod_1', rewardQuantity: 2 },
    ])
    mockedPrisma.referralRewardGrant.createMany.mockResolvedValue({ count: 1 })
    mockedPrisma.referralRewardGrant.findFirst.mockResolvedValue({ id: 'grant_3', tierRewardId: 'tr_3', status: 'MANUAL_PENDING' })

    const result = await emitTierRewards(mockedPrisma, baseInput)

    expect(mockedPrisma.discount.create).not.toHaveBeenCalled()
    expect(mockedPrisma.couponCode.create).not.toHaveBeenCalled()
    expect(mockedPrisma.referralRewardGrant.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            rewardProductId: 'prod_1',
            rewardQuantity: 2,
            status: 'MANUAL_PENDING',
          }),
        ],
      }),
    )
    // No artifact to attach — the grant is used as-is, `update` is never called.
    expect(mockedPrisma.referralRewardGrant.update).not.toHaveBeenCalled()
    expect(result).toHaveLength(1)
    expect(result[0].grant.status).toBe('MANUAL_PENDING')
    expect(result[0].discount).toBeUndefined()
  })

  it('skips emission when the grant already exists (createMany count 0)', async () => {
    mockedPrisma.referralTierReward.findMany.mockResolvedValue([
      { id: 'tr_1', rewardType: 'PERCENT_COUPON', rewardPercent: 15, rewardProductId: null, rewardQuantity: 1 },
    ])
    mockedPrisma.referralRewardGrant.createMany.mockResolvedValueOnce({ count: 0 }) // already existed

    const result = await emitTierRewards(mockedPrisma, baseInput)

    expect(mockedPrisma.discount.create).not.toHaveBeenCalled() // no double-mint
    expect(mockedPrisma.referralRewardGrant.findFirst).not.toHaveBeenCalled()
    expect(mockedPrisma.referralRewardGrant.update).not.toHaveBeenCalled()
    expect(result).toHaveLength(0)
  })

  it('emits one grant per ACTIVE tierReward when several are configured for the same tier', async () => {
    mockedPrisma.referralTierReward.findMany.mockResolvedValue([
      { id: 'tr_1', rewardType: 'PERCENT_COUPON', rewardPercent: 15, rewardProductId: null, rewardQuantity: 1 },
      { id: 'tr_4', rewardType: 'FREE_PRODUCT', rewardPercent: null, rewardProductId: 'prod_1', rewardQuantity: 1 },
    ])
    mockedPrisma.referralRewardGrant.createMany.mockResolvedValue({ count: 1 })
    mockedPrisma.referralRewardGrant.findFirst
      .mockResolvedValueOnce({ id: 'grant_1', tierRewardId: 'tr_1' })
      .mockResolvedValueOnce({ id: 'grant_4', tierRewardId: 'tr_4', status: 'MANUAL_PENDING' })
    mockedPrisma.discount.create.mockResolvedValue({ id: 'disc_1' })
    mockedPrisma.customerDiscount.create.mockResolvedValue({ id: 'cd_1' })
    mockedPrisma.couponCode.create.mockResolvedValue({ id: 'cc_1', code: 'MINDFORM-TIER1-C123' })
    mockedPrisma.referralRewardGrant.update.mockResolvedValue({ id: 'grant_1', discountId: 'disc_1', couponCodeId: 'cc_1' })

    const result = await emitTierRewards(mockedPrisma, baseInput)

    expect(mockedPrisma.referralTierReward.findMany).toHaveBeenCalledWith({
      where: { configId: 'config_1', tierLevel: 1, active: true },
      orderBy: { createdAt: 'asc' },
    })
    expect(result).toHaveLength(2)
  })

  // ---- REGRESSION: findMany scoping ----

  it('scopes the tierReward lookup by configId + tierLevel + active only', async () => {
    mockedPrisma.referralTierReward.findMany.mockResolvedValue([])
    await emitTierRewards(mockedPrisma, { ...baseInput, tierLevel: 2 })
    expect(mockedPrisma.referralTierReward.findMany).toHaveBeenCalledWith({
      where: { configId: 'config_1', tierLevel: 2, active: true },
      orderBy: { createdAt: 'asc' },
    })
  })
})

describe('onOrderPaid', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockedPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockedPrisma))
  })

  it('does nothing when no PENDING Referral for this order', async () => {
    mockedPrisma.referral.findFirst.mockResolvedValue(null)
    await onOrderPaid({ orderId: 'o1', venueId: 'venue_1' })
    expect(mockedPrisma.referral.update).not.toHaveBeenCalled()
  })

  it('marks Referral as QUALIFIED and increments referrer count', async () => {
    mockedPrisma.referral.findFirst.mockResolvedValue({
      id: 'ref_1',
      status: 'PENDING',
      referrerCustomerId: 'cust_ref',
    })
    mockedPrisma.customer.update.mockResolvedValue({
      id: 'cust_ref',
      firstName: 'Jose',
      lastName: 'P',
      referralCount: 3,
      referralTier: null,
    })
    mockedPrisma.referralProgramConfig.findUnique.mockResolvedValue({
      tier1ReferralsRequired: 7,
      tier2ReferralsRequired: 12,
      tier3ReferralsRequired: 20,
    })
    await onOrderPaid({ orderId: 'o1', venueId: 'venue_1' })
    expect(mockedPrisma.referral.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'ref_1' },
        data: expect.objectContaining({ status: 'QUALIFIED' }),
      }),
    )
    expect(mockedPrisma.customer.update).toHaveBeenCalledWith({
      where: { id: 'cust_ref' },
      data: { referralCount: { increment: 1 } },
    })
  })

  it('emits tier rewards as grants + writes ActivityLog listing them when crossing threshold', async () => {
    mockedPrisma.referral.findFirst.mockResolvedValue({
      id: 'ref_1',
      status: 'PENDING',
      referrerCustomerId: 'cust_ref',
    })
    mockedPrisma.customer.update
      .mockResolvedValueOnce({ id: 'cust_ref', firstName: 'Jose', lastName: 'P', referralCount: 7, referralTier: null }) // increment call
      .mockResolvedValueOnce({ id: 'cust_ref', referralTier: 'TIER_1' }) // set tier call
    mockedPrisma.referralProgramConfig.findUnique.mockResolvedValue({
      id: 'config_1',
      tier1ReferralsRequired: 7,
      tier2ReferralsRequired: 12,
      tier3ReferralsRequired: 20,
      rewardCouponExpiryDays: 90,
      codePrefix: 'MINDFORM',
    })
    mockedPrisma.referralTierReward.findMany.mockResolvedValue([
      { id: 'tr_1', rewardType: 'PERCENT_COUPON', rewardPercent: 15, rewardProductId: null, rewardQuantity: 1 },
    ])
    mockedPrisma.referralRewardGrant.createMany.mockResolvedValue({ count: 1 })
    mockedPrisma.referralRewardGrant.findFirst.mockResolvedValue({ id: 'grant_1', tierRewardId: 'tr_1' })
    mockedPrisma.discount.create.mockResolvedValue({ id: 'disc_1' })
    mockedPrisma.customerDiscount.create.mockResolvedValue({ id: 'cd_1' })
    mockedPrisma.couponCode.create.mockResolvedValue({ id: 'cc_1', code: 'MINDFORM-TIER1-ABCDEF' })
    mockedPrisma.referralRewardGrant.update.mockResolvedValue({
      id: 'grant_1',
      tierRewardId: 'tr_1',
      rewardType: 'PERCENT_COUPON',
      rewardPercent: 15,
      status: 'ISSUED',
      discountId: 'disc_1',
      couponCodeId: 'cc_1',
    })

    await onOrderPaid({ orderId: 'o1', venueId: 'venue_1' })

    expect(mockedPrisma.discount.create).toHaveBeenCalled()
    expect(mockedPrisma.referral.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'ref_1' },
        data: expect.objectContaining({ rewardDiscountId: 'disc_1' }),
      }),
    )
    expect(mockedPrisma.activityLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'REFERRAL_TIER_UNLOCKED',
          data: expect.objectContaining({
            tier: 'TIER_1',
            grants: [expect.objectContaining({ grantId: 'grant_1', rewardType: 'PERCENT_COUPON', status: 'ISSUED' })],
          }),
        }),
      }),
    )
  })

  it('does NOT emit any reward when below threshold', async () => {
    mockedPrisma.referral.findFirst.mockResolvedValue({
      id: 'ref_1',
      status: 'PENDING',
      referrerCustomerId: 'cust_ref',
    })
    mockedPrisma.customer.update.mockResolvedValue({
      id: 'cust_ref',
      firstName: 'X',
      lastName: 'Y',
      referralCount: 6,
      referralTier: null,
    })
    mockedPrisma.referralProgramConfig.findUnique.mockResolvedValue({
      tier1ReferralsRequired: 7,
      tier2ReferralsRequired: 12,
      tier3ReferralsRequired: 20,
    })
    await onOrderPaid({ orderId: 'o1', venueId: 'venue_1' })
    expect(mockedPrisma.discount.create).not.toHaveBeenCalled()
    expect(mockedPrisma.referralTierReward.findMany).not.toHaveBeenCalled()
  })

  it('does NOT set rewardDiscountId when the tier only grants FREE_PRODUCT (no discount emitted)', async () => {
    mockedPrisma.referral.findFirst.mockResolvedValue({
      id: 'ref_1',
      status: 'PENDING',
      referrerCustomerId: 'cust_ref',
    })
    mockedPrisma.customer.update
      .mockResolvedValueOnce({ id: 'cust_ref', firstName: 'Jose', lastName: 'P', referralCount: 7, referralTier: null })
      .mockResolvedValueOnce({ id: 'cust_ref', referralTier: 'TIER_1' })
    mockedPrisma.referralProgramConfig.findUnique.mockResolvedValue({
      id: 'config_1',
      tier1ReferralsRequired: 7,
      tier2ReferralsRequired: 12,
      tier3ReferralsRequired: 20,
      rewardCouponExpiryDays: 90,
      codePrefix: 'MINDFORM',
    })
    mockedPrisma.referralTierReward.findMany.mockResolvedValue([
      { id: 'tr_3', rewardType: 'FREE_PRODUCT', rewardPercent: null, rewardProductId: 'prod_1', rewardQuantity: 1 },
    ])
    mockedPrisma.referralRewardGrant.createMany.mockResolvedValue({ count: 1 })
    mockedPrisma.referralRewardGrant.findFirst.mockResolvedValue({
      id: 'grant_3',
      tierRewardId: 'tr_3',
      rewardType: 'FREE_PRODUCT',
      status: 'MANUAL_PENDING',
    })

    await onOrderPaid({ orderId: 'o1', venueId: 'venue_1' })

    expect(mockedPrisma.discount.create).not.toHaveBeenCalled()
    // Only ONE referral.update call: the QUALIFIED transition. No second
    // call setting rewardDiscountId, since nothing minted a Discount.
    expect(mockedPrisma.referral.update).toHaveBeenCalledTimes(1)
    expect(mockedPrisma.activityLog.create).toHaveBeenCalledWith(
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
