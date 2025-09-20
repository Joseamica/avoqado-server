import { Server, Socket } from 'socket.io'
import { StaffRole } from '@prisma/client'
import { AuthContext } from '../../../security'

/**
 * Socket Authentication Context - extends the existing AuthContext pattern
 */
export interface SocketAuthContext extends AuthContext {
  socketId: string
  connectedAt: Date
  lastActivity: Date
}

/**
 * Authenticated Socket - extends Socket with our auth context
 */
export interface AuthenticatedSocket extends Socket {
  authContext?: SocketAuthContext
  correlationId: string
}

/**
 * Room Types - Hierarchical room management
 */
export enum RoomType {
  VENUE = 'venue',
  TABLE = 'table',
  ORDER = 'order',
  ROLE = 'role',
  USER = 'user',
  GLOBAL = 'global',
}

export interface RoomIdentifier {
  type: RoomType
  venueId: string
  tableId?: string
  orderId?: string
  userId?: string
  role?: StaffRole
}

/**
 * Event Types - Strongly typed event system
 */
export enum SocketEventType {
  // Connection Events
  CONNECTION = 'connection',
  DISCONNECT = 'disconnect',

  // Authentication Events
  AUTHENTICATE = 'authenticate',
  AUTHENTICATION_SUCCESS = 'authentication_success',
  AUTHENTICATION_ERROR = 'authentication_error',

  // Room Management
  JOIN_ROOM = 'join_room',
  LEAVE_ROOM = 'leave_room',
  ROOM_JOINED = 'room_joined',
  ROOM_LEFT = 'room_left',

  // Business Events - Payment
  PAYMENT_INITIATED = 'payment_initiated',
  PAYMENT_PROCESSING = 'payment_processing',
  PAYMENT_COMPLETED = 'payment_completed',
  PAYMENT_FAILED = 'payment_failed',

  // Business Events - Orders
  ORDER_CREATED = 'order_created',
  ORDER_UPDATED = 'order_updated',
  ORDER_STATUS_CHANGED = 'order_status_changed',
  ORDER_DELETED = 'order_deleted',

  // Business Events - System
  SYSTEM_ALERT = 'system_alert',
  VENUE_UPDATE = 'venue_update',
  TABLE_STATUS_CHANGE = 'table_status_change',

  // Business Events - Notifications
  NOTIFICATION_NEW = 'notification_new',
  NOTIFICATION_READ = 'notification_read',
  NOTIFICATION_DELETED = 'notification_deleted',
  NOTIFICATION_COUNT_UPDATED = 'notification_count_updated',

  // Error Events
  ERROR = 'error',
  RATE_LIMIT_EXCEEDED = 'rate_limit_exceeded',
}

/**
 * Event Payload Interfaces - Strongly typed payloads
 */
export interface BaseEventPayload {
  correlationId: string
  timestamp: Date
  venueId: string
  userId?: string
}

export interface AuthenticationPayload {
  token: string
}

export interface RoomJoinPayload {
  roomType: RoomType
  venueId: string
  tableId?: string
  orderId?: string
  metadata?: Record<string, any>
}

export interface PaymentEventPayload extends BaseEventPayload {
  paymentId: string
  amount: number
  currency: string
  tableId?: string
  orderId?: string
  status: 'initiated' | 'processing' | 'completed' | 'failed'
  metadata?: Record<string, any>
}

export interface OrderEventPayload extends BaseEventPayload {
  orderId: string
  tableId?: string
  status?: string
  items?: any[]
  total?: number
  metadata?: Record<string, any>
}

export interface SystemAlertPayload extends BaseEventPayload {
  level: 'info' | 'warning' | 'error' | 'critical'
  title: string
  message: string
  targetRoles?: StaffRole[]
  metadata?: Record<string, any>
}

export interface NotificationEventPayload extends BaseEventPayload {
  notificationId: string
  recipientId: string
  type: string
  title: string
  message: string
  priority: 'LOW' | 'NORMAL' | 'HIGH'
  isRead: boolean
  actionUrl?: string
  actionLabel?: string
  metadata?: Record<string, any>
}

/**
 * Socket Server Configuration
 */
export interface SocketServerConfig {
  cors: {
    origin: string[]
    methods: string[]
    credentials: boolean
  }
  rateLimit: {
    windowMs: number
    maxConnections: number
    maxEventsPerWindow: number
  }
  redis?: {
    url?: string // ✅ Railway/Heroku style
    host?: string // ✅ Made optional
    port?: number // ✅ Made optional
    password?: string
    db?: number
  }
  authentication: {
    required: boolean
    timeout: number // ms to authenticate after connection
  }
}

/**
 * Room Broadcasting Options
 */
export interface BroadcastOptions {
  excludeSocket?: string
  includeRoles?: StaffRole[]
  excludeRoles?: StaffRole[]
  metadata?: Record<string, any>
}

/**
 * Event Handler Function Types
 */
export type SocketEventHandler<T = any> = (
  socket: AuthenticatedSocket,
  payload: T,
  callback?: (response: any) => void,
) => Promise<void> | void

export type SocketMiddleware = (socket: AuthenticatedSocket, next: (err?: Error) => void) => void

/**
 * Socket Manager Interface
 */
export interface ISocketManager {
  initialize(server: any): Server
  broadcastToVenue(venueId: string, event: SocketEventType, payload: any, options?: BroadcastOptions): void
  broadcastToTable(venueId: string, tableId: string, event: SocketEventType, payload: any, options?: BroadcastOptions): void
  broadcastToRole(role: StaffRole, event: SocketEventType, payload: any, options?: BroadcastOptions): void
  broadcastToUser(userId: string, event: SocketEventType, payload: any, options?: BroadcastOptions): void
  getConnectedSockets(venueId: string): AuthenticatedSocket[]
  getSocketsByRole(role: StaffRole, venueId?: string): AuthenticatedSocket[]
}

/**
 * Error Types for Socket operations
 */
export class SocketError extends Error {
  public statusCode: number
  public socketId?: string
  public correlationId?: string

  constructor(message: string, statusCode: number = 500, socketId?: string, correlationId?: string) {
    super(message)
    this.statusCode = statusCode
    this.socketId = socketId
    this.correlationId = correlationId
    this.name = 'SocketError'
  }
}

export class SocketAuthenticationError extends SocketError {
  constructor(message: string = 'Socket authentication failed', socketId?: string, correlationId?: string) {
    super(message, 401, socketId, correlationId)
    this.name = 'SocketAuthenticationError'
  }
}

export class SocketAuthorizationError extends SocketError {
  constructor(message: string = 'Socket authorization failed', socketId?: string, correlationId?: string) {
    super(message, 403, socketId, correlationId)
    this.name = 'SocketAuthorizationError'
  }
}
