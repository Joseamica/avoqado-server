import { AuthenticatedSocket, SocketEventType, RoomJoinPayload, RoomType } from '../types'
import { RoomManagerService } from '../services/roomManager.service'
import { BroadcastingService } from '../services/broadcasting.service'
import logger from '../../../config/logger'
import { BadRequestError, UnauthorizedError } from '../../../errors/AppError'
import { v4 as uuidv4 } from 'uuid'

/**
 * Room Controller
 * Handles room management operations following existing controller patterns
 * Manages venue, table, and role-based room assignments
 */
export class RoomController {
  private roomManager: RoomManagerService
  private broadcastingService: BroadcastingService | null = null

  constructor(roomManager: RoomManagerService) {
    this.roomManager = roomManager
  }

  public setBroadcastingService(broadcastingService: BroadcastingService): void {
    this.broadcastingService = broadcastingService
  }

  /**
   * Handle join room request
   * Following the same error handling pattern as HTTP controllers
   */
  public handleJoinRoom(
    socket: AuthenticatedSocket,
    payload: RoomJoinPayload,
    callback?: (response: any) => void
  ): void {
    const correlationId = socket.correlationId || uuidv4()

    try {
      // Validate authentication
      if (!socket.authContext) {
        const error = new UnauthorizedError('Authentication required to join rooms')
        this.sendErrorResponse(error, correlationId, callback, socket)
        return
      }

      // Validate payload
      this.validateJoinRoomPayload(payload)

      // Authorize room access
      this.authorizeRoomAccess(socket, payload)

      const { roomType, venueId, tableId, metadata } = payload
      const { userId, role } = socket.authContext

      // Verify venue access
      if (venueId !== socket.authContext.venueId) {
        const error = new UnauthorizedError('Access denied to specified venue')
        this.sendErrorResponse(error, correlationId, callback, socket)
        return
      }

      // Handle different room types
      switch (roomType) {
        case RoomType.TABLE:
          this.handleJoinTableRoom(socket, tableId!, correlationId, callback)
          break

        case RoomType.VENUE:
          this.handleJoinVenueRoom(socket, correlationId, callback)
          break

        case RoomType.ROLE:
          this.handleJoinRoleRoom(socket, correlationId, callback)
          break

        case RoomType.USER:
          this.handleJoinUserRoom(socket, correlationId, callback)
          break

        default:
          const error = new BadRequestError(`Unsupported room type: ${roomType}`)
          this.sendErrorResponse(error, correlationId, callback, socket)
      }

      logger.info('Room join request processed', {
        correlationId,
        socketId: socket.id,
        userId,
        venueId,
        roomType,
        tableId,
        role,
        metadata
      })

    } catch (error) {
      logger.error('Error processing join room request', {
        correlationId,
        socketId: socket.id,
        payload,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined
      })

      this.sendErrorResponse(
        error instanceof Error ? error : new Error('Join room failed'),
        correlationId,
        callback,
        socket
      )
    }
  }

  /**
   * Handle leave room request
   */
  public handleLeaveRoom(
    socket: AuthenticatedSocket,
    payload: RoomJoinPayload,
    callback?: (response: any) => void
  ): void {
    const correlationId = socket.correlationId || uuidv4()

    try {
      if (!socket.authContext) {
        const error = new UnauthorizedError('Authentication required to leave rooms')
        this.sendErrorResponse(error, correlationId, callback, socket)
        return
      }

      this.validateJoinRoomPayload(payload)

      const { roomType, venueId, tableId } = payload
      const { userId, role } = socket.authContext

      // Verify venue access
      if (venueId !== socket.authContext.venueId) {
        const error = new UnauthorizedError('Access denied to specified venue')
        this.sendErrorResponse(error, correlationId, callback, socket)
        return
      }

      // Handle different room types
      switch (roomType) {
        case RoomType.TABLE:
          this.handleLeaveTableRoom(socket, tableId!, correlationId, callback)
          break

        default:
          // For other room types, users are automatically managed
          const response = {
            correlationId,
            success: true,
            message: `Left ${roomType} room`,
            roomType,
            venueId
          }
          
          if (callback) callback(response)
          socket.emit(SocketEventType.ROOM_LEFT, response)
      }

      logger.info('Room leave request processed', {
        correlationId,
        socketId: socket.id,
        userId,
        venueId,
        roomType,
        tableId,
        role
      })

    } catch (error) {
      logger.error('Error processing leave room request', {
        correlationId,
        socketId: socket.id,
        payload,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined
      })

      this.sendErrorResponse(
        error instanceof Error ? error : new Error('Leave room failed'),
        correlationId,
        callback,
        socket
      )
    }
  }

  // Private helper methods for different room types

  private handleJoinTableRoom(
    socket: AuthenticatedSocket,
    tableId: string,
    correlationId: string,
    callback?: (response: any) => void
  ): void {
    if (!tableId) {
      throw new BadRequestError('Table ID required for table room')
    }

    // Join the table room
    this.roomManager.joinTableRoom(socket, tableId)

    const response = {
      correlationId,
      success: true,
      message: `Joined table room: ${tableId}`,
      roomType: RoomType.TABLE,
      venueId: socket.authContext!.venueId,
      tableId
    }

    if (callback) callback(response)
    socket.emit(SocketEventType.ROOM_JOINED, response)

    // Notify other table members
    if (this.broadcastingService) {
      this.broadcastingService.broadcastToTable(
        socket.authContext!.venueId,
        tableId,
        SocketEventType.TABLE_STATUS_CHANGE,
        {
          type: 'user_joined_table',
          userId: socket.authContext!.userId,
          role: socket.authContext!.role,
          tableId,
          timestamp: new Date()
        },
        { excludeSocket: socket.id }
      )
    }
  }

