import { createServer } from 'http'
import { AddressInfo } from 'net'
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client'
import { StaffRole } from '@prisma/client'
import jwt from 'jsonwebtoken'

import { SocketManager } from '../managers/socketManager'
import { SocketEventType } from '../types'
import { ACCESS_TOKEN_SECRET } from '../../../config/env'

/**
 * Socket.io Integration Tests
 * Tests the complete socket system including authentication, rooms, and broadcasting
 * Following existing test patterns in the codebase
 */

describe('SocketManager Integration Tests', () => {
  let httpServer: any
  let httpServerAddr: AddressInfo
  let socketManager: SocketManager
  let clientSocket: ClientSocket

  // Test data
  const testUser = {
    sub: 'test-user-123',
    orgId: 'test-org-123',
    venueId: 'test-venue-123',
    role: StaffRole.WAITER
  }

  const generateTestToken = (payload = testUser): string => {
    return jwt.sign(payload, ACCESS_TOKEN_SECRET || 'test-secret', { expiresIn: '1h' })
  }

  beforeAll(async () => {
    // Create HTTP server
    httpServer = createServer()
    
    // Initialize socket manager
    socketManager = new SocketManager({
      authentication: { required: true, timeout: 5000 },
      rateLimit: { windowMs: 60000, maxConnections: 100, maxEventsPerWindow: 50 }
    })
    
    const io = socketManager.initialize(httpServer)
    
    // Start server
    await new Promise<void>((resolve) => {
      httpServer.listen(() => {
        httpServerAddr = httpServer.address() as AddressInfo
        resolve()
      })
    })
  })

  afterAll(async () => {
    await socketManager.shutdown()
    httpServer.close()
  })

  beforeEach(() => {
    // Clean up any existing client connections
    if (clientSocket) {
      clientSocket.disconnect()
    }
  })

  afterEach(() => {
    if (clientSocket) {
      clientSocket.disconnect()
    }
  })

  describe('Authentication', () => {
    it('should authenticate with valid JWT token', (done) => {
      const token = generateTestToken()
      
      clientSocket = ioClient(`http://localhost:${httpServerAddr.port}`, {
        auth: { token }
      })

      clientSocket.on('connect', () => {
        expect(clientSocket.connected).toBe(true)
        done()
      })

      clientSocket.on(SocketEventType.AUTHENTICATION_SUCCESS, (data) => {
        expect(data.success).toBe(true)
        expect(data.authContext.userId).toBe(testUser.sub)
        expect(data.authContext.venueId).toBe(testUser.venueId)
        expect(data.authContext.role).toBe(testUser.role)
      })

      clientSocket.on('connect_error', (error) => {
        done(error)
      })
    })

    it('should reject invalid JWT token', (done) => {
      clientSocket = ioClient(`http://localhost:${httpServerAddr.port}`, {
        auth: { token: 'invalid-token' }
      })

      clientSocket.on('connect', () => {
        // Should not connect with invalid token
        done(new Error('Should not connect with invalid token'))
      })

      clientSocket.on('connect_error', (error) => {
        expect(error.message).toContain('authentication')
        done()
      })
    })

    it('should reject connection without token', (done) => {
      clientSocket = ioClient(`http://localhost:${httpServerAddr.port}`)

      clientSocket.on('connect', () => {
        done(new Error('Should not connect without token'))
      })

      clientSocket.on('connect_error', (error) => {
        expect(error.message).toContain('authentication')
        done()
      })
    })

    it('should handle expired token', (done) => {
      const expiredToken = jwt.sign(
        testUser, 
        ACCESS_TOKEN_SECRET || 'test-secret', 
        { expiresIn: '-1h' }
      )
      
      clientSocket = ioClient(`http://localhost:${httpServerAddr.port}`, {
        auth: { token: expiredToken }
      })

      clientSocket.on('connect_error', (error) => {
        expect(error.message).toContain('expired')
        done()
      })
    })
  })

  describe('Room Management', () => {
    beforeEach((done) => {
      const token = generateTestToken()
      clientSocket = ioClient(`http://localhost:${httpServerAddr.port}`, {
        auth: { token }
      })
      clientSocket.on('connect', done)
    })

    it('should join table room successfully', (done) => {
      const tableId = 'table-001'
      
      clientSocket.emit(SocketEventType.JOIN_ROOM, {
        roomType: 'table',
        venueId: testUser.venueId,
        tableId
      }, (response: any) => {
        expect(response.success).toBe(true)
        expect(response.tableId).toBe(tableId)
        expect(response.roomType).toBe('table')
        done()
      })
    })

    it('should leave table room successfully', (done) => {
      const tableId = 'table-001'
      
      // First join the room
      clientSocket.emit(SocketEventType.JOIN_ROOM, {
        roomType: 'table',
        venueId: testUser.venueId,
        tableId
      }, () => {
        // Then leave the room
        clientSocket.emit(SocketEventType.LEAVE_ROOM, {
          roomType: 'table',
          venueId: testUser.venueId,
          tableId
        }, (response: any) => {
          expect(response.success).toBe(true)
          expect(response.tableId).toBe(tableId)
          done()
        })
      })
    })

    it('should reject room access to different venue', (done) => {
      clientSocket.emit(SocketEventType.JOIN_ROOM, {
        roomType: 'table',
        venueId: 'different-venue-id',
        tableId: 'table-001'
      }, (response: any) => {
        expect(response.success).toBe(false)
        expect(response.error).toContain('Access denied')
        done()
      })
    })
  })

  describe('Business Events', () => {
    beforeEach((done) => {
      const token = generateTestToken()
      clientSocket = ioClient(`http://localhost:${httpServerAddr.port}`, {
        auth: { token }
      })
      clientSocket.on('connect', done)
    })

    it('should broadcast payment event successfully', (done) => {
      const paymentData = {
        paymentId: 'payment-123',
        amount: 100.50,
        currency: 'USD',
        venueId: testUser.venueId,
        orderId: 'order-123'
      }

      // Listen for the broadcasted event
      clientSocket.on(SocketEventType.PAYMENT_COMPLETED, (data) => {
        expect(data.paymentId).toBe(paymentData.paymentId)
        expect(data.amount).toBe(paymentData.amount)
        expect(data.status).toBe('completed')
        done()
      })

      // Emit payment event
      clientSocket.emit(SocketEventType.PAYMENT_COMPLETED, paymentData)
    })

    it('should broadcast order event successfully', (done) => {
      const orderData = {
        orderId: 'order-456',
        venueId: testUser.venueId,
        tableId: 'table-001',
        items: [{ id: 'item-1', name: 'Test Item', quantity: 1 }],
        total: 25.99
      }

      clientSocket.on(SocketEventType.ORDER_CREATED, (data) => {
        expect(data.orderId).toBe(orderData.orderId)
        expect(data.total).toBe(orderData.total)
        expect(data.items).toHaveLength(1)
        done()
      })

      clientSocket.emit(SocketEventType.ORDER_CREATED, orderData)
    })

    it('should reject unauthorized payment event', (done) => {
      // Create token with role that doesn't have payment permissions
      const customerToken = generateTestToken({
        ...testUser,
        role: StaffRole.CUSTOMER
      })

      const customerSocket = ioClient(`http://localhost:${httpServerAddr.port}`, {
        auth: { token: customerToken }
      })

      customerSocket.on('connect', () => {
        customerSocket.emit(SocketEventType.PAYMENT_COMPLETED, {
          paymentId: 'payment-123',
          amount: 100,
          currency: 'USD',
          venueId: testUser.venueId
        }, (response: any) => {
          expect(response.success).toBe(false)
          expect(response.error).toContain('not authorized')
          customerSocket.disconnect()
          done()
        })
      })
    })
  })

  describe('Broadcasting', () => {
    let clientSocket2: ClientSocket

    beforeEach(async () => {
      // Connect first client
      const token1 = generateTestToken()
      clientSocket = ioClient(`http://localhost:${httpServerAddr.port}`, {
        auth: { token: token1 }
      })

      // Connect second client
      const token2 = generateTestToken({
        ...testUser,
        sub: 'test-user-456'
      })
      clientSocket2 = ioClient(`http://localhost:${httpServerAddr.port}`, {
        auth: { token: token2 }
      })

      // Wait for both to connect
      await Promise.all([
        new Promise(resolve => clientSocket.on('connect', resolve)),
        new Promise(resolve => clientSocket2.on('connect', resolve))
      ])
    })

    afterEach(() => {
      if (clientSocket2) {
        clientSocket2.disconnect()
      }
    })

    it('should broadcast venue-wide events', (done) => {
      const alertData = {
        level: 'info',
        title: 'Test Alert',
        message: 'This is a test alert',
        venueId: testUser.venueId
      }

      // Second client should receive the alert
      clientSocket2.on(SocketEventType.SYSTEM_ALERT, (data) => {
        expect(data.title).toBe(alertData.title)
        expect(data.level).toBe(alertData.level)
        done()
      })

      // First client sends the alert (with manager role)
      const managerToken = generateTestToken({
        ...testUser,
        role: StaffRole.MANAGER
      })
      
      const managerSocket = ioClient(`http://localhost:${httpServerAddr.port}`, {
        auth: { token: managerToken }
      })

      managerSocket.on('connect', () => {
        managerSocket.emit(SocketEventType.SYSTEM_ALERT, alertData)
      })
    })

    it('should not broadcast to excluded socket', (done) => {
      const alertData = {
        level: 'info',
        title: 'Test Alert',
        message: 'This is a test alert',
        venueId: testUser.venueId
      }

      let alertReceived = false

      // First client should NOT receive its own alert
      clientSocket.on(SocketEventType.SYSTEM_ALERT, () => {
        alertReceived = true
      })

      // Use socket manager directly to test exclusion
      setTimeout(() => {
        socketManager.broadcastToVenue(
          testUser.venueId,
          SocketEventType.SYSTEM_ALERT,
          alertData,
          { excludeSocket: clientSocket.id }
        )

        // Wait and check that first client didn't receive the event
        setTimeout(() => {
          expect(alertReceived).toBe(false)
          done()
        }, 100)
      }, 100)
    })
  })

  describe('Error Handling', () => {
    beforeEach((done) => {
      const token = generateTestToken()
      clientSocket = ioClient(`http://localhost:${httpServerAddr.port}`, {
        auth: { token }
      })
      clientSocket.on('connect', done)
    })

    it('should handle invalid event payload', (done) => {
      clientSocket.emit(SocketEventType.PAYMENT_INITIATED, {
        // Missing required fields
        venueId: testUser.venueId
      }, (response: any) => {
        expect(response.success).toBe(false)
        expect(response.error).toContain('required')
        done()
      })
    })

    it('should handle malformed room join request', (done) => {
      clientSocket.emit(SocketEventType.JOIN_ROOM, {
        // Missing required fields
        roomType: 'table'
      }, (response: any) => {
        expect(response.success).toBe(false)
        expect(response.error).toContain('required')
        done()
      })
    })
  })

  describe('Rate Limiting', () => {
    beforeEach((done) => {
      const token = generateTestToken()
      clientSocket = ioClient(`http://localhost:${httpServerAddr.port}`, {
        auth: { token }
      })
      clientSocket.on('connect', done)
    })

    it('should rate limit excessive connections from same IP', async () => {
      const connections: ClientSocket[] = []
      const maxConnections = 10

      try {
        // Try to create more connections than allowed
        for (let i = 0; i < maxConnections + 5; i++) {
          const token = generateTestToken({
            ...testUser,
            sub: `user-${i}`
          })
          
          const socket = ioClient(`http://localhost:${httpServerAddr.port}`, {
            auth: { token },
            timeout: 1000
          })
          
          connections.push(socket)
        }

        // Wait for connection attempts
        await new Promise(resolve => setTimeout(resolve, 2000))

        // Some connections should be rejected due to rate limiting
        const connectedSockets = connections.filter(s => s.connected)
        expect(connectedSockets.length).toBeLessThan(maxConnections + 5)

      } finally {
        // Clean up all connections
        connections.forEach(socket => socket.disconnect())
      }
    })
  })

  describe('Connection Statistics', () => {
    it('should track connection statistics', () => {
      const stats = socketManager.getServerStats()
      
      expect(stats).toBeDefined()
      expect(stats?.connectionStats).toBeDefined()
      expect(typeof stats?.connectionStats.totalConnections).toBe('number')
      expect(typeof stats?.connectionStats.venueConnections).toBe('object')
    })
  })
})
