/**
 * Payment TPV Service Tests - Priority 1C: Pre-Flight Validation
 *
 * Tests the pre-flight inventory validation that prevents payment capture
 * for orders that cannot be fulfilled due to insufficient inventory.
 *
 * World-Class Pattern: Stripe / Shopify Checkout
 */

import prisma from '@/utils/prismaClient'
import * as paymentService from '@/services/tpv/payment.tpv.service'
import * as productInventoryService from '@/services/dashboard/productInventoryIntegration.service'
import { BadRequestError } from '@/errors/AppError'
import { Decimal } from '@prisma/client/runtime/library'

// Mock dependencies
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    order: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    payment: {
      create: jest.fn(),
      findFirst: jest.fn(),
    },
    venueTransaction: {
      create: jest.fn(),
    },
    shift: {
      findFirst: jest.fn(),
    },
    staffVenue: {
      findFirst: jest.fn(),
    },
    paymentAllocation: {
      create: jest.fn(),
    },
    review: {
      create: jest.fn(),
    },
    $transaction: jest.fn(),
  },
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}))

jest.mock('@/services/dashboard/productInventoryIntegration.service', () => ({
  getProductInventoryStatus: jest.fn(),
  deductInventoryForProduct: jest.fn(),
}))

jest.mock('@/services/tpv/digitalReceipt.tpv.service', () => ({
  generateDigitalReceipt: jest.fn(),
}))

jest.mock('@/communication/sockets/managers/socketManager', () => ({
  socketManager: {
    broadcastToVenue: jest.fn(),
  },
}))

jest.mock('@/services/payments/transactionCost.service', () => ({
  createTransactionCost: jest.fn(),
}))

