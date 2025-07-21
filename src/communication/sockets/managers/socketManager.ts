import { Server, Socket } from 'socket.io'
import http from 'http'
// Redis imports - will be conditionally used if Redis is configured
let createAdapter: any
let createClient: any
try {
  createAdapter = require('@socket.io/redis-adapter').createAdapter
  createClient = require('redis').createClient
} catch (error) {
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
type ConnectionController = any
type RoomController = any
type BusinessEventController = any

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

  constructor(config?: Partial<SocketServerConfig>) {
    this.config = { ...socketConfig, ...config }
    this.roomManager = new RoomManagerService()

    // Initialize controllers - will be properly imported when modules are created
    this.connectionController = {} as any // Placeholder
    this.roomController = {} as any // Placeholder
    this.businessEventController = {} as any // Placeholder
  }

  /**
   * Initialize Socket.io server
   */
  public initialize(server: http.Server): Server {
    logger.info('📡 Initializing Socket.io server', {
      correlationId: uuidv4(),
      config: {
        corsOrigins: this.config.cors.origin.length,
        authRequired: this.config.authentication.required,
        redisEnabled: !!this.config.redis,
      },
    })

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

    // Provide broadcasting service to controllers (when properly implemented)
    // this.connectionController.setBroadcastingService(this.broadcastingService)
    // this.roomController.setBroadcastingService(this.broadcastingService)
    // this.businessEventController.setBroadcastingService(this.broadcastingService)

    logger.info('📡 Socket.io server initialized successfully', {
      correlationId: uuidv4(),
      serverVersion: '4.x',
    })

    return this.io
  }

  /**
   * Setup Redis adapter for horizontal scaling
   */
  private async setupRedisAdapter(): Promise<void> {
    if (!this.config.redis || !this.io || !createAdapter || !createClient) {
      logger.info('Redis adapter not configured or modules not available, using memory adapter')
      return
    }

    try {
      const { host, port, password, db } = this.config.redis

      // Create Redis clients
      this.redisClient = createClient({
        socket: {
          host,
          port,
        },
        password,
        database: db,
      })

      this.redisSubscriber = createClient({
        socket: {
          host,
          port,
        },
        password,
        database: db,
      })

      // Connect clients
      await this.redisClient.connect()
      await this.redisSubscriber.connect()

      // Setup adapter
      this.io.adapter(createAdapter(this.redisClient, this.redisSubscriber))

      logger.info('Redis adapter configured successfully', {
        correlationId: uuidv4(),
        host,
        port,
        db,
      })
    } catch (error) {
      logger.error('Failed to setup Redis adapter', {
        correlationId: uuidv4(),
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      })

      // Continue without Redis adapter
      logger.warn('Continuing with memory adapter due to Redis setup failure')
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

    logger.info('📡 Socket middleware configured', {
      correlationId: uuidv4(),
      authRequired: this.config.authentication.required,
      rateLimitEnabled: true,
    })
  }

  /**
   * Setup event handlers
   */
  private setupEventHandlers(): void {
    if (!this.io) return

    this.io.on(SocketEventType.CONNECTION, (socket: Socket) => {
      const authenticatedSocket = socket as AuthenticatedSocket
      const correlationId = authenticatedSocket.correlationId || uuidv4()

      logger.info('📡 New socket connection', {
        correlationId,
        socketId: socket.id,
        ip: socket.handshake.address,
        userAgent: socket.handshake.headers['user-agent'],
        authContext: authenticatedSocket.authContext
          ? {
              userId: authenticatedSocket.authContext.userId,
              venueId: authenticatedSocket.authContext.venueId,
              role: authenticatedSocket.authContext.role,
            }
          : null,
      })

      // Register socket with room manager if authenticated
      if (authenticatedSocket.authContext) {
        this.roomManager.registerSocket(authenticatedSocket)
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

    // Disconnection
    socket.on(SocketEventType.DISCONNECT, reason => {
      if (socket.authContext) {
        this.roomManager.unregisterSocket(socket)
      }
      logger.info('📡 Socket disconnected', {
        correlationId: socket.correlationId,
        socketId: socket.id,
        reason,
        userId: socket.authContext?.userId,
      })
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
    logger.info('📡 Shutting down Socket.io server', {
      correlationId: uuidv4(),
    })

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

      logger.info('📡 Socket.io server shutdown completed', {
        correlationId: uuidv4(),
      })
    } catch (error) {
      logger.error('📡 Error during Socket.io shutdown', {
        correlationId: uuidv4(),
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      })
    }
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
