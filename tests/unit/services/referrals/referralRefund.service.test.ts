/**
 * referralRefund.service tests — Phase B3, Task 13 (single-discount era) →
 * Task 6 (rewritten around ReferralRewardGrant, spec §6).
 *
 * Closes the "void path" loop: when an Order linked to a QUALIFIED
 * Referral is refunded, the Referral is voided, the referrer's count
 * is decremented, and — if the tier drops — every ReferralRewardGrant
 * that referral's tier-crossing emitted is revoked per its own
 * `rewardType` + `status` (spec §6 table):
 *
 *   - PERCENT_COUPON: ISSUED + unredeemed → revoke (Discount + CouponCode
 *     deactivated, grant → REVOKED). REDEEMED (or a CouponRedemption
 *     already exists) → left alone; a stale ISSUED grant gets corrected
 *     to REDEEMED so the state stays truthful.
 *   - PERMANENT_DISCOUNT: usage is decided via `OrderDiscount` (NOT
 *     CouponRedemption). Never applied → deactivate + REVOKED. Already
 *     applied → STILL deactivate going forward (no retroactive clawback)
 *     AND grant → REVOKED with a reason mentioning "permanente" — it must
 *     never stay ISSUED.
 *   - FREE_PRODUCT: MANUAL_PENDING → REVOKED. MANUAL_FULFILLED → left alone.
 *
 * `ReferralTierUnlock` is NEVER deleted on refund (D11: a tier is earned
 * once per lifetime; refund revokes grants but never the unlock).
 *
 * Schema notes:
 *   - The 3-record reward bundle (Discount + CouponCode + CustomerDiscount)
 *     is deactivated via `active: false` on all three rows in a single
 *     transaction. Discount additionally records `deactivatedReason` and
 *     `deactivatedAt` for audit.
 *   - `isRewardRedeemed` queries CouponRedemption through the nested
 *     `couponCode.discountId` filter — Prisma resolves this via the
 *     `couponCode` relation on CouponRedemption.
 */

import { onOrderRefunded, isRewardRedeemed, revokeTierReward } from '@/services/referrals/referralRefund.service'
import prisma from '@/utils/prismaClient'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    $transaction: jest.fn(),
    referral: { findFirst: jest.fn(), update: jest.fn() },
    customer: { update: jest.fn() },
    referralProgramConfig: { findUnique: jest.fn() },
    referralRewardGrant: { findMany: jest.fn(), update: jest.fn() },
    referralTierUnlock: { delete: jest.fn() },
    discount: { update: jest.fn() },
    customerDiscount: { updateMany: jest.fn() },
    couponCode: { updateMany: jest.fn() },
    couponRedemption: { findFirst: jest.fn() },
    orderDiscount: { findFirst: jest.fn() },
    activityLog: { create: jest.fn() },
  },
}))

const mockedPrisma = prisma as any

describe('isRewardRedeemed', () => {
  beforeEach(() => jest.clearAllMocks())
  it('returns true when a CouponRedemption exists for the Discount', async () => {
    mockedPrisma.couponRedemption.findFirst.mockResolvedValue({ id: 'red_1' })
    expect(await isRewardRedeemed('disc_1')).toBe(true)
  })
  it('returns false when no CouponRedemption exists', async () => {
    mockedPrisma.couponRedemption.findFirst.mockResolvedValue(null)
    expect(await isRewardRedeemed('disc_1')).toBe(false)
  })
})

describe('revokeTierReward', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockedPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockedPrisma))
  })
  it('deactivates Discount, CouponCode, CustomerDiscount + reason + deactivatedAt', async () => {
    mockedPrisma.discount.update.mockResolvedValue({ id: 'disc_1' })
    mockedPrisma.couponCode.updateMany.mockResolvedValue({ count: 1 })
    mockedPrisma.customerDiscount.updateMany.mockResolvedValue({ count: 1 })
    await revokeTierReward('disc_1', 'TIER_REVERSED_BY_REFUND')
    expect(mockedPrisma.discount.update).toHaveBeenCalledWith({
      where: { id: 'disc_1' },
      data: expect.objectContaining({
        active: false,
        deactivatedReason: 'TIER_REVERSED_BY_REFUND',
        deactivatedAt: expect.any(Date),
      }),
    })
    expect(mockedPrisma.couponCode.updateMany).toHaveBeenCalledWith({
      where: { discountId: 'disc_1' },
      data: { active: false },
    })
    expect(mockedPrisma.customerDiscount.updateMany).toHaveBeenCalledWith({
      where: { discountId: 'disc_1' },
      data: { active: false },
    })
  })
})

