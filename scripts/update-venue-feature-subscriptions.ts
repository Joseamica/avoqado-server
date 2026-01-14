/**
 * Update VenueFeature Subscriptions - January 2025
 *
 * This script updates EXISTING venue subscriptions:
 * 1. Deactivates VenueFeature records for disabled features
 * 2. Updates prices for active features to match new Feature prices
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register scripts/update-venue-feature-subscriptions.ts
 *
 * Options:
 *   DRY_RUN=true npx ts-node ... (preview changes without applying)
 */

import Stripe from 'stripe'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!)

const DRY_RUN = process.env.DRY_RUN === 'true'

// Features to deactivate
const FEATURES_TO_DEACTIVATE = ['ADVANCED_ANALYTICS', 'ONLINE_ORDERING', 'RESERVATIONS']

// New prices (in MXN)
const NEW_PRICES: Record<string, number> = {
  CHATBOT: 199.0,
  INVENTORY_TRACKING: 89.0,
}

async function deactivateFeatureSubscriptions() {
  logger.info('🚫 Deactivating subscriptions for disabled features...')

  for (const featureCode of FEATURES_TO_DEACTIVATE) {
    // Get feature
    const feature = await prisma.feature.findUnique({
      where: { code: featureCode },
    })

    if (!feature) {
      logger.warn(`  ⚠️ Feature ${featureCode} not found`)
      continue
    }

    // Find all active VenueFeature records for this feature
    const venueFeatures = await prisma.venueFeature.findMany({
      where: {
        featureId: feature.id,
        active: true,
      },
      include: {
        venue: { select: { name: true, slug: true } },
      },
    })

    logger.info(`  📦 ${featureCode}: Found ${venueFeatures.length} active subscriptions`)

    for (const vf of venueFeatures) {
      logger.info(`    - ${vf.venue.name} (${vf.venue.slug})`)

      if (DRY_RUN) {
        logger.info(`      [DRY RUN] Would deactivate subscription`)
        continue
      }

      // Cancel Stripe subscription if exists
      if (vf.stripeSubscriptionId) {
        try {
          await stripe.subscriptions.cancel(vf.stripeSubscriptionId)
          logger.info(`      ✅ Cancelled Stripe subscription ${vf.stripeSubscriptionId}`)
        } catch (error: any) {
          // Subscription might already be cancelled
          if (error.code !== 'resource_missing') {
            logger.error(`      ❌ Error cancelling Stripe subscription:`, error.message)
          }
        }
      }

      // Deactivate VenueFeature
      await prisma.venueFeature.update({
        where: { id: vf.id },
        data: {
          active: false,
          endDate: new Date(),
        },
      })
      logger.info(`      ✅ Deactivated VenueFeature`)
    }
  }
}

async function updateSubscriptionPrices() {
  logger.info('\n💰 Updating prices for active subscriptions...')

  for (const [featureCode, newPrice] of Object.entries(NEW_PRICES)) {
    // Get feature
    const feature = await prisma.feature.findUnique({
      where: { code: featureCode },
    })

    if (!feature) {
      logger.warn(`  ⚠️ Feature ${featureCode} not found`)
      continue
    }

    // Find all active VenueFeature records for this feature with old prices
    const venueFeatures = await prisma.venueFeature.findMany({
      where: {
        featureId: feature.id,
        active: true,
        NOT: {
          monthlyPrice: newPrice,
        },
      },
      include: {
        venue: { select: { name: true, slug: true } },
      },
    })

    logger.info(`  📦 ${featureCode}: Found ${venueFeatures.length} subscriptions to update`)

    for (const vf of venueFeatures) {
      const oldPrice = vf.monthlyPrice.toNumber()
      logger.info(`    - ${vf.venue.name}: $${oldPrice} → $${newPrice} MXN`)

      if (DRY_RUN) {
        logger.info(`      [DRY RUN] Would update price`)
        continue
      }

      // Update VenueFeature price
      await prisma.venueFeature.update({
        where: { id: vf.id },
        data: { monthlyPrice: newPrice },
      })

      // Note: Stripe subscriptions keep their original prices until renewal
      // The new price from Feature table will be used for new subscriptions
      // To update Stripe subscription price, we'd need to:
      // 1. Create new price in Stripe
      // 2. Update subscription to use new price
      // This is typically done at renewal time, not mid-subscription

      logger.info(`      ✅ Updated VenueFeature price`)
    }
  }
}

async function showCurrentState() {
  logger.info('\n📊 Current VenueFeature state:')

  const venueFeatures = await prisma.venueFeature.findMany({
    where: { active: true },
    include: {
      feature: { select: { code: true, name: true } },
      venue: { select: { name: true, slug: true } },
    },
    orderBy: [{ venue: { name: 'asc' } }, { feature: { code: 'asc' } }],
  })

  let currentVenue = ''
  for (const vf of venueFeatures) {
    if (vf.venue.name !== currentVenue) {
      currentVenue = vf.venue.name
      logger.info(`\n  🏪 ${currentVenue} (${vf.venue.slug}):`)
    }
    logger.info(`    - ${vf.feature.code}: $${vf.monthlyPrice} MXN`)
  }
}

async function main() {
  try {
    logger.info('🚀 VenueFeature Subscription Update - January 2025')
    logger.info(`   Mode: ${DRY_RUN ? '🔍 DRY RUN (no changes)' : '⚡ LIVE (applying changes)'}`)
    logger.info('')

    await showCurrentState()

    await deactivateFeatureSubscriptions()
    await updateSubscriptionPrices()

    if (!DRY_RUN) {
      await showCurrentState()
    }

    logger.info('\n✅ Script completed successfully!')

    process.exit(0)
  } catch (error) {
    logger.error('❌ Script failed:', error)
    process.exit(1)
  }
}

main()