  private handleLeaveTableRoom(
    socket: AuthenticatedSocket,
    tableId: string,
    correlationId: string,
    callback?: (response: any) => void
  ): void {
    if (!tableId) {
      throw new BadRequestError('Table ID required for table room')
    }

    // Leave the table room
    this.roomManager.leaveTableRoom(socket, tableId)

    const response = {
      correlationId,
      success: true,
      message: `Left table room: ${tableId}`,
      roomType: RoomType.TABLE,
      venueId: socket.authContext!.venueId,
      tableId
    }

    if (callback) callback(response)
    socket.emit(SocketEventType.ROOM_LEFT, response)

    // Notify other table members
    if (this.broadcastingService) {
      this.broadcastingService.broadcastToTable(
        socket.authContext!.venueId,
        tableId,
        SocketEventType.TABLE_STATUS_CHANGE,
        {
          type: 'user_left_table',
          userId: socket.authContext!.userId,
          role: socket.authContext!.role,
          tableId,
          timestamp: new Date()
        },
        { excludeSocket: socket.id }
      )
    }
  }

  private handleJoinVenueRoom(
    socket: AuthenticatedSocket,
    correlationId: string,
    callback?: (response: any) => void
  ): void {
    // Users are automatically in venue rooms
    const response = {
      correlationId,
      success: true,
      message: `Already in venue room: ${socket.authContext!.venueId}`,
      roomType: RoomType.VENUE,
      venueId: socket.authContext!.venueId
    }

    if (callback) callback(response)
    socket.emit(SocketEventType.ROOM_JOINED, response)
  }

  private handleJoinRoleRoom(
    socket: AuthenticatedSocket,
    correlationId: string,
    callback?: (response: any) => void
  ): void {
    // Users are automatically in role rooms
    const response = {
      correlationId,
      success: true,
      message: `Already in role room: ${socket.authContext!.role}`,
      roomType: RoomType.ROLE,
      venueId: socket.authContext!.venueId,
      role: socket.authContext!.role
    }

    if (callback) callback(response)
    socket.emit(SocketEventType.ROOM_JOINED, response)
  }

  private handleJoinUserRoom(
    socket: AuthenticatedSocket,
    correlationId: string,
    callback?: (response: any) => void
  ): void {
    // Users are automatically in their user rooms
    const response = {
      correlationId,
      success: true,
      message: `Already in user room: ${socket.authContext!.userId}`,
      roomType: RoomType.USER,
      venueId: socket.authContext!.venueId,
      userId: socket.authContext!.userId
    }

    if (callback) callback(response)
    socket.emit(SocketEventType.ROOM_JOINED, response)
  }

  // Validation methods

  private validateJoinRoomPayload(payload: RoomJoinPayload): void {
    if (!payload) {
      throw new BadRequestError('Room payload is required')
    }

    if (!payload.roomType) {
      throw new BadRequestError('Room type is required')
    }

    if (!payload.venueId) {
      throw new BadRequestError('Venue ID is required')
    }

    if (payload.roomType === RoomType.TABLE && !payload.tableId) {
      throw new BadRequestError('Table ID is required for table rooms')
    }

    // Validate room type
    if (!Object.values(RoomType).includes(payload.roomType)) {
      throw new BadRequestError(`Invalid room type: ${payload.roomType}`)
    }
  }

  private authorizeRoomAccess(socket: AuthenticatedSocket, payload: RoomJoinPayload): void {
    const { role } = socket.authContext!
    const { roomType } = payload

    // Add role-based room access rules here
    // For now, allow all authenticated users to join any room in their venue
    // This can be extended based on business requirements

    logger.debug('Room access authorized', {
      socketId: socket.id,
      userId: socket.authContext!.userId,
      role,
      roomType,
      venueId: payload.venueId
    })
  }

  private sendErrorResponse(
    error: Error,
    correlationId: string,
    callback?: (response: any) => void,
    socket?: AuthenticatedSocket
  ): void {
    const statusCode = error instanceof BadRequestError ? 400 :
                     error instanceof UnauthorizedError ? 401 :
                     500

    const response = {
      correlationId,
      success: false,
      error: error.message,
      statusCode
    }

    if (callback) callback(response)
    if (socket) socket.emit(SocketEventType.ERROR, response)
  }

  /**
   * Get room statistics
   */
  public getRoomStats(): {
    connectionStats: ReturnType<RoomManagerService['getConnectionStats']>
    roomCounts: {
      venues: number
      tables: number
      roles: number
      users: number
    }
  } {
    const connectionStats = this.roomManager.getConnectionStats()
    
    return {
      connectionStats,
      roomCounts: {
        venues: Object.keys(connectionStats.venueConnections).length,
        tables: 0, // Would need to track this in room manager
        roles: Object.keys(connectionStats.roleConnections).length,
        users: connectionStats.totalConnections // Each connection is a user
      }
    }
  }
}
