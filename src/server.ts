// src/server.ts - Main entry point for the application

// Ensure environment variables are loaded and checked first.
// This import will also handle dotenv.config() and exit if critical vars are missing.
import './config/env'

import http from 'http'
import app, { getAppCpuPercent, getAppActiveConnections, getAppEventLoopHistogram } from './app' // The configured Express application
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
import { nightlyLowStockJob } from './jobs/nightly-low-stock.job'
import { marketingCampaignJob } from './jobs/marketing-campaign.job'
import { moneygiverSettlementJob } from './jobs/moneygiver-settlement.job'
import { venueCommissionSettlementJob } from './jobs/venue-commission-settlement.job'
// Import the new Socket.io system
import { initializeSocketServer, shutdownSocketServer } from './communication/sockets'
// Import Firebase Admin initialization
import { initializeFirebase } from './config/firebase'
// Import Stripe feature sync startup
import { ensureFeaturesAreSyncedToStripe } from './startup/stripe-sync.startup'
// Import live demo cleanup service (DEMO MODE only)
import { CronJob } from 'cron'
import { cleanupExpiredLiveDemos } from './services/cleanup/liveDemoCleanup.service'
// Import server metrics collection
import { startMetricsCollection, stopMetricsCollection } from './services/superadmin/serverMetrics.service'

const httpServer = http.createServer(app)

// Initialize services
const commandListener = new CommandListener(DATABASE_URL)
const commandRetryService = new CommandRetryService()

// Live demo cleanup job (initialized only in DEMO_MODE)
let liveDemoCleanupJob: CronJob | null = null

const gracefulShutdown = async (signal: string) => {
  logger.info(`Received ${signal}. Starting graceful shutdown...`)

  // Use the Zod-validated NODE_ENV (imported from ./config/env) instead of
  // process.env.NODE_ENV directly. Zod's default() populates the parsed value
  // but does NOT write back to process.env, so process.env.NODE_ENV can be
  // undefined even when NODE_ENV === 'development' from the config module.
  const isDev = NODE_ENV === 'development'

  // Stop accepting new connections AND force-close active ones. Without
  // closeAllConnections(), httpServer.close()'s callback never fires while
  // Socket.io keep-alive clients (TPVs) remain connected — the port would
  // stay bound until the force-exit timeout, racing against tsx watch's
  // respawn on file save and producing EADDRINUSE.
  httpServer.close(() => logger.info('Http server closed.'))
  httpServer.closeAllConnections?.()

  // Dev fast-path: tsx watch spawns the replacement process within ~100ms
  // of killing the old one. Running the full Rabbit/Socket/DB cleanup would
  // hold the port past that deadline. Local dev doesn't need graceful
  // draining — Rabbit and Postgres tolerate abrupt client disconnects fine.
  if (isDev) {
    logger.info(`[Shutdown] Dev fast-exit on ${signal} — skipping graceful cleanup (NODE_ENV=${NODE_ENV})`)
    return process.exit(0)
  }

  // Prod / staging path: full graceful cleanup. Runs regardless of whether
  // httpServer.close()'s callback fired, since we no longer wait for it.
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

      // Stop nightly low stock digest job
      logger.info('Stopping nightly low stock digest job...')
      nightlyLowStockJob.stop()

      // Stop settlement jobs
      moneygiverSettlementJob.stop()
      venueCommissionSettlementJob.stop()

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

    // Stop server metrics collection
    stopMetricsCollection()

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

  // Force shutdown after 30s if the prod cleanup above stalls on a hanging
  // Rabbit/Socket/DB handle. Dev path already returned above with process.exit(0).
  setTimeout(() => {
    logger.error('Forced shutdown after 30s timeout')
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

      // Start Moneygiver daily settlement report (daily at 7:00 AM Mexico City)
      moneygiverSettlementJob.start()

      // Start Venue Commission settlement report (daily at 7:00 AM Mexico City)
      venueCommissionSettlementJob.start()

      // Start auto clock-out job (every 15 minutes for HR automation)
      autoClockOutJob.start()

      // Start nightly email jobs only in production (avoid sending emails from dev/staging)
      if (NODE_ENV === 'production') {
        nightlySalesSummaryJob.start()
        nightlyLowStockJob.start()
        logger.info('📧 Nightly email jobs started (production)')
      } else {
        logger.info('⏭️  Nightly email jobs disabled (non-production environment)')
      }

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
      // Listen with EADDRINUSE retry — protects against tsx watch's "Rerunning..."
      // mode where a new process is spawned WITHOUT sending SIGTERM to the old
      // one, leaving a brief window (~100-500ms) where the port is still bound.
      // Without this retry, hot-reloads cascade into fatal EADDRINUSE crashes.
      // Only active in dev; prod listens once and fails fast so the platform
      // (Render/systemd) can restart cleanly.
      //
      // Bump maxListeners a bit: each failed listen() attempt adds internal
      // handlers on the Server emitter. Default is 10; we allow enough headroom
      // for our retry count without triggering a noisy MaxListenersExceeded
      // warning during a recovery sequence.
      httpServer.setMaxListeners(25)

      const isDevEnv = NODE_ENV === 'development'
      const maxAttempts = isDevEnv ? 10 : 1
      const retryDelayMs = 500

      const listenWithRetry = (attempt = 1) => {
        // Success + error handlers are scoped to THIS attempt only — we remove
        // both before scheduling the next retry so listeners don't accumulate.
        const onListening = () => {
          httpServer.removeListener('error', onError)
          if (attempt > 1) logger.info(`Port ${PORT} freed on attempt ${attempt}`)
          logger.info(`🚀 Server running at http://localhost:${PORT} in ${NODE_ENV} mode`)
          logger.info(`📚 API documentation available at http://localhost:${PORT}/api-docs`)
          if (isDevEnv) {
            logger.warn('⚠️  Application is running in Development mode.')
          }
        }
        const onError = (err: NodeJS.ErrnoException) => {
          httpServer.removeListener('listening', onListening)
          if (err.code === 'EADDRINUSE' && attempt < maxAttempts) {
            logger.warn(`Port ${PORT} busy (attempt ${attempt}/${maxAttempts}). Retrying in ${retryDelayMs}ms…`)
            setTimeout(() => listenWithRetry(attempt + 1), retryDelayMs)
            return
          }
          if (err.code === 'EADDRINUSE') {
            // Final attempt failed — likely an orphan process is holding the
            // port (not a restart race). Tell the dev how to recover.
            logger.error(
              `Port ${PORT} still busy after ${maxAttempts} attempts. ` +
                `An orphan process is likely holding it. Run:\n` +
                `   lsof -ti:${PORT} | xargs kill -9\n` +
                `Then restart 'npm run dev'.`,
            )
          } else {
            logger.error('HTTP server failed to bind', { code: err.code, port: PORT, attempt })
          }
          process.exit(1)
        }
        httpServer.once('listening', onListening)
        httpServer.once('error', onError)
        httpServer.listen(PORT)
      }
      listenWithRetry()

      // Start server metrics collection (health monitoring)
      // Wire app.ts live monitors → metrics service
      startMetricsCollection({
        cpuPercentFn: getAppCpuPercent,
        activeConnectionsFn: getAppActiveConnections,
        eventLoopHistogramFn: getAppEventLoopHistogram,
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
