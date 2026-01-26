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

  // Business Events - Shifts
  SHIFT_OPENED = 'shift_opened',
  SHIFT_CLOSED = 'shift_closed',
  SHIFT_UPDATED = 'shift_updated',

  // Business Events - Notifications
  NOTIFICATION_NEW = 'notification_new',
  NOTIFICATION_READ = 'notification_read',
  NOTIFICATION_DELETED = 'notification_deleted',
  NOTIFICATION_COUNT_UPDATED = 'notification_count_updated',

  // Business Events - TPV Admin Commands
  TPV_COMMAND = 'tpv_command',
  TPV_COMMAND_RESPONSE = 'tpv_command_response',
  TPV_STATUS_UPDATE = 'tpv_status_update',

  // Business Events - TPV Remote Command ACK System (Enterprise Feature)
  // Server → Terminal
  TPV_COMMAND_SEND = 'tpv_command_send', // Command sent to terminal
  TPV_COMMAND_CANCELLED = 'tpv_command_cancelled', // Command cancelled by admin

  // Terminal → Server
  TPV_COMMAND_ACK = 'tpv_command_ack', // Terminal received the command
  TPV_COMMAND_STARTED = 'tpv_command_started', // Terminal started executing
  TPV_COMMAND_PROGRESS = 'tpv_command_progress', // Progress update (0-100%)
  TPV_COMMAND_RESULT = 'tpv_command_result', // Final execution result

  // Server → Dashboard (Real-time status updates)
  TPV_COMMAND_STATUS_CHANGED = 'tpv_command_status_changed', // Status transition notification
  TPV_BULK_OPERATION_PROGRESS = 'tpv_bulk_operation_progress', // Bulk operation progress
  TPV_COMMAND_QUEUED = 'tpv_command_queued', // Command added to offline queue

  // Server → TPV (Config Invalidation - Multi-Merchant Cache Sync)
  // Pattern: Toast/Square style - Backend is SOURCE OF TRUTH, push notifications for config changes
  TERMINAL_CONFIG_CHANGED = 'terminal_config_changed', // Merchant added/updated/deleted

  // Business Events - Inventory Real-time
  INVENTORY_LOW_STOCK = 'inventory_low_stock',
  INVENTORY_OUT_OF_STOCK = 'inventory_out_of_stock',
  INVENTORY_UPDATED = 'inventory_updated',

  // Business Events - Hardware
  PRINTER_STATUS = 'printer_status',
  CARD_READER_STATUS = 'card_reader_status',
  PERIPHERAL_ERROR = 'peripheral_error',

  // Business Events - Crypto Payments (B4Bit)
  CRYPTO_PAYMENT_CONFIRMED = 'crypto:payment_confirmed',
  CRYPTO_PAYMENT_FAILED = 'crypto:payment_failed',

  // Business Events - Terminal Observability
  TERMINAL_LOG = 'terminal:log',
  TERMINAL_HEARTBEAT = 'terminal:heartbeat',

  // Business Events - Menu & Products (Real-time)
  MENU_UPDATED = 'menu_updated',
  MENU_ITEM_CREATED = 'menu_item_created',
  MENU_ITEM_UPDATED = 'menu_item_updated',
  MENU_ITEM_DELETED = 'menu_item_deleted',
  MENU_ITEM_AVAILABILITY_CHANGED = 'menu_item_availability_changed',
  MENU_CATEGORY_UPDATED = 'menu_category_updated',
  MENU_CATEGORY_DELETED = 'menu_category_deleted',
  PRODUCT_PRICE_CHANGED = 'product_price_changed',

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

/**
 * Crypto Payment Event Payloads (B4Bit Integration)
 */
export interface CryptoPaymentConfirmedPayload extends BaseEventPayload {
  requestId: string // B4Bit request ID
  paymentId: string // Our internal payment ID
  amount: number // Amount in centavos
  currency: string // "MXN"
  txHash: string // Blockchain transaction hash
  cryptoAmount: string // Amount in crypto (e.g., "0.00123")
  cryptoCurrency: string // Crypto currency (e.g., "BTC", "ETH")
  confirmations?: number // Blockchain confirmations
  orderId?: string
  orderNumber?: string
  receiptUrl?: string
  receiptAccessKey?: string
}

