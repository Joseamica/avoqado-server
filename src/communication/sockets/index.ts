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
  try {
    const io = socketManager.initialize(server)
    return io
  } catch (error) {
    logger.error('Failed to initialize Socket.io server', {
      correlationId: uuidv4(),
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
  try {
    await socketManager.shutdown()
  } catch (error) {
    logger.error('Error during Socket.io server shutdown', {
      correlationId: uuidv4(),
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
 * Broadcast TPV command
 * Convenience function for sending commands to specific TPV terminals
 */
export function broadcastTpvCommand(
  terminalId: string,
  venueId: string,
  command: {
    type: 'SHUTDOWN' | 'RESTART' | 'MAINTENANCE_MODE' | 'EXIT_MAINTENANCE' | 'UPDATE_STATUS' | string
    payload?: any
    requestedBy: string
  },
  options?: BroadcastOptions,
): void {
  try {
    if (socketManager.getServer()) {
      const correlationId = require('uuid').v4()
      const timestamp = new Date().toISOString()

      // Broadcast to venue - structure matches Android SocketManager.kt:732-755
      socketManager.broadcastToVenue(
        venueId,
        'tpv_command' as any,
        {
          terminalId,
          commandId: correlationId, // Use correlationId as commandId for tracking
          correlationId,
          type: command.type, // ← Android expects "type" at root level
          commandType: command.type, // ← Also include for backwards compatibility
          payload: command.payload,
          requiresPin: false,
          priority: 'NORMAL',
          expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(), // 5 min expiry
          requestedBy: command.requestedBy,
          requestedByName: null,
          venueId,
          timestamp,
          metadata: null,
        },
        options,
      )

      // Also broadcast command sent notification for admin visibility
      socketManager.broadcastToVenue(
        venueId,
        'tpv_command_sent' as any,
        {
          terminalId,
          command: command.type,
          requestedBy: command.requestedBy,
          timestamp,
        },
        options,
      )

      logger.info(`📡 TPV command broadcast: ${command.type} → ${terminalId}`, {
        terminalId,
        venueId,
        commandType: command.type,
        correlationId,
      })
    } else {
      logger.warn('Socket server not initialized for TPV command', {
        terminalId,
        venueId,
        commandType: command.type,
      })
    }
  } catch (error) {
    logger.error('Error broadcasting TPV command', {
      terminalId,
      venueId,
      commandType: command.type,
      error: error instanceof Error ? error.message : 'Unknown error',
    })
  }
}

/**
 * Broadcast TPV status update
 * Function for broadcasting when a TPV terminal changes status
 */
export function broadcastTpvStatusUpdate(
  terminalId: string,
  venueId: string,
  statusData: {
    status: string
    lastHeartbeat?: Date
    version?: string
    ipAddress?: string
    systemInfo?: any
  },
  options?: BroadcastOptions,
): void {
  try {
    if (socketManager.getServer()) {
      socketManager.broadcastToVenue(
        venueId,
        'tpv_status_update' as any,
        {
          terminalId,
          ...statusData,
          correlationId: require('uuid').v4(),
          timestamp: new Date(),
        },
        options,
      )
    } else {
      logger.warn('Socket server not initialized for TPV status update', {
        terminalId,
        venueId,
        status: statusData.status,
      })
    }
  } catch (error) {
    logger.error('Error broadcasting TPV status update', {
      terminalId,
      venueId,
      error: error instanceof Error ? error.message : 'Unknown error',
    })
  }
}

/**
 * Broadcast TPV command status changed
 * Notifies dashboard when a command's status changes (ACK, completed, failed, etc.)
 */
export function broadcastTpvCommandStatusChanged(
  terminalId: string,
  venueId: string,
  statusData: {
    terminalId: string
    terminalName: string
    commandId: string
    correlationId: string
    commandType: string
    previousStatus: string
    newStatus: string
    statusChangedAt: Date
    message?: string
    requestedByName?: string
  },
  options?: BroadcastOptions,
): void {
  try {
    if (socketManager.getServer()) {
      socketManager.broadcastToVenue(
        venueId,
        'tpv_command_status_changed' as any,
        {
          ...statusData,
          correlationId: statusData.correlationId || require('uuid').v4(),
          timestamp: new Date(),
        },
        options,
      )
    } else {
      logger.warn('Socket server not initialized for TPV command status change', {
        terminalId,
        venueId,
        commandId: statusData.commandId,
        newStatus: statusData.newStatus,
      })
    }
  } catch (error) {
    logger.error('Error broadcasting TPV command status change', {
      terminalId,
      venueId,
      commandId: statusData.commandId,
      error: error instanceof Error ? error.message : 'Unknown error',
    })
  }
}

/**
 * Broadcast TPV command queued notification
 * Notifies dashboard when a command is queued for offline terminal
 */
export function broadcastTpvCommandQueued(
  terminalId: string,
  venueId: string,
  queueData: {
    terminalId: string
    terminalName: string
    commandId: string
    correlationId: string
    commandType: string
    queuedAt: Date
    expiresAt: Date
    reason: string
  },
  options?: BroadcastOptions,
): void {
  try {
    if (socketManager.getServer()) {
      socketManager.broadcastToVenue(
        venueId,
        'tpv_command_queued' as any,
        {
          ...queueData,
          correlationId: queueData.correlationId || require('uuid').v4(),
          timestamp: new Date(),
        },
        options,
      )
    } else {
      logger.warn('Socket server not initialized for TPV command queued', {
        terminalId,
        venueId,
        commandId: queueData.commandId,
      })
    }
  } catch (error) {
    logger.error('Error broadcasting TPV command queued', {
      terminalId,
      venueId,
      commandId: queueData.commandId,
      error: error instanceof Error ? error.message : 'Unknown error',
    })
  }
}

/**
 * Broadcast TPV bulk operation progress
 * Notifies dashboard about progress of bulk command operations (e.g., restart all terminals)
 */
export function broadcastTpvBulkOperationProgress(
  venueId: string,
  progressData: {
    operationId: string
    commandType: string
    totalTerminals: number
    completedTerminals: number
    failedTerminals: number
    pendingTerminals: number
    status: string
    completedAt?: Date
  },
  options?: BroadcastOptions,
): void {
  try {
    if (socketManager.getServer()) {
      socketManager.broadcastToVenue(
        venueId,
        'tpv_bulk_operation_progress' as any,
        {
          ...progressData,
          correlationId: require('uuid').v4(),
          timestamp: new Date(),
        },
        options,
      )
    } else {
      logger.warn('Socket server not initialized for TPV bulk operation progress', {
        venueId,
        operationId: progressData.operationId,
        status: progressData.status,
      })
    }
  } catch (error) {
    logger.error('Error broadcasting TPV bulk operation progress', {
      venueId,
      operationId: progressData.operationId,
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
