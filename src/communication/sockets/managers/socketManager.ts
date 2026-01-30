import { Server, Socket } from 'socket.io'
import http from 'http'
// Redis imports - will be conditionally used if Redis is configured
let createAdapter: any
let createClient: any
try {
  createAdapter = require('@socket.io/redis-adapter').createAdapter
  createClient = require('redis').createClient
} catch {
  // Redis modules not available - will use memory adapter
}
import { StaffRole } from '@prisma/client'

import { SocketEventType, AuthenticatedSocket, ISocketManager, BroadcastOptions, SocketServerConfig } from '../types'
import { socketConfig } from '../config/socketConfig'
import { socketAuthenticationMiddleware, socketRateLimitMiddleware } from '../middleware/authentication.middleware'
import { RoomManagerService } from '../services/roomManager.service'
import { BroadcastingService } from '../services/broadcasting.service'
import logger from '../../../config/logger'
import { v4 as uuidv4 } from 'uuid'

// Import event controllers
import { ConnectionController } from '../controllers/connection.controller'

// Import TPV command service for handling command ACK/results
import { tpvCommandExecutionService } from '../../../services/tpv/command-execution.service'
// Import terminal registry for tracking terminalId → socketId
import { terminalRegistry } from '../terminal-registry'
// Import terminal payment service for handling payment results
import { terminalPaymentService } from '../../../services/terminal-payment.service'
import { RoomController } from '../controllers/room.controller'
import { BusinessEventController } from '../controllers/businessEvent.controller'
import { ObservabilityController } from '../controllers/observability.controller'

/**
 * Main Socket Manager
 * Enterprise-grade Socket.io server following existing patterns
 * Integrates authentication, room management, and event broadcasting
 */
export class SocketManager implements ISocketManager {
  private io: Server | null = null
  private roomManager: RoomManagerService
  private broadcastingService: BroadcastingService | null = null
  private config: SocketServerConfig
  private redisClient?: any
  private redisSubscriber?: any

  // Controllers
  private connectionController: ConnectionController
  private roomController: RoomController
  private businessEventController: BusinessEventController
  private observabilityController: ObservabilityController

  constructor(config?: Partial<SocketServerConfig>) {
    this.config = { ...socketConfig, ...config }
    this.roomManager = new RoomManagerService()

    // Initialize controllers
    this.connectionController = new ConnectionController(this.roomManager)
    this.roomController = new RoomController(this.roomManager)
    this.businessEventController = new BusinessEventController(this.roomManager)
    this.observabilityController = new ObservabilityController(this.roomManager)
  }

  /**
   * Initialize Socket.io server
   */
  public initialize(server: http.Server): Server {
    logger.info('📡 Socket.io server initializing...')

    // Create Socket.io server
    this.io = new Server(server, {
      cors: this.config.cors,
      allowRequest: (req, callback) => {
        // Additional request validation can be added here
        callback(null, true)
      },
    })

    // Setup Redis adapter if configured
    this.setupRedisAdapter()

    // Setup middleware
    this.setupMiddleware()

    // Setup event handlers
    this.setupEventHandlers()

    // Initialize broadcasting service
    this.broadcastingService = new BroadcastingService(this.io, this.roomManager)

    // Provide broadcasting service to controllers
    this.connectionController.setBroadcastingService(this.broadcastingService)
    this.roomController.setBroadcastingService(this.broadcastingService)
    this.businessEventController.setBroadcastingService(this.broadcastingService)
    this.observabilityController.setBroadcastingService(this.broadcastingService)

    logger.info('✅ Socket.io server ready')

    return this.io
  }

