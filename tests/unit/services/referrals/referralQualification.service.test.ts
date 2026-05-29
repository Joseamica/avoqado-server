/**
 * referralQualification.service tests — Phase B3, Task 12
 *
 * Closes the "happy path" loop: when an Order linked to a PENDING
 * Referral is paid, the referrer's count is incremented and — if a
 * tier threshold is crossed — a 3-record reward bundle is created
 * atomically (Discount + CustomerDiscount + CouponCode).
 *
 * Schema notes:
 *   - No `Coupon` model. The reward is modeled as Discount (parent)
 *     plus CustomerDiscount (referrer's entitlement) plus CouponCode
 *     (shareable code).
 *   - DiscountType enum value is `PERCENTAGE` (not `PERCENT`).
 *   - ActivityLog's JSON payload column is `data` (inner), wrapped by
 *     Prisma's `data:` create argument (outer).
 */

import { computeTier, emitTierReward, onOrderPaid } from '@/services/referrals/referralQualification.service'
import prisma from '@/utils/prismaClient'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    $transaction: jest.fn(),
    referral: { findFirst: jest.fn(), update: jest.fn() },
    customer: { update: jest.fn() },
    referralProgramConfig: { findUnique: jest.fn() },
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

describe('emitTierReward', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockedPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockedPrisma))
  })

  it('creates Discount + CustomerDiscount + CouponCode atomically for TIER_1', async () => {
    mockedPrisma.discount.create.mockResolvedValue({ id: 'disc_1', value: 15 })
    mockedPrisma.customerDiscount.create.mockResolvedValue({ id: 'cd_1' })
    mockedPrisma.couponCode.create.mockResolvedValue({ id: 'cc_1', code: 'MINDFORM-TIER1-XYZ' })
    const config = {
      tier1RewardPercent: 15,
      tier2RewardPercent: 20,
      tier3RewardPercent: 25,
      rewardCouponExpiryDays: 90,
      codePrefix: 'MINDFORM',
    } as any
    const result = await emitTierReward({
      venueId: 'venue_1',
      referrer: { id: 'cust_abc123', firstName: 'Jose', lastName: 'P' },
      tier: 'TIER_1',
      config,
    })
    expect(mockedPrisma.discount.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          venueId: 'venue_1',
          value: 15,
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
        data: expect.objectContaining({
          customerId: 'cust_abc123',
          discountId: 'disc_1',
          active: true,
        }),
      }),
    )
    expect(mockedPrisma.couponCode.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          discountId: 'disc_1',
          code: expect.stringMatching(/^MINDFORM-TIER1-/),
          active: true,
        }),
      }),
    )
    expect(result.discount.id).toBe('disc_1')
    expect(result.couponCode.code).toMatch(/^MINDFORM-TIER1-/)
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

  it('emits tier reward + writes ActivityLog when crossing threshold', async () => {
    mockedPrisma.referral.findFirst.mockResolvedValue({
      id: 'ref_1',
      status: 'PENDING',
      referrerCustomerId: 'cust_ref',
    })
    mockedPrisma.customer.update
      .mockResolvedValueOnce({ id: 'cust_ref', firstName: 'Jose', lastName: 'P', referralCount: 7, referralTier: null }) // increment call
      .mockResolvedValueOnce({ id: 'cust_ref', referralTier: 'TIER_1' }) // set tier call
    mockedPrisma.referralProgramConfig.findUnique.mockResolvedValue({
      tier1ReferralsRequired: 7,
      tier2ReferralsRequired: 12,
      tier3ReferralsRequired: 20,
      tier1RewardPercent: 15,
      tier2RewardPercent: 20,
      tier3RewardPercent: 25,
      rewardCouponExpiryDays: 90,
      codePrefix: 'MINDFORM',
    })
    mockedPrisma.discount.create.mockResolvedValue({ id: 'disc_1' })
    mockedPrisma.customerDiscount.create.mockResolvedValue({ id: 'cd_1' })
    mockedPrisma.couponCode.create.mockResolvedValue({ id: 'cc_1' })
    await onOrderPaid({ orderId: 'o1', venueId: 'venue_1' })
    expect(mockedPrisma.discount.create).toHaveBeenCalled()
    expect(mockedPrisma.activityLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'REFERRAL_TIER_UNLOCKED',
          data: expect.objectContaining({ tier: 'TIER_1' }),
        }),
      }),
    )
  })

  it('does NOT emit reward when below threshold', async () => {
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
  })
})
