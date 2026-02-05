// src/server.ts - Main entry point for the application

// Ensure environment variables are loaded and checked first.
// This import will also handle dotenv.config() and exit if critical vars are missing.
import './config/env'

import http from 'http'
import app from './app' // The configured Express application
import logger from './config/logger'
import { PORT, NODE_ENV, DATABASE_URL } from './config/env'
import pgPool from './config/database' // Import pgPool for graceful shutdown
import prisma from './utils/prismaClient' // Import Prisma client for graceful shutdown
import { connectToRabbitMQ, closeRabbitMQConnection } from './communication/rabbitmq/connection'
import { CommandListener } from './communication/rabbitmq/commandListener'
import { CommandRetryService } from './communication/rabbitmq/commandRetryService'
import { startEventConsumer } from './communication/rabbitmq/consumer'
import { startPosConnectionMonitor } from './jobs/monitorPosConnections'
import { tpvHealthMonitorJob } from './jobs/tpv-health-monitor.job'
import { subscriptionCancellationJob } from './jobs/subscription-cancellation.job'
import { settlementDetectionJob } from './jobs/settlement-detection.job'
import { abandonedOrdersCleanupJob } from './jobs/abandoned-orders-cleanup.job'
import { commissionAggregationJob } from './jobs/commission-aggregation.job'
import { autoClockOutJob } from './jobs/auto-clockout.job'
import { nightlySalesSummaryJob } from './jobs/nightly-sales-summary.job'
import { marketingCampaignJob } from './jobs/marketing-campaign.job'
// Import the new Socket.io system
import { initializeSocketServer, shutdownSocketServer } from './communication/sockets'
// Import Firebase Admin initialization
import { initializeFirebase } from './config/firebase'
// Import Stripe feature sync startup
import { ensureFeaturesAreSyncedToStripe } from './startup/stripe-sync.startup'
// Import live demo cleanup service (DEMO MODE only)
import { CronJob } from 'cron'
import { cleanupExpiredLiveDemos } from './services/cleanup/liveDemoCleanup.service'

const httpServer = http.createServer(app)

// Initialize services
const commandListener = new CommandListener(DATABASE_URL)
const commandRetryService = new CommandRetryService()

// Live demo cleanup job (initialized only in DEMO_MODE)
let liveDemoCleanupJob: CronJob | null = null

const gracefulShutdown = async (signal: string) => {
  logger.info(`Received ${signal}. Starting graceful shutdown...`)

  // Stop accepting new HTTP connections
  httpServer.close(async () => {
    logger.info('Http server closed.')

    try {
      // Only stop services that were started (skip in demo mode)
      if (process.env.DEMO_MODE !== 'true') {
        // Stop command processing services
        logger.info('Stopping command services...')
        await commandListener.stop()
        commandRetryService.stop()

        // Stop TPV health monitor
        logger.info('Stopping TPV health monitor...')
        tpvHealthMonitorJob.stop()

        // Stop subscription cancellation job
        logger.info('Stopping subscription cancellation job...')
        subscriptionCancellationJob.stop()

        // Stop settlement detection job
        logger.info('Stopping settlement detection job...')
        settlementDetectionJob.stop()

        // Stop abandoned orders cleanup job
        logger.info('Stopping abandoned orders cleanup job...')
        abandonedOrdersCleanupJob.stop()

        // Stop commission aggregation job
        logger.info('Stopping commission aggregation job...')
        commissionAggregationJob.stop()

        // Stop auto clock-out job
        logger.info('Stopping auto clock-out job...')
        autoClockOutJob.stop()

        // Stop nightly sales summary job
        logger.info('Stopping nightly sales summary job...')
        nightlySalesSummaryJob.stop()

        // Stop live demo cleanup job
        if (liveDemoCleanupJob) {
          logger.info('Stopping live demo cleanup job...')
          liveDemoCleanupJob.stop()
        }

        // Shutdown Socket.io server
        logger.info('Shutting down Socket.io server...')
        await shutdownSocketServer()

        // Close RabbitMQ connections
        logger.info('Closing RabbitMQ connections...')
        await closeRabbitMQConnection()
      } else {
        // In DEMO_MODE, stop the live demo cleanup job
        if (liveDemoCleanupJob) {
          logger.info('Stopping live demo cleanup job...')
          liveDemoCleanupJob.stop()
        }
      }

      // Close database connections
      logger.info('Closing database connections...')
      await pgPool.end()
      logger.info('PostgreSQL pool has been closed.')

      await prisma.$disconnect()
      logger.info('Prisma client has been disconnected.')

      process.exit(0)
    } catch (error) {
      logger.error('Error during graceful shutdown:', error)
      process.exit(1)
    }
  })

  // Force shutdown after 30 seconds
  setTimeout(() => {
    logger.error('Forced shutdown after timeout')
    process.exit(1)
  }, 30000)
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))
process.on('uncaughtException', error => {
  try {
    logger.error('Uncaught Exception, initiating shutdown...', error)
    gracefulShutdown('uncaughtException')
  } catch (shutdownError) {
    logger.error('Error during graceful shutdown:', shutdownError)
    process.exit(1)
  }
})
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason)
  gracefulShutdown('unhandledRejection')
})

