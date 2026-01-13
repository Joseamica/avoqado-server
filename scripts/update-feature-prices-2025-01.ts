/**
 * Update Feature Prices and Disable Features - January 2025
 *
 * This script:
 * 1. Updates prices for CHATBOT (399 -> 199 MXN) and INVENTORY_TRACKING (299 -> 89 MXN)
 * 2. Deactivates features: ADVANCED_ANALYTICS, ONLINE_ORDERING, RESERVATIONS
 * 3. Creates new Stripe prices for updated features (Stripe prices are immutable)
 * 4. Archives old Stripe prices and products for disabled features
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register scripts/update-feature-prices-2025-01.ts
 *
 * Options:
 *   DRY_RUN=true npx ts-node ... (preview changes without applying)
 */

import Stripe from 'stripe'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!)

const DRY_RUN = process.env.DRY_RUN === 'true'

// Price updates (in MXN)
const PRICE_UPDATES = {
  CHATBOT: 199.0, // was 399.0
  INVENTORY_TRACKING: 89.0, // was 299.0
}

// Features to disable
const FEATURES_TO_DISABLE = ['ADVANCED_ANALYTICS', 'ONLINE_ORDERING', 'RESERVATIONS']

async function updateFeaturePrices() {
  logger.info('💰 Updating feature prices...')

  for (const [code, newPrice] of Object.entries(PRICE_UPDATES)) {
    const feature = await prisma.feature.findUnique({
      where: { code },
    })

    if (!feature) {
      logger.warn(`  ⚠️ Feature ${code} not found, skipping`)
      continue
    }

    const oldPrice = feature.monthlyPrice.toNumber()
    logger.info(`  📦 ${code}: $${oldPrice} MXN -> $${newPrice} MXN`)

    if (DRY_RUN) {
      logger.info(`    [DRY RUN] Would update database and create new Stripe price`)
      continue
    }

    // Update database price
    await prisma.feature.update({
      where: { code },
      data: { monthlyPrice: newPrice },
    })

    // Create new Stripe price (prices are immutable in Stripe)
    if (feature.stripeProductId) {
      try {
        // Archive old price if exists
        if (feature.stripePriceId) {
          await stripe.prices.update(feature.stripePriceId, { active: false })
          logger.info(`    ✅ Archived old Stripe price ${feature.stripePriceId}`)
        }

        // Create new price
        const newStripePrice = await stripe.prices.create({
          product: feature.stripeProductId,
          unit_amount: Math.round(newPrice * 100), // Convert to centavos
          currency: 'mxn',
          recurring: { interval: 'month' },
          metadata: {
            featureId: feature.id,
            featureCode: feature.code,
            updatedAt: new Date().toISOString(),
          },
        })

        // Update database with new price ID
        await prisma.feature.update({
          where: { code },
          data: { stripePriceId: newStripePrice.id },
        })

        logger.info(`    ✅ Created new Stripe price ${newStripePrice.id}`)
      } catch (error) {
        logger.error(`    ❌ Error updating Stripe price for ${code}:`, error)
      }
    } else {
      logger.info(`    ⚠️ No Stripe product ID, will be created on next sync`)
    }
  }
}

async function disableFeatures() {
  logger.info('🚫 Disabling features...')

  for (const code of FEATURES_TO_DISABLE) {
    const feature = await prisma.feature.findUnique({
      where: { code },
    })

    if (!feature) {
      logger.info(`  ⚠️ Feature ${code} not found (may already be removed from seed)`)
      continue
    }

    if (!feature.active) {
      logger.info(`  ⏭️ Feature ${code} already inactive`)
      continue
    }

    logger.info(`  🔒 Disabling ${code}...`)

    if (DRY_RUN) {
      logger.info(`    [DRY RUN] Would deactivate in DB and archive in Stripe`)
      continue
    }

    // Deactivate in database
    await prisma.feature.update({
      where: { code },
      data: { active: false },
    })

    // Archive in Stripe
    if (feature.stripeProductId) {
      try {
        await stripe.products.update(feature.stripeProductId, { active: false })
        logger.info(`    ✅ Archived Stripe product ${feature.stripeProductId}`)
      } catch (error) {
        logger.error(`    ❌ Error archiving Stripe product:`, error)
      }
    }

    if (feature.stripePriceId) {
      try {
        await stripe.prices.update(feature.stripePriceId, { active: false })
        logger.info(`    ✅ Archived Stripe price ${feature.stripePriceId}`)
      } catch (error) {
        logger.error(`    ❌ Error archiving Stripe price:`, error)
      }
    }

    logger.info(`    ✅ Feature ${code} deactivated`)
  }
}

async function showCurrentState() {
  logger.info('\n📊 Current feature state:')

  const features = await prisma.feature.findMany({
    orderBy: { code: 'asc' },
  })

  for (const feature of features) {
    const status = feature.active ? '✅ Active' : '❌ Inactive'
    const stripeStatus = feature.stripePriceId ? '💳 Stripe' : '⚠️ No Stripe'
    logger.info(`  ${feature.code}: $${feature.monthlyPrice} MXN | ${status} | ${stripeStatus}`)
  }
}

async function main() {
  try {
    logger.info('🚀 Feature Price & Status Update - January 2025')
    logger.info(`   Mode: ${DRY_RUN ? '🔍 DRY RUN (no changes)' : '⚡ LIVE (applying changes)'}`)
    logger.info('')

    await showCurrentState()
    logger.info('')

    await updateFeaturePrices()
    logger.info('')

    await disableFeatures()
    logger.info('')

    if (!DRY_RUN) {
      await showCurrentState()
    }

    logger.info('\n✅ Script completed successfully!')
    logger.info('')
    logger.info('📝 Next steps:')
    logger.info('   1. For existing venue subscriptions with updated prices:')
    logger.info('      - Existing subscriptions keep old prices until renewed')
    logger.info('      - New subscriptions use new prices')
    logger.info('   2. For disabled features:')
    logger.info('      - Existing VenueFeature records remain (grandfathered)')
    logger.info('      - No new venues can subscribe to these features')

    process.exit(0)
  } catch (error) {
    logger.error('❌ Script failed:', error)
    process.exit(1)
  }
}

main()
