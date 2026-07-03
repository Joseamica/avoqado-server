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
 * Everything `onOrderPaid`'s transaction needs to hand off to the
 * fire-and-forget tier-up email step that runs AFTER commit. `null` means
 * "nothing to email" (no-op claim, no tier crossed, or already-unlocked
 * re-cross) — the caller treats `null` as "return early, no email".
 */
interface OnOrderPaidTxResult {
  referrer: { id: string; firstName: string | null; lastName: string | null; referralCount: number }
  newTier: ReferralTier
  emitted: EmittedTierReward[]
  config: ReferralProgramConfig
}

/**
 * Event handler called from the payment-settled webhook. Implements the
 * spec §5 seven-step flow, ALL inside one `prisma.$transaction` so the
 * claim, the increment, the unlock guard and the reward emission either
 * all land together or none do:
 *
 *   1. CAS claim BY ORDER: `Referral.updateMany({ qualifyingOrderId,
 *      status: 'PENDING' } → status: 'QUALIFIED')`. `count === 0` means
 *      another execution (or a duplicate webhook) already claimed this
 *      order, or there never was a PENDING referral for it — no-op.
 *      The partial-unique index on `qualifyingOrderId` guarantees at
 *      most one claimable referral per order, so this claim can never
 *      double-count even under concurrent retries.
 *   2. Re-fetch the just-claimed referral (`updateMany` doesn't return
 *      rows).
 *   3. Increment the referrer's `referralCount` — safe now that the
 *      claim above prevents a double-increment for the same order.
 *   4. Recompute the tier. No NEW tier crossed → commit as-is (claim +
 *      increment stand) and return.
 *   5. Unlock guard: `ReferralTierUnlock.createMany({ skipDuplicates:
 *      true })` on `(customerId, tierLevel)`. `count === 0` means this
 *      customer already earned this level once before (e.g. re-crossing
 *      the threshold after a refund revoked their prior grants — tiers
 *      are earned ONCE per lifetime, spec D11) — skip emission, do NOT
 *      re-mint rewards. `count === 1` → fresh unlock, emit.
 *   6. `Customer.referralTier` / `tierUnlockedAt` / `tierUpModalSeenAt`
 *      updated in the SAME tx — see the note below on why this runs
 *      even when the unlock guard skipped emission.
 *   7. `ActivityLog` REFERRAL_TIER_UNLOCKED listing every grant (empty
 *      list when the unlock guard skipped).
 *
 * ⚠️ We NEVER try/catch a P2002 for the CAS claim or the unlock guard —
 * both use `updateMany`/`createMany({ skipDuplicates: true })` + a
 * `count` check specifically because a real unique-constraint violation
 * would abort the whole Postgres transaction, rolling back the claim,
 * the increment, and any grants already written in this same tx.
 *
 * Design decision — Customer.referralTier stays in sync even when the
 * unlock guard skips (documented per the task brief, see task-5-report.md
 * for the full writeup): `referralRefund.service.ts` treats
 * `Customer.referralTier` as a live projection of `referralCount` (it
 * freely lowers it, including to `null`, when a refund drops the
 * referrer below a threshold — see `onOrderRefunded`). `ReferralTierUnlock`
 * is the SEPARATE "earned once, for reward-emission purposes" ledger.
 * Keeping these two concerns decoupled — `referralTier` always reflects
 * "what tier does this count currently justify", `ReferralTierUnlock`
 * answers "has this reward already been paid out" — means a customer who
 * gets refunded down and then re-earns the same tier sees their tier
 * badge correctly restored, without us paying out the reward a second
 * time. The alternative (freezing `referralTier` at whatever the refund
 * left it) would leave the displayed tier permanently wrong for anyone
 * who re-crosses a threshold post-refund.
 */
