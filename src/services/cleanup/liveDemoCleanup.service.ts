/**
 * Live Demo Cleanup Service
 *
 * Automatically cleans up expired live demo sessions.
 * Deletes venues, staff, and all associated data for sessions that have:
 * 1. Expired (expiresAt < now)
 * 2. Been inactive for > 5 hours (lastActivityAt + 5 hours < now)
 */

import prisma from '@/utils/prismaClient'
import { addHours } from 'date-fns'
import logger from '@/config/logger'

const INACTIVITY_THRESHOLD_HOURS = 5

/**
 * Cleans up expired and inactive live demo sessions
 * Should be run periodically (e.g., every hour via cron)
 *
 * @returns Number of sessions cleaned up
 */
export async function cleanupExpiredLiveDemos(): Promise<number> {
  try {
    logger.info('🧹 Starting live demo cleanup...')

    const now = new Date()
    const inactivityThreshold = addHours(now, -INACTIVITY_THRESHOLD_HOURS)

    // Find expired or inactive sessions
    const expiredSessions = await prisma.liveDemoSession.findMany({
      where: {
        OR: [
          {
            // Session has expired
            expiresAt: {
              lt: now,
            },
          },
          {
            // Session has been inactive for too long
            lastActivityAt: {
              lt: inactivityThreshold,
            },
          },
        ],
      },
      include: {
        venue: true,
        staff: true,
      },
    })

    if (expiredSessions.length === 0) {
      logger.info('✅ No expired live demo sessions found')
      return 0
    }

    logger.info(`🗑️ Found ${expiredSessions.length} expired live demo sessions to clean up`)

    let cleanedCount = 0

    for (const session of expiredSessions) {
      try {
        // Delete venue and staff data manually to avoid foreign key constraint errors
        logger.info(`🗑️ Cleaning up venue: ${session.venue.name} (${session.venue.id})`)

        // Delete all venue-related data in correct order (from dependent to independent)
        await deleteVenueData(session.venue.id)

        // Delete staff
        await prisma.staff.delete({
          where: { id: session.staff.id },
        })

        // Finally delete the session
        await prisma.liveDemoSession.delete({
          where: { id: session.id },
        })

        logger.info(`✅ Cleaned up live demo session ${session.sessionId} (venue: ${session.venue.name}, staff: ${session.staff.email})`)

        cleanedCount++
      } catch (error) {
        logger.error(`❌ Error cleaning up session ${session.sessionId}:`, error)
        // Continue with other sessions even if one fails
      }
    }

    logger.info(`✅ Live demo cleanup complete. Cleaned ${cleanedCount} sessions.`)

    return cleanedCount
  } catch (error) {
    logger.error('❌ Error in cleanupExpiredLiveDemos:', error)
    throw error
  }
}

/**
 * Cleans up ALL live demo sessions (for testing/development)
 * WARNING: This will delete all live demo venues and sessions
 *
 * @returns Number of sessions cleaned up
 */
export async function cleanupAllLiveDemos(): Promise<number> {
  try {
    logger.warn('⚠️ Cleaning up ALL live demo sessions (including active ones)...')

    const allSessions = await prisma.liveDemoSession.findMany({
      include: {
        venue: true,
        staff: true,
      },
    })

    if (allSessions.length === 0) {
      logger.info('✅ No live demo sessions found')
      return 0
    }

    logger.info(`🗑️ Found ${allSessions.length} live demo sessions to clean up`)

    let cleanedCount = 0

    for (const session of allSessions) {
      try {
        // Delete venue and staff data manually to avoid foreign key constraint errors
        logger.info(`🗑️ Cleaning up venue: ${session.venue.name} (${session.venue.id})`)

        await deleteVenueData(session.venue.id)

        await prisma.staff.delete({
          where: { id: session.staff.id },
        })

        await prisma.liveDemoSession.delete({
          where: { id: session.id },
        })

        logger.info(`✅ Cleaned up session ${session.sessionId}`)
        cleanedCount++
      } catch (error) {
        logger.error(`❌ Error cleaning up session ${session.sessionId}:`, error)
      }
    }

    logger.info(`✅ Cleanup complete. Cleaned ${cleanedCount} sessions.`)

    return cleanedCount
  } catch (error) {
    logger.error('❌ Error in cleanupAllLiveDemos:', error)
    throw error
  }
}

