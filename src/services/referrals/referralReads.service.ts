import prisma from '@/utils/prismaClient'
import { ReferralStatus, ReferralTier } from '@prisma/client'
import { fromZonedTime } from 'date-fns-tz'
import { getVenueTimezone } from '@/services/dashboard/commission/commission-utils'
import { zonaValida } from '@/utils/datetime'
import { venueCivilDate } from '@/utils/venueDateKeys'

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
      // `id` is the TIEBREAK — without it a tie group crossing a skip/take page boundary repeats a row
      // on one page and drops another for good (Asana 1217127206664238).
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
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
  // D19: «este mes» empieza el día 1 a la medianoche del NEGOCIO. `setDate(1)` + `setHours(0)` daban la del proceso (UTC
  // en producción): en CDMX el mes empezaba a las 18:00 del último día del mes anterior.
  const timezone = zonaValida(await getVenueTimezone(venueId))
  const { year, month } = venueCivilDate(new Date(), timezone)
  const monthStart = (offset: number) =>
    fromZonedTime(`${new Date(Date.UTC(year, month - 1 + offset, 1)).toISOString().slice(0, 10)}T00:00:00.000`, timezone)
  const startOfMonth = monthStart(0)
  const startOfPrevMonth = monthStart(-1)

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
  // D32: «Premios emitidos» del panel = TODOS los premios de nivel del mes, también el producto gratis (que no crea
  // descuento). Cada premio deja una sola fila de `ReferralRewardGrant` (única por cliente, nivel y premio), y un premio
  // revocado después sigue contando porque sí se emitió. Campo propio: `couponsEmittedThisMonth` conserva su significado.
  // ponytail: filtra por el índice de `venueId` y luego por fecha; los premios son pocos por negocio (≤ 3 niveles por
  // cliente que llega a nivel). Si un negocio llega a miles de premios, índice `(venueId, createdAt)`.
  const rewardsIssuedThisMonth = await prisma.referralRewardGrant.count({
    where: { venueId, createdAt: { gte: startOfMonth } },
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
    rewardsIssuedThisMonth,
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
