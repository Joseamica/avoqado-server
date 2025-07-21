# Socket.io Integration Guide

This guide shows how to integrate the Socket.io system with your existing Avoqado backend.

## 1. Server Integration

Update your `src/server.ts` to initialize the Socket.io server:

```typescript
// src/server.ts - Add these imports
import { initializeSocketServer, shutdownSocketServer } from './communication/sockets'

// In your startApplication function, after creating the HTTP server:
const startApplication = async () => {
  try {
    // ... existing database connections and RabbitMQ setup ...

    // Create HTTP server
    const httpServer = http.createServer(app)

    // Initialize Socket.io server
    logger.info('Initializing Socket.io server...')
    const io = initializeSocketServer(httpServer)
    logger.info('Socket.io server initialized successfully')

    // Start the server
    httpServer.listen(PORT, () => {
      logger.info(`🚀 Server is running on port ${PORT}`, {
        environment: NODE_ENV,
        database: DATABASE_URL ? 'Connected' : 'Not configured',
        socketio: 'Enabled'
      })
    })

  } catch (error) {
    logger.error('Failed to start application', {
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined
    })
    process.exit(1)
  }
}

// Update graceful shutdown to include Socket.io
const gracefulShutdown = async (signal: string) => {
  logger.info(`Received ${signal}. Starting graceful shutdown...`)

  httpServer.close(async () => {
    logger.info('Http server closed.')

    try {
      // ... existing cleanup code ...

      // Shutdown Socket.io server
      logger.info('Shutting down Socket.io server...')
      await shutdownSocketServer()

      // ... rest of cleanup ...

      process.exit(0)
    } catch (error) {
      logger.error('Error during graceful shutdown', {
        error: error instanceof Error ? error.message : 'Unknown error'
      })
      process.exit(1)
    }
  })
}
```

## 2. Service Integration Examples

### Payment Service Integration

```typescript
// src/services/dashboard/payment.dashboard.service.ts
import { broadcastPaymentEvent } from '../../communication/sockets'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'

export async function processPayment(
  venueId: string,
  paymentData: ProcessPaymentData
): Promise<Payment> {
  const correlationId = uuidv4()
  
  try {
    logger.info('Processing payment', {
      correlationId,
      venueId,
      paymentId: paymentData.id,
      amount: paymentData.amount
    })

    // Broadcast payment initiated
    broadcastPaymentEvent(venueId, 'initiated', {
      paymentId: paymentData.id,
      amount: paymentData.amount,
      currency: paymentData.currency,
      venueId,
      tableId: paymentData.tableId,
      orderId: paymentData.orderId
    })

    // Process payment (your existing logic)
    const payment = await prisma.payment.create({
      data: paymentData
    })

    // Update payment status to processing
    broadcastPaymentEvent(venueId, 'processing', {
      paymentId: payment.id,
      amount: payment.amount,
      currency: payment.currency,
      venueId,
      tableId: payment.tableId,
      orderId: payment.orderId
    })

    // Simulate payment processing
    const success = await processWithPaymentGateway(payment)

    if (success) {
      // Update database
      const updatedPayment = await prisma.payment.update({
        where: { id: payment.id },
        data: { status: 'COMPLETED', completedAt: new Date() }
      })

      // Broadcast success
      broadcastPaymentEvent(venueId, 'completed', {
        paymentId: payment.id,
        amount: payment.amount,
        currency: payment.currency,
        venueId,
        tableId: payment.tableId,
        orderId: payment.orderId,
        metadata: { completedAt: updatedPayment.completedAt }
      })

      return updatedPayment
    } else {
      // Handle failure
      await prisma.payment.update({
        where: { id: payment.id },
        data: { status: 'FAILED', failedAt: new Date() }
      })

      broadcastPaymentEvent(venueId, 'failed', {
        paymentId: payment.id,
        amount: payment.amount,
        currency: payment.currency,
        venueId,
        tableId: payment.tableId,
        orderId: payment.orderId,
        metadata: { failureReason: 'Payment gateway declined' }
      })

      throw new BadRequestError('Payment failed')
    }

  } catch (error) {
    logger.error('Payment processing error', {
      correlationId,
      venueId,
      paymentId: paymentData.id,
      error: error instanceof Error ? error.message : 'Unknown error'
    })

    // Broadcast failure
    broadcastPaymentEvent(venueId, 'failed', {
      paymentId: paymentData.id,
      amount: paymentData.amount,
      currency: paymentData.currency,
      venueId,
      metadata: { failureReason: 'Internal processing error' }
    })

    throw error
  }
}
```

