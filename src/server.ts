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
// Import the new Socket.io system
import { initializeSocketServer, shutdownSocketServer } from './communication/sockets'
// Import Firebase Admin initialization
import { initializeFirebase } from './config/firebase'

const httpServer = http.createServer(app)

// Initialize services
const commandListener = new CommandListener(DATABASE_URL)
const commandRetryService = new CommandRetryService()

const gracefulShutdown = async (signal: string) => {
  logger.info(`Received ${signal}. Starting graceful shutdown...`)

  // Stop accepting new HTTP connections
  httpServer.close(async () => {
    logger.info('Http server closed.')

    try {
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

      // Shutdown Socket.io server
      logger.info('Shutting down Socket.io server...')
      await shutdownSocketServer()

      // Close RabbitMQ connections
      logger.info('Closing RabbitMQ connections...')
      await closeRabbitMQConnection()

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

    // Connect to RabbitMQ in background (non-blocking)
    // If RabbitMQ is unavailable, the app will continue without it
    // DEMO MODE: Skip RabbitMQ to save memory on free tier deployments
    if (process.env.DEMO_MODE === 'true') {
      logger.info('⏭️  RabbitMQ disabled (DEMO_MODE=true)')
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

    logger.info('✅ All communication and monitoring services started successfully.')

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
