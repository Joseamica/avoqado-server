/**
 * Verify complete conversion details
 */

import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'

async function main() {
  try {
    const venueId = 'cmh3ygfa8000n9kmq4r6f2rmf'

    const venue = await prisma.venue.findUnique({
      where: { id: venueId },
      include: {
        features: {
          include: {
            feature: true,
          },
        },
      },
    })

    if (!venue) {
      logger.error(`Venue ${venueId} not found`)
      process.exit(1)
    }

    logger.info('🎉 CONVERSION VERIFICATION REPORT')
    logger.info('=====================================')

    logger.info('\n📊 VENUE STATUS:')
    logger.info(`  Name: ${venue.name}`)
    logger.info(`  Demo Mode: ${venue.isDemo ? '❌ Still demo' : '✅ Converted to real'}`)
    logger.info(`  Stripe Customer: ${venue.stripeCustomerId || '❌ Missing'}`)
    logger.info(`  Payment Method: ${venue.stripePaymentMethodId || '❌ Missing'}`)

    logger.info('\n💳 STRIPE INTEGRATION:')
    if (venue.stripeCustomerId) {
      logger.info(`  ✅ Customer ID: ${venue.stripeCustomerId}`)
    }
    if (venue.stripePaymentMethodId) {
      logger.info(`  ✅ Payment Method: ${venue.stripePaymentMethodId}`)
    }

    logger.info('\n🎯 FEATURES & SUBSCRIPTIONS:')
    logger.info(`  Total Features: ${venue.features.length}`)

    if (venue.features.length > 0) {
      for (const vf of venue.features) {
        logger.info(`\n  📦 ${vf.feature.name} (${vf.feature.code}):`)
        logger.info(`     Status: ${vf.active ? '✅ Active' : '❌ Inactive'}`)
        logger.info(`     Monthly Price: $${vf.monthlyPrice} MXN`)
        logger.info(`     Start Date: ${vf.startDate.toISOString()}`)
        logger.info(`     Trial End: ${vf.endDate ? vf.endDate.toISOString() : 'N/A (paid)'}`)
        logger.info(`     Stripe Subscription: ${vf.stripeSubscriptionId || '❌ Missing'}`)
        logger.info(`     Stripe Price: ${vf.stripePriceId || '❌ Missing'}`)

        if (vf.endDate) {
          const now = new Date()
          const daysRemaining = Math.ceil((new Date(vf.endDate).getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
          logger.info(`     Trial Days Remaining: ${daysRemaining} days`)
        }
      }
    } else {
      logger.warn('  ⚠️  No features found')
    }

    logger.info('\n=====================================')
    logger.info('✅ Verification Complete!')

    process.exit(0)
  } catch (error) {
    logger.error('Error verifying conversion:', error)
    process.exit(1)
  }
}

main()
