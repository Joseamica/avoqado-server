import { StaffRole } from '@prisma/client'
import logger from '../../../config/logger'
import { NotFoundError } from '../../../errors/AppError'
import { AuthenticatedSocket, BroadcastOptions } from '../types'

/**
 * Room Manager Service
 * Handles hierarchical room management following the venue -> table -> user pattern
 * Integrates with existing logging and error handling patterns
 */
export class RoomManagerService {
  private connectedSockets: Map<string, AuthenticatedSocket> = new Map()
  private socketsByVenue: Map<string, Set<string>> = new Map()
  private socketsByTable: Map<string, Set<string>> = new Map()
  private socketsByRole: Map<StaffRole, Set<string>> = new Map()
  private socketsByUser: Map<string, Set<string>> = new Map()

  /**
   * Register a socket connection
   */
  public registerSocket(socket: AuthenticatedSocket): void {
    if (!socket.authContext) {
      logger.error('Cannot register socket without authentication context', {
        socketId: socket.id,
        correlationId: socket.correlationId,
      })
      return
    }

    const { socketId, userId, venueId, role } = socket.authContext

    // Store socket reference
    this.connectedSockets.set(socketId, socket)

    // Add to venue room
    this.addToVenueRoom(venueId, socketId)

    // Add to role room
    this.addToRoleRoom(role, socketId)

    // Add to user room
    this.addToUserRoom(userId, socketId)

    logger.info('Socket registered successfully', {
      socketId,
      userId,
      venueId,
      role,
      correlationId: socket.correlationId,
      totalConnections: this.connectedSockets.size,
    })
  }

  /**
   * Unregister a socket connection
   */
  public unregisterSocket(socket: AuthenticatedSocket): void {
    const socketId = socket.id

    if (!socket.authContext) {
      logger.warn('Unregistering socket without auth context', { socketId })
      this.connectedSockets.delete(socketId)
      return
    }

    const { userId, venueId, role } = socket.authContext

    // Remove from all collections
    this.connectedSockets.delete(socketId)
    this.removeFromVenueRoom(venueId, socketId)
    this.removeFromRoleRoom(role, socketId)
    this.removeFromUserRoom(userId, socketId)

    // Remove from all table rooms
    this.removeFromAllTableRooms(socketId)

    logger.info('Socket unregistered successfully', {
      socketId,
      userId,
      venueId,
      role,
      correlationId: socket.correlationId,
      remainingConnections: this.connectedSockets.size,
    })
  }

  /**
   * Join a table room
   */
  public joinTableRoom(socket: AuthenticatedSocket, tableId: string): void {
    if (!socket.authContext) {
      throw new NotFoundError('Authentication context required to join table room')
    }

    const { socketId, venueId } = socket.authContext
    const roomKey = `${venueId}:${tableId}`

    // Join Socket.io room
    socket.join(this.getTableRoomName(venueId, tableId))

    // Track in our collections
    this.addToTableRoom(roomKey, socketId)

    logger.info('Socket joined table room', {
      socketId,
      venueId,
      tableId,
      roomName: this.getTableRoomName(venueId, tableId),
      correlationId: socket.correlationId,
    })
  }

  /**
   * Leave a table room
   */
  public leaveTableRoom(socket: AuthenticatedSocket, tableId: string): void {
    if (!socket.authContext) {
      return
    }

    const { socketId, venueId } = socket.authContext
    const roomKey = `${venueId}:${tableId}`

    // Leave Socket.io room
    socket.leave(this.getTableRoomName(venueId, tableId))

    // Remove from our collections
    this.removeFromTableRoom(roomKey, socketId)

    logger.info('Socket left table room', {
      socketId,
      venueId,
      tableId,
      roomName: this.getTableRoomName(venueId, tableId),
      correlationId: socket.correlationId,
    })
  }

  /**
   * Get all sockets in a venue
   */
  public getVenueSockets(venueId: string): AuthenticatedSocket[] {
    const socketIds = this.socketsByVenue.get(venueId) || new Set()
    return Array.from(socketIds)
      .map(id => this.connectedSockets.get(id))
      .filter((socket): socket is AuthenticatedSocket => socket !== undefined)
  }

  /**
   * Get all sockets in a table room
   */
  public getTableSockets(venueId: string, tableId: string): AuthenticatedSocket[] {
    const roomKey = `${venueId}:${tableId}`
    const socketIds = this.socketsByTable.get(roomKey) || new Set()
    return Array.from(socketIds)
      .map(id => this.connectedSockets.get(id))
      .filter((socket): socket is AuthenticatedSocket => socket !== undefined)
  }

