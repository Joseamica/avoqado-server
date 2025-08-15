import { Server } from 'socket.io'
import { StaffRole } from '@prisma/client'
import {
  SocketEventType,
  BroadcastOptions,
  PaymentEventPayload,
  OrderEventPayload,
  SystemAlertPayload,
  BaseEventPayload,
  AuthenticatedSocket,
} from '../types'
import { RoomManagerService } from './roomManager.service'
import logger from '../../../config/logger'
import { v4 as uuidv4 } from 'uuid'

/**
 * Broadcasting Service
 * Handles all real-time event broadcasting following existing service patterns
 * Integrates with room management and logging systems
 */
export class BroadcastingService {
  private io: Server
  private roomManager: RoomManagerService

  constructor(io: Server, roomManager: RoomManagerService) {
    this.io = io
    this.roomManager = roomManager
  }

  /**
   * Broadcast to entire venue
   */
  public broadcastToVenue(venueId: string, event: SocketEventType, payload: any, options: BroadcastOptions = {}): void {
    const correlationId = uuidv4()

    try {
      const sockets = this.roomManager.getVenueSockets(venueId)
      const filteredSockets = this.roomManager.filterSocketsByOptions(sockets, options)

      const enrichedPayload = this.enrichPayload(payload, correlationId, venueId)

      // Emit to each filtered socket
      filteredSockets.forEach(socket => {
        socket.emit(event, enrichedPayload)
      })

      logger.info('Broadcast to venue completed', {
        correlationId,
        venueId,
        event,
        totalSockets: sockets.length,
        filteredSockets: filteredSockets.length,
        options: this.sanitizeOptions(options),
      })
    } catch (error) {
      logger.error('Error broadcasting to venue', {
        correlationId,
        venueId,
        event,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      })
    }
  }

  /**
   * Broadcast to specific table
   */
  public broadcastToTable(venueId: string, tableId: string, event: SocketEventType, payload: any, options: BroadcastOptions = {}): void {
    const correlationId = uuidv4()

    try {
      const sockets = this.roomManager.getTableSockets(venueId, tableId)
      const filteredSockets = this.roomManager.filterSocketsByOptions(sockets, options)

      const enrichedPayload = this.enrichPayload(payload, correlationId, venueId)

      filteredSockets.forEach(socket => {
        socket.emit(event, enrichedPayload)
      })

      logger.info('Broadcast to table completed', {
        correlationId,
        venueId,
        tableId,
        event,
        totalSockets: sockets.length,
        filteredSockets: filteredSockets.length,
        options: this.sanitizeOptions(options),
      })
    } catch (error) {
      logger.error('Error broadcasting to table', {
        correlationId,
        venueId,
        tableId,
        event,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      })
    }
  }

  /**
   * Broadcast to users with specific role
   */
  public broadcastToRole(role: StaffRole, event: SocketEventType, payload: any, venueId?: string, options: BroadcastOptions = {}): void {
    const correlationId = uuidv4()

    try {
      const sockets = this.roomManager.getRoleSockets(role, venueId)
      const filteredSockets = this.roomManager.filterSocketsByOptions(sockets, options)

      const enrichedPayload = this.enrichPayload(payload, correlationId, venueId)

      filteredSockets.forEach(socket => {
        socket.emit(event, enrichedPayload)
      })

      logger.info('Broadcast to role completed', {
        correlationId,
        role,
        venueId,
        event,
        totalSockets: sockets.length,
        filteredSockets: filteredSockets.length,
        options: this.sanitizeOptions(options),
      })
    } catch (error) {
      logger.error('Error broadcasting to role', {
        correlationId,
        role,
        venueId,
        event,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      })
    }
  }

  /**
   * Broadcast to specific user
   */
  public broadcastToUser(userId: string, event: SocketEventType, payload: any, options: BroadcastOptions = {}): void {
    const correlationId = uuidv4()

    try {
      const sockets = this.roomManager.getUserSockets(userId)
      const filteredSockets = this.roomManager.filterSocketsByOptions(sockets, options)

      const enrichedPayload = this.enrichPayload(payload, correlationId)

      filteredSockets.forEach(socket => {
        socket.emit(event, enrichedPayload)
      })

      logger.info('Broadcast to user completed', {
        correlationId,
        userId,
        event,
        totalSockets: sockets.length,
        filteredSockets: filteredSockets.length,
        options: this.sanitizeOptions(options),
      })
    } catch (error) {
      logger.error('Error broadcasting to user', {
        correlationId,
        userId,
        event,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      })
    }
  }