// --- Application Startup Logic ---
const startApplication = async (retries = 3) => {
  try {
    // Initialize Firebase Admin SDK (for storage file deletion)
    try {
      initializeFirebase()
      logger.info('✅ Firebase Admin SDK initialized')
    } catch (error) {
      logger.warn('⚠️  Firebase Admin SDK not initialized. File deletion from storage will be skipped.', error)
      // Continue startup even if Firebase is not configured
    }

    // Sync features to Stripe (non-blocking)
    // Ensures all features have Stripe product/price IDs for subscriptions
    ensureFeaturesAreSyncedToStripe().catch(err => {
      logger.warn('⚠️  Stripe feature sync failed during startup:', err)
    })

    // Connect to RabbitMQ in background (non-blocking)
    // If RabbitMQ is unavailable, the app will continue without it
    // DEMO MODE or DISABLE_RABBITMQ: Skip RabbitMQ to save bandwidth/memory
    if (process.env.DEMO_MODE === 'true' || process.env.DISABLE_RABBITMQ === 'true') {
      logger.info('⏭️  RabbitMQ disabled (DEMO_MODE or DISABLE_RABBITMQ)')
    } else {
      connectToRabbitMQ()
        .then(() => {
          // Start event consumer only if RabbitMQ connected successfully
          try {
            startEventConsumer()
            logger.info('✅ Event consumer started')
          } catch (err) {
            logger.warn('⚠️  Event consumer could not start:', err)
          }

          // Start command listener
          commandListener.start().catch(err => {
            logger.warn('⚠️  Command listener could not start:', err)
          })
        })
        .catch(err => {
          logger.warn('⚠️  RabbitMQ initialization failed, continuing without it:', err)
        })
    }

    // DEMO MODE: Skip background jobs to save memory on free tier deployments
    if (process.env.DEMO_MODE === 'true') {
      logger.info('⏭️  Background jobs disabled (DEMO_MODE=true)')

      // Start live demo cleanup job (ONLY in DEMO_MODE)
      // Runs every hour to clean up expired/inactive demo sessions
      liveDemoCleanupJob = new CronJob(
        '0 * * * *', // Every hour at :00 minutes
        async () => {
          try {
            const cleanedCount = await cleanupExpiredLiveDemos()
            if (cleanedCount > 0) {
              logger.info(`🧹 Live Demo Cleanup: Deleted ${cleanedCount} expired/inactive sessions`)
            }
          } catch (error) {
            logger.error('❌ Error in Live Demo Cleanup:', error)
          }
        },
        null,
        true, // Start immediately
        'America/Mexico_City',
      )

      logger.info('🧹 Live Demo Cleanup Job started - running every hour (DEMO_MODE=true)')
    } else {
      // Start retry service for failed commands
      commandRetryService.start()

      // Start POS connection monitor
      startPosConnectionMonitor()

      // Start TPV health monitor
      tpvHealthMonitorJob.start()

      // Start subscription cancellation job
      subscriptionCancellationJob.start()

      // Start settlement detection job
      settlementDetectionJob.start()

      // Start abandoned orders cleanup job
      abandonedOrdersCleanupJob.start()

      // Start commission aggregation job (daily at 3:00 AM Mexico City)
      commissionAggregationJob.start()

      // Start auto clock-out job (every 15 minutes for HR automation)
      autoClockOutJob.start()

      // Start nightly sales summary job (daily at 10 PM Mexico City - sends email to admins/owners)
      nightlySalesSummaryJob.start()

      // Start marketing campaign job (every 5 minutes - processes email queue)
      marketingCampaignJob.start()

      // Start live demo cleanup job (runs every hour to delete expired sessions)
      liveDemoCleanupJob = new CronJob(
        '0 * * * *', // Every hour at :00 minutes
        async () => {
          try {
            const cleanedCount = await cleanupExpiredLiveDemos()
            if (cleanedCount > 0) {
              logger.info(`🧹 Live Demo Cleanup: Deleted ${cleanedCount} expired/inactive sessions`)
            }
          } catch (error) {
            logger.error('❌ Error in Live Demo Cleanup:', error)
          }
        },
        null,
        true, // Start immediately
        'America/Mexico_City',
      )

      logger.info('✅ All communication and monitoring services started successfully.')
      logger.info('🧹 Live Demo Cleanup Job started - running every hour')
    }

    // Start HTTP server
    if (require.main === module || NODE_ENV !== 'test') {
      httpServer.listen(PORT, () => {
        logger.info(`🚀 Server running at http://localhost:${PORT} in ${NODE_ENV} mode`)
        logger.info(`📚 API documentation available at http://localhost:${PORT}/api-docs`)
        if (NODE_ENV === 'development') {
          logger.warn('⚠️  Application is running in Development mode.')
        }
      })

      // Initialize Socket.io server after HTTP server starts
      // DEMO MODE: Skip Socket.IO to save memory on free tier deployments
      if (process.env.DEMO_MODE === 'true') {
        logger.info('⏭️  Socket.IO disabled (DEMO_MODE=true)')
      } else {
        initializeSocketServer(httpServer)
        logger.info('✅ Socket.IO server initialized')
      }
    }
  } catch (error) {
    if (retries > 0) {
      logger.warn(`Startup failed, retrying... (${retries} attempts left)`)
      setTimeout(() => startApplication(retries - 1), 5000)
    } else {
      logger.error('💥 Critical failure after all retries:', error)
      process.exit(1)
    }
  }
}

// Start the application
startApplication()

// Export for testing
export { httpServer as server, pgPool }
