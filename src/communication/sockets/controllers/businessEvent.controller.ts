import { StaffRole } from '@prisma/client'
import { AuthenticatedSocket, SocketEventType, PaymentEventPayload, OrderEventPayload, SystemAlertPayload } from '../types'
import { RoomManagerService } from '../services/roomManager.service'
import { BroadcastingService } from '../services/broadcasting.service'
import logger from '../../../config/logger'
import { BadRequestError, UnauthorizedError } from '../../../errors/AppError'
import { v4 as uuidv4 } from 'uuid'

/**
 * Business Event Controller
 * Handles business-specific real-time events following existing controller patterns
 * Manages payment, order, and system alert events with proper authorization
 */
export class BusinessEventController {
  private roomManager: RoomManagerService
  private broadcastingService: BroadcastingService | null = null

  constructor(roomManager: RoomManagerService) {
    this.roomManager = roomManager
  }

  public setBroadcastingService(broadcastingService: BroadcastingService): void {
    this.broadcastingService = broadcastingService
  }

  /**
   * Handle payment events
   * Following the same authorization pattern as HTTP controllers
   */
  public handlePaymentEvent(
    socket: AuthenticatedSocket,
    eventType: 'initiated' | 'processing' | 'completed' | 'failed',
    payload: Omit<PaymentEventPayload, 'correlationId' | 'timestamp' | 'status'>,
    callback?: (response: any) => void,
  ): void {
    const correlationId = socket.correlationId || uuidv4()

    try {
      // Validate authentication
      if (!socket.authContext) {
        const error = new UnauthorizedError('Authentication required for payment events')
        this.sendErrorResponse(error, correlationId, callback, socket)
        return
      }

      // Authorize payment event access
      this.authorizePaymentAccess(socket, eventType)

      // Validate payload
      this.validatePaymentPayload(payload)

      // Verify venue access
      if (payload.venueId !== socket.authContext.venueId) {
        const error = new UnauthorizedError('Access denied to specified venue')
        this.sendErrorResponse(error, correlationId, callback, socket)
        return
      }

      const { userId, venueId, role } = socket.authContext

      // Enrich payload with metadata
      const enrichedPayload: PaymentEventPayload = {
        ...payload,
        correlationId,
        timestamp: new Date(),
        status: eventType,
        userId,
      }

      // Broadcast payment event
      if (this.broadcastingService) {
        this.broadcastingService.broadcastPaymentEvent(venueId, eventType, enrichedPayload, { excludeSocket: socket.id })
      }

      // Send success response
      const response = {
        correlationId,
        success: true,
        message: `Payment ${eventType} event broadcasted`,
        eventType,
        paymentId: payload.paymentId,
      }

      if (callback) callback(response)

      logger.info('Payment event processed successfully', {
        correlationId,
        socketId: socket.id,
        userId,
        venueId,
        role,
        eventType,
        paymentId: payload.paymentId,
        amount: payload.amount,
      })
    } catch (error) {
      logger.error('Error processing payment event', {
        correlationId,
        socketId: socket.id,
        eventType,
        payload,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      })

      this.sendErrorResponse(error instanceof Error ? error : new Error('Payment event failed'), correlationId, callback, socket)
    }
  }

