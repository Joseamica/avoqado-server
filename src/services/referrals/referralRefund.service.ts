import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { Prisma, ReferralRewardGrant, ReferralTier } from '@prisma/client'
import { computeTier, tierToLevel } from './referralQualification.service'

type TxClient = Prisma.TransactionClient

/**
 * Why the qualifying sale stopped counting. Persisted verbatim on
 * `Referral.voidReason` and echoed in the `REFERRAL_TIER_REVERSED`
 * ActivityLog, so finance can tell "the customer got their money back" apart
 * from "the check was voided".
 */
export type ReferralRevertReason = 'ORDER_REFUNDED' | 'ORDER_CANCELLED'

/**
 * Has the referrer already redeemed their tier reward on a real order?
 * We check via the CouponCode relation rather than CustomerDiscount
 * usage counters because CouponRedemption is the authoritative record
 * (one row per actual checkout) — counters can drift if the API layer
 * forgets to increment them.
 *
 * Accepts an optional `tx` so callers inside `onOrderRefunded`'s
 * transaction can read through the SAME transaction client (default is
 * the top-level `prisma` for any standalone caller).
 */
export async function isRewardRedeemed(discountId: string, tx: TxClient | typeof prisma = prisma): Promise<boolean> {
  const redemption = await tx.couponRedemption.findFirst({
    where: { couponCode: { discountId } },
  })
  return redemption !== null
}

/**
 * Soft-deactivate all three rows of a tier reward bundle. We use
 * `active: false` rather than DELETE so the historical record survives
 * for analytics + dispute resolution.
 *
 * Only Discount carries the deactivation reason + timestamp; the child
 * rows just flip `active` to false because they inherit context from
 * the parent.
 *
 * Core logic runs against whatever `tx` it's given — callers that are
 * already inside a transaction (e.g. `onOrderRefunded`) MUST use this
 * directly so every write in the refund flow lands in ONE transaction.
 */
async function revokeTierRewardInTx(tx: TxClient, discountId: string, reason: string): Promise<void> {
  await tx.discount.update({
    where: { id: discountId },
    data: {
      active: false,
      deactivatedReason: reason,
      deactivatedAt: new Date(),
    },
  })
  await tx.couponCode.updateMany({
    where: { discountId },
    data: { active: false },
  })
  await tx.customerDiscount.updateMany({
    where: { discountId },
    data: { active: false },
  })
}

/**
 * Standalone public wrapper — opens its own transaction. No caller
 * outside this file uses it today, but it stays exported (and tested
 * directly) for any future one-off caller that isn't already inside a
 * transaction. `onOrderRefunded` does NOT use this — it calls
 * `revokeTierRewardInTx` with its own `tx` so the whole refund flow
 * commits or rolls back together.
 */
export async function revokeTierReward(discountId: string, reason: string): Promise<void> {
  await prisma.$transaction(async tx => {
    await revokeTierRewardInTx(tx, discountId, reason)
  })
}

export interface OnOrderRefundedInput {
  orderId: string
  venueId: string
}

export interface RevertReferralRewardInput extends OnOrderRefundedInput {
  reason: ReferralRevertReason
}

/**
 * Is this order reversed IN FULL? Only then does the reward go back.
 *
 * 🔴 Founder decision 2026-08-18: a PARTIAL refund does NOT revert the
 * reward. Booksy stops charging for a visit that did not happen; it does not
 * claw back a visit that happened and got partly discounted. Until now this
 * file was called unconditionally from BOTH refund paths
 * (`refund.tpv.service.ts`, `refund.dashboard.service.ts`), so refunding $20
 * of a $500 sale voided the referral and could revoke a coupon the referrer
 * had already earned. The guard lives HERE, not at the call sites, so every
 * present and future caller inherits it.
 *
 * Three ways to be fully reversed, in cheapest-first order:
 *   - the order is CANCELLED / DELETED (a voided check),
 *   - `paymentStatus` already reads REFUNDED,
 *   - completed REFUND payments cover the merchandise.
 *
 * ⚠️ MERCHANDISE, not `Order.total`: the total carries the tip, while
 * refunds only ever sum the sale part (`Payment.amount`; the tip travels in
 * `tipAmount`). Comparing against the tip-inclusive total means an order
 * with a tip NEVER crosses — the same trap that kept
 * `crossedFullRefundThreshold` from restocking inventory (audit 2026-08-12).
 *
 * This is a STATE predicate, not the edge-crossing one restock uses: it must
 * answer the same way on a retry, because the caller may run twice.
 */