  /**
   * Setup Redis adapter for horizontal scaling
   */
  private async setupRedisAdapter(): Promise<void> {
    if (!this.config.redis || !this.io || !createAdapter || !createClient) {
      return
    }

    try {
      // ✅ FIXED: Support both URL and individual properties
      let clientConfig: any

      if (this.config.redis.url) {
        // Use URL (Railway, Heroku style)
        clientConfig = { url: this.config.redis.url }
      } else {
        // Use individual properties (traditional style)
        clientConfig = {
          socket: {
            host: this.config.redis.host,
            port: this.config.redis.port,
          },
          password: this.config.redis.password,
          database: this.config.redis.db,
        }
      }

      // Create Redis clients
      this.redisClient = createClient(clientConfig)
      this.redisSubscriber = createClient(clientConfig)

      // Connect clients
      await this.redisClient.connect()
      await this.redisSubscriber.connect()

      // Setup adapter
      this.io.adapter(createAdapter(this.redisClient, this.redisSubscriber))

      logger.info('✅ Redis adapter configured')
    } catch (error) {
      logger.error('Failed to setup Redis adapter', {
        correlationId: uuidv4(),
        error: error instanceof Error ? error.message : 'Unknown error',
      })

      logger.warn('⚠️  Using memory adapter instead')
    }
  }
  /**
   * Setup middleware chain
   */
  private setupMiddleware(): void {
    if (!this.io) return

    // Rate limiting middleware
    this.io.use((socket: Socket, next) => {
      const rateLimitMiddleware = socketRateLimitMiddleware({
        windowMs: this.config.rateLimit.windowMs,
        maxEvents: this.config.rateLimit.maxEventsPerWindow,
      })
      rateLimitMiddleware(socket as any, next as any)
    })

    // Authentication middleware
    if (this.config.authentication.required) {
      this.io.use((socket: Socket, next) => {
        socketAuthenticationMiddleware(socket as any, next as any)
      })
    }
  }

  /**
   * Setup event handlers
   */
  private setupEventHandlers(): void {
    if (!this.io) return

    this.io.on(SocketEventType.CONNECTION, (socket: Socket) => {
      const authenticatedSocket = socket as AuthenticatedSocket
      const _correlationId = authenticatedSocket.correlationId || uuidv4()

      const user = authenticatedSocket.authContext?.userId || 'unauthenticated'
      logger.info(`📡 Socket connected: ${user} (${socket.id})`)

      // Register socket with room manager if authenticated
      if (authenticatedSocket.authContext) {
        this.roomManager.registerSocket(authenticatedSocket)

        // Register terminal in registry if terminalId provided in auth handshake
        const terminalId = socket.handshake?.auth?.terminalId
        if (terminalId) {
          terminalRegistry.register(terminalId, socket.id, authenticatedSocket.authContext.venueId)
        }
      }

      // Setup authentication timeout if required
      if (this.config.authentication.required && !authenticatedSocket.authContext) {
        this.setupAuthenticationTimeout(authenticatedSocket)
      }

      // Register event handlers
      this.registerSocketEventHandlers(authenticatedSocket)
    })
  }

