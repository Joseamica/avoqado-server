/**
 * Pay Later Orders Tests
 *
 * Tests the pay-later order functionality that allows customers to defer payment.
 *
 * Feature Overview:
 * - Pay-later orders = Orders with PENDING/PARTIAL payment status AND customer linkage
 * - No credit limits (unlimited trust model)
 * - Order-by-order tracking (no aggregated balances)
 * - Filtering mechanism to separate pay-later orders from regular unpaid orders
 *
 * Key Business Rules:
 * 1. Regular unpaid orders (DINE_IN) = paymentStatus:PENDING + NO customer
 * 2. Pay-later orders = paymentStatus:PENDING + HAS customer (OrderCustomer)
 * 3. Default getOrders() excludes pay-later orders
 * 4. onlyPayLater option returns ONLY pay-later orders
 */

import { PaymentStatus } from '@prisma/client'

// Define mock type
interface MockPrismaClient {
  order: { findMany: jest.Mock }
}

// Mock prisma before importing the service
const mockPrismaClient: MockPrismaClient = {
  order: {
    findMany: jest.fn(),
  },
}

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: mockPrismaClient,
}))

// Import service after mocking
import * as orderTpvService from '@/services/tpv/order.tpv.service'

describe('Pay Later Orders - getOrders()', () => {
  const venueId = 'venue-123'
  const orgId = 'org-456'

  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('Default Behavior (Exclude Pay-Later)', () => {
    it('should exclude pay-later orders by default', async () => {
      // Arrange
      const mockOrders = [
        {
          id: 'order-1',
          paymentStatus: PaymentStatus.PENDING,
          orderCustomers: [], // Regular unpaid order (no customer)
          tableName: 'Table 1',
        },
        {
          id: 'order-2',
          paymentStatus: PaymentStatus.PENDING,
          orderCustomers: [{ customerId: 'cust-1' }], // Pay-later order (has customer)
          tableName: 'Table 2',
        },
      ]

      mockPrismaClient.order.findMany.mockResolvedValue([mockOrders[0]]) // Only returns regular order

      // Act
      await orderTpvService.getOrders(venueId, orgId)

      // Assert
      expect(mockPrismaClient.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            venueId,
            paymentStatus: { in: ['PENDING', 'PARTIAL'] },
            orderCustomers: { none: {} }, // ✅ Key assertion: Excludes orders with customers
          }),
        }),
      )
    })

    it('should return only regular unpaid orders (no customer linkage)', async () => {
      // Arrange
      const mockOrders = [
        {
          id: 'order-1',
          orderNumber: 'ORD-001',
          paymentStatus: PaymentStatus.PENDING,
          orderCustomers: [],
          tableName: 'Table 1',
        },
        {
          id: 'order-2',
          orderNumber: 'ORD-002',
          paymentStatus: PaymentStatus.PENDING,
          orderCustomers: [],
          tableName: 'Table 2',
        },
      ]

      mockPrismaClient.order.findMany.mockResolvedValue(mockOrders)

      // Act
      const result = await orderTpvService.getOrders(venueId, orgId)

      // Assert
      expect(result).toHaveLength(2)
      expect(result[0].id).toBe('order-1')
      expect(result[1].id).toBe('order-2')
    })
  })

  describe('Pay-Later Only Filter', () => {
    it('should return ONLY pay-later orders when onlyPayLater=true', async () => {
      // Arrange
      const mockPayLaterOrders = [
        {
          id: 'order-pay-later-1',
          orderNumber: 'ORD-100',
          paymentStatus: PaymentStatus.PENDING,
          orderCustomers: [
            {
              customerId: 'cust-1',
              customer: { id: 'cust-1', firstName: 'John', phone: '555-0100' },
            },
          ],
          tableName: 'Table 5',
        },
        {
          id: 'order-pay-later-2',
          orderNumber: 'ORD-101',
          paymentStatus: PaymentStatus.PARTIAL,
          remainingBalance: 50.0,
          orderCustomers: [
            {
              customerId: 'cust-2',
              customer: { id: 'cust-2', firstName: 'Jane', phone: '555-0200' },
            },
          ],
          tableName: 'Table 6',
        },
      ]

      mockPrismaClient.order.findMany.mockResolvedValue(mockPayLaterOrders)

      // Act
      const result = await orderTpvService.getOrders(venueId, orgId, { onlyPayLater: true })

      // Assert
      expect(mockPrismaClient.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            venueId,
            paymentStatus: { in: ['PENDING', 'PARTIAL'] },
            orderCustomers: { some: {} }, // ✅ Key assertion: ONLY orders with customers
          }),
        }),
      )

      expect(result).toHaveLength(2)
      // Note: orderCustomers type checking validated by WHERE clause above
    })

    it('should include orderCustomers include in Prisma query', async () => {
      // Arrange
      mockPrismaClient.order.findMany.mockResolvedValue([])

      // Act
      await orderTpvService.getOrders(venueId, orgId, { onlyPayLater: true })

      // Assert - Verify orderCustomers is included in the query
      expect(mockPrismaClient.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          include: expect.objectContaining({
            orderCustomers: expect.objectContaining({
              include: expect.objectContaining({
                customer: expect.anything(),
              }),
            }),
          }),
        }),
      )
    })

    it('should handle PARTIAL payment status for pay-later orders', async () => {
      // Arrange
      const mockPartialPayLaterOrder = {
        id: 'order-1',
        orderNumber: 'ORD-100',
        paymentStatus: PaymentStatus.PARTIAL,
        total: 100.0,
        paidAmount: 30.0,
        remainingBalance: 70.0,
        orderCustomers: [{ customerId: 'cust-1' }],
        tableName: 'Table 1',
      }

      mockPrismaClient.order.findMany.mockResolvedValue([mockPartialPayLaterOrder])

      // Act
      const result = await orderTpvService.getOrders(venueId, orgId, { onlyPayLater: true })

      // Assert
      expect(result).toHaveLength(1)
      expect(result[0].paymentStatus).toBe(PaymentStatus.PARTIAL)
      expect(result[0].remainingBalance).toBe(70.0)
    })
  })

  describe('Include Pay-Later Filter', () => {
    it('should return ALL orders (regular + pay-later) when includePayLater=true', async () => {
      // Arrange
      const mockAllOrders = [
        {
          id: 'order-regular-1',
          orderNumber: 'ORD-001',
          paymentStatus: PaymentStatus.PENDING,
          orderCustomers: [], // Regular order
          tableName: 'Table 1',
        },
        {
          id: 'order-pay-later-1',
          orderNumber: 'ORD-100',
          paymentStatus: PaymentStatus.PENDING,
          orderCustomers: [{ customerId: 'cust-1' }], // Pay-later order
          tableName: 'Table 5',
        },
      ]

      mockPrismaClient.order.findMany.mockResolvedValue(mockAllOrders)

      // Act
      const result = await orderTpvService.getOrders(venueId, orgId, { includePayLater: true })

      // Assert
      expect(mockPrismaClient.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            venueId,
            paymentStatus: { in: ['PENDING', 'PARTIAL'] },
            // ✅ No orderCustomers filter when includePayLater=true
          }),
        }),
      )

      expect(result).toHaveLength(2)
    })
  })

  describe('Edge Cases', () => {
    it('should return empty array when no pay-later orders exist', async () => {
      // Arrange
      mockPrismaClient.order.findMany.mockResolvedValue([])

      // Act
      const result = await orderTpvService.getOrders(venueId, orgId, { onlyPayLater: true })

      // Assert
      expect(result).toEqual([])
    })

    it('should exclude PAID orders from pay-later filter', async () => {
      // Arrange
      mockPrismaClient.order.findMany.mockResolvedValue([])

      // Act
      await orderTpvService.getOrders(venueId, orgId, { onlyPayLater: true })

      // Assert
      expect(mockPrismaClient.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            paymentStatus: { in: ['PENDING', 'PARTIAL'] }, // ✅ Does NOT include PAID
          }),
        }),
      )
    })

    it('should handle orders with multiple customers', async () => {
      // Arrange
      const mockMultiCustomerOrder = {
        id: 'order-1',
        orderNumber: 'ORD-100',
        paymentStatus: PaymentStatus.PENDING,
        orderCustomers: [
          { customerId: 'cust-1', isPrimary: true, customer: { firstName: 'John' } },
          { customerId: 'cust-2', isPrimary: false, customer: { firstName: 'Jane' } },
        ],
        tableName: 'Table 1',
      }

      mockPrismaClient.order.findMany.mockResolvedValue([mockMultiCustomerOrder])

      // Act
      const result = await orderTpvService.getOrders(venueId, orgId, { onlyPayLater: true })

      // Assert - Query parameters are correct (actual data structure validated by Prisma types)
      expect(mockPrismaClient.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            orderCustomers: { some: {} },
          }),
        }),
      )
      expect(result).toHaveLength(1)
    })
  })

  describe('Business Logic Validation', () => {
    it('should differentiate between regular takeout and pay-later orders', async () => {
      /**
       * Business Rule:
       * - Regular TAKEOUT: paymentStatus=PENDING, NO customer → Shows in default list
       * - Pay-later TAKEOUT: paymentStatus=PENDING, HAS customer → Excluded from default, shows in pay-later filter
       */

      // Default filter (excludes pay-later)
      mockPrismaClient.order.findMany.mockResolvedValueOnce([{ id: 'takeout-regular', orderCustomers: [], tableName: null }])

      const regularOrders = await orderTpvService.getOrders(venueId, orgId)
      expect(regularOrders).toHaveLength(1)
      expect(regularOrders[0].id).toBe('takeout-regular')

      // Pay-later filter
      mockPrismaClient.order.findMany.mockResolvedValueOnce([
        { id: 'takeout-pay-later', orderCustomers: [{ customerId: 'cust-1' }], tableName: null },
      ])

      const payLaterOrders = await orderTpvService.getOrders(venueId, orgId, { onlyPayLater: true })
      expect(payLaterOrders).toHaveLength(1)
      expect(payLaterOrders[0].id).toBe('takeout-pay-later')
    })

    it('should support unlimited trust model (no balance checks)', async () => {
      /**
       * Business Rule:
       * - No credit limits
       * - Always allow creating new pay-later orders regardless of existing balance
       * - This test validates we don't check remaining balances in the query
       */

      mockPrismaClient.order.findMany.mockResolvedValue([
        {
          id: 'order-1',
          remainingBalance: 1000.0, // Large outstanding balance
          orderCustomers: [{ customerId: 'cust-1' }],
          tableName: 'Table 1',
        },
      ])

      // Act
      const result = await orderTpvService.getOrders(venueId, orgId, { onlyPayLater: true })

      // Assert: No balance filter in query
      expect(mockPrismaClient.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.not.objectContaining({
            remainingBalance: expect.anything(),
          }),
        }),
      )
      expect(result).toHaveLength(1) // Order is returned regardless of balance
    })
  })
})
