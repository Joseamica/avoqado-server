/**
 * Seeds the PLAN_PRO base-subscription feature and its Stripe objects:
 *   - Stripe Product "Plan Avoqado Pro"
 *   - Price plan_pro_monthly  ($1,158.84/mo MXN = $999 + 16% IVA)
 *   - Price plan_pro_annual   ($11,588.40/yr MXN = $9,990 + 16% IVA, 2 months free)
 *   - Coupon INTRO_PRO_3M     (-$464 off, repeating, 3 months -> $694.84 = $599 + IVA)
 *   - Coupon WINBACK_FIRST_MONTH_FREE (100% off, once)
 *   - Feature row PLAN_PRO (monthlyPrice 999 base, ex-IVA) linked to the monthly price
 *
 * IVA model: Stripe Tax is NOT used. The 16% IVA is baked INTO the price (tax_behavior
 * 'inclusive'), so Stripe charges the gross amount and the merchant itemizes/remits the IVA
 * on their own CFDI factura. The UI still presents it as "$999 + IVA".
 *
 * Idempotent: prices are matched by lookup_key; because Stripe prices are immutable, when the
 * amount or tax_behavior changes a NEW price is created and the lookup_key is transferred onto
 * it (the old price keeps serving its existing subscriptions). The coupon is recreated when its
 * amount changed (existing redemptions keep their discount). The script never charges anyone —
 * it only creates pricing CONFIGURATION.
 *
 * Run (apply):    npx tsx -r dotenv/config -r tsconfig-paths/register scripts/seed-plan-pro.ts
 * Run (preview):  npx tsx -r dotenv/config -r tsconfig-paths/register scripts/seed-plan-pro.ts --dry-run
 *   --dry-run only READS Stripe and prints exactly what it would create/transfer; it makes NO
 *   Stripe mutations and NO database writes. Use it to verify against production before applying.
 */
import Stripe from 'stripe'
import prisma from '../src/utils/prismaClient'
import logger from '../src/config/logger'

// Match src/services/stripe.service.ts: use the SDK's default (pinned) API version.
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!)

// --dry-run: read Stripe + print the plan, mutate NOTHING (no create/del/transfer, no DB write).
const DRY_RUN = process.argv.includes('--dry-run')
const log = (msg: string) => logger.info(`${DRY_RUN ? '[DRY-RUN] ' : ''}${msg}`)

// Pricing: base (ex-IVA) amounts + IVA rate. The Stripe price is the IVA-inclusive gross.
const IVA_RATE = 0.16
const BASE_MONTHLY = 999
const BASE_ANNUAL = 9990
const BASE_PROMO = 599 // 3-month intro price (ex-IVA)
const toCents = (mxn: number) => Math.round(mxn * 100)
const MONTHLY_AMOUNT = toCents(BASE_MONTHLY * (1 + IVA_RATE)) // 115884 = $1,158.84
const ANNUAL_AMOUNT = toCents(BASE_ANNUAL * (1 + IVA_RATE)) // 1158840 = $11,588.40
const COUPON_OFF = toCents((BASE_MONTHLY - BASE_PROMO) * (1 + IVA_RATE)) // 46400 = $464 (gross of the $400 ex-IVA discount)
const TAX_BEHAVIOR = 'inclusive' as const

/**
 * Returns a price with the given lookup_key + amount. Stripe prices are immutable, so when the
 * amount or tax_behavior differs from the existing price we create a NEW price and transfer the
 * lookup_key onto it (the old price keeps serving its existing subscriptions).
 */
async function ensurePrice(productId: string, lookupKey: string, unitAmount: number, interval: 'month' | 'year'): Promise<Stripe.Price> {
  const existing = (await stripe.prices.list({ lookup_keys: [lookupKey], limit: 1 })).data[0]
  if (existing && existing.unit_amount === unitAmount && existing.tax_behavior === TAX_BEHAVIOR) {
    log(`price ${lookupKey}: already correct ($${(unitAmount / 100).toFixed(2)}, ${TAX_BEHAVIOR}) → reuse ${existing.id}`)
    return existing
  }
  if (DRY_RUN) {
    log(
      existing
        ? `price ${lookupKey}: WOULD CREATE $${(unitAmount / 100).toFixed(2)} (${TAX_BEHAVIOR}) and TRANSFER lookup_key from ${existing.id} (currently $${((existing.unit_amount ?? 0) / 100).toFixed(2)}, ${existing.tax_behavior}). Existing subscriptions keep their old price; only NEW subs use the new one.`
        : `price ${lookupKey}: WOULD CREATE $${(unitAmount / 100).toFixed(2)} (${TAX_BEHAVIOR}). None exists today.`,
    )
    return existing ?? ({ id: `(dry-run:${lookupKey})` } as Stripe.Price)
  }
  return stripe.prices.create({
    product: productId,
    currency: 'mxn',
    unit_amount: unitAmount,
    recurring: { interval },
    lookup_key: lookupKey,
    transfer_lookup_key: Boolean(existing),
    tax_behavior: TAX_BEHAVIOR,
  })
}