  /**
   * Get all sockets by role
   */
  public getRoleSockets(role: StaffRole, venueId?: string): AuthenticatedSocket[] {
    const socketIds = this.socketsByRole.get(role) || new Set()
    let sockets = Array.from(socketIds)
      .map(id => this.connectedSockets.get(id))
      .filter((socket): socket is AuthenticatedSocket => socket !== undefined)

    // Filter by venue if specified
    if (venueId) {
      sockets = sockets.filter(socket => socket.authContext?.venueId === venueId)
    }

    return sockets
  }

  /**
   * Get user sockets
   */
  public getUserSockets(userId: string): AuthenticatedSocket[] {
    const socketIds = this.socketsByUser.get(userId) || new Set()
    return Array.from(socketIds)
      .map(id => this.connectedSockets.get(id))
      .filter((socket): socket is AuthenticatedSocket => socket !== undefined)
  }

  /**
   * Filter sockets by broadcast options
   */
  public filterSocketsByOptions(sockets: AuthenticatedSocket[], options: BroadcastOptions = {}): AuthenticatedSocket[] {
    let filteredSockets = [...sockets]

    // Exclude specific socket
    if (options.excludeSocket) {
      filteredSockets = filteredSockets.filter(socket => socket.id !== options.excludeSocket)
    }

    // Include only specific roles
    if (options.includeRoles && options.includeRoles.length > 0) {
      filteredSockets = filteredSockets.filter(socket => socket.authContext && options.includeRoles!.includes(socket.authContext.role))
    }

    // Exclude specific roles
    if (options.excludeRoles && options.excludeRoles.length > 0) {
      filteredSockets = filteredSockets.filter(socket => socket.authContext && !options.excludeRoles!.includes(socket.authContext.role))
    }

    return filteredSockets
  }

  /**
   * Get connection statistics
   */
  public getConnectionStats(): {
    totalConnections: number
    venueConnections: Record<string, number>
    roleConnections: Record<string, number>
  } {
    const venueConnections: Record<string, number> = {}
    const roleConnections: Record<string, number> = {}

    for (const [venueId, sockets] of this.socketsByVenue.entries()) {
      venueConnections[venueId] = sockets.size
    }

    for (const [role, sockets] of this.socketsByRole.entries()) {
      roleConnections[role] = sockets.size
    }

    return {
      totalConnections: this.connectedSockets.size,
      venueConnections,
      roleConnections,
    }
  }

  // Private helper methods

  private addToVenueRoom(venueId: string, socketId: string): void {
    if (!this.socketsByVenue.has(venueId)) {
      this.socketsByVenue.set(venueId, new Set())
    }
    this.socketsByVenue.get(venueId)!.add(socketId)
  }

  private removeFromVenueRoom(venueId: string, socketId: string): void {
    const venueSet = this.socketsByVenue.get(venueId)
    if (venueSet) {
      venueSet.delete(socketId)
      if (venueSet.size === 0) {
        this.socketsByVenue.delete(venueId)
      }
    }
  }

  private addToTableRoom(roomKey: string, socketId: string): void {
    if (!this.socketsByTable.has(roomKey)) {
      this.socketsByTable.set(roomKey, new Set())
    }
    this.socketsByTable.get(roomKey)!.add(socketId)
  }

  private removeFromTableRoom(roomKey: string, socketId: string): void {
    const tableSet = this.socketsByTable.get(roomKey)
    if (tableSet) {
      tableSet.delete(socketId)
      if (tableSet.size === 0) {
        this.socketsByTable.delete(roomKey)
      }
    }
  }

  private removeFromAllTableRooms(socketId: string): void {
    for (const [roomKey, socketSet] of this.socketsByTable.entries()) {
      if (socketSet.has(socketId)) {
        socketSet.delete(socketId)
        if (socketSet.size === 0) {
          this.socketsByTable.delete(roomKey)
        }
      }
    }
  }

  private addToRoleRoom(role: StaffRole, socketId: string): void {
    if (!this.socketsByRole.has(role)) {
      this.socketsByRole.set(role, new Set())
    }
    this.socketsByRole.get(role)!.add(socketId)
  }

  private removeFromRoleRoom(role: StaffRole, socketId: string): void {
    const roleSet = this.socketsByRole.get(role)
    if (roleSet) {
      roleSet.delete(socketId)
      if (roleSet.size === 0) {
        this.socketsByRole.delete(role)
      }
    }
  }

  private addToUserRoom(userId: string, socketId: string): void {
    if (!this.socketsByUser.has(userId)) {
      this.socketsByUser.set(userId, new Set())
    }
    this.socketsByUser.get(userId)!.add(socketId)
  }

  private removeFromUserRoom(userId: string, socketId: string): void {
    const userSet = this.socketsByUser.get(userId)
    if (userSet) {
      userSet.delete(socketId)
      if (userSet.size === 0) {
        this.socketsByUser.delete(userId)
      }
    }
  }

  private getTableRoomName(venueId: string, tableId: string): string {
    return `venue_${venueId}_table_${tableId}`
  }
}