/**
 * Get statistics about live demo sessions
 *
 * @returns Live demo statistics
 */
export async function getLiveDemoStats(): Promise<{
  total: number
  active: number
  expired: number
  inactive: number
}> {
  const now = new Date()
  const inactivityThreshold = addHours(now, -INACTIVITY_THRESHOLD_HOURS)

  const total = await prisma.liveDemoSession.count()

  const active = await prisma.liveDemoSession.count({
    where: {
      expiresAt: { gte: now },
      lastActivityAt: { gte: inactivityThreshold },
    },
  })

  const expired = await prisma.liveDemoSession.count({
    where: {
      expiresAt: { lt: now },
    },
  })

  const inactive = await prisma.liveDemoSession.count({
    where: {
      lastActivityAt: { lt: inactivityThreshold },
      expiresAt: { gte: now }, // Not yet expired, just inactive
    },
  })

  return {
    total,
    active,
    expired,
    inactive,
  }
}

/**
 * Deletes all venue-related data in the correct order to avoid foreign key constraints
 *
 * @param venueId - Venue ID to delete data for
 */
async function deleteVenueData(venueId: string): Promise<void> {
  logger.info(`🗑️ Deleting all data for venue ${venueId}...`)

  // Delete in correct order (most dependent first)
  // 1. Order items and payments
  await prisma.orderItem.deleteMany({ where: { order: { venueId } } })
  await prisma.payment.deleteMany({ where: { order: { venueId } } })
  await prisma.order.deleteMany({ where: { venueId } })

  // 2. Reviews
  await prisma.review.deleteMany({ where: { venueId } })

  // 3. Products and modifiers
  await prisma.productModifierGroup.deleteMany({ where: { product: { venueId } } })
  await prisma.modifier.deleteMany({ where: { group: { venueId } } })
  await prisma.modifierGroup.deleteMany({ where: { venueId } })

  // 4. Recipes and inventory
  await prisma.recipe.deleteMany({ where: { product: { venueId } } })
  await prisma.rawMaterialMovement.deleteMany({ where: { rawMaterial: { venueId } } })
  await prisma.rawMaterial.deleteMany({ where: { venueId } })
  await prisma.inventory.deleteMany({ where: { venueId } })

  // 5. Products
  await prisma.product.deleteMany({ where: { venueId } })

  // 6. Menu categories and menus
  await prisma.menuCategoryAssignment.deleteMany({ where: { menu: { venueId } } })
  await prisma.menuCategory.deleteMany({ where: { venueId } })
  await prisma.menu.deleteMany({ where: { venueId } })

  // 7. Tables and areas
  await prisma.table.deleteMany({ where: { venueId } })
  await prisma.area.deleteMany({ where: { venueId } })

  // 8. Shifts and staff assignments
  await prisma.shift.deleteMany({ where: { venueId } })
  await prisma.staffVenue.deleteMany({ where: { venueId } })

  // 9. Payment config (merchant accounts will cascade delete)
  await prisma.venuePaymentConfig.deleteMany({ where: { venueId } })

  // 10. Features and settings
  await prisma.venueFeature.deleteMany({ where: { venueId } })
  await prisma.venueSettings.deleteMany({ where: { venueId } })

  // 11. Webhook events
  await prisma.webhookEvent.deleteMany({ where: { venueId } })

  // 12. Finally, delete the venue
  await prisma.venue.delete({ where: { id: venueId } })

  logger.info(`✅ Successfully deleted all data for venue ${venueId}`)
}
