/**
 * Seeds the cancellation-retention Stripe coupons used by the subscription
 * retention / win-back flow:
 *   - Coupon RETENTION_30_3M   (30% off, repeating, 3 months) — applied to the venue's
 *     base-plan subscription when the merchant accepts the "stay" retention offer in the
 *     cancellation flow. "Avoqado — 30% off 3 meses (retención)".
 *   - Coupon WINBACK_30_1M     (30% off, once) — referenced by the cancellation
 *     confirmation email's win-back CTA for merchants who DID cancel. The existing
 *     WINBACK_FIRST_MONTH_FREE (100% off once) is a stronger, suspension-only win-back; the
 *     cancellation-email win-back is a gentler 30%-off-once nudge with a redemption deadline,
 *     so we create a dedicated coupon rather than overload the first-month-free one.
 *
 * Discount model mirrors the rest of billing: coupons are percent-off, so they apply
 * cleanly on top of the IVA-inclusive price (no currency/amount coupling). Stripe Tax is
 * NOT used here — the IVA is baked into the price (tax_behavior 'inclusive').
 *
 * Idempotent: the coupon is recreated only when its discount or duration changed (coupons
 * are immutable); existing redemptions keep their discount. The script never charges anyone —
 * it only creates pricing CONFIGURATION.
 *
 * Run (apply):    npx tsx -r dotenv/config -r tsconfig-paths/register scripts/seed-retention-coupon.ts
 * Run (preview):  npx tsx -r dotenv/config -r tsconfig-paths/register scripts/seed-retention-coupon.ts --dry-run
 *   --dry-run only READS Stripe and prints exactly what it would create/recreate; it makes NO
 *   Stripe mutations. Use it to verify against the target Stripe account before applying.
 */
import Stripe from 'stripe'
import logger from '../src/config/logger'

// Match src/services/stripe.service.ts: use the SDK's default (pinned) API version.
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!)

// --dry-run: read Stripe + print the plan, mutate NOTHING (no create/del).
const DRY_RUN = process.argv.includes('--dry-run')
const log = (msg: string) => logger.info(`${DRY_RUN ? '[DRY-RUN] ' : ''}${msg}`)

/**
 * Returns the coupon with the given id + config, recreating it when its discount or duration
 * changed (coupons are immutable). Matches on amount_off OR percent_off depending on which the
 * config specifies; existing redemptions keep their discount. Mirrors `ensureCoupon` in
 * scripts/seed-plan-pro.ts.
 */
async function ensureCoupon(id: string, cfg: Stripe.CouponCreateParams): Promise<Stripe.Coupon> {
  let existing: Stripe.Coupon | null = null
  try {
    existing = await stripe.coupons.retrieve(id)
  } catch {
    existing = null
  }
  if (existing) {
    const matches = cfg.amount_off != null ? existing.amount_off === cfg.amount_off : existing.percent_off === cfg.percent_off
    const durationMatches =
      existing.duration === cfg.duration && (cfg.duration !== 'repeating' || existing.duration_in_months === cfg.duration_in_months)
    if (matches && durationMatches) {
      log(`coupon ${id}: already correct → reuse`)
      return existing
    }
    if (DRY_RUN) {
      log(`coupon ${id}: WOULD DELETE + RECREATE (config changed). Existing redemptions keep their discount.`)
      return existing
    }
    await stripe.coupons.del(id)
  } else if (DRY_RUN) {
    log(`coupon ${id}: WOULD CREATE (none exists today).`)
    return { id } as Stripe.Coupon
  }
  return stripe.coupons.create({ id, ...cfg })
}

async function main() {
  log(`Stripe key mode: ${(process.env.STRIPE_SECRET_KEY ?? '').startsWith('sk_live') ? 'LIVE (production)' : 'TEST'}`)

  // Retention offer: 30% off for 3 months, applied to the live base-plan subscription when a
  // merchant accepts the "stay" offer in the cancellation flow.
  const retentionCoupon = await ensureCoupon('RETENTION_30_3M', {
    percent_off: 30,
    duration: 'repeating',
    duration_in_months: 3,
    name: 'Avoqado — 30% off 3 meses (retención)',
  })

  // Cancellation-email win-back: 30% off once, surfaced as the CTA in the cancellation
  // confirmation email (paired with a redemption deadline). Gentler than the
  // suspension-only WINBACK_FIRST_MONTH_FREE (100% off once).
  const winbackCoupon = await ensureCoupon('WINBACK_30_1M', {
    percent_off: 30,
    duration: 'once',
    name: 'Avoqado — Win-back: 30% off (regresa)',
  })

  logger.info(
    `${DRY_RUN ? '[DRY-RUN] (nothing was changed) ' : '✅ Seeded '}retention coupons: ` +
      `retentionCoupon=${retentionCoupon.id} (30% off, repeating 3mo) ` +
      `winbackCoupon=${winbackCoupon.id} (30% off, once)`,
  )
  process.exit(0)
}

main().catch(err => {
  logger.error('seed-retention-coupon failed:', err)
  process.exit(1)
})