### Order Service Integration

```typescript
// src/services/dashboard/order.dashboard.service.ts
import { broadcastOrderEvent } from '../../communication/sockets'

export async function createOrder(
  venueId: string,
  orderData: CreateOrderData,
  authContext: AuthContext
): Promise<Order> {
  const correlationId = uuidv4()
  
  try {
    logger.info('Creating new order', {
      correlationId,
      venueId,
      tableId: orderData.tableId,
      userId: authContext.userId
    })

    const order = await prisma.order.create({
      data: {
        ...orderData,
        venueId,
        createdById: authContext.userId,
        status: 'PENDING'
      },
      include: {
        items: true,
        table: true
      }
    })

    // Broadcast order created event
    broadcastOrderEvent(venueId, 'created', {
      orderId: order.id,
      venueId,
      userId: authContext.userId,
      tableId: order.tableId,
      status: order.status,
      items: order.items,
      total: order.total,
      metadata: {
        createdBy: authContext.role,
        tableNumber: order.table?.tableNumber
      }
    })

    logger.info('Order created successfully', {
      correlationId,
      orderId: order.id,
      venueId,
      total: order.total
    })

    return order

  } catch (error) {
    logger.error('Order creation failed', {
      correlationId,
      venueId,
      error: error instanceof Error ? error.message : 'Unknown error'
    })
    throw error
  }
}

export async function updateOrderStatus(
  orderId: string,
  newStatus: string,
  authContext: AuthContext
): Promise<Order> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { items: true }
  })

  if (!order) {
    throw new NotFoundError('Order not found')
  }

  const updatedOrder = await prisma.order.update({
    where: { id: orderId },
    data: { status: newStatus, updatedAt: new Date() },
    include: { items: true }
  })

  // Broadcast status change
  broadcastOrderEvent(order.venueId, 'status_changed', {
    orderId: order.id,
    venueId: order.venueId,
    userId: authContext.userId,
    tableId: order.tableId,
    status: newStatus,
    items: updatedOrder.items,
    total: updatedOrder.total,
    metadata: {
      previousStatus: order.status,
      updatedBy: authContext.role
    }
  })

  return updatedOrder
}
```

### System Alert Integration

```typescript
// src/services/dashboard/alert.dashboard.service.ts
import { broadcastSystemAlert } from '../../communication/sockets'
import { StaffRole } from '@prisma/client'

export async function sendMaintenanceAlert(
  venueId: string,
  maintenanceInfo: MaintenanceInfo,
  authContext: AuthContext
): Promise<void> {
  try {
    // Only admins/managers can send system alerts
    if (![StaffRole.ADMIN, StaffRole.MANAGER].includes(authContext.role)) {
      throw new UnauthorizedError('Insufficient permissions to send system alerts')
    }

    // Log maintenance alert
    await prisma.systemAlert.create({
      data: {
        venueId,
        level: 'warning',
        title: 'Scheduled Maintenance',
        message: `System maintenance scheduled: ${maintenanceInfo.description}`,
        createdById: authContext.userId,
        targetRoles: [StaffRole.ADMIN, StaffRole.MANAGER, StaffRole.WAITER]
      }
    })

    // Broadcast alert
    broadcastSystemAlert(venueId, {
      level: 'warning',
      title: 'Scheduled Maintenance',
      message: `System will undergo maintenance from ${maintenanceInfo.startTime} to ${maintenanceInfo.endTime}. ${maintenanceInfo.description}`,
      venueId,
      userId: authContext.userId,
      targetRoles: [StaffRole.ADMIN, StaffRole.MANAGER, StaffRole.WAITER],
      metadata: {
        startTime: maintenanceInfo.startTime,
        endTime: maintenanceInfo.endTime,
        estimatedDuration: maintenanceInfo.estimatedDuration
      }
    })

    logger.info('Maintenance alert sent', {
      venueId,
      userId: authContext.userId,
      startTime: maintenanceInfo.startTime
    })

  } catch (error) {
    logger.error('Failed to send maintenance alert', {
      venueId,
      userId: authContext.userId,
      error: error instanceof Error ? error.message : 'Unknown error'
    })
    throw error
  }
}
```

## 3. HTTP Controller Integration

Update your existing controllers to trigger real-time events:

