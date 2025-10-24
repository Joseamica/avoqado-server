/**
 * Sync all active features to Stripe
 * Creates Stripe products and prices for features that don't have them yet
 *
 * Usage: npx ts-node -r tsconfig-paths/register scripts/sync-features-to-stripe.ts
 */

import { syncFeaturesToStripe } from '@/services/stripe.service'
import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'

async function main() {
  try {
    logger.info('🔄 Starting feature sync to Stripe...')

    // Check current state
    const totalFeatures = await prisma.feature.count({
      where: { active: true },
    })

    const featuresWithPrices = await prisma.feature.count({
      where: {
        active: true,
        stripePriceId: { not: null },
      },
    })

    logger.info(`📊 Current state: ${featuresWithPrices}/${totalFeatures} features have Stripe prices`)

    // Sync features to Stripe
    const synced = await syncFeaturesToStripe()

    logger.info(`✅ Sync complete! ${synced.length} features now have Stripe products/prices`)

    // Show results
    for (const feature of synced) {
      logger.info(`  ✓ ${feature.code}: Product=${feature.stripeProductId}, Price=${feature.stripePriceId}`)
    }

    process.exit(0)
  } catch (error) {
    logger.error('❌ Error syncing features to Stripe:', error)
    process.exit(1)
  }
}

main()
