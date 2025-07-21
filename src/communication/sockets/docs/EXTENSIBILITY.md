# Socket.io Extensibility Guide

This guide demonstrates how to easily add new real-time events to the Avoqado Socket.io system while maintaining consistency with existing patterns.

## Overview

The Socket.io system is designed to make adding new events trivial by following established patterns:

1. **Define event types** in the type system
2. **Add payload interfaces** for type safety
3. **Implement business logic** in controllers/services
4. **Use existing broadcasting** infrastructure

## Adding New Event Types

### Step 1: Define Event Types

Add new event types to `src/communication/sockets/types/index.ts`:

```typescript
export enum SocketEventType {
  // Existing events...
  
  // New events for menu management
  MENU_ITEM_ADDED = 'menu_item_added',
  MENU_ITEM_UPDATED = 'menu_item_updated',
  MENU_ITEM_REMOVED = 'menu_item_removed',
  
  // New events for table management
  TABLE_RESERVED = 'table_reserved',
  TABLE_FREED = 'table_freed',
  TABLE_REQUEST_ASSISTANCE = 'table_request_assistance',
  
  // New events for kitchen operations
  KITCHEN_ORDER_READY = 'kitchen_order_ready',
  KITCHEN_DELAY_ALERT = 'kitchen_delay_alert',
}
```

### Step 2: Define Payload Interfaces

Add strongly typed payload interfaces:

```typescript
export interface MenuEventPayload extends BaseEventPayload {
  menuItemId: string
  name: string
  price?: number
  categoryId?: string
  availability?: boolean
  metadata?: Record<string, any>
}

export interface TableEventPayload extends BaseEventPayload {
  tableId: string
  status: 'reserved' | 'occupied' | 'free' | 'assistance_requested'
  reservationId?: string
  estimatedDuration?: number
  metadata?: Record<string, any>
}

export interface KitchenEventPayload extends BaseEventPayload {
  orderId: string
  items: Array<{
    id: string
    name: string
    status: 'preparing' | 'ready' | 'delayed'
    estimatedTime?: number
  }>
  estimatedCompletionTime?: Date
  delayReason?: string
  metadata?: Record<string, any>
}
```

### Step 3: Extend Business Event Controller

Add new handler methods to `BusinessEventController`:

```typescript
/**
 * Handle menu events
 */
public handleMenuEvent(
  socket: AuthenticatedSocket,
  eventType: 'added' | 'updated' | 'removed',
  payload: Omit<MenuEventPayload, 'correlationId' | 'timestamp'>,
  callback?: (response: any) => void
): void {
  const correlationId = socket.correlationId || uuidv4()

  try {
    // Validate authentication
    if (!socket.authContext) {
      const error = new UnauthorizedError('Authentication required for menu events')
      this.sendErrorResponse(error, correlationId, callback, socket)
      return
    }

    // Authorize menu event access (only managers/admins)
    this.authorizeMenuAccess(socket, eventType)
    
    // Validate payload
    this.validateMenuPayload(payload)
    
    // Verify venue access
    if (payload.venueId !== socket.authContext.venueId) {
      const error = new UnauthorizedError('Access denied to specified venue')
      this.sendErrorResponse(error, correlationId, callback, socket)
      return
    }

    const { userId, venueId, role } = socket.authContext

    // Enrich payload
    const enrichedPayload: MenuEventPayload = {
      ...payload,
      correlationId,
      timestamp: new Date(),
      userId
    }

    // Broadcast menu event
    if (this.broadcastingService) {
      this.broadcastingService.broadcastMenuEvent(
        venueId,
        eventType,
        enrichedPayload,
        { excludeSocket: socket.id }
      )
    }

    // Send success response
    const response = {
      correlationId,
      success: true,
      message: `Menu ${eventType} event broadcasted`,
      eventType,
      menuItemId: payload.menuItemId
    }

    if (callback) callback(response)

    logger.info('Menu event processed successfully', {
      correlationId,
      socketId: socket.id,
      userId,
      venueId,
      role,
      eventType,
      menuItemId: payload.menuItemId
    })

  } catch (error) {
    // Error handling following existing pattern
    this.sendErrorResponse(
      error instanceof Error ? error : new Error('Menu event failed'),
      correlationId,
      callback,
      socket
    )
  }
}

private authorizeMenuAccess(socket: AuthenticatedSocket, eventType: string): void {
  const { role } = socket.authContext!
  
  // Only managers and admins can modify menu
  const allowedRoles = [StaffRole.ADMIN, StaffRole.MANAGER]

  if (!allowedRoles.includes(role)) {
    throw new UnauthorizedError(`Role ${role} not authorized for menu events`)
  }
}

private validateMenuPayload(payload: any): void {
  if (!payload.menuItemId) {
    throw new BadRequestError('Menu item ID is required')
  }
  if (!payload.name) {
    throw new BadRequestError('Menu item name is required')
  }
  if (!payload.venueId) {
    throw new BadRequestError('Venue ID is required')
  }
}
```

### Step 4: Add Broadcasting Methods

Extend the `BroadcastingService` with specific methods:

