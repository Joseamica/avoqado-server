import prisma from '@/utils/prismaClient'
import {
  ReferralTier,
  ReferralProgramConfig,
  Discount,
  CustomerDiscount,
  CouponCode,
} from '@prisma/client'

type TierConfig = Pick<
  ReferralProgramConfig,
  'tier1ReferralsRequired' | 'tier2ReferralsRequired' | 'tier3ReferralsRequired'
>

/**
 * Pure-function tier resolver. Compares a referral count against the
 * three configured thresholds and returns the highest tier that's been
 * unlocked, or null if the count is still below tier 1.
 *
 * Inclusive on the threshold (`>=`) so the very order that brings the
 * referrer to exactly N referrals unlocks the tier — matching the
 * "your 7th referral wins" UX copy.
 */
export function computeTier(count: number, config: TierConfig): ReferralTier | null {
  if (count >= config.tier3ReferralsRequired) return 'TIER_3'
  if (count >= config.tier2ReferralsRequired) return 'TIER_2'
  if (count >= config.tier1ReferralsRequired) return 'TIER_1'
  return null
}

export interface EmitTierRewardInput {
  venueId: string
  referrer: { id: string; firstName: string | null; lastName: string | null }
  tier: ReferralTier
  config: ReferralProgramConfig
}

export interface TierRewardBundle {
  discount: Discount
  customerDiscount: CustomerDiscount
  couponCode: CouponCode
}

/**
 * Mint a tier reward as three linked rows in a single transaction:
 *
 *   1. Discount      — the parent rule (PERCENTAGE, ORDER scope, single-use,
 *                      tagged `source: REFERRAL_TIER` for analytics + revoke).
 *   2. CustomerDiscount — entitles the referrer to use the Discount.
 *   3. CouponCode    — the shareable string the referrer redeems at checkout.
 *
 * The bundle is atomic because partial creation (Discount without
 * CouponCode, etc.) would leak rewards that customers can never use or
 * track. Throwing inside the transaction triggers a Postgres rollback.
 *
 * Code shape: `{PREFIX}-TIER{N}-{LAST6_OF_CUSTOMER_ID_UPPER}`.
 * The customer-id suffix keeps codes unique even when two customers
 * unlock the same tier in the same venue, without needing a separate
 * sequence.
 */
export async function emitTierReward(input: EmitTierRewardInput): Promise<TierRewardBundle> {
  const percent = {
    TIER_1: input.config.tier1RewardPercent,
    TIER_2: input.config.tier2RewardPercent,
    TIER_3: input.config.tier3RewardPercent,
  }[input.tier]
  const prefix = input.config.codePrefix ?? 'VENUE'
  const tierNum = input.tier.split('_')[1]
  const customerShort = input.referrer.id.slice(-6).toUpperCase()
  const validUntil = new Date()
  validUntil.setDate(validUntil.getDate() + input.config.rewardCouponExpiryDays)
  const referrerName =
    [input.referrer.firstName, input.referrer.lastName].filter(Boolean).join(' ') || 'customer'

  return prisma.$transaction(async tx => {
    const discount = await tx.discount.create({
      data: {
        venueId: input.venueId,
        name: `Referral ${input.tier} reward — ${referrerName}`,
        type: 'PERCENTAGE',
        value: percent as any,
        scope: 'ORDER',
        validUntil,
        maxUsesPerCustomer: 1,
        maxTotalUses: 1,
        active: true,
        source: 'REFERRAL_TIER',
      },
    })

    const customerDiscount = await tx.customerDiscount.create({
      data: {
        customerId: input.referrer.id,
        discountId: discount.id,
        active: true,
        validUntil,
        maxUses: 1,
      },
    })

    const couponCode = await tx.couponCode.create({
      data: {
        discountId: discount.id,
        code: `${prefix.toUpperCase()}-TIER${tierNum}-${customerShort}`,
        maxUses: 1,
        maxUsesPerCustomer: 1,
        active: true,
        validFrom: new Date(),
        validUntil,
      },
    })

    return { discount, customerDiscount, couponCode }
  })
}

export interface OnOrderPaidInput {
  orderId: string
  venueId: string
}

