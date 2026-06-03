/**
 * Seeds the PLAN_PRO base-subscription feature and its Stripe objects:
 *   - Stripe Product "Plan Avoqado Pro"
 *   - Price plan_pro_monthly  ($1,158.84/mo MXN = $999 + 16% IVA)
 *   - Price plan_pro_annual   ($11,588.40/yr MXN = $9,990 + 16% IVA, 2 months free)
 *   - Coupon INTRO_PRO_3M     (-$464 off, repeating, 3 months -> $694.84 = $599 + IVA)
 *   - Feature row PLAN_PRO (monthlyPrice 999 base, ex-IVA) linked to the monthly price
 *
 * IVA model: Stripe Tax is NOT used. The 16% IVA is baked INTO the price (tax_behavior
 * 'inclusive'), so Stripe charges the gross amount and the merchant itemizes/remits the IVA
 * on their own CFDI factura. The UI still presents it as "$999 + IVA".
 *
 * Idempotent: prices are matched by lookup_key; because Stripe prices are immutable, when the
 * amount or tax_behavior changes a NEW price is created and the lookup_key is transferred onto
 * it (the old price keeps serving its existing subscriptions). The coupon is recreated when its
 * amount changed (existing redemptions keep their discount).
 * Run: npx tsx -r dotenv/config -r tsconfig-paths/register scripts/seed-plan-pro.ts
 */
import Stripe from 'stripe'
import prisma from '../src/utils/prismaClient'
import logger from '../src/config/logger'

// Match src/services/stripe.service.ts: use the SDK's default (pinned) API version.
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!)

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
    return existing
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

/** Returns the intro coupon, recreating it when its amount changed (coupons are immutable). */
async function ensureCoupon(): Promise<Stripe.Coupon> {
  try {
    const existing = await stripe.coupons.retrieve('INTRO_PRO_3M')
    if (existing.amount_off === COUPON_OFF) return existing
    await stripe.coupons.del('INTRO_PRO_3M')
  } catch {
    /* not found — fall through to create */
  }
  return stripe.coupons.create({
    id: 'INTRO_PRO_3M',
    amount_off: COUPON_OFF,
    currency: 'mxn',
    duration: 'repeating',
    duration_in_months: 3,
    name: 'Avoqado Pro - 3 meses a $599 + IVA',
  })
}

async function main() {
  // 1. Product — anchor on the strongly-consistent monthly lookup_key. products.search is
  // EVENTUALLY consistent and would duplicate the product on rapid re-runs.
  const existingMonthly = (await stripe.prices.list({ lookup_keys: ['plan_pro_monthly'], limit: 1 })).data[0]
  let product: Stripe.Product
  if (existingMonthly) {
    const prodRef = existingMonthly.product
    product = typeof prodRef === 'string' ? await stripe.products.retrieve(prodRef) : (prodRef as Stripe.Product)
  } else {
    const products = await stripe.products.search({ query: "metadata['code']:'PLAN_PRO'" })
    product = products.data[0] ?? (await stripe.products.create({ name: 'Plan Avoqado Pro', metadata: { code: 'PLAN_PRO' } }))
  }

  // 2 + 3. Prices (IVA-inclusive; recreated with lookup_key transfer when the amount changes).
  const monthly = await ensurePrice(product.id, 'plan_pro_monthly', MONTHLY_AMOUNT, 'month')
  const annual = await ensurePrice(product.id, 'plan_pro_annual', ANNUAL_AMOUNT, 'year')

  // 4. Intro coupon.
  const coupon = await ensureCoupon()

  // 5. Feature row — monthlyPrice stores the BASE (ex-IVA) 999, matching the "$999 + IVA" UI.
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

  logger.info(
    `✅ Seeded PLAN_PRO (IVA-inclusive, no Stripe Tax): product=${product.id} ` +
      `monthly=${monthly.id} ($${(MONTHLY_AMOUNT / 100).toFixed(2)}) ` +
      `annual=${annual.id} ($${(ANNUAL_AMOUNT / 100).toFixed(2)}) ` +
      `coupon=${coupon.id} (-$${(COUPON_OFF / 100).toFixed(2)})`,
  )
  process.exit(0)
}

main().catch(err => {
  logger.error('seed-plan-pro failed:', err)
  process.exit(1)
})
