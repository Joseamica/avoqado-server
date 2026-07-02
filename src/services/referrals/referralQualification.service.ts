import prisma from '@/utils/prismaClient'
import {
  Prisma,
  ReferralTier,
  ReferralProgramConfig,
  ReferralTierReward,
  ReferralRewardGrant,
  ReferralRewardType,
  Discount,
  CouponCode,
} from '@prisma/client'

type TierConfig = Pick<ReferralProgramConfig, 'tier1ReferralsRequired' | 'tier2ReferralsRequired' | 'tier3ReferralsRequired'>

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

/**
 * `ReferralTier` ('TIER_1' | 'TIER_2' | 'TIER_3') → the plain Int level
 * used by `ReferralTierReward.tierLevel` / `ReferralRewardGrant.tierLevel`.
 */
export function tierToLevel(tier: ReferralTier): number {
  return Number(tier.split('_')[1])
}

export interface EmitTierRewardsInput {
  venueId: string
  customer: { id: string; firstName: string | null; lastName: string | null }
  /** Plain Int level (1 | 2 | 3) — matches `ReferralTierReward.tierLevel`. */
  tierLevel: number
  config: ReferralProgramConfig
  /** The Referral whose PAID order unlocked this tier, if any (for audit linkage). */
  referralId?: string
}

/**
 * One emitted reward: the (now-updated) grant row plus whichever artifact
 * was minted for it, if any. Shape chosen so a caller (today: `onOrderPaid`
 * below; tomorrow: Task 5's rewrite) never has to re-query for the
 * discount/coupon it just created — everything needed for the tier-up
 * email or the ActivityLog payload is already attached.
 */
export interface EmittedTierReward {
  grant: ReferralRewardGrant
  /** Present for PERCENT_COUPON and PERMANENT_DISCOUNT. Absent for FREE_PRODUCT. */
  discount?: Discount
  /** Present ONLY for PERCENT_COUPON. */
  couponCode?: CouponCode
}

/**
 * Prefix consistency: tier-coupon codes must share the same prefix the
 * customer's own referralCode uses. referralCode.service falls back to
 * venue.slug when config.codePrefix is null — mirror that here.
 * Normalize exactly like referralCode.service.normalizeVenuePrefix: strip
 * accents/non-alphanumerics, uppercase, cap at 8 chars.
 */
async function resolveCodePrefix(tx: Prisma.TransactionClient, venueId: string, config: ReferralProgramConfig): Promise<string> {
  let prefix = config.codePrefix
  if (!prefix) {
    const venue = await tx.venue.findUnique({
      where: { id: venueId },
      select: { slug: true },
    })
    prefix = venue?.slug ?? venueId.slice(-8)
  }
  return prefix
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase()
    .slice(0, 8)
}

/**
 * Mint a PERCENT_COUPON bundle: Discount (one-time, ORDER scope) +
 * CustomerDiscount (referrer's entitlement) + CouponCode (shareable
 * string). Same shape as the pre-Task-4 single-coupon `emitTierReward`.
 *
 * Code shape: `{PREFIX}-TIER{N}-{LAST6_OF_CUSTOMER_ID_UPPER}`. The
 * customer-id suffix keeps codes unique even when two customers unlock
 * the same tier in the same venue, without needing a separate sequence.
 */
async function mintPercentCoupon(
  tx: Prisma.TransactionClient,
  input: EmitTierRewardsInput,
  tierReward: ReferralTierReward,
): Promise<{ discount: Discount; couponCode: CouponCode }> {
  const prefix = await resolveCodePrefix(tx, input.venueId, input.config)
  const customerShort = input.customer.id.slice(-6).toUpperCase()
  const validUntil = new Date()
  validUntil.setDate(validUntil.getDate() + input.config.rewardCouponExpiryDays)
  const referrerName = [input.customer.firstName, input.customer.lastName].filter(Boolean).join(' ') || 'customer'
  const percent = tierReward.rewardPercent != null ? new Prisma.Decimal(tierReward.rewardPercent) : new Prisma.Decimal(0)

  const discount = await tx.discount.create({
    data: {
      venueId: input.venueId,
      name: `Referral TIER_${input.tierLevel} reward — ${referrerName}`,
      type: 'PERCENTAGE',
      value: percent,
      scope: 'ORDER',
      validUntil,
      maxUsesPerCustomer: 1,
      maxTotalUses: 1,
      active: true,
      source: 'REFERRAL_TIER',
    },
  })

  await tx.customerDiscount.create({
    data: {
      customerId: input.customer.id,
      discountId: discount.id,
      active: true,
      validUntil,
      maxUses: 1,
    },
  })

  const couponCode = await tx.couponCode.create({
    data: {
      discountId: discount.id,
      code: `${prefix}-TIER${input.tierLevel}-${customerShort}`,
      maxUses: 1,
      maxUsesPerCustomer: 1,
      active: true,
      validFrom: new Date(),
      validUntil,
    },
  })

  return { discount, couponCode }
}

