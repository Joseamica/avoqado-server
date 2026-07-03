import prisma from '@/utils/prismaClient'
import { ReferralStatus, ReferralTier } from '@prisma/client'

export interface ListReferralsInput {
  venueId: string
  status?: ReferralStatus
  tier?: ReferralTier
  dateFrom?: Date
  dateTo?: Date
  page?: number
  pageSize?: number
}

/**
 * Full referral history where one customer is the REFERRER. Powers the
 * dashboard's per-customer ReferralCard (un-paginated: a single referrer's
 * history is small by nature).
 *
 * A referral's tier crossing can emit SEVERAL rewards (Task 3/4 configurable
 * rewards: e.g. a PERCENT_COUPON + a FREE_PRODUCT on the same tier), so this
 * projects the full `ReferralRewardGrant[]` as `rewards`. `rewardDiscount`
 * (single, via the legacy `Referral.rewardDiscountId` FK) is kept in the
 * response — DEPRECATED but still populated by
 * `referralQualification.service` as "first discount-bearing grant" — per
 * the cross-repo rule to never remove API response fields. New dashboard
 * code should read `rewards`, not `rewardDiscount`.
 */
export async function listCustomerReferrals(venueId: string, customerId: string) {
  const referrals = await prisma.referral.findMany({
    where: { venueId, referrerCustomerId: customerId },
    include: {
      referrerCustomer: { select: { id: true, firstName: true, lastName: true, referralTier: true } },
      referredCustomer: { select: { id: true, firstName: true, lastName: true } },
      // DEPRECATED (see doc above) — kept for callers not yet migrated to `rewards[]`.
      rewardDiscount: { select: { id: true, value: true, active: true } },
      referralGrants: {
        select: {
          id: true,
          rewardType: true,
          rewardPercent: true,
          rewardProductId: true,
          rewardQuantity: true,
          status: true,
          fulfilledAt: true,
          discount: { select: { couponCodes: { select: { code: true }, take: 1 } } },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  })

  return referrals.map(({ referralGrants, ...referral }) => ({
    ...referral,
    rewards: referralGrants.map(grant => ({
      id: grant.id,
      rewardType: grant.rewardType,
      rewardPercent: grant.rewardPercent,
      rewardProductId: grant.rewardProductId,
      rewardQuantity: grant.rewardQuantity,
      status: grant.status,
      fulfilledAt: grant.fulfilledAt,
      couponCode: grant.discount?.couponCodes?.[0]?.code ?? null,
    })),
  }))
}

export async function listReferrals(input: ListReferralsInput) {
  const page = input.page ?? 1
  const pageSize = input.pageSize ?? 25
  const where: any = { venueId: input.venueId }
  if (input.status) where.status = input.status
  if (input.dateFrom || input.dateTo) {
    where.createdAt = {}
    if (input.dateFrom) where.createdAt.gte = input.dateFrom
    if (input.dateTo) where.createdAt.lte = input.dateTo
  }
  if (input.tier) {
    where.referrerCustomer = { referralTier: input.tier }
  }
  const [rawItems, total] = await Promise.all([
    prisma.referral.findMany({
      where,
      include: {
        referrerCustomer: { select: { id: true, firstName: true, lastName: true, referralTier: true } },
        referredCustomer: { select: { id: true, firstName: true, lastName: true } },
        // DEPRECATED (see listCustomerReferrals doc above) — kept for callers not yet migrated to `rewards[]`.
        rewardDiscount: { select: { id: true, value: true, active: true } },
        referralGrants: {
          select: {
            id: true,
            rewardType: true,
            rewardPercent: true,
            rewardProductId: true,
            rewardQuantity: true,
            status: true,
            fulfilledAt: true,
            discount: { select: { couponCodes: { select: { code: true }, take: 1 } } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.referral.count({ where }),
  ])

  const items = rawItems.map(({ referralGrants, ...referral }) => ({
    ...referral,
    rewards: referralGrants.map(grant => ({
      id: grant.id,
      rewardType: grant.rewardType,
      rewardPercent: grant.rewardPercent,
      rewardProductId: grant.rewardProductId,
      rewardQuantity: grant.rewardQuantity,
      status: grant.status,
      fulfilledAt: grant.fulfilledAt,
      couponCode: grant.discount?.couponCodes?.[0]?.code ?? null,
    })),
  }))

  return { items, total, page, pageSize }
}

export async function getReferralSummary(venueId: string) {
  const startOfMonth = new Date()
  startOfMonth.setDate(1)
  startOfMonth.setHours(0, 0, 0, 0)
  const startOfPrevMonth = new Date(startOfMonth)
  startOfPrevMonth.setMonth(startOfPrevMonth.getMonth() - 1)

  const [thisMonth, prevMonth, qualifiedThisMonth, pendingThisMonth] = await Promise.all([
    prisma.referral.count({ where: { venueId, createdAt: { gte: startOfMonth } } }),
    prisma.referral.count({
      where: { venueId, createdAt: { gte: startOfPrevMonth, lt: startOfMonth } },
    }),
    prisma.referral.count({
      where: { venueId, status: 'QUALIFIED', qualifiedAt: { gte: startOfMonth } },
    }),
    prisma.referral.count({
      where: { venueId, status: 'PENDING', createdAt: { gte: startOfMonth } },
    }),
  ])

  const couponsEmittedThisMonth = await prisma.discount.count({
    where: { venueId, source: 'REFERRAL_TIER', createdAt: { gte: startOfMonth } },
  })

  const topReferrer = await prisma.customer.findFirst({
    where: { venueId, referralCount: { gt: 0 } },
    orderBy: { referralCount: 'desc' },
    select: { id: true, firstName: true, lastName: true, referralCount: true, referralTier: true },
  })

  return {
    referralsThisMonth: thisMonth,
    referralsPrevMonth: prevMonth,
    conversionRate: thisMonth > 0 ? qualifiedThisMonth / thisMonth : 0,
    qualifiedThisMonth,
    pendingThisMonth,
    couponsEmittedThisMonth,
    topReferrer,
  }
}

export async function getHallOfFame(venueId: string, limit: number = 10) {
  return prisma.customer.findMany({
    where: { venueId, referralCount: { gt: 0 } },
    orderBy: { referralCount: 'desc' },
    take: limit,
    select: {
      id: true,
      firstName: true,
      lastName: true,
      referralCount: true,
      referralTier: true,
      tierUnlockedAt: true,
    },
  })
}