  /**
   * Register event handlers for individual sockets
   */
  private registerSocketEventHandlers(socket: AuthenticatedSocket): void {
    // Authentication events (if not already authenticated)
    socket.on(SocketEventType.AUTHENTICATE, (payload, callback) => {
      this.connectionController.handleAuthentication(socket, payload, callback)
    })

    // Room management events
    socket.on(SocketEventType.JOIN_ROOM, (payload, callback) => {
      this.roomController.handleJoinRoom(socket, payload, callback)
    })

    socket.on(SocketEventType.LEAVE_ROOM, (payload, callback) => {
      this.roomController.handleLeaveRoom(socket, payload, callback)
    })

    // Business events
    socket.on(SocketEventType.PAYMENT_INITIATED, (payload, callback) => {
      this.businessEventController.handlePaymentEvent(socket, 'initiated', payload, callback)
    })

    socket.on(SocketEventType.ORDER_CREATED, (payload, callback) => {
      this.businessEventController.handleOrderEvent(socket, 'created', payload, callback)
    })

    socket.on(SocketEventType.ORDER_UPDATED, (payload, callback) => {
      this.businessEventController.handleOrderEvent(socket, 'updated', payload, callback)
    })

    // System events
    socket.on(SocketEventType.SYSTEM_ALERT, (payload, callback) => {
      this.businessEventController.handleSystemAlert(socket, payload, callback)
    })

    // Observability events (Terminal → Server)
    socket.on('tpv:log', (payload, callback) => {
      this.observabilityController.handleTerminalLog(socket, payload, callback)
    })

    socket.on('tpv:heartbeat', (payload, callback) => {
      this.observabilityController.handleTerminalHeartbeat(socket, payload, callback)
    })

    // TPV Command Events (Terminal → Server)
    // Handle command acknowledgment from terminal
    socket.on(SocketEventType.TPV_COMMAND_ACK, async (payload, callback) => {
      try {
        const { commandId, terminalId, receivedAt } = payload
        logger.info('📡 TPV Command ACK received', { commandId, terminalId, socketId: socket.id })

        await tpvCommandExecutionService.handleCommandAck(commandId, terminalId, receivedAt ? new Date(receivedAt) : new Date())

        if (callback) callback({ success: true, message: 'ACK processed' })
      } catch (error) {
        logger.error('Error processing TPV command ACK', {
          socketId: socket.id,
          payload,
          error: error instanceof Error ? error.message : 'Unknown error',
        })
        if (callback) callback({ success: false, error: error instanceof Error ? error.message : 'Unknown error' })
      }
    })

    // Handle command execution started from terminal
    socket.on(SocketEventType.TPV_COMMAND_STARTED, async (payload, callback) => {
      try {
        const { commandId, terminalId, startedAt } = payload
        logger.info('📡 TPV Command execution started', { commandId, terminalId, socketId: socket.id })

        await tpvCommandExecutionService.handleCommandStarted(commandId, terminalId, startedAt ? new Date(startedAt) : new Date())

        if (callback) callback({ success: true, message: 'Execution start recorded' })
      } catch (error) {
        logger.error('Error processing TPV command started', {
          socketId: socket.id,
          payload,
          error: error instanceof Error ? error.message : 'Unknown error',
        })
        if (callback) callback({ success: false, error: error instanceof Error ? error.message : 'Unknown error' })
      }
    })

    // Handle command result from terminal (SUCCESS/FAILURE/REJECTED)
    socket.on(SocketEventType.TPV_COMMAND_RESULT, async (payload, callback) => {
      try {
        const { commandId, terminalId, success, resultStatus: directResultStatus, resultData, errorMessage, message } = payload

        // Support both formats:
        // 1. Android sends: { resultStatus: 'SUCCESS'|'REJECTED'|'FAILED', message: '...' }
        // 2. Legacy format: { success: true|false, errorMessage: '...' }
        let resultStatus: string
        if (directResultStatus) {
          // Android format - use directly (normalize ERROR → FAILED for backwards compatibility)
          resultStatus = directResultStatus === 'ERROR' ? 'FAILED' : directResultStatus
        } else {
          // Legacy format - convert boolean to status
          // Valid enum values: SUCCESS, PARTIAL_SUCCESS, FAILED, TIMEOUT, REJECTED
          resultStatus = success ? 'SUCCESS' : 'FAILED'
        }

        logger.info('📡 TPV Command result received', {
          commandId,
          terminalId,
          resultStatus,
          message: message || errorMessage,
          socketId: socket.id,
        })

        await tpvCommandExecutionService.handleCommandResult(
          commandId,
          terminalId,
          resultStatus as any,
          message || errorMessage,
          resultData,
        )

        if (callback) callback({ success: true, message: 'Result processed' })
      } catch (error) {
        logger.error('Error processing TPV command result', {
          socketId: socket.id,
          payload,
          error: error instanceof Error ? error.message : 'Unknown error',
        })
        if (callback) callback({ success: false, error: error instanceof Error ? error.message : 'Unknown error' })
      }
    })

    // Terminal Payment Result (TPV → Server → iOS HTTP response)
    socket.on('terminal:payment_result', (payload, callback) => {
      try {
        const { requestId, status, transactionId, cardDetails, errorMessage, receipt } = payload
        logger.info('💳 Terminal payment result received', {
          requestId,
          status,
          transactionId,
          socketId: socket.id,
        })

        const handled = terminalPaymentService.handlePaymentResult({
          requestId,
          status,
          transactionId,
          cardDetails,
          errorMessage,
          receipt,
        })

        if (callback) callback({ success: handled })
      } catch (error) {
        logger.error('Error processing terminal payment result', {
          socketId: socket.id,
          payload,
          error: error instanceof Error ? error.message : 'Unknown error',
        })
        if (callback) callback({ success: false, error: error instanceof Error ? error.message : 'Unknown error' })
      }
    })

    // Disconnection
    socket.on(SocketEventType.DISCONNECT, _reason => {
      if (socket.authContext) {
        this.roomManager.unregisterSocket(socket)
      }
      // Clean up terminal registry
      terminalRegistry.unregisterBySocketId(socket.id)
      const user = socket.authContext?.userId || 'unauthenticated'
      logger.info(`📡 Socket disconnected: ${user} (${socket.id})`)
    })

    // Error handling
    socket.on('error', error => {
      logger.error('📡 Socket error', {
        correlationId: socket.correlationId,
        socketId: socket.id,
        userId: socket.authContext?.userId,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      })
    })
  }