describe('Payment TPV Service - Pre-Flight Validation', () => {
  const mockVenueId = 'venue-123'
  const mockOrderId = 'order-123'

  beforeEach(() => {
    jest.clearAllMocks()

    // Setup common mocks that all tests need
    ;(prisma.shift.findFirst as jest.Mock).mockResolvedValue({ id: 'shift-1', status: 'OPEN' })
    ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue({ staffId: 'staff-1', venueId: mockVenueId })

    // Mock $transaction to execute the callback with a tx object
    ;(prisma.$transaction as jest.Mock).mockImplementation(async callback => {
      const tx = {
        payment: {
          create: prisma.payment.create,
        },
        paymentAllocation: {
          create: prisma.paymentAllocation.create,
        },
        venueTransaction: {
          create: prisma.venueTransaction.create,
        },
        order: {
          update: prisma.order.update,
        },
      }
      return callback(tx)
    })
  })

  describe('recordOrderPayment - Priority 1C', () => {
    it('should validate inventory BEFORE completing order (pre-flight)', async () => {
      // Setup
      const mockOrder = {
        id: mockOrderId,
        venueId: mockVenueId,
        orderNumber: 'ORD-001',
        total: new Decimal(100),
        paymentStatus: 'PENDING',
        source: 'TPV',
        externalId: null,
        items: [
          {
            id: 'item-1',
            productId: 'prod-1',
            quantity: 2,
            product: { name: 'Hamburguesa' },
          },
        ],
        payments: [],
      }

      const mockPaymentData = {
        venueId: mockVenueId,
        amount: 10000, // 100 USD in cents
        tip: 0,
        status: 'COMPLETED' as const,
        method: 'CASH' as const,
        source: 'TPV',
        splitType: 'FULLPAYMENT' as const,
        tpvId: 'tpv-1',
        staffId: 'staff-1',
        paidProductsId: [],
        currency: 'USD',
        isInternational: false,
      }

      const mockInventoryStatus = {
        inventoryMethod: 'RECIPE' as const,
        available: true,
        maxPortions: 5,
        insufficientIngredients: [],
      }

      ;(prisma.order.findUnique as jest.Mock).mockResolvedValue(mockOrder)
      ;(productInventoryService.getProductInventoryStatus as jest.Mock).mockResolvedValue(mockInventoryStatus)
      ;(prisma.order.update as jest.Mock).mockResolvedValue({ ...mockOrder, paymentStatus: 'PAID' })
      ;(prisma.payment.create as jest.Mock).mockResolvedValue({ id: 'payment-1', feeAmount: 0, netAmount: 100 })
      ;(prisma.venueTransaction.create as jest.Mock).mockResolvedValue({})
      ;(prisma.paymentAllocation.create as jest.Mock).mockResolvedValue({})
      ;(productInventoryService.deductInventoryForProduct as jest.Mock).mockResolvedValue({})

      // Execute
      await (paymentService as any).recordOrderPayment(mockVenueId, mockOrderId, mockPaymentData, 'user-1')

      // Verify - getProductInventoryStatus was called for validation
      expect(productInventoryService.getProductInventoryStatus).toHaveBeenCalledWith(mockVenueId, 'prod-1')
    })

    it('should reject payment when inventory validation fails (RECIPE method)', async () => {
      // Setup
      const mockOrder = {
        id: mockOrderId,
        venueId: mockVenueId,
        orderNumber: 'ORD-001',
        total: new Decimal(100),
        paymentStatus: 'PENDING',
        source: 'TPV',
        externalId: null,
        items: [
          {
            id: 'item-1',
            productId: 'prod-1',
            quantity: 5, // Requesting 5 portions
            product: { name: 'Hamburguesa' },
          },
        ],
        payments: [],
      }

      const mockPaymentData = {
        venueId: mockVenueId,
        amount: 10000,
        tip: 0,
        status: 'COMPLETED' as const,
        method: 'CASH' as const,
        source: 'TPV',
        splitType: 'FULLPAYMENT' as const,
        tpvId: 'tpv-1',
        staffId: 'staff-1',
        paidProductsId: [],
        currency: 'USD',
        isInternational: false,
      }

      // Insufficient inventory - only 2 portions available
      const mockInventoryStatus = {
        inventoryMethod: 'RECIPE' as const,
        available: false,
        maxPortions: 2,
        insufficientIngredients: [
          {
            rawMaterialId: 'raw-1',
            name: 'Carne',
            required: 0.5,
            available: 0.1,
            unit: 'KG',
          },
        ],
      }

      ;(prisma.order.findUnique as jest.Mock).mockResolvedValue(mockOrder)
      ;(productInventoryService.getProductInventoryStatus as jest.Mock).mockResolvedValue(mockInventoryStatus)
      ;(prisma.payment.create as jest.Mock).mockResolvedValue({ id: 'payment-1', feeAmount: 0, netAmount: 100 })

      // Execute & Verify
      await expect((paymentService as any).recordOrderPayment(mockVenueId, mockOrderId, mockPaymentData, 'user-1')).rejects.toThrow(
        BadRequestError,
      )

      await expect((paymentService as any).recordOrderPayment(mockVenueId, mockOrderId, mockPaymentData, 'user-1')).rejects.toThrow(
        /insufficient inventory/i,
      )

      // Verify - Payment was NOT created
      expect(prisma.payment.create).not.toHaveBeenCalled()
      // Verify - Inventory was NOT deducted
      expect(productInventoryService.deductInventoryForProduct).not.toHaveBeenCalled()
    })

    it('should reject payment when inventory validation fails (QUANTITY method)', async () => {
      // Setup
      const mockOrder = {
        id: mockOrderId,
        venueId: mockVenueId,
        orderNumber: 'ORD-001',
        total: new Decimal(100),
        paymentStatus: 'PENDING',
        source: 'TPV',
        externalId: null,
        items: [
          {
            id: 'item-1',
            productId: 'prod-1',
            quantity: 10, // Requesting 10 units
            product: { name: 'Camisa' },
          },
        ],
        payments: [],
      }

      const mockPaymentData = {
        venueId: mockVenueId,
        amount: 10000,
        tip: 0,
        status: 'COMPLETED' as const,
        method: 'CASH' as const,
        source: 'TPV',
        splitType: 'FULLPAYMENT' as const,
        tpvId: 'tpv-1',
        staffId: 'staff-1',
        paidProductsId: [],
        currency: 'USD',
        isInternational: false,
      }

      // Insufficient stock - only 3 units available
      const mockInventoryStatus = {
        inventoryMethod: 'QUANTITY' as const,
        available: false,
        currentStock: 3,
        reorderPoint: 5,
        lowStock: true,
      }

      ;(prisma.order.findUnique as jest.Mock).mockResolvedValue(mockOrder)
      ;(productInventoryService.getProductInventoryStatus as jest.Mock).mockResolvedValue(mockInventoryStatus)
      ;(prisma.payment.create as jest.Mock).mockResolvedValue({ id: 'payment-1', feeAmount: 0, netAmount: 100 })

      // Execute & Verify
      await expect((paymentService as any).recordOrderPayment(mockVenueId, mockOrderId, mockPaymentData, 'user-1')).rejects.toThrow(
        BadRequestError,
      )

      // Verify - Error message includes product details
      await expect((paymentService as any).recordOrderPayment(mockVenueId, mockOrderId, mockPaymentData, 'user-1')).rejects.toThrow(
        /Camisa.*requested 10.*available 3/i,
      )
    })

    it('should allow payment for products without inventory tracking', async () => {
      // Setup
      const mockOrder = {
        id: mockOrderId,
        venueId: mockVenueId,
        orderNumber: 'ORD-001',
        total: new Decimal(100),
        paymentStatus: 'PENDING',
        source: 'TPV',
        externalId: null,
        items: [
          {
            id: 'item-1',
            productId: 'prod-service',
            quantity: 1,
            product: { name: 'Consultoría' }, // Service - no inventory
          },
        ],
        payments: [],
      }

      const mockPaymentData = {
        venueId: mockVenueId,
        amount: 10000,
        tip: 0,
        status: 'COMPLETED' as const,
        method: 'CASH' as const,
        source: 'TPV',
        splitType: 'FULLPAYMENT' as const,
        tpvId: 'tpv-1',
        staffId: 'staff-1',
        paidProductsId: [],
        currency: 'USD',
        isInternational: false,
      }

      // No inventory tracking - always available
      const mockInventoryStatus = {
        inventoryMethod: null,
        available: true,
        message: 'No inventory tracking',
      }

      ;(prisma.order.findUnique as jest.Mock).mockResolvedValue(mockOrder)
      ;(productInventoryService.getProductInventoryStatus as jest.Mock).mockResolvedValue(mockInventoryStatus)
      ;(prisma.order.update as jest.Mock).mockResolvedValue({ ...mockOrder, paymentStatus: 'PAID' })
      ;(prisma.payment.create as jest.Mock).mockResolvedValue({ id: 'payment-1', feeAmount: 0, netAmount: 100 })
      ;(prisma.venueTransaction.create as jest.Mock).mockResolvedValue({})
      ;(prisma.paymentAllocation.create as jest.Mock).mockResolvedValue({})

      // Execute - Should succeed without inventory checks
      await (paymentService as any).recordOrderPayment(mockVenueId, mockOrderId, mockPaymentData, 'user-1')

      // Verify - Payment was created
      expect(prisma.payment.create).toHaveBeenCalled()
    })

    it('should NOT validate inventory for partial payments', async () => {
      // Setup
      const mockOrder = {
        id: mockOrderId,
        venueId: mockVenueId,
        orderNumber: 'ORD-001',
        total: new Decimal(100),
        paymentStatus: 'PENDING',
        source: 'TPV',
        externalId: null,
        items: [
          {
            id: 'item-1',
            productId: 'prod-1',
            quantity: 2,
            product: { name: 'Hamburguesa' },
          },
        ],
        payments: [],
      }

      const mockPaymentData = {
        venueId: mockVenueId,
        amount: 5000, // Only 50 USD (partial payment)
        tip: 0,
        status: 'COMPLETED' as const,
        method: 'CASH' as const,
        source: 'TPV',
        splitType: 'CUSTOMAMOUNT' as const,
        tpvId: 'tpv-1',
        staffId: 'staff-1',
        paidProductsId: [],
        currency: 'USD',
        isInternational: false,
      }

      ;(prisma.order.findUnique as jest.Mock).mockResolvedValue(mockOrder)
      ;(prisma.payment.create as jest.Mock).mockResolvedValue({ id: 'payment-1', feeAmount: 0, netAmount: 50 })
      ;(prisma.venueTransaction.create as jest.Mock).mockResolvedValue({})
      ;(prisma.paymentAllocation.create as jest.Mock).mockResolvedValue({})
      ;(prisma.order.update as jest.Mock).mockResolvedValue({ ...mockOrder, paymentStatus: 'PARTIAL' })

      // Execute
      await (paymentService as any).recordOrderPayment(mockVenueId, mockOrderId, mockPaymentData, 'user-1')

      // Verify - Inventory status was NOT checked (only validates on full payment)
      expect(productInventoryService.getProductInventoryStatus).not.toHaveBeenCalled()
    })
  })

  describe('REGRESSION TESTS - Existing payment functionality', () => {
    it('should still create payment record correctly', async () => {
      // Setup
      const mockOrder = {
        id: mockOrderId,
        venueId: mockVenueId,
        orderNumber: 'ORD-001',
        total: new Decimal(100),
        paymentStatus: 'PENDING',
        source: 'TPV',
        externalId: null,
        items: [
          {
            id: 'item-1',
            productId: 'prod-1',
            quantity: 2,
            product: { name: 'Producto' },
          },
        ],
        payments: [],
      }

      const mockPaymentData = {
        venueId: mockVenueId,
        amount: 10000,
        tip: 500,
        status: 'COMPLETED' as const,
        method: 'CASH' as const,
        source: 'TPV',
        splitType: 'FULLPAYMENT' as const,
        tpvId: 'tpv-1',
        staffId: 'staff-1',
        paidProductsId: [],
        currency: 'USD',
        isInternational: false,
      }

      const mockInventoryStatus = {
        inventoryMethod: null,
        available: true,
      }

      ;(prisma.order.findUnique as jest.Mock).mockResolvedValue(mockOrder)
      ;(productInventoryService.getProductInventoryStatus as jest.Mock).mockResolvedValue(mockInventoryStatus)
      ;(prisma.payment.create as jest.Mock).mockResolvedValue({ id: 'payment-1' })
      ;(prisma.venueTransaction.create as jest.Mock).mockResolvedValue({})
      ;(prisma.paymentAllocation.create as jest.Mock).mockResolvedValue({})
      ;(prisma.order.update as jest.Mock).mockResolvedValue({ ...mockOrder, paymentStatus: 'PAID' })

      // Execute
      await (paymentService as any).recordOrderPayment(mockVenueId, mockOrderId, mockPaymentData, 'user-1')

      // Verify - Payment was created with correct data
      expect(prisma.payment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            venueId: mockVenueId,
            orderId: mockOrderId,
            amount: 100, // Converted from cents
            tipAmount: 5, // Converted from cents
            method: 'CASH',
          }),
        }),
      )
    })

    it('should still create VenueTransaction for financial tracking', async () => {
      // Setup
      const mockOrder = {
        id: mockOrderId,
        venueId: mockVenueId,
        orderNumber: 'ORD-001',
        total: new Decimal(100),
        paymentStatus: 'PENDING',
        source: 'TPV',
        externalId: null,
        items: [],
        payments: [],
      }

      const mockPaymentData = {
        venueId: mockVenueId,
        amount: 10000,
        tip: 0,
        status: 'COMPLETED' as const,
        method: 'CASH' as const,
        source: 'TPV',
        splitType: 'FULLPAYMENT' as const,
        tpvId: 'tpv-1',
        staffId: 'staff-1',
        paidProductsId: [],
        currency: 'USD',
        isInternational: false,
      }

      ;(prisma.order.findUnique as jest.Mock).mockResolvedValue(mockOrder)
      ;(prisma.payment.create as jest.Mock).mockResolvedValue({ id: 'payment-1', feeAmount: 0, netAmount: 100 })
      ;(prisma.venueTransaction.create as jest.Mock).mockResolvedValue({})
      ;(prisma.paymentAllocation.create as jest.Mock).mockResolvedValue({})
      ;(prisma.order.update as jest.Mock).mockResolvedValue({ ...mockOrder, paymentStatus: 'PAID' })

      // Execute
      await (paymentService as any).recordOrderPayment(mockVenueId, mockOrderId, mockPaymentData, 'user-1')

      // Verify - VenueTransaction was created
      expect(prisma.venueTransaction.create).toHaveBeenCalled()
    })
  })
})