async function isOrderFullyReversed(orderId: string, venueId: string): Promise<boolean> {
  const order = await prisma.order.findUnique({
    where: { id: orderId, venueId },
    select: { status: true, paymentStatus: true, total: true, tipAmount: true },
  })
  if (!order) return false

  if (order.status === 'CANCELLED' || order.status === 'DELETED') return true
  if (order.paymentStatus === 'REFUNDED') return true

  const merchandiseTotal = Math.max(0, Number(order.total) - Number(order.tipAmount ?? 0))
  if (merchandiseTotal <= 0.01) return false

  const refunds = await prisma.payment.findMany({
    where: { orderId, venueId, type: 'REFUND', status: 'COMPLETED' },
    select: { amount: true },
  })
  const totalRefundedSale = refunds.reduce((sum, p) => sum + Math.abs(Number(p.amount)), 0)
  return totalRefundedSale >= merchandiseTotal - 0.01
}

/**
 * THE entrypoint for "this sale stopped counting — take the reward back".
 *
 * Contract, and every clause of it is load-bearing:
 *   - **Never throws.** A refund or a cancellation that already moved money
 *     must not fail because a referral bookkeeping write failed. Callers
 *     don't need their own try/catch (the two existing ones keep theirs;
 *     that's harmless).
 *   - **Never silent.** Swallowing without a trail is exactly how a revoked
 *     reward survives and nobody finds out, so every skip and every failure
 *     writes a greppable `[referral]` line. The execution context stamps
 *     `venueName` / `correlationId` / `entrypoint` on it for free.
 *   - **Idempotent.** Reverting twice is a no-op: the second pass finds no
 *     QUALIFIED referral for the order.
 *   - **Only on a FULL reversal** — see `isOrderFullyReversed`.
 *
 * Call it from the refund paths and from order cancellation. It is a no-op
 * for an order that never qualified a referral, so wiring it in costs one
 * indexed read.
 */