export async function onOrderPaid(input: OnOrderPaidInput): Promise<void> {
  const txResult = await prisma.$transaction(async tx => {
    // Step 1: CAS claim by order. `count === 0` → someone else already
    // claimed this order (concurrent execution or duplicate webhook), or
    // there is no PENDING referral for it. Either way, no-op.
    const claim = await tx.referral.updateMany({
      where: { qualifyingOrderId: input.orderId, status: 'PENDING' },
      data: { status: 'QUALIFIED', qualifiedAt: new Date() },
    })
    if (claim.count === 0) return null

    // Step 2: `updateMany` doesn't return rows — re-fetch the referral we
    // just claimed (now QUALIFIED, and per the partial-unique index there
    // is at most one such row for this order).
    const referral = await tx.referral.findFirst({
      where: { qualifyingOrderId: input.orderId, status: 'QUALIFIED' },
    })
    /* istanbul ignore if -- defensive only: claim.count === 1 guarantees this row exists */
    if (!referral) return null

    // Step 3: increment the referrer's referralCount — safe from
    // double-counting because step 1 already ensured this is the only
    // execution that will reach this line for this order.
    const referrer = await tx.customer.update({
      where: { id: referral.referrerCustomerId },
      data: { referralCount: { increment: 1 } },
    })

    const config = await tx.referralProgramConfig.findUnique({
      where: { venueId: input.venueId },
    })
    if (!config) return null

    // Step 4: no NEW tier crossed → commit the claim + increment as-is.
    const newTier = computeTier(referrer.referralCount, config)
    if (!newTier || newTier === referrer.referralTier) return null

    // Step 5: unlock guard — a tier is earned ONCE per customer lifetime
    // (spec D11). `count === 0` → already unlocked previously (e.g.
    // re-crossing after a refund revoked the prior grants) — skip
    // emission, don't re-mint. `count === 1` → fresh unlock, emit.
    const unlock = await tx.referralTierUnlock.createMany({
      data: [{ customerId: referrer.id, tierLevel: tierToLevel(newTier), unlockedByReferralId: referral.id }],
      skipDuplicates: true,
    })

    const emitted: EmittedTierReward[] =
      unlock.count > 0
        ? await emitTierRewards(tx, {
            venueId: input.venueId,
            customer: { id: referrer.id, firstName: referrer.firstName, lastName: referrer.lastName },
            tierLevel: tierToLevel(newTier),
            config,
            referralId: referral.id,
          })
        : []

    // Step 6: keep Customer.referralTier in sync with the live count
    // regardless of whether this is a fresh unlock or an already-earned
    // re-cross (see design decision in the function doc above).
    await tx.customer.update({
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
    // around grants) keeps working. Nothing to point at when the unlock
    // guard skipped emission, or when the tier configures ONLY FREE_PRODUCT.
    const firstDiscount = emitted.find(e => e.discount)?.discount
    if (firstDiscount) {
      await tx.referral.update({
        where: { id: referral.id },
        data: { rewardDiscountId: firstDiscount.id },
      })
    }

    // Step 7: ActivityLog — always written on a tier crossing, even when
    // the unlock guard skipped emission, so the audit trail shows the
    // re-cross happened (grants: [] + alreadyUnlocked: true documents why
    // nothing was minted).
    await tx.activityLog.create({
      data: {
        venueId: input.venueId,
        action: 'REFERRAL_TIER_UNLOCKED',
        entity: 'Customer',
        entityId: referrer.id,
        data: {
          tier: newTier,
          triggeringReferralId: referral.id,
          alreadyUnlocked: unlock.count === 0,
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

    return { referrer, newTier, emitted, config } as OnOrderPaidTxResult
  })

  if (!txResult) return
  const { referrer, newTier, emitted, config } = txResult

  // Tier-up email — fire-and-forget, OUTSIDE the transaction. Wrapped in
  // try/catch so a Resend / satori / resvg failure can never break the
  // payment-paid event handler (we'd rather lose the email than lose the
  // qualification + reward bundle that already committed).
  //
  // Only sent when the tier granted a PERCENT_COUPON (the email template
  // is built around "here's your coupon code"). A tier configured with
  // ONLY PERMANENT_DISCOUNT / FREE_PRODUCT rewards — or an already-earned
  // re-cross where nothing was (re-)emitted — skips the email.
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
