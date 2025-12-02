/**
 * Stripe Feature Sync Startup Service
 *
 * Automatically syncs features to Stripe on server startup if any features
 * are missing Stripe product/price IDs. This ensures users can subscribe
 * to features without manual intervention.
 *
 * Non-blocking: Server will start even if sync fails (logs warning)
 */

import prisma from '@/utils/prismaClient'
import { syncFeaturesToStripe } from '@/services/stripe.service'
import logger from '@/config/logger'

/**
 * Check if any active features are missing Stripe IDs and sync if needed
 * @returns Promise<boolean> - true if sync was performed, false if already synced
 */
export async function ensureFeaturesAreSyncedToStripe(): Promise<boolean> {
  try {
    // Skip if Stripe is not configured
    if (!process.env.STRIPE_SECRET_KEY) {
      logger.warn('⏭️  Stripe sync skipped: STRIPE_SECRET_KEY not configured')
      return false
    }

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

    const featuresMissingStripe = totalFeatures - featuresWithPrices

    // If all features are synced, skip
    if (featuresMissingStripe === 0) {
      logger.info(`✅ Stripe sync: All ${totalFeatures} features already have Stripe prices`)
      return false
    }

    // Some features need syncing
    logger.info(`🔄 Stripe sync: ${featuresMissingStripe}/${totalFeatures} features missing Stripe IDs, syncing...`)

    // Sync features to Stripe
    const synced = await syncFeaturesToStripe()

    logger.info(`✅ Stripe sync complete: ${synced.length} features now synced`)

    // Log which features were synced
    for (const feature of synced) {
      if (feature.stripePriceId) {
        logger.info(`   ✓ ${feature.code}: Product=${feature.stripeProductId}, Price=${feature.stripePriceId}`)
      }
    }

    return true
  } catch (error) {
    // Non-blocking: Log error but don't crash the server
    logger.error('❌ Stripe sync failed on startup:', error)
    logger.warn('⚠️  Features may not be subscribable until manually synced')
    logger.warn('   Run: npx ts-node -r tsconfig-paths/register scripts/sync-features-to-stripe.ts')
    return false
  }
}