export async function revertReferralRewardForOrder(input: RevertReferralRewardInput): Promise<void> {
  try {
    // Cheapest question first, and it is the common case by far: most orders
    // never qualified a referral. Asking it here keeps the hook silent and
    // costs one indexed read — logging a "referral" line on every ordinary
    // refund would be exactly the noise the log rules warn about.
    const qualified = await prisma.referral.findFirst({
      where: { qualifyingOrderId: input.orderId, venueId: input.venueId, status: 'QUALIFIED' },
      select: { id: true },
    })
    if (!qualified) return

    if (!(await isOrderFullyReversed(input.orderId, input.venueId))) {
      logger.info('[referral] reversión omitida: la venta calificadora no está revertida en su totalidad (reembolso parcial)', {
        orderId: input.orderId,
        venueId: input.venueId,
        referralId: qualified.id,
        reason: input.reason,
      })
      return
    }
    await revertQualifiedReferral(input)
  } catch (err) {
    logger.error('[referral] no se pudo revertir el premio de la venta calificadora', {
      orderId: input.orderId,
      venueId: input.venueId,
      reason: input.reason,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * `ReferralTier | null` → the plain Int level used to compare against
 * `ReferralRewardGrant.tierLevel`. `null` (no tier at all) is level 0,
 * so `{ tierLevel: { gt: 0 } }` correctly means "every grant, at any
 * level, must be revoked" when the referrer drops out of the program
 * entirely.
 */
function levelOf(tier: ReferralTier | null): number {
  return tier ? tierToLevel(tier) : 0
}

/**
 * Revoke a single `PERCENT_COUPON` grant per spec §6:
 *   - `status !== 'ISSUED'` (already REVOKED, or REDEEMED) → no-op, leave it.
 *   - `status === 'ISSUED'` and a CouponRedemption already exists (state
 *     drift — the coupon WAS used but nothing corrected the grant) →
 *     self-heal to REDEEMED. Do NOT touch the Discount/CouponCode; the
 *     customer keeps what they used.
 *   - `status === 'ISSUED'` and unredeemed → deactivate Discount +
 *     CouponCode (+ CustomerDiscount), grant → REVOKED.
 * Returns the grant id if it was REVOKED (for the ActivityLog summary).
 */
async function revokePercentCouponGrant(tx: TxClient, grant: ReferralRewardGrant, reason: string): Promise<string | null> {
  if (grant.status !== 'ISSUED') return null

  const redeemed = grant.discountId ? await isRewardRedeemed(grant.discountId, tx) : false
  if (redeemed) {
    // Grant fell out of sync with reality (redeemed but never marked) —
    // keep the state truthful without clawing back an already-used reward.
    await tx.referralRewardGrant.update({
      where: { id: grant.id },
      data: { status: 'REDEEMED' },
    })
    return null
  }

  if (grant.discountId) {
    await revokeTierRewardInTx(tx, grant.discountId, reason)
  }
  await tx.referralRewardGrant.update({
    where: { id: grant.id },
    data: { status: 'REVOKED', revokedAt: new Date(), revokeReason: reason },
  })
  return grant.id
}

/**
 * Revoke a single `PERMANENT_DISCOUNT` grant per spec §6. Usage is decided
 * via `OrderDiscount` — NOT `CouponRedemption` (a permanent discount has no
 * coupon to redeem, it just auto-applies on every order):
 *   - `status !== 'ISSUED'` → no-op.
 *   - Never applied (no `OrderDiscount` row references this Discount) →
 *     deactivate Discount + CustomerDiscount, grant → REVOKED.
 *   - Already applied at least once → STILL deactivate going forward (no
 *     retroactive clawback of the historical `OrderDiscount` rows) AND the
 *     grant → REVOKED with a reason documenting why — it must NEVER stay
 *     ISSUED (that would be a lie: the reward is gone, applied or not).
 */
async function revokePermanentDiscountGrant(tx: TxClient, grant: ReferralRewardGrant, reason: string): Promise<string | null> {
  if (grant.status !== 'ISSUED') return null

  const applied = grant.discountId ? await tx.orderDiscount.findFirst({ where: { discountId: grant.discountId } }) : null
  const revokeReason = applied ? 'permanente ya consumido, desactivado sin clawback' : reason

  if (grant.discountId) {
    await revokeTierRewardInTx(tx, grant.discountId, revokeReason)
  }
  await tx.referralRewardGrant.update({
    where: { id: grant.id },
    data: { status: 'REVOKED', revokedAt: new Date(), revokeReason },
  })
  return grant.id
}

/**
 * Revoke a single `FREE_PRODUCT` grant per spec §6:
 *   - `MANUAL_PENDING` (staff hasn't handed it over yet) → REVOKED.
 *   - `MANUAL_FULFILLED` (already handed over) → left alone, nothing to
 *     claw back from a physical product already given.
 */
async function revokeFreeProductGrant(tx: TxClient, grant: ReferralRewardGrant, reason: string): Promise<string | null> {
  if (grant.status !== 'MANUAL_PENDING') return null

  await tx.referralRewardGrant.update({
    where: { id: grant.id },
    data: { status: 'REVOKED', revokedAt: new Date(), revokeReason: reason },
  })
  return grant.id
}

/**
 * Event handler called from the refund / cancellation webhook. Reverses
 * the qualification side effects, ALL inside one `prisma.$transaction`
 * (a mid-flow failure must never strand a deactivated Discount whose
 * grant still reads ISSUED, or a decremented count with no matching
 * grant revocation):
 *
 *   1. Find the QUALIFIED Referral attached to this order; if none,
 *      no-op (idempotent).
 *   2. Flip it to VOID with reason `ORDER_REFUNDED`.
 *   3. Decrement the referrer's `referralCount`.
 *   4. Re-derive their tier. If it did NOT drop, stop — no grant is
 *      touched (referralTier is a live projection of referralCount, per
 *      Task 5's design: if other referrals still support the tier, the
 *      rewards this one triggered stay untouched).
 *   5. If it DID drop, load every `ReferralRewardGrant` the referrer no
 *      longer qualifies for and revoke each per its own `rewardType` +
 *      `status` (spec §6 table):
 *        - PERCENT_COUPON     → `revokePercentCouponGrant`
 *        - PERMANENT_DISCOUNT → `revokePermanentDiscountGrant`
 *        - FREE_PRODUCT       → `revokeFreeProductGrant`
 *
 *      ⚠️ Grants are looked up by `customerId` + `tierLevel`, NOT by
 *      `referralId`. A grant's `referralId` records only the ONE
 *      referral whose tier-crossing originally triggered the mint — the
 *      order being refunded here is almost always a DIFFERENT referral
 *      belonging to the same referrer. Filtering by `referralId` would
 *      return `[]` for every refund except the exact referral that
 *      happened to trigger the unlock, silently leaking every other
 *      reward. Instead we scope by `{ customerId: referral
 *      .referrerCustomerId, tierLevel: { gt: levelOf(newTier) }, status:
 *      { in: ['ISSUED', 'MANUAL_PENDING'] } }`: every non-terminal grant
 *      for a level the customer no longer qualifies for gets revoked;
 *      grants for levels still supported by the (lowered) count are left
 *      alone. REDEEMED / REVOKED / MANUAL_FULFILLED are terminal and
 *      excluded by the status filter — the self-heal branch inside
 *      `revokePercentCouponGrant` still runs because ISSUED-but-actually-
 *      redeemed coupons are included by that same filter.
 *
 *      `ReferralTierUnlock` is NEVER deleted here (D11: a tier is earned
 *      once per lifetime — refund revokes the grants, not the unlock, so
 *      re-crossing the threshold later does not re-mint the reward).
 *   6. Persist the new (possibly null) tier on Customer.
 *   7. Always emit a `REFERRAL_TIER_REVERSED` ActivityLog with old + new
 *      tier + the list of revoked grant ids so finance can reconcile.
 */
async function revertQualifiedReferral(input: RevertReferralRewardInput): Promise<void> {
  await prisma.$transaction(async tx => {
    const referral = await tx.referral.findFirst({
      where: { qualifyingOrderId: input.orderId, status: 'QUALIFIED' },
    })
    if (!referral) return

    await tx.referral.update({
      where: { id: referral.id },
      data: { status: 'VOID', voidedAt: new Date(), voidReason: input.reason },
    })

    const referrer = await tx.customer.update({
      where: { id: referral.referrerCustomerId },
      data: { referralCount: { decrement: 1 } },
    })

    const config = await tx.referralProgramConfig.findUnique({
      where: { venueId: input.venueId },
    })
    if (!config) return

    const newTier = computeTier(referrer.referralCount, config)
    if (newTier === referrer.referralTier) return

    // Tier dropped — revoke every grant the referrer no longer qualifies
    // for, scoped by customer + tier level (NOT referralId — see the
    // function doc above for why that would silently under-revoke).
    const grants = await tx.referralRewardGrant.findMany({
      where: {
        customerId: referral.referrerCustomerId,
        tierLevel: { gt: levelOf(newTier) },
        status: { in: ['ISSUED', 'MANUAL_PENDING'] },
      },
    })

    const revokedGrantIds: string[] = []
    for (const grant of grants) {
      let revokedId: string | null = null
      if (grant.rewardType === 'PERCENT_COUPON') {
        revokedId = await revokePercentCouponGrant(tx, grant, 'TIER_REVERSED_BY_REFUND')
      } else if (grant.rewardType === 'PERMANENT_DISCOUNT') {
        revokedId = await revokePermanentDiscountGrant(tx, grant, 'TIER_REVERSED_BY_REFUND')
      } else if (grant.rewardType === 'FREE_PRODUCT') {
        revokedId = await revokeFreeProductGrant(tx, grant, 'TIER_REVERSED_BY_REFUND')
      }
      if (revokedId) revokedGrantIds.push(revokedId)
    }

    await tx.customer.update({
      where: { id: referrer.id },
      data: {
        referralTier: newTier,
        tierUnlockedAt: newTier ? referrer.tierUnlockedAt : null,
      },
    })

    await tx.activityLog.create({
      data: {
        venueId: input.venueId,
        action: 'REFERRAL_TIER_REVERSED',
        entity: 'Customer',
        entityId: referrer.id,
        data: {
          previousTier: referrer.referralTier,
          newTier,
          triggeringReferralId: referral.id,
          refundedOrderId: input.orderId,
          revertReason: input.reason,
          revokedGrantIds,
        },
      },
    })
  })
}

/**
 * Back-compat alias for the refund paths that already import this name
 * (`refund.tpv.service.ts`, `refund.dashboard.service.ts`). Delegates to
 * `revertReferralRewardForOrder`, so those two call sites pick up the
 * partial-refund guard and the never-throw contract without being edited.
 * New callers should use `revertReferralRewardForOrder` and state their
 * reason.
 */
export async function onOrderRefunded(input: OnOrderRefundedInput): Promise<void> {
  await revertReferralRewardForOrder({ ...input, reason: 'ORDER_REFUNDED' })
}

/**
 * Hook de CANCELACIÓN de orden (mobile, TPV, dashboard). Dos cosas, ninguna
 * lanza jamás — la cancelación no puede caerse por el referido:
 *
 *   1. Los referidos **PENDING** atados a esta orden pasan a `VOID` con razón
 *      `ORDER_CANCELLED`. Sin esto la fila quedaba colgada para siempre: nunca
 *      calificó (la orden nunca se pagó) y nadie la cerraba, y además seguía
 *      ocupando el índice único parcial `Referral_qualifyingOrderId_active_key`.
 *   2. Defensa en profundidad: `revertReferralRewardForOrder`. Hoy los tres
 *      caminos de cancelación rechazan una orden con dinero encima, y un
 *      referido sólo califica con la orden PAID, así que esta rama es un no-op
 *      por construcción — igual que la guardia de estado de `onOrderPaid`. Se
 *      conecta para que el próximo camino de cancelación no reabra el hueco.
 *
 * Decisión del founder 2026-08-18 (mercado: Booksy revierte con no-show,
 * Mindbody sólo premia la compra que ocurrió).
 */
export async function onOrderCancelled(input: OnOrderRefundedInput): Promise<void> {
  try {
    const voided = await prisma.referral.updateMany({
      where: { qualifyingOrderId: input.orderId, venueId: input.venueId, status: 'PENDING' },
      data: { status: 'VOID', voidedAt: new Date(), voidReason: 'ORDER_CANCELLED' },
    })
    if (voided.count > 0) {
      logger.info('[referral] referidos pendientes anulados por cancelación de la orden', {
        orderId: input.orderId,
        venueId: input.venueId,
        count: voided.count,
      })
    }
  } catch (err) {
    logger.error('[referral] no se pudieron anular los referidos pendientes de la orden cancelada', {
      orderId: input.orderId,
      venueId: input.venueId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
  await revertReferralRewardForOrder({ ...input, reason: 'ORDER_CANCELLED' })
}