  /**
   * Setup authentication timeout for unauthenticated connections
   */
  private setupAuthenticationTimeout(socket: AuthenticatedSocket): void {
    const timeout = setTimeout(() => {
      if (!socket.authContext) {
        logger.warn('📡 Socket authentication timeout', {
          correlationId: socket.correlationId,
          socketId: socket.id,
          timeout: this.config.authentication.timeout,
        })

        socket.emit(SocketEventType.AUTHENTICATION_ERROR, {
          error: 'Authentication timeout',
          message: 'Authentication required within timeout period',
        })

        socket.disconnect(true)
      }
    }, this.config.authentication.timeout)

    // Clear timeout if socket disconnects or authenticates
    socket.on(SocketEventType.DISCONNECT, () => clearTimeout(timeout))
    socket.on(SocketEventType.AUTHENTICATION_SUCCESS, () => clearTimeout(timeout))
  }

  // Public broadcasting methods implementing ISocketManager interface

  public broadcastToVenue(venueId: string, event: SocketEventType, payload: any, options?: BroadcastOptions): void {
    if (!this.broadcastingService) {
      logger.error('📡 Broadcasting service not initialized')
      return
    }
    this.broadcastingService.broadcastToVenue(venueId, event, payload, options)
  }

  public broadcastToTable(venueId: string, tableId: string, event: SocketEventType, payload: any, options?: BroadcastOptions): void {
    if (!this.broadcastingService) {
      logger.error('📡 Broadcasting service not initialized')
      return
    }
    this.broadcastingService.broadcastToTable(venueId, tableId, event, payload, options)
  }

  public broadcastToRole(role: StaffRole, event: SocketEventType, payload: any, options?: BroadcastOptions): void {
    if (!this.broadcastingService) {
      logger.error('📡 Broadcasting service not initialized')
      return
    }
    this.broadcastingService.broadcastToRole(role, event, payload, undefined, options)
  }

  public broadcastToUser(userId: string, event: SocketEventType, payload: any, options?: BroadcastOptions): void {
    if (!this.broadcastingService) {
      logger.error('📡 Broadcasting service not initialized')
      return
    }
    this.broadcastingService.broadcastToUser(userId, event, payload, options)
  }

  public getConnectedSockets(venueId: string): AuthenticatedSocket[] {
    return this.roomManager.getVenueSockets(venueId)
  }

  public getSocketsByRole(role: StaffRole, venueId?: string): AuthenticatedSocket[] {
    return this.roomManager.getRoleSockets(role, venueId)
  }

  /**
   * Get server statistics
   */
  public getServerStats() {
    if (!this.broadcastingService) {
      return null
    }
    return this.broadcastingService.getBroadcastingStats()
  }

  /**
   * Graceful shutdown
   */
  public async shutdown(): Promise<void> {
    try {
      // Close all socket connections
      if (this.io) {
        this.io.close()
      }

      // Close Redis connections
      if (this.redisClient) {
        await this.redisClient.disconnect()
      }
      if (this.redisSubscriber) {
        await this.redisSubscriber.disconnect()
      }

      logger.info('✅ Socket.io server shutdown completed')
    } catch (error) {
      logger.error('Error during Socket.io shutdown', {
        correlationId: uuidv4(),
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      })
    }
  }

  /**
   * Get the broadcasting service
   */
  public getBroadcastingService(): BroadcastingService | null {
    return this.broadcastingService
  }

  /**
   * Get the Socket.io server instance
   */
  public getServer(): Server | null {
    return this.io
  }
}

// Export singleton instance
export const socketManager = new SocketManager()
export default socketManager