  /**
   * Handle order events
   */
  public handleOrderEvent(
    socket: AuthenticatedSocket,
    eventType: 'created' | 'updated' | 'status_changed' | 'deleted',
    payload: Omit<OrderEventPayload, 'correlationId' | 'timestamp'>,
    callback?: (response: any) => void,
  ): void {
    const correlationId = socket.correlationId || uuidv4()

    try {
      if (!socket.authContext) {
        const error = new UnauthorizedError('Authentication required for order events')
        this.sendErrorResponse(error, correlationId, callback, socket)
        return
      }

      // Authorize order event access
      this.authorizeOrderAccess(socket, eventType)

      // Validate payload
      this.validateOrderPayload(payload)

      // Verify venue access
      if (payload.venueId !== socket.authContext.venueId) {
        const error = new UnauthorizedError('Access denied to specified venue')
        this.sendErrorResponse(error, correlationId, callback, socket)
        return
      }

      const { userId, venueId, role } = socket.authContext

      // Enrich payload
      const enrichedPayload: OrderEventPayload = {
        ...payload,
        correlationId,
        timestamp: new Date(),
        userId,
      }

      // Broadcast order event
      if (this.broadcastingService) {
        this.broadcastingService.broadcastOrderEvent(venueId, eventType, enrichedPayload, { excludeSocket: socket.id })
      }

      // Send success response
      const response = {
        correlationId,
        success: true,
        message: `Order ${eventType} event broadcasted`,
        eventType,
        orderId: payload.orderId,
      }

      if (callback) callback(response)

      logger.info('Order event processed successfully', {
        correlationId,
        socketId: socket.id,
        userId,
        venueId,
        role,
        eventType,
        orderId: payload.orderId,
        tableId: payload.tableId,
      })
    } catch (error) {
      logger.error('Error processing order event', {
        correlationId,
        socketId: socket.id,
        eventType,
        payload,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      })

      this.sendErrorResponse(error instanceof Error ? error : new Error('Order event failed'), correlationId, callback, socket)
    }
  }

  /**
   * Handle system alerts
   */
  public handleSystemAlert(
    socket: AuthenticatedSocket,
    payload: Omit<SystemAlertPayload, 'correlationId' | 'timestamp'>,
    callback?: (response: any) => void,
  ): void {
    const correlationId = socket.correlationId || uuidv4()

    try {
      if (!socket.authContext) {
        const error = new UnauthorizedError('Authentication required for system alerts')
        this.sendErrorResponse(error, correlationId, callback, socket)
        return
      }

      // Authorize system alert access (usually admin/manager only)
      this.authorizeSystemAlertAccess(socket)

      // Validate payload
      this.validateSystemAlertPayload(payload)

      // Verify venue access
      if (payload.venueId !== socket.authContext.venueId) {
        const error = new UnauthorizedError('Access denied to specified venue')
        this.sendErrorResponse(error, correlationId, callback, socket)
        return
      }

      const { userId, venueId, role } = socket.authContext

      // Enrich payload
      const enrichedPayload: SystemAlertPayload = {
        ...payload,
        correlationId,
        timestamp: new Date(),
        userId,
      }

      // Broadcast system alert
      if (this.broadcastingService) {
        this.broadcastingService.broadcastSystemAlert(venueId, enrichedPayload, { excludeSocket: socket.id })
      }

      // Send success response
      const response = {
        correlationId,
        success: true,
        message: 'System alert broadcasted',
        level: payload.level,
        title: payload.title,
      }

      if (callback) callback(response)

      logger.info('System alert processed successfully', {
        correlationId,
        socketId: socket.id,
        userId,
        venueId,
        role,
        level: payload.level,
        title: payload.title,
        targetRoles: payload.targetRoles,
      })
    } catch (error) {
      logger.error('Error processing system alert', {
        correlationId,
        socketId: socket.id,
        payload,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      })

      this.sendErrorResponse(error instanceof Error ? error : new Error('System alert failed'), correlationId, callback, socket)
    }
  }

  // Authorization methods following existing patterns

  private authorizePaymentAccess(socket: AuthenticatedSocket, eventType: string): void {
    const { role } = socket.authContext!

    // Define which roles can trigger payment events
    const allowedRoles: StaffRole[] = [StaffRole.ADMIN, StaffRole.SUPERADMIN, StaffRole.MANAGER, StaffRole.WAITER, StaffRole.CASHIER]

    if (!allowedRoles.includes(role)) {
      throw new UnauthorizedError(`Role ${role} not authorized for payment events`)
    }

    // Additional authorization logic based on event type
    if (eventType === 'failed' || eventType === 'completed') {
      const criticalRoles: StaffRole[] = [StaffRole.ADMIN, StaffRole.SUPERADMIN, StaffRole.MANAGER, StaffRole.CASHIER]
      if (!criticalRoles.includes(role)) {
        throw new UnauthorizedError(`Role ${role} not authorized for ${eventType} payment events`)
      }
    }
  }

