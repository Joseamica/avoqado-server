/**
 * referralRefund.service tests — Phase B3, Task 13
 *
 * Closes the "void path" loop: when an Order linked to a QUALIFIED
 * Referral is refunded, the Referral is voided, the referrer's count
 * is decremented, and any unredeemed tier reward is revoked. Rewards
 * that the referrer has already redeemed are preserved — we don't claw
 * back something the customer already cashed in.
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

import {
  onOrderRefunded,
  isRewardRedeemed,
  revokeTierReward,
} from '@/services/referrals/referralRefund.service'
import prisma from '@/utils/prismaClient'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    $transaction: jest.fn(),
    referral: { findFirst: jest.fn(), update: jest.fn() },
    customer: { update: jest.fn() },
    referralProgramConfig: { findUnique: jest.fn() },
    discount: { update: jest.fn() },
    customerDiscount: { updateMany: jest.fn() },
    couponCode: { updateMany: jest.fn() },
    couponRedemption: { findFirst: jest.fn() },
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
  beforeEach(() => {
    jest.clearAllMocks()
    mockedPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockedPrisma))
  })

  it('does nothing when no QUALIFIED Referral exists for this order', async () => {
    mockedPrisma.referral.findFirst.mockResolvedValue(null)
    await onOrderRefunded({ orderId: 'o1', venueId: 'v1' })
    expect(mockedPrisma.referral.update).not.toHaveBeenCalled()
  })

  it('voids Referral and decrements referrer count', async () => {
    mockedPrisma.referral.findFirst.mockResolvedValue({
      id: 'ref_1',
      status: 'QUALIFIED',
      referrerCustomerId: 'cust_ref',
      rewardDiscountId: null,
    })
    mockedPrisma.customer.update.mockResolvedValue({
      id: 'cust_ref',
      referralCount: 6,
      referralTier: 'TIER_1',
    })
    mockedPrisma.referralProgramConfig.findUnique.mockResolvedValue({
      tier1ReferralsRequired: 7,
      tier2ReferralsRequired: 12,
      tier3ReferralsRequired: 20,
    })
    await onOrderRefunded({ orderId: 'o1', venueId: 'v1' })
    expect(mockedPrisma.referral.update).toHaveBeenCalledWith({
      where: { id: 'ref_1' },
      data: expect.objectContaining({
        status: 'VOID',
        voidReason: 'ORDER_REFUNDED',
      }),
    })
  })

  it('revokes unredeemed reward when tier drops', async () => {
    mockedPrisma.referral.findFirst.mockResolvedValue({
      id: 'ref_1',
      status: 'QUALIFIED',
      referrerCustomerId: 'cust_ref',
      rewardDiscountId: 'disc_1',
    })
    mockedPrisma.customer.update.mockResolvedValue({
      id: 'cust_ref',
      referralCount: 6,
      referralTier: 'TIER_1',
    })
    mockedPrisma.referralProgramConfig.findUnique.mockResolvedValue({
      tier1ReferralsRequired: 7,
      tier2ReferralsRequired: 12,
      tier3ReferralsRequired: 20,
    })
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
  })

  it('preserves redeemed reward (no revoke) even if tier drops', async () => {
    mockedPrisma.referral.findFirst.mockResolvedValue({
      id: 'ref_1',
      status: 'QUALIFIED',
      referrerCustomerId: 'cust_ref',
      rewardDiscountId: 'disc_1',
    })
    mockedPrisma.customer.update.mockResolvedValue({
      id: 'cust_ref',
      referralCount: 6,
      referralTier: 'TIER_1',
    })
    mockedPrisma.referralProgramConfig.findUnique.mockResolvedValue({
      tier1ReferralsRequired: 7,
      tier2ReferralsRequired: 12,
      tier3ReferralsRequired: 20,
    })
    mockedPrisma.couponRedemption.findFirst.mockResolvedValue({ id: 'red_1' }) // ALREADY redeemed
    await onOrderRefunded({ orderId: 'o1', venueId: 'v1' })
    expect(mockedPrisma.discount.update).not.toHaveBeenCalled()
  })
})
