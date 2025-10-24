/**
 * Reset venue to demo mode for testing conversion
 */

import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'

async function main() {
  try {
    const venueId = 'cmh3ygfa8000n9kmq4r6f2rmf'

    logger.info(`🔄 Resetting venue ${venueId} to demo mode...`)

    // Delete any existing features
    const deletedFeatures = await prisma.venueFeature.deleteMany({
      where: { venueId },
    })
    logger.info(`  ✓ Deleted ${deletedFeatures.count} existing features`)

    // Reset venue to demo
    const updated = await prisma.venue.update({
      where: { id: venueId },
      data: {
        isDemo: true,
        stripeCustomerId: null,
        stripePaymentMethodId: null,
        demoExpiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000), // 14 days
      },
    })

    logger.info('✅ Venue reset to demo:', {
      id: updated.id,
      name: updated.name,
      isDemo: updated.isDemo,
      demoExpiresAt: updated.demoExpiresAt,
    })

    process.exit(0)
  } catch (error) {
    logger.error('Error resetting venue:', error)
    process.exit(1)
  }
}

main()
