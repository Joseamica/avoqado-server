/**
 * Cleanup Live Demo Sessions Script
 *
 * Manually run cleanup for expired/inactive live demo sessions
 * Can be scheduled via cron or run manually
 *
 * Usage:
 *   npm run cleanup:live-demos            # Clean up expired sessions
 *   npm run cleanup:live-demos -- --all   # Clean up ALL sessions (dev only)
 *   npm run cleanup:live-demos -- --stats # Show statistics only
 */

import * as liveDemoCleanupService from '@/services/cleanup/liveDemoCleanup.service'
import logger from '@/config/logger'

async function main() {
  const args = process.argv.slice(2)
  const showStatsOnly = args.includes('--stats')
  const cleanupAll = args.includes('--all')

  try {
    // Show statistics
    if (showStatsOnly) {
      logger.info('📊 Fetching live demo statistics...')
      const stats = await liveDemoCleanupService.getLiveDemoStats()

      logger.info('📊 Live Demo Statistics:')
      logger.info(`  Total Sessions: ${stats.total}`)
      logger.info(`  Active Sessions: ${stats.active}`)
      logger.info(`  Expired Sessions: ${stats.expired}`)
      logger.info(`  Inactive Sessions (>5h): ${stats.inactive}`)
      logger.info(`  Sessions to Clean: ${stats.expired + stats.inactive}`)

      process.exit(0)
      return
    }

    // Cleanup all sessions (dev only)
    if (cleanupAll) {
      if (process.env.NODE_ENV === 'production') {
        logger.error('❌ Cannot use --all flag in production')
        process.exit(1)
        return
      }

      logger.warn('⚠️ Cleaning up ALL live demo sessions (including active)...')

      const confirmation = process.env.SKIP_CONFIRMATION === 'true'
      if (!confirmation) {
        logger.warn('⚠️ Set SKIP_CONFIRMATION=true to proceed without confirmation')
        process.exit(1)
        return
      }

      const cleanedCount = await liveDemoCleanupService.cleanupAllLiveDemos()
      logger.info(`✅ Cleanup complete. Cleaned ${cleanedCount} sessions.`)

      process.exit(0)
      return
    }

    // Normal cleanup (expired + inactive)
    logger.info('🧹 Starting live demo cleanup (expired + inactive sessions)...')
    const cleanedCount = await liveDemoCleanupService.cleanupExpiredLiveDemos()

    if (cleanedCount === 0) {
      logger.info('✅ No sessions to clean')
    } else {
      logger.info(`✅ Successfully cleaned ${cleanedCount} expired live demo sessions`)
    }

    process.exit(0)
  } catch (error) {
    logger.error('❌ Error in cleanup script:', error)
    process.exit(1)
  }
}

main()
