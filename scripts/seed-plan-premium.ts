/**
 * Seeds the PLAN_PREMIUM base-subscription feature and its Stripe objects:
 *   - Stripe Product "Plan Avoqado Premium"
 *   - Price plan_premium_monthly  ($1,970.84/mo MXN = $1,699 + 16% IVA)
 *   - Price plan_premium_annual   ($19,708.40/yr MXN = $16,990 + 16% IVA, 2 months free)
 *   - Feature row PLAN_PREMIUM (monthlyPrice 1699 base, ex-IVA) linked to the monthly price
 *
 * Sibling of scripts/seed-plan-pro.ts — same IVA-inclusive model (Stripe Tax NOT used; the 16%
 * IVA is baked INTO the price via tax_behavior 'inclusive'). No intro/win-back coupons for
 * Premium yet (add later if a promo is decided). The script never charges anyone — it only
 * creates pricing CONFIGURATION.
 *
 * Idempotent: prices are matched by lookup_key; because Stripe prices are immutable, when the
 * amount or tax_behavior changes a NEW price is created and the lookup_key is transferred onto it
 * (the old price keeps serving its existing subscriptions).
 *
 * Run (apply):    npx tsx -r dotenv/config -r tsconfig-paths/register scripts/seed-plan-premium.ts
 * Run (preview):  npx tsx -r dotenv/config -r tsconfig-paths/register scripts/seed-plan-premium.ts --dry-run
 *   --dry-run only READS Stripe and prints exactly what it would create/transfer; it makes NO
 *   Stripe mutations and NO database writes.
 */
import Stripe from 'stripe'
import prisma from '../src/utils/prismaClient'
import logger from '../src/config/logger'

// Match src/services/stripe.service.ts: use the SDK's default (pinned) API version.
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!)

// --dry-run: read Stripe + print the plan, mutate NOTHING (no create/transfer, no DB write).
const DRY_RUN = process.argv.includes('--dry-run')
const log = (msg: string) => logger.info(`${DRY_RUN ? '[DRY-RUN] ' : ''}${msg}`)

// Pricing: base (ex-IVA) amounts + IVA rate. The Stripe price is the IVA-inclusive gross.
const IVA_RATE = 0.16
const BASE_MONTHLY = 1699
const BASE_ANNUAL = 16990 // 2 months free vs monthly*12
const toCents = (mxn: number) => Math.round(mxn * 100)
const MONTHLY_AMOUNT = toCents(BASE_MONTHLY * (1 + IVA_RATE)) // 197084 = $1,970.84
const ANNUAL_AMOUNT = toCents(BASE_ANNUAL * (1 + IVA_RATE)) // 1970840 = $19,708.40
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
        ? `price ${lookupKey}: WOULD CREATE $${(unitAmount / 100).toFixed(2)} (${TAX_BEHAVIOR}) and TRANSFER lookup_key from ${existing.id} (currently $${((existing.unit_amount ?? 0) / 100).toFixed(2)}, ${existing.tax_behavior}).`
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

async function main() {
  log(`Stripe key mode: ${(process.env.STRIPE_SECRET_KEY ?? '').startsWith('sk_live') ? 'LIVE (production)' : 'TEST'}`)

  // 1. Product — anchor on the strongly-consistent monthly lookup_key. products.search is
  // EVENTUALLY consistent and would duplicate the product on rapid re-runs.
  const existingMonthly = (await stripe.prices.list({ lookup_keys: ['plan_premium_monthly'], limit: 1 })).data[0]
  let product: Stripe.Product
  if (existingMonthly) {
    const prodRef = existingMonthly.product
    product = typeof prodRef === 'string' ? await stripe.products.retrieve(prodRef) : (prodRef as Stripe.Product)
  } else {
    const products = await stripe.products.search({ query: "metadata['code']:'PLAN_PREMIUM'" })
    if (products.data[0]) {
      product = products.data[0]
    } else if (DRY_RUN) {
      log('product: WOULD CREATE "Plan Avoqado Premium" (none exists today).')
      product = { id: '(dry-run:product)' } as Stripe.Product
    } else {
      product = await stripe.products.create({ name: 'Plan Avoqado Premium', metadata: { code: 'PLAN_PREMIUM' } })
    }
  }

  // 2 + 3. Prices (IVA-inclusive; recreated with lookup_key transfer when the amount changes).
  const monthly = await ensurePrice(product.id, 'plan_premium_monthly', MONTHLY_AMOUNT, 'month')
  const annual = await ensurePrice(product.id, 'plan_premium_annual', ANNUAL_AMOUNT, 'year')

  // 4. Feature row — monthlyPrice stores the BASE (ex-IVA) 1699, matching the "$1,699 + IVA" UI.
  if (DRY_RUN) {
    log(`Feature PLAN_PREMIUM: WOULD UPSERT (monthlyPrice=${BASE_MONTHLY}, stripePriceId=${monthly.id}). No DB write in dry-run.`)
  } else {
    await prisma.feature.upsert({
      where: { code: 'PLAN_PREMIUM' },
      update: { stripeProductId: product.id, stripePriceId: monthly.id, active: true, monthlyPrice: BASE_MONTHLY },
      create: {
        code: 'PLAN_PREMIUM',
        name: 'Plan Avoqado Premium',
        description: 'Suscripcion Premium de la plataforma',
        category: 'OPERATIONS',
        monthlyPrice: BASE_MONTHLY,
        stripeProductId: product.id,
        stripePriceId: monthly.id,
        active: true,
      },
    })
  }

  logger.info(
    `${DRY_RUN ? '[DRY-RUN] (nothing was changed) ' : '✅ Seeded '}PLAN_PREMIUM (IVA-inclusive, no Stripe Tax): product=${product.id} ` +
      `monthly=${monthly.id} ($${(MONTHLY_AMOUNT / 100).toFixed(2)}) ` +
      `annual=${annual.id} ($${(ANNUAL_AMOUNT / 100).toFixed(2)})`,
  )
  process.exit(0)
}

main().catch(err => {
  logger.error('seed-plan-premium failed:', err)
  process.exit(1)
})