/**
 * Event handler called from the payment-settled webhook. Walks the
 * referral state machine forward in three steps:
 *
 *   1. Flip the linked PENDING Referral to QUALIFIED (idempotent: if
 *      no PENDING row is found for this order, the function no-ops).
 *   2. Increment the referrer's `referralCount`.
 *   3. If that increment crossed a tier threshold, mint a reward
 *      bundle, attach it to the Referral, set `Customer.referralTier`,
 *      and emit a `REFERRAL_TIER_UNLOCKED` ActivityLog.
 *
 * We intentionally re-check the existing tier before emitting so that
 * an idempotent retry of the same webhook doesn't double-mint coupons.
 */
export async function onOrderPaid(input: OnOrderPaidInput): Promise<void> {
  const referral = await prisma.referral.findFirst({
    where: { qualifyingOrderId: input.orderId, status: 'PENDING' },
  })
  if (!referral) return

  await prisma.referral.update({
    where: { id: referral.id },
    data: { status: 'QUALIFIED', qualifiedAt: new Date() },
  })

  const referrer = await prisma.customer.update({
    where: { id: referral.referrerCustomerId },
    data: { referralCount: { increment: 1 } },
  })

  const config = await prisma.referralProgramConfig.findUnique({
    where: { venueId: input.venueId },
  })
  if (!config) return

  const newTier = computeTier(referrer.referralCount, config)
  if (!newTier || newTier === referrer.referralTier) return

  const bundle = await emitTierReward({
    venueId: input.venueId,
    referrer: { id: referrer.id, firstName: referrer.firstName, lastName: referrer.lastName },
    tier: newTier,
    config,
  })

  await prisma.customer.update({
    where: { id: referrer.id },
    data: {
      referralTier: newTier,
      tierUnlockedAt: new Date(),
      tierUpModalSeenAt: null,
    },
  })

  await prisma.referral.update({
    where: { id: referral.id },
    data: { rewardDiscountId: bundle.discount.id },
  })

  await prisma.activityLog.create({
    data: {
      venueId: input.venueId,
      action: 'REFERRAL_TIER_UNLOCKED',
      entity: 'Customer',
      entityId: referrer.id,
      data: {
        tier: newTier,
        couponCode: bundle.couponCode.code,
        discountId: bundle.discount.id,
        triggeringReferralId: referral.id,
      },
    },
  })

  // Tier-up email — fire-and-forget. Wrapped in try/catch so a
  // Resend / satori / resvg failure can never break the payment-paid
  // event handler (we'd rather lose the email than lose the
  // qualification + reward bundle that already landed in the DB).
  try {
    const fullReferrer = await prisma.customer.findUnique({
      where: { id: referrer.id },
      select: { email: true, firstName: true, lastName: true, marketingConsent: true },
    })
    if (fullReferrer?.email && fullReferrer.marketingConsent) {
      const venue = await prisma.venue.findUnique({
        where: { id: input.venueId },
        select: { name: true },
      })
      if (venue) {
        const tierLabel = { TIER_1: 'Nivel 1', TIER_2: 'Nivel 2', TIER_3: 'Nivel 3' }[newTier]
        const rewardPercent = Number(bundle.discount.value)
        const { generateTierUpCard } = await import('@/services/referrals/referralCard.service')
        const { sendReferralTierUpEmail } = await import('@/services/email.service')
        const cardPng = await generateTierUpCard({
          customerName:
            [fullReferrer.firstName, fullReferrer.lastName].filter(Boolean).join(' ') || 'Cliente',
          venueName: venue.name,
          tier: newTier,
          tierLabel,
          referralCount: referrer.referralCount,
          rewardPercent,
          couponCode: bundle.couponCode.code,
          validDays: config.rewardCouponExpiryDays,
        })
        await sendReferralTierUpEmail({
          to: fullReferrer.email,
          customerName: fullReferrer.firstName ?? 'Cliente',
          venueName: venue.name,
          tier: newTier,
          tierLabel,
          referralCount: referrer.referralCount,
          rewardPercent,
          couponCode: bundle.couponCode.code,
          validDays: config.rewardCouponExpiryDays,
          cardPng,
        })
      }
    }
  } catch (err) {
    console.error('[referral-tier-up-email] failed', {
      customerId: referrer.id,
      tier: newTier,
      err,
    })
  }
}