/**
 * Mint a PERMANENT_DISCOUNT: an `isAutomatic` Discount with NO
 * `validUntil` / usage caps, applied by the discount engine on every
 * future order (spec §5, §8). No CouponCode — nothing to redeem, it
 * just always applies.
 */
async function mintPermanentDiscount(
  tx: Prisma.TransactionClient,
  input: EmitTierRewardsInput,
  tierReward: ReferralTierReward,
): Promise<Discount> {
  const referrerName = [input.customer.firstName, input.customer.lastName].filter(Boolean).join(' ') || 'customer'
  const percent = tierReward.rewardPercent != null ? new Prisma.Decimal(tierReward.rewardPercent) : new Prisma.Decimal(0)

  const discount = await tx.discount.create({
    data: {
      venueId: input.venueId,
      name: `Referral TIER_${input.tierLevel} permanent discount — ${referrerName}`,
      type: 'PERCENTAGE',
      value: percent,
      scope: 'ORDER',
      isAutomatic: true,
      validUntil: null,
      maxUsesPerCustomer: null,
      maxTotalUses: null,
      active: true,
      source: 'REFERRAL_TIER',
    },
  })

  await tx.customerDiscount.create({
    data: {
      customerId: input.customer.id,
      discountId: discount.id,
      active: true,
      validUntil: null,
      maxUses: null,
    },
  })

  return discount
}

/**
 * Emit every ACTIVE `ReferralTierReward` configured for `input.tierLevel`
 * as a `ReferralRewardGrant`, idempotently.
 *
 * MUST be called with a `tx` that is ALREADY an open transaction (the
 * caller owns transaction boundaries — see `onOrderPaid` below and the
 * full CAS-claim rewrite landing in Task 5). This function never opens
 * its own top-level `$transaction`.
 *
 * Idempotency (defense layer 2 of 3 per spec §5 — layers 1/3 are the
 * order-claim + `ReferralTierUnlock` guard added in Task 5):
 * `ReferralRewardGrant` has `@@unique([customerId, tierLevel, tierRewardId])`.
 * We claim a row via `createMany({ skipDuplicates: true })` and branch on
 * `count`:
 *   - `count === 0` → a grant for this (customer, tier, reward) already
 *     exists. Skip emission entirely — do NOT mint a second artifact.
 *   - `count === 1` → we won the race. Mint the artifact for this
 *     `rewardType` and `update` the grant with its id(s).
 *
 * ⚠️ We NEVER try/catch a P2002 here instead of skipDuplicates+count: a
 * unique-constraint violation ABORTS the entire Postgres transaction
 * (every prior write in this `tx`, including other tier rewards' grants,
 * would roll back). `createMany({ skipDuplicates: true })` avoids raising
 * the constraint error in the first place.
 */