```typescript
/**
 * Menu Events
 */
public broadcastMenuEvent(
  venueId: string,
  eventType: 'added' | 'updated' | 'removed',
  menuData: Omit<MenuEventPayload, 'correlationId' | 'timestamp'>,
  options?: BroadcastOptions
): void {
  const eventMap = {
    added: SocketEventType.MENU_ITEM_ADDED,
    updated: SocketEventType.MENU_ITEM_UPDATED,
    removed: SocketEventType.MENU_ITEM_REMOVED
  }

  const payload: MenuEventPayload = {
    ...menuData,
    correlationId: uuidv4(),
    timestamp: new Date()
  }

  // Broadcast to venue (all connected staff)
  this.broadcastToVenue(venueId, eventMap[eventType], payload, options)

  // Broadcast to specific roles if needed
  if (eventType === 'added' || eventType === 'updated') {
    // Notify kitchen staff about menu changes
    this.broadcastToRole(StaffRole.KITCHEN, eventMap[eventType], payload, venueId, options)
  }
}

/**
 * Table Events
 */
public broadcastTableEvent(
  venueId: string,
  eventType: 'reserved' | 'freed' | 'assistance_requested',
  tableData: Omit<TableEventPayload, 'correlationId' | 'timestamp'>,
  options?: BroadcastOptions
): void {
  const eventMap = {
    reserved: SocketEventType.TABLE_RESERVED,
    freed: SocketEventType.TABLE_FREED,
    assistance_requested: SocketEventType.TABLE_REQUEST_ASSISTANCE
  }

  const payload: TableEventPayload = {
    ...tableData,
    correlationId: uuidv4(),
    timestamp: new Date()
  }

  // Broadcast to venue
  this.broadcastToVenue(venueId, eventMap[eventType], payload, options)

  // For assistance requests, specifically notify waiters
  if (eventType === 'assistance_requested') {
    this.broadcastToRole(StaffRole.WAITER, eventMap[eventType], payload, venueId, options)
  }
}
```

### Step 5: Register Event Handlers

Update the `SocketManager` to register new event handlers:

```typescript
private registerSocketEventHandlers(socket: AuthenticatedSocket): void {
  // Existing handlers...

  // New menu events
  socket.on(SocketEventType.MENU_ITEM_ADDED, (payload, callback) => {
    this.businessEventController.handleMenuEvent(socket, 'added', payload, callback)
  })

  socket.on(SocketEventType.MENU_ITEM_UPDATED, (payload, callback) => {
    this.businessEventController.handleMenuEvent(socket, 'updated', payload, callback)
  })

  // New table events
  socket.on(SocketEventType.TABLE_REQUEST_ASSISTANCE, (payload, callback) => {
    this.businessEventController.handleTableEvent(socket, 'assistance_requested', payload, callback)
  })

  // New kitchen events
  socket.on(SocketEventType.KITCHEN_ORDER_READY, (payload, callback) => {
    this.businessEventController.handleKitchenEvent(socket, 'order_ready', payload, callback)
  })
}
```

### Step 6: Create Convenience Functions

Add convenience functions to the main index file:

```typescript
/**
 * Broadcast menu event
 * Convenience function for broadcasting menu-related events
 */
export function broadcastMenuEvent(
  venueId: string,
  eventType: 'added' | 'updated' | 'removed',
  menuData: any,
  options?: BroadcastOptions
): void {
  const broadcastingService = socketManager.getServer()?.['broadcastingService']
  if (broadcastingService) {
    broadcastingService.broadcastMenuEvent(venueId, eventType, menuData, options)
  } else {
    logger.warn('Socket broadcasting service not available for menu event', {
      venueId,
      eventType,
      menuItemId: menuData.menuItemId
    })
  }
}
```

## Integration with Services

### Using in Menu Service

```typescript
// src/services/dashboard/menu.dashboard.service.ts
import { broadcastMenuEvent } from '../../communication/sockets'

export async function createMenuItem(
  venueId: string, 
  menuItemData: CreateMenuItemData
): Promise<MenuItem> {
  try {
    // Create menu item in database
    const menuItem = await prisma.menuItem.create({
      data: {
        ...menuItemData,
        venueId
      }
    })

    // Broadcast real-time event
    broadcastMenuEvent(venueId, 'added', {
      menuItemId: menuItem.id,
      name: menuItem.name,
      price: menuItem.price,
      categoryId: menuItem.categoryId,
      availability: menuItem.available,
      venueId
    })

    return menuItem

  } catch (error) {
    logger.error('Error creating menu item', {
      venueId,
      error: error instanceof Error ? error.message : 'Unknown error'
    })
    throw error
  }
}
```

### Using in Table Service

```typescript
// src/services/dashboard/table.dashboard.service.ts
import { broadcastTableEvent } from '../../communication/sockets'

export async function requestTableAssistance(
  venueId: string,
  tableId: string,
  customerId?: string
): Promise<void> {
  try {
    // Log assistance request
    await prisma.tableAssistanceRequest.create({
      data: {
        tableId,
        venueId,
        customerId,
        requestedAt: new Date()
      }
    })

    // Broadcast real-time event
    broadcastTableEvent(venueId, 'assistance_requested', {
      tableId,
      status: 'assistance_requested',
      venueId,
      metadata: {
        requestedBy: customerId ? 'customer' : 'system',
        priority: 'normal'
      }
    })

  } catch (error) {
    logger.error('Error requesting table assistance', {
      venueId,
      tableId,
      error: error instanceof Error ? error.message : 'Unknown error'
    })
    throw error
  }
}
```

## Pattern Summary

The extensibility pattern follows these principles:

1. **Type Safety**: All events are strongly typed
2. **Consistent Authorization**: Role-based access control
3. **Proper Validation**: Input validation using AppError classes
4. **Comprehensive Logging**: Correlation ID tracking
5. **Error Handling**: Standardized error responses
6. **Broadcasting Logic**: Smart targeting of relevant audiences
7. **Service Integration**: Easy to use from existing services

## Benefits

- **Easy to Add**: New events require minimal boilerplate
- **Type Safe**: Compile-time checking of event payloads
- **Consistent**: Following established patterns ensures reliability
- **Maintainable**: Clear separation of concerns
- **Testable**: Each component can be tested independently
- **Scalable**: Works with Redis adapter for multiple server instances

This design makes it trivial to add any new real-time feature while maintaining the high quality and consistency of the codebase.
