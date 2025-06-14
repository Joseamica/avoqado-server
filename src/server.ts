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
  logger.error('Uncaught Exception:', error)
  gracefulShutdown('uncaughtException')
})
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason)
  gracefulShutdown('unhandledRejection')
})

// --- Application Startup Logic ---
const startApplication = async () => {
  try {
    // Connect to RabbitMQ and ensure topology
    await connectToRabbitMQ()

    // Start event consumer (listens to events from POS)
    startEventConsumer()

    // Start command listener (replaces polling worker)
    await commandListener.start()

    // Start retry service for failed commands
    commandRetryService.start()

    logger.info('✅ All communication services started successfully.')

    // Start HTTP server
    if (require.main === module || NODE_ENV !== 'test') {
      httpServer.listen(PORT, () => {
        logger.info(`🚀 Server running at http://localhost:${PORT} in ${NODE_ENV} mode`)
        logger.info(`📚 API documentation available at http://localhost:${PORT}/api-docs`)
        if (NODE_ENV === 'development') {
          logger.warn('⚠️  Application is running in Development mode.')
        }
      })
    }
  } catch (error) {
    logger.error('💥 Critical failure during application startup:', error)
    process.exit(1)
  }
}

// Start the application
startApplication()

// Export for testing
export { httpServer as server, pgPool }