export async function emitTierRewards(tx: Prisma.TransactionClient, input: EmitTierRewardsInput): Promise<EmittedTierReward[]> {
  const activeRewards = await tx.referralTierReward.findMany({
    where: { configId: input.config.id, tierLevel: input.tierLevel, active: true },
    orderBy: { createdAt: 'asc' },
  })

  const emitted: EmittedTierReward[] = []

  for (const tierReward of activeRewards) {
    const isFreeProduct = tierReward.rewardType === ReferralRewardType.FREE_PRODUCT

    const { count } = await tx.referralRewardGrant.createMany({
      data: [
        {
          venueId: input.venueId,
          customerId: input.customer.id,
          tierLevel: input.tierLevel,
          referralId: input.referralId ?? null,
          tierRewardId: tierReward.id,
          rewardType: tierReward.rewardType,
          rewardPercent: tierReward.rewardPercent != null ? new Prisma.Decimal(tierReward.rewardPercent) : null,
          rewardProductId: tierReward.rewardProductId,
          rewardQuantity: tierReward.rewardQuantity,
          status: isFreeProduct ? 'MANUAL_PENDING' : 'ISSUED',
        },
      ],
      skipDuplicates: true,
    })

    if (count === 0) {
      // Already granted for this (customer, tier, reward) — idempotent skip.
      // No double-mint of the artifact.
      continue
    }

    const grant = await tx.referralRewardGrant.findFirst({
      where: { customerId: input.customer.id, tierLevel: input.tierLevel, tierRewardId: tierReward.id },
    })
    // Defensive only — we just created it via createMany with count===1.
    if (!grant) continue

    if (tierReward.rewardType === ReferralRewardType.PERCENT_COUPON) {
      const { discount, couponCode } = await mintPercentCoupon(tx, input, tierReward)
      const updatedGrant = await tx.referralRewardGrant.update({
        where: { id: grant.id },
        data: { discountId: discount.id, couponCodeId: couponCode.id },
      })
      emitted.push({ grant: updatedGrant, discount, couponCode })
    } else if (tierReward.rewardType === ReferralRewardType.PERMANENT_DISCOUNT) {
      const discount = await mintPermanentDiscount(tx, input, tierReward)
      const updatedGrant = await tx.referralRewardGrant.update({
        where: { id: grant.id },
        data: { discountId: discount.id },
      })
      emitted.push({ grant: updatedGrant, discount })
    } else {
      // FREE_PRODUCT (v1, manual) — no automated artifact. The grant is
      // already MANUAL_PENDING; staff fulfills it later (Task 8).
      emitted.push({ grant })
    }
  }

  return emitted
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
 *   3. If that increment crossed a tier threshold, emit every configured
 *      reward for that tier as a grant (`emitTierRewards`), attach the
 *      first discount-bearing one to the Referral for back-compat, set
 *      `Customer.referralTier`, and emit a `REFERRAL_TIER_UNLOCKED`
 *      ActivityLog listing every grant.
 *
 * We intentionally re-check the existing tier before emitting so that
 * an idempotent retry of the same webhook doesn't double-mint rewards.
 *
 * NOTE (scope boundary): this function does NOT yet implement the
 * order-level CAS claim or the `ReferralTierUnlock` once-per-lifetime
 * guard from spec §5 — that's the Task 5 rewrite. `emitTierRewards`
 * itself is idempotent per-grant (unique constraint), so a retry here
 * cannot double-mint an individual reward, but a retry CAN still
 * re-increment `referralCount` — unchanged behavior from before Task 4,
 * not introduced by it.
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

  const emitted = await prisma.$transaction(tx =>
    emitTierRewards(tx, {
      venueId: input.venueId,
      customer: { id: referrer.id, firstName: referrer.firstName, lastName: referrer.lastName },
      tierLevel: tierToLevel(newTier),
      config,
      referralId: referral.id,
    }),
  )

  await prisma.customer.update({
    where: { id: referrer.id },
    data: {
      referralTier: newTier,
      tierUnlockedAt: new Date(),
      tierUpModalSeenAt: null,
    },
  })

  // `Referral.rewardDiscountId` predates per-tier N-rewards (single-bundle
  // era). Keep it pointing at the first discount-bearing grant so any code
  // still reading it (referralRefund.service, until Task 6 rewrites it
  // around grants) keeps working. A tier configured with ONLY FREE_PRODUCT
  // rewards leaves this null — nothing wrong, just nothing to point at.
  const firstDiscount = emitted.find(e => e.discount)?.discount
  if (firstDiscount) {
    await prisma.referral.update({
      where: { id: referral.id },
      data: { rewardDiscountId: firstDiscount.id },
    })
  }

  await prisma.activityLog.create({
    data: {
      venueId: input.venueId,
      action: 'REFERRAL_TIER_UNLOCKED',
      entity: 'Customer',
      entityId: referrer.id,
      data: {
        tier: newTier,
        triggeringReferralId: referral.id,
        grants: emitted.map(e => ({
          grantId: e.grant.id,
          tierRewardId: e.grant.tierRewardId,
          rewardType: e.grant.rewardType,
          status: e.grant.status,
          discountId: e.discount?.id ?? null,
          couponCode: e.couponCode?.code ?? null,
        })),
      },
    },
  })

  // Tier-up email — fire-and-forget. Wrapped in try/catch so a
  // Resend / satori / resvg failure can never break the payment-paid
  // event handler (we'd rather lose the email than lose the
  // qualification + reward bundle that already landed in the DB).
  //
  // Only sent when the tier granted a PERCENT_COUPON (the email template
  // is built around "here's your coupon code"). A tier configured with
  // ONLY PERMANENT_DISCOUNT / FREE_PRODUCT rewards skips the email in v1
  // — broadening the template to cover every rewardType is out of scope
  // for this task.
  const percentCouponReward = emitted.find(e => e.couponCode)
  try {
    if (percentCouponReward) {
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
          const rewardPercent = Number(percentCouponReward.grant.rewardPercent ?? 0)
          const { generateTierUpCard } = await import('@/services/referrals/referralCard.service')
          const { sendReferralTierUpEmail } = await import('@/services/email.service')
          const cardPng = await generateTierUpCard({
            customerName: [fullReferrer.firstName, fullReferrer.lastName].filter(Boolean).join(' ') || 'Cliente',
            venueName: venue.name,
            tier: newTier,
            tierLabel,
            referralCount: referrer.referralCount,
            rewardPercent,
            couponCode: percentCouponReward.couponCode!.code,
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
            couponCode: percentCouponReward.couponCode!.code,
            validDays: config.rewardCouponExpiryDays,
            cardPng,
          })
        }
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
