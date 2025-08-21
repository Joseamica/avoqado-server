/**
 * Socket.io Communication Module
 * Enterprise-grade real-time communication for Avoqado
 *
 * This module provides a complete Socket.io infrastructure that integrates
 * seamlessly with the existing Avoqado backend architecture.
 *
 * Features:
 * - JWT Authentication integration with existing middleware patterns
 * - Hierarchical room management (venue -> table -> user)
 * - Role-based access control using Prisma StaffRole enum
 * - Enterprise-grade error handling with AppError classes
 * - Comprehensive logging with correlationId tracking
 * - Redis adapter support for horizontal scaling
 * - Rate limiting and security measures
 * - Strongly typed event system
 * - Modular broadcasting service
 *
 * @example
 * // Initialize in server.ts
 * import { initializeSocketServer } from './communication/sockets'
 *
 * const server = http.createServer(app)
 * const io = initializeSocketServer(server)
 *
 * @example
 * // Broadcast events from services
 * import { broadcastPaymentEvent, broadcastOrderEvent } from './communication/sockets'
 *
 * // In payment service
 * broadcastPaymentEvent(venueId, 'completed', paymentData)
 *
 * // In order service
 * broadcastOrderEvent(venueId, 'created', orderData)
 */

// Core exports
export { socketManager as default, SocketManager } from './managers/socketManager'
export { RoomManagerService } from './services/roomManager.service'
export { BroadcastingService } from './services/broadcasting.service'

// Controllers
export { ConnectionController } from './controllers/connection.controller'
export { RoomController } from './controllers/room.controller'
export { BusinessEventController } from './controllers/businessEvent.controller'

// Middleware
export {
  socketAuthenticationMiddleware,
  socketAuthorizationMiddleware,
  socketRateLimitMiddleware,
} from './middleware/authentication.middleware'

// Types and interfaces
export type {
  SocketAuthContext,
  AuthenticatedSocket,
  RoomIdentifier,
  BroadcastOptions,
  PaymentEventPayload,
  OrderEventPayload,
  SystemAlertPayload,
  NotificationEventPayload,
  BaseEventPayload,
  AuthenticationPayload,
  RoomJoinPayload,
  ISocketManager,
  SocketServerConfig,
  SocketEventHandler,
  SocketMiddleware,
} from './types'

export { SocketEventType, RoomType, SocketError, SocketAuthenticationError, SocketAuthorizationError } from './types'

// Configuration
export { socketConfig } from './config/socketConfig'

// Main initialization function
import http from 'http'
import { Server } from 'socket.io'
import { socketManager } from './managers/socketManager'
import logger from '../../config/logger'
import { v4 as uuidv4 } from 'uuid'

/**
 * Initialize Socket.io server
 * This function should be called from server.ts after creating the HTTP server
 */
export function initializeSocketServer(server: http.Server): Server {
  const correlationId = uuidv4()

  logger.info('📡 Initializing Socket.io server from main module', {
    correlationId,
    timestamp: new Date().toISOString(),
  })

  try {
    const io = socketManager.initialize(server)

    logger.info('📡 Socket.io server initialization completed successfully', {
      correlationId,
      serverInitialized: true,
    })

    return io
  } catch (error) {
    logger.error('Failed to initialize Socket.io server', {
      correlationId,
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
    })
    throw error
  }
}

/**
 * Get the initialized socket manager instance
 * Use this to access socket functionality from anywhere in the application
 */
export function getSocketManager(): typeof socketManager {
  return socketManager
}

/**
 * Graceful shutdown of Socket.io server
 * Should be called during application shutdown
 */
export async function shutdownSocketServer(): Promise<void> {
  const correlationId = uuidv4()

  logger.info('📡 Shutting down Socket.io server', {
    correlationId,
    timestamp: new Date().toISOString(),
  })

  try {
    await socketManager.shutdown()

    logger.info('📡 Socket.io server shutdown completed', {
      correlationId,
    })
  } catch (error) {
    logger.error('Error during Socket.io server shutdown', {
      correlationId,
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
    })
    throw error
  }
}

// Convenience functions for common operations

/**
 * Broadcast payment event
 * Convenience function for broadcasting payment-related events
 */
export function broadcastPaymentEvent(
  venueId: string,
  eventType: 'initiated' | 'processing' | 'completed' | 'failed',
  paymentData: any,
  options?: BroadcastOptions,
): void {
  try {
    // Use the socket manager's broadcasting methods directly
    if (socketManager.getServer()) {
      // Map event types to socket event types and broadcast using socket manager
      const eventMap = {
        initiated: 'payment_initiated' as any,
        processing: 'payment_processing' as any,
        completed: 'payment_completed' as any,
        failed: 'payment_failed' as any,
      }

      socketManager.broadcastToVenue(
        venueId,
        eventMap[eventType],
        {
          ...paymentData,
          correlationId: require('uuid').v4(),
          timestamp: new Date(),
          status: eventType,
        },
        options,
      )
    } else {
      logger.warn('Socket server not initialized for payment event', {
        venueId,
        eventType,
        paymentId: paymentData.paymentId,
      })
    }
  } catch (error) {
    logger.error('Error broadcasting payment event', {
      venueId,
      eventType,
      error: error instanceof Error ? error.message : 'Unknown error',
    })
  }
}

/**
 * Broadcast order event
 * Convenience function for broadcasting order-related events
 */
export function broadcastOrderEvent(
  venueId: string,
  eventType: 'created' | 'updated' | 'status_changed' | 'deleted',
  orderData: any,
  options?: BroadcastOptions,
): void {
  try {
    if (socketManager.getServer()) {
      // Map event types to socket event types
      const eventMap = {
        created: 'order_created' as any,
        updated: 'order_updated' as any,
        status_changed: 'order_status_changed' as any,
        deleted: 'order_deleted' as any,
      }

      socketManager.broadcastToVenue(
        venueId,
        eventMap[eventType],
        {
          ...orderData,
          correlationId: require('uuid').v4(),
          timestamp: new Date(),
        },
        options,
      )
    } else {
      logger.warn('Socket server not initialized for order event', {
        venueId,
        eventType,
        orderId: orderData.orderId,
      })
    }
  } catch (error) {
    logger.error('Error broadcasting order event', {
      venueId,
      eventType,
      error: error instanceof Error ? error.message : 'Unknown error',
    })
  }
}

/**
 * Broadcast system alert
 * Convenience function for broadcasting system alerts
 */
export function broadcastSystemAlert(venueId: string, alertData: any, options?: BroadcastOptions): void {
  try {
    if (socketManager.getServer()) {
      socketManager.broadcastToVenue(
        venueId,
        'system_alert' as any,
        {
          ...alertData,
          correlationId: require('uuid').v4(),
          timestamp: new Date(),
        },
        options,
      )
    } else {
      logger.warn('Socket server not initialized for system alert', {
        venueId,
        level: alertData.level,
        title: alertData.title,
      })
    }
  } catch (error) {
    logger.error('Error broadcasting system alert', {
      venueId,
      error: error instanceof Error ? error.message : 'Unknown error',
    })
  }
}

/**
 * Get connection statistics
 * Useful for monitoring and analytics
 */
export function getConnectionStats() {
  return socketManager.getServerStats()
}

// Re-export types for convenience
export type { Server } from 'socket.io'
import { BroadcastOptions } from './types'