describe('onOrderRefunded', () => {
  const baseReferral = {
    id: 'ref_1',
    status: 'QUALIFIED',
    referrerCustomerId: 'cust_ref',
  }
  const baseConfig = {
    tier1ReferralsRequired: 7,
    tier2ReferralsRequired: 12,
    tier3ReferralsRequired: 20,
  }

  beforeEach(() => {
    jest.clearAllMocks()
    mockedPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockedPrisma))
    mockedPrisma.referralRewardGrant.findMany.mockResolvedValue([])
  })

  it('does nothing when no QUALIFIED Referral exists for this order', async () => {
    mockedPrisma.referral.findFirst.mockResolvedValue(null)
    await onOrderRefunded({ orderId: 'o1', venueId: 'v1' })
    expect(mockedPrisma.referral.update).not.toHaveBeenCalled()
  })

  it('voids Referral and decrements referrer count', async () => {
    mockedPrisma.referral.findFirst.mockResolvedValue(baseReferral)
    mockedPrisma.customer.update.mockResolvedValue({
      id: 'cust_ref',
      referralCount: 6,
      referralTier: 'TIER_1',
    })
    mockedPrisma.referralProgramConfig.findUnique.mockResolvedValue(baseConfig)
    await onOrderRefunded({ orderId: 'o1', venueId: 'v1' })
    expect(mockedPrisma.referral.update).toHaveBeenCalledWith({
      where: { id: 'ref_1' },
      data: expect.objectContaining({
        status: 'VOID',
        voidReason: 'ORDER_REFUNDED',
      }),
    })
  })

  it('does not touch grants or ActivityLog when the tier does not drop', async () => {
    mockedPrisma.referral.findFirst.mockResolvedValue(baseReferral)
    mockedPrisma.customer.update.mockResolvedValue({
      id: 'cust_ref',
      referralCount: 8,
      referralTier: 'TIER_1', // stays TIER_1 even after decrement
    })
    mockedPrisma.referralProgramConfig.findUnique.mockResolvedValue(baseConfig)
    await onOrderRefunded({ orderId: 'o1', venueId: 'v1' })
    expect(mockedPrisma.referralRewardGrant.findMany).not.toHaveBeenCalled()
    expect(mockedPrisma.activityLog.create).not.toHaveBeenCalled()
  })

  describe('when the tier drops', () => {
    beforeEach(() => {
      mockedPrisma.referral.findFirst.mockResolvedValue(baseReferral)
      mockedPrisma.customer.update.mockResolvedValue({
        id: 'cust_ref',
        referralCount: 6,
        referralTier: 'TIER_1',
      })
      mockedPrisma.referralProgramConfig.findUnique.mockResolvedValue(baseConfig)
    })

    it('revokes an unredeemed PERCENT_COUPON grant', async () => {
      mockedPrisma.referralRewardGrant.findMany.mockResolvedValue([
        {
          id: 'grant_1',
          rewardType: 'PERCENT_COUPON',
          status: 'ISSUED',
          discountId: 'disc_1',
          couponCodeId: 'coupon_1',
        },
      ])
      mockedPrisma.couponRedemption.findFirst.mockResolvedValue(null) // not redeemed
      mockedPrisma.discount.update.mockResolvedValue({ id: 'disc_1' })
      mockedPrisma.couponCode.updateMany.mockResolvedValue({ count: 1 })
      mockedPrisma.customerDiscount.updateMany.mockResolvedValue({ count: 1 })

      await onOrderRefunded({ orderId: 'o1', venueId: 'v1' })

      expect(mockedPrisma.discount.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'disc_1' },
          data: expect.objectContaining({ active: false }),
        }),
      )
      expect(mockedPrisma.couponCode.updateMany).toHaveBeenCalledWith({
        where: { discountId: 'disc_1' },
        data: { active: false },
      })
      expect(mockedPrisma.referralRewardGrant.update).toHaveBeenCalledWith({
        where: { id: 'grant_1' },
        data: expect.objectContaining({ status: 'REVOKED', revokedAt: expect.any(Date) }),
      })
    })

    it('does NOT revoke a REDEEMED coupon grant', async () => {
      mockedPrisma.referralRewardGrant.findMany.mockResolvedValue([
        {
          id: 'grant_1',
          rewardType: 'PERCENT_COUPON',
          status: 'REDEEMED',
          discountId: 'disc_1',
          couponCodeId: 'coupon_1',
        },
      ])
      await onOrderRefunded({ orderId: 'o1', venueId: 'v1' })
      expect(mockedPrisma.discount.update).not.toHaveBeenCalled()
      expect(mockedPrisma.referralRewardGrant.update).not.toHaveBeenCalled()
    })

    it('self-heals a stale ISSUED coupon grant to REDEEMED when a CouponRedemption already exists', async () => {
      mockedPrisma.referralRewardGrant.findMany.mockResolvedValue([
        {
          id: 'grant_1',
          rewardType: 'PERCENT_COUPON',
          status: 'ISSUED',
          discountId: 'disc_1',
          couponCodeId: 'coupon_1',
        },
      ])
      mockedPrisma.couponRedemption.findFirst.mockResolvedValue({ id: 'red_1' }) // already redeemed
      await onOrderRefunded({ orderId: 'o1', venueId: 'v1' })
      expect(mockedPrisma.discount.update).not.toHaveBeenCalled()
      expect(mockedPrisma.referralRewardGrant.update).toHaveBeenCalledWith({
        where: { id: 'grant_1' },
        data: { status: 'REDEEMED' },
      })
    })

    it('revokes a never-applied PERMANENT_DISCOUNT grant', async () => {
      mockedPrisma.referralRewardGrant.findMany.mockResolvedValue([
        {
          id: 'grant_2',
          rewardType: 'PERMANENT_DISCOUNT',
          status: 'ISSUED',
          discountId: 'disc_2',
          couponCodeId: null,
        },
      ])
      mockedPrisma.orderDiscount.findFirst.mockResolvedValue(null) // never applied
      mockedPrisma.discount.update.mockResolvedValue({ id: 'disc_2' })
      mockedPrisma.couponCode.updateMany.mockResolvedValue({ count: 0 })
      mockedPrisma.customerDiscount.updateMany.mockResolvedValue({ count: 1 })

      await onOrderRefunded({ orderId: 'o1', venueId: 'v1' })

      expect(mockedPrisma.orderDiscount.findFirst).toHaveBeenCalledWith({ where: { discountId: 'disc_2' } })
      expect(mockedPrisma.discount.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'disc_2' }, data: expect.objectContaining({ active: false }) }),
      )
      expect(mockedPrisma.customerDiscount.updateMany).toHaveBeenCalledWith({
        where: { discountId: 'disc_2' },
        data: { active: false },
      })
      expect(mockedPrisma.referralRewardGrant.update).toHaveBeenCalledWith({
        where: { id: 'grant_2' },
        data: expect.objectContaining({ status: 'REVOKED' }),
      })
    })

    it('marks an already-applied PERMANENT_DISCOUNT grant REVOKED (no clawback)', async () => {
      mockedPrisma.referralRewardGrant.findMany.mockResolvedValue([
        {
          id: 'grant_2',
          rewardType: 'PERMANENT_DISCOUNT',
          status: 'ISSUED',
          discountId: 'disc_2',
          couponCodeId: null,
        },
      ])
      mockedPrisma.orderDiscount.findFirst.mockResolvedValue({ id: 'od1' } as any) // ya aplicado
      mockedPrisma.discount.update.mockResolvedValue({ id: 'disc_2' })
      mockedPrisma.couponCode.updateMany.mockResolvedValue({ count: 0 })
      mockedPrisma.customerDiscount.updateMany.mockResolvedValue({ count: 1 })

      await onOrderRefunded({ orderId: 'o1', venueId: 'v1' })

      // No retroactive clawback: the historical OrderDiscount is never touched.
      expect(mockedPrisma.orderDiscount.findFirst).toHaveBeenCalled()
      // But the Discount IS deactivated going forward...
      expect(mockedPrisma.discount.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'disc_2' }, data: expect.objectContaining({ active: false }) }),
      )
      // ...and the grant must NEVER be left ISSUED — always REVOKED, state must not lie.
      expect(mockedPrisma.referralRewardGrant.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'grant_2' },
          data: expect.objectContaining({ status: 'REVOKED', revokeReason: expect.stringContaining('permanente') }),
        }),
      )
    })

    it('revokes a MANUAL_PENDING FREE_PRODUCT grant', async () => {
      mockedPrisma.referralRewardGrant.findMany.mockResolvedValue([
        {
          id: 'grant_3',
          rewardType: 'FREE_PRODUCT',
          status: 'MANUAL_PENDING',
          discountId: null,
          couponCodeId: null,
        },
      ])
      await onOrderRefunded({ orderId: 'o1', venueId: 'v1' })
      expect(mockedPrisma.referralRewardGrant.update).toHaveBeenCalledWith({
        where: { id: 'grant_3' },
        data: expect.objectContaining({ status: 'REVOKED' }),
      })
    })

    it('does NOT revoke a MANUAL_FULFILLED FREE_PRODUCT grant', async () => {
      mockedPrisma.referralRewardGrant.findMany.mockResolvedValue([
        {
          id: 'grant_3',
          rewardType: 'FREE_PRODUCT',
          status: 'MANUAL_FULFILLED',
          discountId: null,
          couponCodeId: null,
        },
      ])
      await onOrderRefunded({ orderId: 'o1', venueId: 'v1' })
      expect(mockedPrisma.referralRewardGrant.update).not.toHaveBeenCalled()
    })

    it('does not delete the ReferralTierUnlock on refund', async () => {
      mockedPrisma.referralRewardGrant.findMany.mockResolvedValue([])
      await onOrderRefunded({ orderId: 'o1', venueId: 'v1' })
      expect(mockedPrisma.referralTierUnlock.delete).not.toHaveBeenCalled()
    })

    it('handles multiple grants of different types in the same tier crossing', async () => {
      mockedPrisma.referralRewardGrant.findMany.mockResolvedValue([
        { id: 'grant_1', rewardType: 'PERCENT_COUPON', status: 'ISSUED', discountId: 'disc_1', couponCodeId: 'coupon_1' },
        { id: 'grant_2', rewardType: 'PERMANENT_DISCOUNT', status: 'ISSUED', discountId: 'disc_2', couponCodeId: null },
        { id: 'grant_3', rewardType: 'FREE_PRODUCT', status: 'MANUAL_PENDING', discountId: null, couponCodeId: null },
      ])
      mockedPrisma.couponRedemption.findFirst.mockResolvedValue(null)
      mockedPrisma.orderDiscount.findFirst.mockResolvedValue(null)
      mockedPrisma.discount.update.mockResolvedValue({ id: 'disc_x' })
      mockedPrisma.couponCode.updateMany.mockResolvedValue({ count: 1 })
      mockedPrisma.customerDiscount.updateMany.mockResolvedValue({ count: 1 })

      await onOrderRefunded({ orderId: 'o1', venueId: 'v1' })

      expect(mockedPrisma.referralRewardGrant.update).toHaveBeenCalledTimes(3)
      expect(mockedPrisma.activityLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            data: expect.objectContaining({
              revokedGrantIds: expect.arrayContaining(['grant_1', 'grant_2', 'grant_3']),
            }),
          }),
        }),
      )
    })
  })
})