/**
 * Returns the coupon with the given id + config, recreating it when its discount or duration
 * changed (coupons are immutable). Matches on amount_off OR percent_off depending on which the
 * config specifies; existing redemptions keep their discount.
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
    if (matches && existing.duration === cfg.duration) {
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

  // 1. Product — anchor on the strongly-consistent monthly lookup_key. products.search is
  // EVENTUALLY consistent and would duplicate the product on rapid re-runs.
  const existingMonthly = (await stripe.prices.list({ lookup_keys: ['plan_pro_monthly'], limit: 1 })).data[0]
  let product: Stripe.Product
  if (existingMonthly) {
    const prodRef = existingMonthly.product
    product = typeof prodRef === 'string' ? await stripe.products.retrieve(prodRef) : (prodRef as Stripe.Product)
  } else {
    const products = await stripe.products.search({ query: "metadata['code']:'PLAN_PRO'" })
    if (products.data[0]) {
      product = products.data[0]
    } else if (DRY_RUN) {
      log('product: WOULD CREATE "Plan Avoqado Pro" (none exists today).')
      product = { id: '(dry-run:product)' } as Stripe.Product
    } else {
      product = await stripe.products.create({ name: 'Plan Avoqado Pro', metadata: { code: 'PLAN_PRO' } })
    }
  }

  // 2 + 3. Prices (IVA-inclusive; recreated with lookup_key transfer when the amount changes).
  const monthly = await ensurePrice(product.id, 'plan_pro_monthly', MONTHLY_AMOUNT, 'month')
  const annual = await ensurePrice(product.id, 'plan_pro_annual', ANNUAL_AMOUNT, 'year')

  // 4. Coupons: intro (3-month discount) + win-back (first month free).
  const introCoupon = await ensureCoupon('INTRO_PRO_3M', {
    amount_off: COUPON_OFF,
    currency: 'mxn',
    duration: 'repeating',
    duration_in_months: 3,
    name: 'Avoqado Pro - 3 meses a $599 + IVA',
  })
  const winbackCoupon = await ensureCoupon('WINBACK_FIRST_MONTH_FREE', {
    percent_off: 100,
    duration: 'once',
    name: 'Avoqado Pro - Win-back: 1er mes gratis',
  })

  // 5. Feature row — monthlyPrice stores the BASE (ex-IVA) 999, matching the "$999 + IVA" UI.
  if (DRY_RUN) {
    log(`Feature PLAN_PRO: WOULD UPSERT (monthlyPrice=${BASE_MONTHLY}, stripePriceId=${monthly.id}). No DB write in dry-run.`)
  } else {
    await prisma.feature.upsert({
      where: { code: 'PLAN_PRO' },
      update: { stripeProductId: product.id, stripePriceId: monthly.id, active: true, monthlyPrice: BASE_MONTHLY },
      create: {
        code: 'PLAN_PRO',
        name: 'Plan Avoqado Pro',
        description: 'Suscripcion base de la plataforma',
        category: 'OPERATIONS',
        monthlyPrice: BASE_MONTHLY,
        stripeProductId: product.id,
        stripePriceId: monthly.id,
        active: true,
      },
    })
  }

  logger.info(
    `${DRY_RUN ? '[DRY-RUN] (nothing was changed) ' : '✅ Seeded '}PLAN_PRO (IVA-inclusive, no Stripe Tax): product=${product.id} ` +
      `monthly=${monthly.id} ($${(MONTHLY_AMOUNT / 100).toFixed(2)}) ` +
      `annual=${annual.id} ($${(ANNUAL_AMOUNT / 100).toFixed(2)}) ` +
      `introCoupon=${introCoupon.id} (-$${(COUPON_OFF / 100).toFixed(2)}) ` +
      `winbackCoupon=${winbackCoupon.id} (1st month free)`,
  )
  process.exit(0)
}

main().catch(err => {
  logger.error('seed-plan-pro failed:', err)
  process.exit(1)
})
