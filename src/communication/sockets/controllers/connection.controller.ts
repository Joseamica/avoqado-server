import { NextFunction } from 'express'
import { AuthenticatedSocket, SocketEventType, AuthenticationPayload, SocketAuthenticationError } from '../types'
import { RoomManagerService } from '../services/roomManager.service'
import { BroadcastingService } from '../services/broadcasting.service'
import { socketAuthenticationMiddleware } from '../middleware/authentication.middleware'
import logger from '../../../config/logger'
import { v4 as uuidv4 } from 'uuid'

/**
 * Connection Controller
 * Handles socket connection lifecycle following existing controller patterns
 * Integrates with authentication and room management services
 */
export class ConnectionController {
  private roomManager: RoomManagerService
  private broadcastingService: BroadcastingService | null = null

  constructor(roomManager: RoomManagerService) {
    this.roomManager = roomManager
  }

  public setBroadcastingService(broadcastingService: BroadcastingService): void {
    this.broadcastingService = broadcastingService
  }

  /**
   * Handle new socket connection
   * Following the same pattern as HTTP controllers
   */
  public handleConnection(socket: AuthenticatedSocket): void {
    const correlationId = socket.correlationId || uuidv4()
    
    try {
      // If already authenticated (via middleware), register immediately
      if (socket.authContext) {
        this.registerAuthenticatedSocket(socket)
        
        // Emit authentication success
        socket.emit(SocketEventType.AUTHENTICATION_SUCCESS, {
          correlationId,
          authContext: {
            userId: socket.authContext.userId,
            venueId: socket.authContext.venueId,
            role: socket.authContext.role,
            orgId: socket.authContext.orgId
          },
          connectedAt: socket.authContext.connectedAt
        })
      }

      logger.info('Socket connection handled successfully', {
        correlationId,
        socketId: socket.id,
        authenticated: !!socket.authContext,
        userId: socket.authContext?.userId,
        venueId: socket.authContext?.venueId
      })

    } catch (error) {
      logger.error('Error handling socket connection', {
        correlationId,
        socketId: socket.id,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined
      })

      // Emit error and disconnect
      socket.emit(SocketEventType.ERROR, {
        correlationId,
        error: 'Connection handling failed',
        message: 'An error occurred while establishing connection'
      })
      
      socket.disconnect(true)
    }
  }

  /**
   * Handle manual authentication (if not done via middleware)
   */
  public handleAuthentication(
    socket: AuthenticatedSocket, 
    payload: AuthenticationPayload, 
    callback?: (response: any) => void
  ): void {
    const correlationId = socket.correlationId || uuidv4()
    
    try {
      logger.info('Manual socket authentication attempt', {
        correlationId,
        socketId: socket.id,
        hasToken: !!payload.token
      })

      // If already authenticated, return success
      if (socket.authContext) {
        const response = {
          correlationId,
          success: true,
          message: 'Already authenticated',
          authContext: socket.authContext
        }
        
        if (callback) callback(response)
        socket.emit(SocketEventType.AUTHENTICATION_SUCCESS, response)
        return
      }

      // Manually authenticate using the middleware logic
      const mockSocket = {
        ...socket,
        handshake: {
          ...socket.handshake,
          auth: { token: payload.token }
        }
      } as unknown as AuthenticatedSocket

      socketAuthenticationMiddleware(mockSocket, (error?: Error) => {
        if (error) {
          logger.warn('Manual socket authentication failed', {
            correlationId,
            socketId: socket.id,
            error: error.message
          })

          const response = {
            correlationId,
            success: false,
            error: error.message
          }

          if (callback) callback(response)
          socket.emit(SocketEventType.AUTHENTICATION_ERROR, response)
          socket.disconnect(true)
          return
        }

        // Copy auth context from mock socket
        socket.authContext = mockSocket.authContext
        
        if (socket.authContext) {
          this.registerAuthenticatedSocket(socket)
          
          const response = {
            correlationId,
            success: true,
            message: 'Authentication successful',
            authContext: socket.authContext
          }
          
          if (callback) callback(response)
          socket.emit(SocketEventType.AUTHENTICATION_SUCCESS, response)

          logger.info('Manual socket authentication successful', {
            correlationId,
            socketId: socket.id,
            userId: socket.authContext.userId,
            venueId: socket.authContext.venueId
          })
        }
      })

    } catch (error) {
      logger.error('Error during manual socket authentication', {
        correlationId,
        socketId: socket.id,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined
      })

      const response = {
        correlationId,
        success: false,
        error: 'Authentication processing failed'
      }

      if (callback) callback(response)
      socket.emit(SocketEventType.AUTHENTICATION_ERROR, response)
      socket.disconnect(true)
    }
  }

  /**
   * Handle socket disconnection
   */
  public handleDisconnection(socket: AuthenticatedSocket, reason: string): void {
    const correlationId = socket.correlationId || uuidv4()
    
    try {
      logger.info('Socket disconnection', {
        correlationId,
        socketId: socket.id,
        reason,
        userId: socket.authContext?.userId,
        venueId: socket.authContext?.venueId,
        duration: socket.authContext ? 
          Date.now() - socket.authContext.connectedAt.getTime() : 
          undefined
      })

      // Unregister from room manager
      if (socket.authContext) {
        this.roomManager.unregisterSocket(socket)
        
        // Notify venue about user disconnection (optional)
        if (this.broadcastingService && socket.authContext.venueId) {
          this.broadcastingService.broadcastToVenue(
            socket.authContext.venueId,
            SocketEventType.VENUE_UPDATE,
            {
              type: 'user_disconnected',
              userId: socket.authContext.userId,
              role: socket.authContext.role,
              timestamp: new Date()
            },
            { excludeSocket: socket.id }
          )
        }
      }

    } catch (error) {
      logger.error('Error handling socket disconnection', {
        correlationId,
        socketId: socket.id,
        reason,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined
      })
    }
  }

  /**
   * Get connection statistics
   */
  public getConnectionStats(): {
    totalConnections: number
    authenticatedConnections: number
    venueConnections: Record<string, number>
  } {
    const stats = this.roomManager.getConnectionStats()
    return {
      totalConnections: stats.totalConnections,
      authenticatedConnections: stats.totalConnections, // All registered are authenticated
      venueConnections: stats.venueConnections
    }
  }

  // Private helper methods

  private registerAuthenticatedSocket(socket: AuthenticatedSocket): void {
    if (!socket.authContext) {
      throw new SocketAuthenticationError('Cannot register socket without auth context')
    }

    // Register with room manager
    this.roomManager.registerSocket(socket)

    // Update last activity timestamp
    const updateActivity = () => {
      if (socket.authContext) {
        socket.authContext.lastActivity = new Date()
      }
    }

    // Track activity on events
    const originalEmit = socket.emit.bind(socket)
    socket.emit = function(...args: Parameters<typeof originalEmit>) {
      updateActivity()
      return originalEmit(...args)
    }

    // Also track when socket receives events
    socket.onAny(() => {
      updateActivity()
    })

    // Notify venue about new user connection (optional)
    if (this.broadcastingService) {
      this.broadcastingService.broadcastToVenue(
        socket.authContext.venueId,
        SocketEventType.VENUE_UPDATE,
        {
          type: 'user_connected',
          userId: socket.authContext.userId,
          role: socket.authContext.role,
          timestamp: socket.authContext.connectedAt
        },
        { excludeSocket: socket.id }
      )
    }
  }
}