export interface CryptoPaymentFailedPayload extends BaseEventPayload {
  requestId: string // B4Bit request ID
  paymentId?: string
  reason: string // "timeout", "insufficient_amount", "expired", etc.
  status: 'OC' | 'EX' // Out of Condition or Expired
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
 * TPV Command Payloads - Admin commands sent to TPV terminals
 */
export interface TPVCommandPayload extends BaseEventPayload {
  terminalId: string
  command: {
    type: 'MAINTENANCE_MODE' | 'RELOAD' | 'DISABLE' | 'ENABLE' | 'SHUTDOWN' | 'RESTART'
    payload?: Record<string, any>
    requestedBy: string // userId who sent command
  }
  metadata?: Record<string, any>
}

export interface TPVCommandResponsePayload extends BaseEventPayload {
  terminalId: string
  commandType: string
  status: 'success' | 'failed' | 'timeout'
  message?: string
  executedAt: Date
  metadata?: Record<string, any>
}

export interface TPVStatusUpdatePayload extends BaseEventPayload {
  terminalId: string
  status: 'ONLINE' | 'OFFLINE' | 'MAINTENANCE' | 'DISABLED'
  lastHeartbeat?: Date
  version?: string
  ipAddress?: string
  systemInfo?: Record<string, any>
  metadata?: Record<string, any>
}

/**
 * TPV Remote Command ACK System Payloads (Enterprise Feature)
 * Full bidirectional communication for remote terminal management
 */

// Server → Terminal: Command to execute
export interface TPVCommandSendPayload extends BaseEventPayload {
  terminalId: string
  commandId: string // TpvCommandQueue.id for tracking
  commandType:
    | 'LOCK'
    | 'UNLOCK'
    | 'MAINTENANCE_MODE'
    | 'EXIT_MAINTENANCE'
    | 'REACTIVATE'
    | 'RESTART'
    | 'SHUTDOWN'
    | 'CLEAR_CACHE'
    | 'FORCE_UPDATE'
    | 'SYNC_DATA'
    | 'FACTORY_RESET'
    | 'EXPORT_LOGS'
    | 'UPDATE_CONFIG'
    | 'REFRESH_MENU'
    | 'UPDATE_MERCHANT'
  payload?: Record<string, any>
  priority: 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL'
  requiresPin: boolean
  expiresAt?: Date
  requestedBy: string
  requestedByName?: string
}

// Server → Terminal: Command cancelled
export interface TPVCommandCancelledPayload extends BaseEventPayload {
  terminalId: string
  commandId: string
  reason: string
  cancelledBy: string
}

// Terminal → Server: Receipt acknowledgment
export interface TPVCommandAckPayload extends BaseEventPayload {
  terminalId: string
  commandId: string
  receivedAt: Date
  terminalStatus: 'READY' | 'BUSY' | 'LOCKED' | 'MAINTENANCE'
}

// Terminal → Server: Execution started
export interface TPVCommandStartedPayload extends BaseEventPayload {
  terminalId: string
  commandId: string
  startedAt: Date
  estimatedDurationMs?: number
}

// Terminal → Server: Progress update (0-100%)
export interface TPVCommandProgressPayload extends BaseEventPayload {
  terminalId: string
  commandId: string
  progress: number // 0-100
  currentStep?: string
  totalSteps?: number
  currentStepNumber?: number
}

// Terminal → Server: Final execution result
export interface TPVCommandResultPayload extends BaseEventPayload {
  terminalId: string
  commandId: string
  status: 'SUCCESS' | 'PARTIAL_SUCCESS' | 'FAILED' | 'TIMEOUT' | 'REJECTED'
  executedAt: Date
  durationMs: number
  message?: string
  errorCode?: string
  resultData?: Record<string, any> // Command-specific result data
}

// Server → Dashboard: Status transition notification
export interface TPVCommandStatusChangedPayload extends BaseEventPayload {
  terminalId: string
  terminalName: string
  commandId: string
  commandType: string
  previousStatus: string
  newStatus: string
  statusChangedAt: Date
  message?: string
  requestedByName?: string
  metadata?: Record<string, any>
}

// Server → Dashboard: Bulk operation progress
export interface TPVBulkOperationProgressPayload extends BaseEventPayload {
  operationId: string
  commandType: string
  status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'PARTIAL_FAILURE' | 'FAILED' | 'CANCELLED'
  totalTargets: number
  successCount: number
  failureCount: number
  pendingCount: number
  currentTerminalId?: string
  currentTerminalName?: string
  failedTerminals?: Array<{
    terminalId: string
    terminalName: string
    error: string
  }>
}

// Server → Dashboard: Command queued (terminal offline)
export interface TPVCommandQueuedPayload extends BaseEventPayload {
  terminalId: string
  terminalName: string
  commandId: string
  commandType: string
  queuedAt: Date
  expiresAt?: Date
  queuePosition?: number
  reason: 'TERMINAL_OFFLINE' | 'TERMINAL_BUSY' | 'SCHEDULED'
}

/**
 * Terminal Config Changed Payload - Multi-Merchant Cache Invalidation
 * Pattern: Toast/Square style - Backend is SOURCE OF TRUTH, push notifications for config changes
 *
 * Use Case: When admin creates/updates/deletes a MerchantAccount, notify affected terminals
 * so they can refresh their cached merchant configuration.
 *
 * 3-Layer Cache Invalidation Architecture:
 * 1. PUSH (this event) - Immediate notification when merchants change
 * 2. PULL (heartbeat configVersion) - Catches missed events if terminal was offline
 * 3. FALLBACK (backend validation) - Graceful fallback if terminal sends stale merchantAccountId
 */
export interface TerminalConfigChangedPayload extends BaseEventPayload {
  terminalId: string
  terminalSerialNumber: string
  changeType: 'MERCHANT_ADDED' | 'MERCHANT_UPDATED' | 'MERCHANT_DELETED' | 'TERMINAL_UPDATED'
  merchantId?: string // The affected merchant (if applicable)
  merchantName?: string // Human-readable name for logging
  configVersion: number // Timestamp-based version for comparison
  urgent: boolean // true = refresh immediately (DELETED), false = refresh when convenient (ADDED/UPDATED)
  reason?: string // Optional human-readable reason for the change
}

/**
 * Inventory Real-time Event Payloads
 */
export interface InventoryEventPayload extends BaseEventPayload {
  rawMaterialId: string
  rawMaterialName: string
  currentStock: number
  unit: string
  threshold?: number // Low stock threshold
  batchInfo?: {
    batchId: string
    expirationDate?: Date
    remainingQuantity: number
  }
  metadata?: Record<string, any>
}

/**
 * Hardware Event Payloads - Printer, Card Reader, etc.
 */
export interface PrinterStatusPayload extends BaseEventPayload {
  terminalId: string
  printerType: 'THERMAL' | 'RECEIPT' | 'KITCHEN'
  status: 'ONLINE' | 'OFFLINE' | 'PAPER_LOW' | 'PAPER_OUT' | 'ERROR'
  errorMessage?: string
  lastPrintedAt?: Date
  metadata?: Record<string, any>
}

export interface CardReaderStatusPayload extends BaseEventPayload {
  terminalId: string
  readerType: 'CONTACTLESS' | 'CHIP' | 'MAGNETIC'
  status: 'READY' | 'READING' | 'ERROR' | 'DISCONNECTED'
  errorMessage?: string
  lastReadAt?: Date
  metadata?: Record<string, any>
}

export interface PeripheralErrorPayload extends BaseEventPayload {
  terminalId: string
  peripheralType: 'PRINTER' | 'CARD_READER' | 'CASH_DRAWER' | 'SCANNER' | 'OTHER'
  errorCode: string
  errorMessage: string
  severity: 'low' | 'medium' | 'high' | 'critical'
  recoverable: boolean
  metadata?: Record<string, any>
}

/**
 * Menu & Product Real-time Event Payloads
 */
export interface MenuUpdatedPayload extends BaseEventPayload {
  updateType: 'FULL_REFRESH' | 'PARTIAL_UPDATE'
  categoryIds?: string[] // Categories affected (if partial)
  productIds?: string[] // Products affected (if partial)
  reason: 'PRICE_CHANGE' | 'AVAILABILITY_CHANGE' | 'ITEM_ADDED' | 'ITEM_REMOVED' | 'CATEGORY_UPDATED'
  updatedBy?: string // User ID who made the change
  metadata?: Record<string, any>
}

export interface MenuItemPayload extends BaseEventPayload {
  itemId: string
  itemName: string
  sku?: string
  categoryId?: string
  categoryName?: string
  price?: number
  available?: boolean
  imageUrl?: string | null
  description?: string | null
  modifierGroupIds?: string[]
  metadata?: Record<string, any>
}

export interface MenuCategoryPayload extends BaseEventPayload {
  categoryId: string
  categoryName: string
  action: 'CREATED' | 'UPDATED' | 'DELETED' | 'ENABLED' | 'DISABLED' | 'REORDERED'
  displayOrder?: number
  active?: boolean
  parentId?: string | null
  affectedItemCount?: number // Number of products in category
  metadata?: Record<string, any>
}

export interface ProductPriceChangedPayload extends BaseEventPayload {
  productId: string
  productName: string
  sku: string
  oldPrice: number
  newPrice: number
  priceChange: number // Absolute difference
  priceChangePercent: number // Percentage change
  categoryId: string
  categoryName: string
  updatedBy?: string // User ID who made the change
  metadata?: Record<string, any>
}

export interface MenuItemAvailabilityChangedPayload extends BaseEventPayload {
  itemId: string
  itemName: string
  available: boolean
  previousAvailability: boolean
  reason?: 'OUT_OF_STOCK' | 'MANUAL' | 'TIME_BASED' | 'INVENTORY_DEPLETION'
  affectedOrders?: string[] // Order IDs that might be affected
  metadata?: Record<string, any>
}

/**
 * Shift Event Payloads - Real-time shift management
 */
export interface ShiftEventPayload extends BaseEventPayload {
  shiftId: string
  staffId: string
  staffName: string
  status: 'OPEN' | 'CLOSED'
  startTime: string
  endTime?: string
  startingCash?: number
  endingCash?: number
  totalSales?: number
  totalTips?: number
  totalOrders?: number
  totalCashPayments?: number
  totalCardPayments?: number
  totalVoucherPayments?: number
  totalOtherPayments?: number
  totalProductsSold?: number
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