```typescript
// src/controllers/dashboard/order.dashboard.controller.ts
import { broadcastOrderEvent } from '../../communication/sockets'

export async function updateOrder(
  req: Request<{ orderId: string }>, 
  res: Response, 
  next: NextFunction
) {
  try {
    const updatedOrder = await orderDashboardService.updateOrder(
      req.params.orderId, 
      req.body,
      req.authContext // Pass auth context for real-time events
    )
    
    res.status(200).json(updatedOrder)
  } catch (error) {
    next(error)
  }
}
```

## 4. Environment Variables

Add these optional environment variables to your `.env` file:

```env
# Socket.io Configuration
REDIS_URL=redis://localhost:6379
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=
REDIS_DB=0

# Socket.io settings (optional, will use defaults)
SOCKET_RATE_LIMIT_WINDOW_MS=900000
SOCKET_MAX_CONNECTIONS=500
SOCKET_MAX_EVENTS_PER_WINDOW=100
```

## 5. Client Implementation Examples

### React Dashboard Client

```typescript
// Dashboard client connection
import { io, Socket } from 'socket.io-client'

class SocketService {
  private socket: Socket | null = null

  connect(token: string) {
    this.socket = io(process.env.REACT_APP_SOCKET_URL, {
      auth: { token },
      transports: ['websocket', 'polling']
    })

    this.socket.on('connect', () => {
      console.log('Connected to server')
      // Join venue room for dashboard updates
      this.socket?.emit('join_room', {
        roomType: 'venue',
        venueId: getUserVenueId()
      })
    })

    // Listen for real-time events
    this.socket.on('payment_completed', (data) => {
      // Update dashboard with payment completion
      updatePaymentStatus(data.paymentId, 'completed')
      showNotification(`Payment of ${data.amount} ${data.currency} completed`)
    })

    this.socket.on('order_created', (data) => {
      // Add new order to dashboard
      addOrderToList(data)
      showNotification(`New order #${data.orderId} from table ${data.tableId}`)
    })

    this.socket.on('system_alert', (data) => {
      // Show system alert
      showAlert(data.level, data.title, data.message)
    })
  }

  disconnect() {
    this.socket?.disconnect()
    this.socket = null
  }
}
```

### Kotlin TPV Client

```kotlin
// Kotlin TPV client connection
class SocketManager(private val token: String) {
    private lateinit var socket: Socket

    fun connect() {
        val options = IO.Options().apply {
            auth = mapOf("token" to token)
            transports = arrayOf(WebSocket.NAME, Polling.NAME)
        }

        socket = IO.socket(BuildConfig.SOCKET_URL, options)

        socket.on(Socket.EVENT_CONNECT) {
            Log.d("Socket", "Connected to server")
            // Join table room for TPV
            socket.emit("join_room", JSONObject().apply {
                put("roomType", "table")
                put("venueId", getVenueId())
                put("tableId", getTableId())
            })
        }

        // Listen for payment events
        socket.on("payment_initiated") { args ->
            val data = args[0] as JSONObject
            // Show payment initiated UI
            showPaymentInitiated(data.getString("paymentId"))
        }

        socket.on("order_status_changed") { args ->
            val data = args[0] as JSONObject
            // Update order status in TPV
            updateOrderStatus(data.getString("orderId"), data.getString("status"))
        }

        socket.connect()
    }

    fun sendPaymentEvent(paymentData: PaymentData) {
        socket.emit("payment_completed", JSONObject().apply {
            put("paymentId", paymentData.id)
            put("amount", paymentData.amount)
            put("currency", paymentData.currency)
            put("venueId", paymentData.venueId)
            put("tableId", paymentData.tableId)
        })
    }
}
```

## 6. Monitoring and Analytics

The system provides built-in connection statistics:

```typescript
// Get real-time connection stats
import { getConnectionStats } from './communication/sockets'

// In your monitoring service
export async function getSystemHealth() {
  const socketStats = getConnectionStats()
  
  return {
    sockets: {
      totalConnections: socketStats?.connectionStats.totalConnections || 0,
      venueConnections: socketStats?.connectionStats.venueConnections || {},
      roleDistribution: socketStats?.connectionStats.roleConnections || {}
    },
    // ... other health metrics
  }
}
```

This integration provides a complete real-time communication layer that seamlessly works with your existing Avoqado backend architecture while maintaining all your established patterns for security, logging, and error handling.
