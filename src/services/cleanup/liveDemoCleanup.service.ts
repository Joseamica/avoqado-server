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
        // Delete the session (cascade will delete venue and staff)
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
