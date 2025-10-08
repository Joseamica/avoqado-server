// src/server.ts - Main entry point for the application

// Ensure environment variables are loaded and checked first.
// This import will also handle dotenv.config() and exit if critical vars are missing.
import './config/env'

import http from 'http'
import detect from 'detect-port'
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
// Import the new Socket.io system
import { initializeSocketServer, shutdownSocketServer } from './communication/sockets'

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
    // Connect to RabbitMQ and ensure topology
    await connectToRabbitMQ()

    // Start event consumer (listens to events from POS)
    startEventConsumer()

    // Start command listener (replaces polling worker)
    await commandListener.start()

    // Start retry service for failed commands
    commandRetryService.start()

    // Start POS connection monitor
    startPosConnectionMonitor()

    // Start TPV health monitor
    tpvHealthMonitorJob.start()

    logger.info('✅ All communication and monitoring services started successfully.')

    // Start HTTP server
    if (require.main === module || NODE_ENV !== 'test') {
      const availablePort = await detect(Number(PORT))

      if (availablePort !== Number(PORT)) {
        logger.warn(`⚠️  Port ${PORT} is already in use, using port ${availablePort} instead`)
      }

      httpServer.listen(availablePort, () => {
        logger.info(`🚀 Server running at http://localhost:${availablePort} in ${NODE_ENV} mode`)
        logger.info(`📚 API documentation available at http://localhost:${availablePort}/api-docs`)
        if (NODE_ENV === 'development') {
          logger.warn('⚠️  Application is running in Development mode.')
        }
      })

      // Initialize Socket.io server after HTTP server starts
      logger.info('📡 Initializing Socket.io server...')
      initializeSocketServer(httpServer)
      logger.info('✅ 📡 Socket.io server initialized successfully')
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
