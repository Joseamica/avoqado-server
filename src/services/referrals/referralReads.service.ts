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
  const [items, total] = await Promise.all([
    prisma.referral.findMany({
      where,
      include: {
        referrerCustomer: { select: { id: true, firstName: true, lastName: true, referralTier: true } },
        referredCustomer: { select: { id: true, firstName: true, lastName: true } },
        rewardDiscount: { select: { id: true, value: true, active: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.referral.count({ where }),
  ])
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
