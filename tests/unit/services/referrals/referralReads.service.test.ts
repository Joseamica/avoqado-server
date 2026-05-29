import { listReferrals, getReferralSummary, getHallOfFame } from '@/services/referrals/referralReads.service'
import prisma from '@/utils/prismaClient'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    referral: { findMany: jest.fn(), count: jest.fn() },
    customer: { findFirst: jest.fn(), findMany: jest.fn() },
    discount: { count: jest.fn() },
  },
}))

const mockedPrisma = prisma as any

describe('referralReads.service', () => {
  beforeEach(() => jest.clearAllMocks())

  describe('listReferrals', () => {
    it('returns paginated list with default page/pageSize', async () => {
      mockedPrisma.referral.findMany.mockResolvedValue([{ id: 'r1' }, { id: 'r2' }])
      mockedPrisma.referral.count.mockResolvedValue(2)
      const result = await listReferrals({ venueId: 'v1' })
      expect(result.items.length).toBe(2)
      expect(result.total).toBe(2)
      expect(result.page).toBe(1)
      expect(result.pageSize).toBe(25)
    })

    it('filters by status', async () => {
      mockedPrisma.referral.findMany.mockResolvedValue([])
      mockedPrisma.referral.count.mockResolvedValue(0)
      await listReferrals({ venueId: 'v1', status: 'QUALIFIED' })
      expect(mockedPrisma.referral.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ status: 'QUALIFIED' }) }),
      )
    })

    it('filters by tier (via referrerCustomer.referralTier)', async () => {
      mockedPrisma.referral.findMany.mockResolvedValue([])
      mockedPrisma.referral.count.mockResolvedValue(0)
      await listReferrals({ venueId: 'v1', tier: 'TIER_1' })
      expect(mockedPrisma.referral.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            referrerCustomer: expect.objectContaining({ referralTier: 'TIER_1' }),
          }),
        }),
      )
    })
  })

  describe('getReferralSummary', () => {
    it('returns this-month, prev-month, conversion, qualified, pending, coupons, top referrer', async () => {
      mockedPrisma.referral.count.mockResolvedValue(0)
      mockedPrisma.discount.count.mockResolvedValue(0)
      mockedPrisma.customer.findFirst.mockResolvedValue(null)
      const result = await getReferralSummary('v1')
      expect(result).toMatchObject({
        referralsThisMonth: 0,
        referralsPrevMonth: 0,
        qualifiedThisMonth: 0,
        pendingThisMonth: 0,
        couponsEmittedThisMonth: 0,
        topReferrer: null,
      })
      expect(result.conversionRate).toBe(0)
    })

    it('computes conversion rate when there are referrals', async () => {
      // call order in service: thisMonth, prevMonth, qualifiedThisMonth, pendingThisMonth, couponsEmittedThisMonth
      mockedPrisma.referral.count
        .mockResolvedValueOnce(10) // thisMonth
        .mockResolvedValueOnce(5)  // prevMonth
        .mockResolvedValueOnce(8)  // qualifiedThisMonth
        .mockResolvedValueOnce(2)  // pendingThisMonth
      mockedPrisma.discount.count.mockResolvedValue(3)
      mockedPrisma.customer.findFirst.mockResolvedValue({ id: 'c1', firstName: 'Jose', lastName: 'P', referralCount: 7, referralTier: 'TIER_1' })
      const result = await getReferralSummary('v1')
      expect(result.conversionRate).toBe(0.8)
      expect(result.couponsEmittedThisMonth).toBe(3)
      expect(result.topReferrer?.referralCount).toBe(7)
    })
  })

  describe('getHallOfFame', () => {
    it('returns top customers ordered by referralCount desc', async () => {
      mockedPrisma.customer.findMany.mockResolvedValue([
        { id: 'c1', firstName: 'Jose', lastName: 'P', referralCount: 10, referralTier: 'TIER_2' },
      ])
      const result = await getHallOfFame('v1', 5)
      expect(mockedPrisma.customer.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { venueId: 'v1', referralCount: { gt: 0 } },
          orderBy: { referralCount: 'desc' },
          take: 5,
        }),
      )
      expect(result.length).toBe(1)
    })
  })
})
