/**
 * Check venue state before conversion testing
 */

import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'

async function main() {
  try {
    const venueId = 'cmh3ygfa8000n9kmq4r6f2rmf'

    const venue = await prisma.venue.findUnique({
      where: { id: venueId },
      include: { features: true },
    })

    if (!venue) {
      logger.error(`Venue ${venueId} not found`)
      process.exit(1)
    }

    logger.info('📊 Venue State:', {
      id: venue.id,
      name: venue.name,
      isDemo: venue.isDemo,
      stripeCustomerId: venue.stripeCustomerId,
      stripePaymentMethodId: venue.stripePaymentMethodId,
      featuresCount: venue.features.length,
    })

    if (venue.features.length > 0) {
      logger.info('📋 Current Features:')
      for (const vf of venue.features) {
        logger.info(`  - ${vf.featureId}: active=${vf.active}, endDate=${vf.endDate}`)
      }
    }

    process.exit(0)
  } catch (error) {
    logger.error('Error checking venue:', error)
    process.exit(1)
  }
}

main()