  // Specific business event methods for easy usage

  /**
   * Payment Events
   */
  public broadcastPaymentEvent(
    venueId: string,
    eventType: 'initiated' | 'processing' | 'completed' | 'failed',
    paymentData: Omit<PaymentEventPayload, 'correlationId' | 'timestamp' | 'status'>,
    options?: BroadcastOptions,
  ): void {
    const eventMap = {
      initiated: SocketEventType.PAYMENT_INITIATED,
      processing: SocketEventType.PAYMENT_PROCESSING,
      completed: SocketEventType.PAYMENT_COMPLETED,
      failed: SocketEventType.PAYMENT_FAILED,
    }

    const payload: PaymentEventPayload = {
      ...paymentData,
      correlationId: uuidv4(),
      timestamp: new Date(),
      status: eventType,
    }

    // Broadcast to venue (dashboards, admin panels)
    this.broadcastToVenue(venueId, eventMap[eventType], payload, options)

    // Also broadcast to specific table if tableId exists
    if (payload.tableId) {
      this.broadcastToTable(venueId, payload.tableId, eventMap[eventType], payload, options)
    }
  }

  /**
   * Order Events
   */
  public broadcastOrderEvent(
    venueId: string,
    eventType: 'created' | 'updated' | 'status_changed' | 'deleted',
    orderData: Omit<OrderEventPayload, 'correlationId' | 'timestamp'>,
    options?: BroadcastOptions,
  ): void {
    const eventMap = {
      created: SocketEventType.ORDER_CREATED,
      updated: SocketEventType.ORDER_UPDATED,
      status_changed: SocketEventType.ORDER_STATUS_CHANGED,
      deleted: SocketEventType.ORDER_DELETED,
    }

    const payload: OrderEventPayload = {
      ...orderData,
      correlationId: uuidv4(),
      timestamp: new Date(),
    }

    // Broadcast to venue
    this.broadcastToVenue(venueId, eventMap[eventType], payload, options)

    // Broadcast to specific table if exists
    if (payload.tableId) {
      this.broadcastToTable(venueId, payload.tableId, eventMap[eventType], payload, options)
    }

    // Broadcast to waiters and kitchen staff for new orders
    if (eventType === 'created') {
      this.broadcastToRole(StaffRole.WAITER, eventMap[eventType], payload, venueId, options)
      this.broadcastToRole(StaffRole.KITCHEN, eventMap[eventType], payload, venueId, options)
    }
  }

  /**
   * System Alert Events
   */
  public broadcastSystemAlert(
    venueId: string,
    alertData: Omit<SystemAlertPayload, 'correlationId' | 'timestamp'>,
    options?: BroadcastOptions,
  ): void {
    const payload: SystemAlertPayload = {
      ...alertData,
      correlationId: uuidv4(),
      timestamp: new Date(),
    }

    // If specific roles are targeted, broadcast to those roles
    if (alertData.targetRoles && alertData.targetRoles.length > 0) {
      alertData.targetRoles.forEach(role => {
        this.broadcastToRole(role, SocketEventType.SYSTEM_ALERT, payload, venueId, options)
      })
    } else {
      // Broadcast to entire venue if no specific roles
      this.broadcastToVenue(venueId, SocketEventType.SYSTEM_ALERT, payload, options)
    }
  }

  /**
   * Get broadcasting statistics
   */
  public getBroadcastingStats(): {
    connectionStats: ReturnType<RoomManagerService['getConnectionStats']>
    serverStats: {
      connectedClients: number
      rooms: number
    }
  } {
    return {
      connectionStats: this.roomManager.getConnectionStats(),
      serverStats: {
        connectedClients: this.io.sockets.sockets.size,
        rooms: this.io.sockets.adapter.rooms.size,
      },
    }
  }

  // Private helper methods

  private enrichPayload(payload: any, correlationId: string, venueId?: string): any {
    const enriched = {
      ...payload,
      correlationId,
      timestamp: payload.timestamp || new Date(),
    }

    if (venueId && !enriched.venueId) {
      enriched.venueId = venueId
    }

    return enriched
  }

  private sanitizeOptions(options: BroadcastOptions): any {
    return {
      excludeSocket: options.excludeSocket ? '***' : undefined,
      includeRoles: options.includeRoles,
      excludeRoles: options.excludeRoles,
      hasMetadata: !!options.metadata,
    }
  }
}
