import { StaffRole } from '@prisma/client'
import { Server } from 'socket.io'
import { v4 as uuidv4 } from 'uuid'
import logger from '../../../config/logger'
import {
  BroadcastOptions,
  CardReaderStatusPayload,
  InventoryEventPayload,
  MenuCategoryPayload,
  MenuItemAvailabilityChangedPayload,
  MenuItemPayload,
  MenuUpdatedPayload,
  NotificationEventPayload,
  OrderEventPayload,
  PaymentEventPayload,
  PeripheralErrorPayload,
  PrinterStatusPayload,
  ProductPriceChangedPayload,
  ShiftEventPayload,
  SocketEventType,
  SystemAlertPayload,
  TerminalConfigChangedPayload,
  TPVCommandPayload,
  TPVCommandResponsePayload,
  TPVStatusUpdatePayload,
} from '../types'
import { RoomManagerService } from './roomManager.service'

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

      logger.debug('Broadcast to venue completed', {
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
   * Broadcast to order room participants
   */
  public broadcastToOrder(venueId: string, orderId: string, event: SocketEventType, payload: any, options: BroadcastOptions = {}): void {
    const correlationId = uuidv4()

    try {
      const sockets = this.roomManager.getOrderSockets(venueId, orderId)
      const filteredSockets = this.roomManager.filterSocketsByOptions(sockets, options)

      const enrichedPayload = this.enrichPayload(payload, correlationId, venueId)

      filteredSockets.forEach(socket => {
        socket.emit(event, enrichedPayload)
      })

      logger.info('Broadcast to order completed', {
        correlationId,
        venueId,
        orderId,
        event,
        totalSockets: sockets.length,
        filteredSockets: filteredSockets.length,
        options: this.sanitizeOptions(options),
      })
    } catch (error) {
      logger.error('Error broadcasting to order', {
        correlationId,
        venueId,
        orderId,
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
   * Shift Events
   * Broadcasts shift lifecycle events (opened, closed, updated) to venue
   * Used to update dashboard in real-time when TPV opens/closes shifts
   */
  public broadcastShiftEvent(
    venueId: string,
    eventType: 'opened' | 'closed' | 'updated',
    shiftData: Omit<ShiftEventPayload, 'correlationId' | 'timestamp'>,
    options?: BroadcastOptions,
  ): void {
    const eventMap = {
      opened: SocketEventType.SHIFT_OPENED,
      closed: SocketEventType.SHIFT_CLOSED,
      updated: SocketEventType.SHIFT_UPDATED,
    }

    const payload: ShiftEventPayload = {
      ...shiftData,
      correlationId: uuidv4(),
      timestamp: new Date(),
    }

    // Broadcast to entire venue (dashboard, admin panels, other TPVs)
    this.broadcastToVenue(venueId, eventMap[eventType], payload, options)

    // Also broadcast to managers and admins specifically for shift events
    this.broadcastToRole(StaffRole.MANAGER, eventMap[eventType], payload, venueId, options)
    this.broadcastToRole(StaffRole.ADMIN, eventMap[eventType], payload, venueId, options)
  }

  /**
   * Notification Events
   */
  public broadcastNewNotification(
    notification: Omit<NotificationEventPayload, 'correlationId' | 'timestamp'>,
    options?: BroadcastOptions,
  ): void {
    const payload: NotificationEventPayload = {
      ...notification,
      correlationId: uuidv4(),
      timestamp: new Date(),
    }

    // Broadcast to specific user
    this.broadcastToUser(notification.recipientId, SocketEventType.NOTIFICATION_NEW, payload, options)

    // Also broadcast count update to venue
    this.broadcastToVenue(
      notification.venueId,
      SocketEventType.NOTIFICATION_COUNT_UPDATED,
      {
        ...payload,
        action: 'increment',
      },
      options,
    )

    logger.info('New notification broadcasted', {
      correlationId: payload.correlationId,
      notificationId: notification.notificationId,
      recipientId: notification.recipientId,
      venueId: notification.venueId,
      title: notification.title,
      priority: notification.priority,
    })
  }

  public broadcastNotificationRead(notificationId: string, recipientId: string, venueId: string, options?: BroadcastOptions): void {
    const payload: Partial<NotificationEventPayload> = {
      notificationId,
      recipientId,
      venueId,
      correlationId: uuidv4(),
      timestamp: new Date(),
    }

    // Broadcast to specific user
    this.broadcastToUser(recipientId, SocketEventType.NOTIFICATION_READ, payload, options)

    // Also broadcast count update to venue
    this.broadcastToVenue(
      venueId,
      SocketEventType.NOTIFICATION_COUNT_UPDATED,
      {
        ...payload,
        action: 'decrement',
      },
      options,
    )

    logger.info('Notification read status broadcasted', {
      correlationId: payload.correlationId,
      notificationId,
      recipientId,
      venueId,
    })
  }

  public broadcastNotificationDeleted(
    notificationId: string,
    recipientId: string,
    venueId: string,
    wasUnread: boolean,
    options?: BroadcastOptions,
  ): void {
    const payload: Partial<NotificationEventPayload> = {
      notificationId,
      recipientId,
      venueId,
      correlationId: uuidv4(),
      timestamp: new Date(),
    }

    // Broadcast to specific user
    this.broadcastToUser(recipientId, SocketEventType.NOTIFICATION_DELETED, payload, options)

    // Also broadcast count update to venue if was unread
    if (wasUnread) {
      this.broadcastToVenue(
        venueId,
        SocketEventType.NOTIFICATION_COUNT_UPDATED,
        {
          ...payload,
          action: 'decrement',
        },
        options,
      )
    }

    logger.info('Notification deleted status broadcasted', {
      correlationId: payload.correlationId,
      notificationId,
      recipientId,
      venueId,
      wasUnread,
    })
  }

  /**
   * TPV Command Events - Admin commands sent to terminals
   */
  public broadcastTPVCommand(
    venueId: string,
    terminalId: string,
    commandData: Omit<TPVCommandPayload, 'correlationId' | 'timestamp' | 'venueId'>,
    options?: BroadcastOptions,
  ): void {
    const payload: TPVCommandPayload = {
      ...commandData,
      venueId,
      correlationId: uuidv4(),
      timestamp: new Date(),
    }

    // Send command directly to specific terminal (via user ID or custom terminal room)
    // For now, broadcast to venue - terminal will filter by terminalId
    this.broadcastToVenue(venueId, SocketEventType.TPV_COMMAND, payload, options)

    logger.info('TPV command broadcasted', {
      correlationId: payload.correlationId,
      venueId,
      terminalId,
      commandType: commandData.command.type,
      requestedBy: commandData.command.requestedBy,
    })
  }

  public broadcastTPVCommandResponse(
    venueId: string,
    responseData: Omit<TPVCommandResponsePayload, 'correlationId' | 'timestamp' | 'venueId'>,
    options?: BroadcastOptions,
  ): void {
    const payload: TPVCommandResponsePayload = {
      ...responseData,
      venueId,
      correlationId: uuidv4(),
      timestamp: new Date(),
    }

    // Broadcast to venue so dashboard can see command execution status
    this.broadcastToVenue(venueId, SocketEventType.TPV_COMMAND_RESPONSE, payload, options)

    // Also broadcast to admins/managers
    this.broadcastToRole(StaffRole.ADMIN, SocketEventType.TPV_COMMAND_RESPONSE, payload, venueId, options)
    this.broadcastToRole(StaffRole.MANAGER, SocketEventType.TPV_COMMAND_RESPONSE, payload, venueId, options)

    logger.info('TPV command response broadcasted', {
      correlationId: payload.correlationId,
      venueId,
      terminalId: responseData.terminalId,
      commandType: responseData.commandType,
      status: responseData.status,
    })
  }

  public broadcastTPVStatusUpdate(
    venueId: string,
    statusData: Omit<TPVStatusUpdatePayload, 'correlationId' | 'timestamp' | 'venueId'>,
    options?: BroadcastOptions,
  ): void {
    const payload: TPVStatusUpdatePayload = {
      ...statusData,
      venueId,
      correlationId: uuidv4(),
      timestamp: new Date(),
    }

    // Broadcast to venue so dashboard can monitor terminal status
    this.broadcastToVenue(venueId, SocketEventType.TPV_STATUS_UPDATE, payload, options)

    logger.info('TPV status update broadcasted', {
      correlationId: payload.correlationId,
      venueId,
      terminalId: statusData.terminalId,
      status: statusData.status,
      lastHeartbeat: statusData.lastHeartbeat,
    })
  }

  /**
   * Terminal Config Changed Event - Multi-Merchant Cache Invalidation
   *
   * Notifies TPV terminals when merchant configuration changes, allowing them to
   * refresh their cached merchant list. Part of the 3-layer cache invalidation strategy:
   *
   * Layer 1: PUSH (this event) - Immediate notification when merchants change
   * Layer 2: PULL (heartbeat configVersion) - Catches missed events if terminal was offline
   * Layer 3: FALLBACK (backend validation) - Graceful fallback if terminal sends stale merchantAccountId
   *
   * Pattern inspired by Toast/Square: Backend is SOURCE OF TRUTH, push notifications for critical changes.
   */
  public broadcastTerminalConfigChanged(
    venueId: string,
    configData: Omit<TerminalConfigChangedPayload, 'correlationId' | 'timestamp' | 'venueId'>,
    options?: BroadcastOptions,
  ): void {
    const payload: TerminalConfigChangedPayload = {
      ...configData,
      venueId,
      correlationId: uuidv4(),
      timestamp: new Date(),
    }

    // Broadcast to venue so all connected terminals receive the config change notification
    this.broadcastToVenue(venueId, SocketEventType.TERMINAL_CONFIG_CHANGED, payload, options)

    // Log with appropriate level based on change type
    const logLevel = configData.urgent ? 'warn' : 'info'
    logger[logLevel]('Terminal config change broadcasted', {
      correlationId: payload.correlationId,
      venueId,
      terminalId: configData.terminalId,
      terminalSerialNumber: configData.terminalSerialNumber,
      changeType: configData.changeType,
      merchantId: configData.merchantId,
      merchantName: configData.merchantName,
      configVersion: configData.configVersion,
      urgent: configData.urgent,
      reason: configData.reason,
    })
  }

  /**
   * Inventory Real-time Events
   */
  public broadcastInventoryEvent(
    venueId: string,
    eventType: 'low_stock' | 'out_of_stock' | 'updated',
    inventoryData: Omit<InventoryEventPayload, 'correlationId' | 'timestamp' | 'venueId'>,
    options?: BroadcastOptions,
  ): void {
    const eventMap = {
      low_stock: SocketEventType.INVENTORY_LOW_STOCK,
      out_of_stock: SocketEventType.INVENTORY_OUT_OF_STOCK,
      updated: SocketEventType.INVENTORY_UPDATED,
    }

    const payload: InventoryEventPayload = {
      ...inventoryData,
      venueId,
      correlationId: uuidv4(),
      timestamp: new Date(),
    }

    // Broadcast to venue
    this.broadcastToVenue(venueId, eventMap[eventType], payload, options)

    // Also broadcast to managers for critical stock alerts
    if (eventType === 'low_stock' || eventType === 'out_of_stock') {
      this.broadcastToRole(StaffRole.MANAGER, eventMap[eventType], payload, venueId, options)
      this.broadcastToRole(StaffRole.ADMIN, eventMap[eventType], payload, venueId, options)
    }

    logger.info('Inventory event broadcasted', {
      correlationId: payload.correlationId,
      venueId,
      eventType,
      rawMaterialId: inventoryData.rawMaterialId,
      rawMaterialName: inventoryData.rawMaterialName,
      currentStock: inventoryData.currentStock,
    })
  }

  /**
   * Hardware Status Events - Printer, Card Reader, etc.
   */
  public broadcastPrinterStatus(
    venueId: string,
    printerData: Omit<PrinterStatusPayload, 'correlationId' | 'timestamp' | 'venueId'>,
    options?: BroadcastOptions,
  ): void {
    const payload: PrinterStatusPayload = {
      ...printerData,
      venueId,
      correlationId: uuidv4(),
      timestamp: new Date(),
    }

    // Broadcast to venue
    this.broadcastToVenue(venueId, SocketEventType.PRINTER_STATUS, payload, options)

    // Alert admins/managers if printer has error
    if (printerData.status === 'ERROR' || printerData.status === 'OFFLINE' || printerData.status === 'PAPER_OUT') {
      this.broadcastToRole(StaffRole.ADMIN, SocketEventType.PRINTER_STATUS, payload, venueId, options)
      this.broadcastToRole(StaffRole.MANAGER, SocketEventType.PRINTER_STATUS, payload, venueId, options)
    }

    logger.info('Printer status broadcasted', {
      correlationId: payload.correlationId,
      venueId,
      terminalId: printerData.terminalId,
      printerType: printerData.printerType,
      status: printerData.status,
    })
  }

  public broadcastCardReaderStatus(
    venueId: string,
    readerData: Omit<CardReaderStatusPayload, 'correlationId' | 'timestamp' | 'venueId'>,
    options?: BroadcastOptions,
  ): void {
    const payload: CardReaderStatusPayload = {
      ...readerData,
      venueId,
      correlationId: uuidv4(),
      timestamp: new Date(),
    }

    // Broadcast to venue
    this.broadcastToVenue(venueId, SocketEventType.CARD_READER_STATUS, payload, options)

    // Alert admins/managers if reader has error
    if (readerData.status === 'ERROR' || readerData.status === 'DISCONNECTED') {
      this.broadcastToRole(StaffRole.ADMIN, SocketEventType.CARD_READER_STATUS, payload, venueId, options)
      this.broadcastToRole(StaffRole.MANAGER, SocketEventType.CARD_READER_STATUS, payload, venueId, options)
    }

    logger.info('Card reader status broadcasted', {
      correlationId: payload.correlationId,
      venueId,
      terminalId: readerData.terminalId,
      readerType: readerData.readerType,
      status: readerData.status,
    })
  }

  public broadcastPeripheralError(
    venueId: string,
    errorData: Omit<PeripheralErrorPayload, 'correlationId' | 'timestamp' | 'venueId'>,
    options?: BroadcastOptions,
  ): void {
    const payload: PeripheralErrorPayload = {
      ...errorData,
      venueId,
      correlationId: uuidv4(),
      timestamp: new Date(),
    }

    // Broadcast to venue
    this.broadcastToVenue(venueId, SocketEventType.PERIPHERAL_ERROR, payload, options)

    // Alert admins/managers for medium/high/critical errors
    if (errorData.severity === 'medium' || errorData.severity === 'high' || errorData.severity === 'critical') {
      this.broadcastToRole(StaffRole.ADMIN, SocketEventType.PERIPHERAL_ERROR, payload, venueId, options)
      this.broadcastToRole(StaffRole.MANAGER, SocketEventType.PERIPHERAL_ERROR, payload, venueId, options)
    }

    logger.error('Peripheral error broadcasted', {
      correlationId: payload.correlationId,
      venueId,
      terminalId: errorData.terminalId,
      peripheralType: errorData.peripheralType,
      errorCode: errorData.errorCode,
      severity: errorData.severity,
      recoverable: errorData.recoverable,
    })
  }

  /**
   * Menu & Product Real-time Events
   */
  public broadcastMenuUpdated(
    venueId: string,
    menuData: Omit<MenuUpdatedPayload, 'correlationId' | 'timestamp' | 'venueId'>,
    options?: BroadcastOptions,
  ): void {
    const payload: MenuUpdatedPayload = {
      ...menuData,
      venueId,
      correlationId: uuidv4(),
      timestamp: new Date(),
    }

    // Broadcast to entire venue (all terminals + dashboard)
    this.broadcastToVenue(venueId, SocketEventType.MENU_UPDATED, payload, options)

    // Also notify managers/admins for significant changes
    if (menuData.reason === 'PRICE_CHANGE' || menuData.reason === 'ITEM_REMOVED') {
      this.broadcastToRole(StaffRole.ADMIN, SocketEventType.MENU_UPDATED, payload, venueId, options)
      this.broadcastToRole(StaffRole.MANAGER, SocketEventType.MENU_UPDATED, payload, venueId, options)
    }

    logger.info('Menu updated broadcasted', {
      correlationId: payload.correlationId,
      venueId,
      updateType: menuData.updateType,
      reason: menuData.reason,
      affectedProducts: menuData.productIds?.length || 0,
      affectedCategories: menuData.categoryIds?.length || 0,
      updatedBy: menuData.updatedBy,
    })
  }

  public broadcastMenuItemCreated(
    venueId: string,
    itemData: Omit<MenuItemPayload, 'correlationId' | 'timestamp' | 'venueId'>,
    options?: BroadcastOptions,
  ): void {
    const payload: MenuItemPayload = {
      ...itemData,
      venueId,
      correlationId: uuidv4(),
      timestamp: new Date(),
    }

    this.broadcastToVenue(venueId, SocketEventType.MENU_ITEM_CREATED, payload, options)

    logger.info('Menu item created broadcasted', {
      correlationId: payload.correlationId,
      venueId,
      itemId: itemData.itemId,
      itemName: itemData.itemName,
      categoryId: itemData.categoryId,
    })
  }

  public broadcastMenuItemUpdated(
    venueId: string,
    itemData: Omit<MenuItemPayload, 'correlationId' | 'timestamp' | 'venueId'>,
    options?: BroadcastOptions,
  ): void {
    const payload: MenuItemPayload = {
      ...itemData,
      venueId,
      correlationId: uuidv4(),
      timestamp: new Date(),
    }

    this.broadcastToVenue(venueId, SocketEventType.MENU_ITEM_UPDATED, payload, options)

    logger.info('Menu item updated broadcasted', {
      correlationId: payload.correlationId,
      venueId,
      itemId: itemData.itemId,
      itemName: itemData.itemName,
    })
  }

  public broadcastMenuItemDeleted(
    venueId: string,
    itemData: Omit<MenuItemPayload, 'correlationId' | 'timestamp' | 'venueId'>,
    options?: BroadcastOptions,
  ): void {
    const payload: MenuItemPayload = {
      ...itemData,
      venueId,
      correlationId: uuidv4(),
      timestamp: new Date(),
    }

    this.broadcastToVenue(venueId, SocketEventType.MENU_ITEM_DELETED, payload, options)

    logger.info('Menu item deleted broadcasted', {
      correlationId: payload.correlationId,
      venueId,
      itemId: itemData.itemId,
      itemName: itemData.itemName,
    })
  }

  public broadcastProductPriceChanged(
    venueId: string,
    priceData: Omit<ProductPriceChangedPayload, 'correlationId' | 'timestamp' | 'venueId'>,
    options?: BroadcastOptions,
  ): void {
    const payload: ProductPriceChangedPayload = {
      ...priceData,
      venueId,
      correlationId: uuidv4(),
      timestamp: new Date(),
    }

    // Broadcast to venue (critical for pricing consistency)
    this.broadcastToVenue(venueId, SocketEventType.PRODUCT_PRICE_CHANGED, payload, options)

    // Notify managers/admins of price changes
    this.broadcastToRole(StaffRole.ADMIN, SocketEventType.PRODUCT_PRICE_CHANGED, payload, venueId, options)
    this.broadcastToRole(StaffRole.MANAGER, SocketEventType.PRODUCT_PRICE_CHANGED, payload, venueId, options)

    logger.info('Product price changed broadcasted', {
      correlationId: payload.correlationId,
      venueId,
      productId: priceData.productId,
      productName: priceData.productName,
      oldPrice: priceData.oldPrice,
      newPrice: priceData.newPrice,
      priceChange: priceData.priceChange,
      priceChangePercent: priceData.priceChangePercent,
      updatedBy: priceData.updatedBy,
    })
  }

  public broadcastMenuItemAvailabilityChanged(
    venueId: string,
    availabilityData: Omit<MenuItemAvailabilityChangedPayload, 'correlationId' | 'timestamp' | 'venueId'>,
    options?: BroadcastOptions,
  ): void {
    const payload: MenuItemAvailabilityChangedPayload = {
      ...availabilityData,
      venueId,
      correlationId: uuidv4(),
      timestamp: new Date(),
    }

    // Broadcast to venue (critical for order processing)
    this.broadcastToVenue(venueId, SocketEventType.MENU_ITEM_AVAILABILITY_CHANGED, payload, options)

    // Alert staff if item becomes unavailable
    if (!availabilityData.available) {
      this.broadcastToRole(StaffRole.WAITER, SocketEventType.MENU_ITEM_AVAILABILITY_CHANGED, payload, venueId, options)
      this.broadcastToRole(StaffRole.CASHIER, SocketEventType.MENU_ITEM_AVAILABILITY_CHANGED, payload, venueId, options)
    }

    logger.info('Menu item availability changed broadcasted', {
      correlationId: payload.correlationId,
      venueId,
      itemId: availabilityData.itemId,
      itemName: availabilityData.itemName,
      available: availabilityData.available,
      previousAvailability: availabilityData.previousAvailability,
      reason: availabilityData.reason,
    })
  }

  public broadcastMenuCategoryUpdated(
    venueId: string,
    categoryData: Omit<MenuCategoryPayload, 'correlationId' | 'timestamp' | 'venueId'>,
    options?: BroadcastOptions,
  ): void {
    const payload: MenuCategoryPayload = {
      ...categoryData,
      venueId,
      correlationId: uuidv4(),
      timestamp: new Date(),
    }

    this.broadcastToVenue(venueId, SocketEventType.MENU_CATEGORY_UPDATED, payload, options)

    logger.info('Menu category updated broadcasted', {
      correlationId: payload.correlationId,
      venueId,
      categoryId: categoryData.categoryId,
      categoryName: categoryData.categoryName,
      action: categoryData.action,
      affectedItemCount: categoryData.affectedItemCount,
    })
  }

  public broadcastMenuCategoryDeleted(
    venueId: string,
    categoryData: Omit<MenuCategoryPayload, 'correlationId' | 'timestamp' | 'venueId'>,
    options?: BroadcastOptions,
  ): void {
    const payload: MenuCategoryPayload = {
      ...categoryData,
      venueId,
      correlationId: uuidv4(),
      timestamp: new Date(),
    }

    this.broadcastToVenue(venueId, SocketEventType.MENU_CATEGORY_DELETED, payload, options)

    // Notify managers/admins of category deletion
    this.broadcastToRole(StaffRole.ADMIN, SocketEventType.MENU_CATEGORY_DELETED, payload, venueId, options)
    this.broadcastToRole(StaffRole.MANAGER, SocketEventType.MENU_CATEGORY_DELETED, payload, venueId, options)

    logger.info('Menu category deleted broadcasted', {
      correlationId: payload.correlationId,
      venueId,
      categoryId: categoryData.categoryId,
      categoryName: categoryData.categoryName,
      affectedItemCount: categoryData.affectedItemCount,
    })
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
