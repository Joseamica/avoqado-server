/**
 * Enable ONLINE_ORDERING Feature - January 2025
 *
 * This script:
 * 1. Archives the old Stripe price ($799)
 * 2. Creates a new Stripe price ($99)
 * 3. Updates the database with the new price ID
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register scripts/enable-online-ordering.ts
 */

import Stripe from 'stripe'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!)

async function main() {
  try {
    logger.info('🚀 Enabling ONLINE_ORDERING with new price $99 MXN')

    // Get the feature
    const feature = await prisma.feature.findUnique({
      where: { code: 'ONLINE_ORDERING' },
    })

    if (!feature) {
      logger.error('❌ Feature ONLINE_ORDERING not found')
      process.exit(1)
    }

    logger.info(`  📦 Found feature: ${feature.name}`)
    logger.info(`     Current price in DB: $${feature.monthlyPrice}`)
    logger.info(`     Stripe Product ID: ${feature.stripeProductId}`)
    logger.info(`     Stripe Price ID: ${feature.stripePriceId}`)

    if (!feature.stripeProductId) {
      logger.error('❌ No Stripe product ID found')
      process.exit(1)
    }

    // Archive old price if exists
    if (feature.stripePriceId) {
      try {
        await stripe.prices.update(feature.stripePriceId, { active: false })
        logger.info(`  ✅ Archived old Stripe price ${feature.stripePriceId}`)
      } catch (error: any) {
        if (error.code !== 'resource_missing') {
          logger.warn(`  ⚠️ Could not archive old price: ${error.message}`)
        }
      }
    }

    // Reactivate the product if it was archived
    try {
      await stripe.products.update(feature.stripeProductId, { active: true })
      logger.info(`  ✅ Reactivated Stripe product ${feature.stripeProductId}`)
    } catch (error: any) {
      logger.warn(`  ⚠️ Could not reactivate product: ${error.message}`)
    }

    // Create new price ($99 MXN)
    const newPrice = await stripe.prices.create({
      product: feature.stripeProductId,
      unit_amount: 9900, // $99 in centavos
      currency: 'mxn',
      recurring: { interval: 'month' },
      metadata: {
        featureId: feature.id,
        featureCode: feature.code,
        updatedAt: new Date().toISOString(),
      },
    })

    logger.info(`  ✅ Created new Stripe price ${newPrice.id}`)

    // Update database with new price ID
    await prisma.feature.update({
      where: { code: 'ONLINE_ORDERING' },
      data: {
        stripePriceId: newPrice.id,
        active: true,
        monthlyPrice: 99.0,
      },
    })

    logger.info(`  ✅ Updated database with new price ID`)

    // Verify
    const updatedFeature = await prisma.feature.findUnique({
      where: { code: 'ONLINE_ORDERING' },
    })

    logger.info('')
    logger.info('📊 Final state:')
    logger.info(`   Code: ${updatedFeature?.code}`)
    logger.info(`   Active: ${updatedFeature?.active}`)
    logger.info(`   Price: $${updatedFeature?.monthlyPrice} MXN`)
    logger.info(`   Stripe Price ID: ${updatedFeature?.stripePriceId}`)

    logger.info('')
    logger.info('✅ ONLINE_ORDERING enabled successfully!')

    process.exit(0)
  } catch (error) {
    logger.error('❌ Script failed:', error)
    process.exit(1)
  }
}

main()