  private authorizeOrderAccess(socket: AuthenticatedSocket, eventType: string): void {
    const { role } = socket.authContext!

    // Define which roles can trigger order events
    const allowedRoles: StaffRole[] = [StaffRole.ADMIN, StaffRole.SUPERADMIN, StaffRole.MANAGER, StaffRole.WAITER, StaffRole.KITCHEN]

    if (!allowedRoles.includes(role)) {
      throw new UnauthorizedError(`Role ${role} not authorized for order events`)
    }

    // Additional authorization logic
    if (eventType === 'deleted') {
      const deleteRoles: StaffRole[] = [StaffRole.ADMIN, StaffRole.SUPERADMIN, StaffRole.MANAGER]
      if (!deleteRoles.includes(role)) {
        throw new UnauthorizedError(`Role ${role} not authorized to delete orders`)
      }
    }
  }

  private authorizeSystemAlertAccess(socket: AuthenticatedSocket): void {
    const { role } = socket.authContext!

    // Only admin and managers can send system alerts
    const allowedRoles: StaffRole[] = [StaffRole.ADMIN, StaffRole.SUPERADMIN, StaffRole.MANAGER]

    if (!allowedRoles.includes(role)) {
      throw new UnauthorizedError(`Role ${role} not authorized to send system alerts`)
    }
  }

  // Validation methods

  private validatePaymentPayload(payload: any): void {
    if (!payload.paymentId) {
      throw new BadRequestError('Payment ID is required')
    }
    if (!payload.amount || payload.amount <= 0) {
      throw new BadRequestError('Valid payment amount is required')
    }
    if (!payload.currency) {
      throw new BadRequestError('Currency is required')
    }
    if (!payload.venueId) {
      throw new BadRequestError('Venue ID is required')
    }
  }

  private validateOrderPayload(payload: any): void {
    if (!payload.orderId) {
      throw new BadRequestError('Order ID is required')
    }
    if (!payload.venueId) {
      throw new BadRequestError('Venue ID is required')
    }
    // Additional validation based on business requirements
  }

  private validateSystemAlertPayload(payload: any): void {
    if (!payload.level) {
      throw new BadRequestError('Alert level is required')
    }
    if (!payload.title) {
      throw new BadRequestError('Alert title is required')
    }
    if (!payload.message) {
      throw new BadRequestError('Alert message is required')
    }
    if (!payload.venueId) {
      throw new BadRequestError('Venue ID is required')
    }

    const validLevels = ['info', 'warning', 'error', 'critical']
    if (!validLevels.includes(payload.level)) {
      throw new BadRequestError(`Invalid alert level. Must be one of: ${validLevels.join(', ')}`)
    }
  }

  private sendErrorResponse(error: Error, correlationId: string, callback?: (response: any) => void, socket?: AuthenticatedSocket): void {
    const statusCode = error instanceof BadRequestError ? 400 : error instanceof UnauthorizedError ? 401 : 500

    const response = {
      correlationId,
      success: false,
      error: error.message,
      statusCode,
    }

    if (callback) callback(response)
    if (socket) socket.emit(SocketEventType.ERROR, response)
  }

  /**
   * Get business event statistics
   */
  public getEventStats(): {
    connectionsByRole: Record<string, number>
    totalEvents: number
  } {
    const connectionStats = this.roomManager.getConnectionStats()

    return {
      connectionsByRole: connectionStats.roleConnections,
      totalEvents: 0, // Would need to track this in a real implementation
    }
  }
}
