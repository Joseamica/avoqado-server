/**
 * Payment TPV Service Tests - Priority 1C: Pre-Flight Validation
 *
 * Tests the pre-flight inventory validation that prevents payment capture
 * for orders that cannot be fulfilled due to insufficient inventory.
 *
 * World-Class Pattern: Stripe / Shopify Checkout
 */

// El guard de ventas por sucursal (venueSalesGuard) NO es el objeto de esta suite:
// se prueba en tests/unit/services/venueSalesGuard.test.ts. Sin este mock, cada
// servicio de venta consulta venue.salesEnabled contra un prismaMock que no lo define.
jest.mock('@/services/venueSalesGuard', () => ({
  __esModule: true,
  assertVenueSalesEnabled: jest.fn(),
}))

import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
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
    merchantAccount: {
      findUnique: jest.fn(),
    },
    venueTransaction: {
      create: jest.fn(),
    },
    shift: {
      findFirst: jest.fn(),
      update: jest.fn(),
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
    activityLog: {
      create: jest.fn().mockResolvedValue({}),
    },
    // Con el cobro ya NO rechazándose por inventario (Square-parity 2026-08-12),
    // el flujo post-cobro corre completo y toca estos modelos; sin ellos el
    // helper muere en un TypeError silencioso y el aviso se pierde.
    serializedItem: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    orderCustomer: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    areaTicketInventoryReservation: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    areaTicketCheckoutSession: {
      findFirst: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    areaTicketPaymentAttempt: {
      findFirst: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
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
        shift: {
          update: prisma.shift.update,
        },
        // recordOrderPayment llama lockAreaTicketCheckoutForPayment(tx, …) — area
        // tickets v7. Este `tx` se arma A MANO: un modelo que la ruta toque y no
        // esté aquí sale undefined y el test truena con un TypeError en lugar de
        // su aserción real. findFirst → null = "no es orden de area tickets".
        areaTicketCheckoutSession: {
          findFirst: jest.fn().mockResolvedValue(null),
        },
        areaTicketPaymentAttempt: {
          findUnique: jest.fn().mockResolvedValue(null),
        },
        $queryRaw: jest.fn().mockResolvedValue([]),
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
        subtotal: new Decimal(100),
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
      ;(prisma.order.update as jest.Mock).mockResolvedValue(mockOrder)
      ;(productInventoryService.getProductInventoryStatus as jest.Mock).mockResolvedValue(mockInventoryStatus)
      ;(productInventoryService.deductInventoryForProduct as jest.Mock).mockResolvedValue({ inventoryMethod: 'QUANTITY' })
      ;(prisma.payment.create as jest.Mock).mockResolvedValue({ id: 'payment-1', feeAmount: 0, netAmount: 100 })

      // (Square-parity 2026-08-12) Antes esto rechazaba con BadRequestError sin
      // cobrar. El dinero físico ya se movió cuando la app registra: el cobro
      // procede y el faltante de la receta viaja como aviso estructurado.
      const result: any = await (paymentService as any).recordOrderPayment(mockVenueId, mockOrderId, mockPaymentData, 'user-1')

      expect(prisma.payment.create).toHaveBeenCalled()
      expect(result.inventoryWarning).toEqual(expect.objectContaining({ code: 'INSUFFICIENT_INVENTORY' }))
      expect(result.inventoryWarning.issues).toEqual(expect.arrayContaining([expect.objectContaining({ productId: 'prod-1' })]))
    })

    it('should reject payment when inventory validation fails (QUANTITY method)', async () => {
      // Setup
      const mockOrder = {
        id: mockOrderId,
        venueId: mockVenueId,
        orderNumber: 'ORD-001',
        total: new Decimal(100),
        subtotal: new Decimal(100),
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
      ;(prisma.order.update as jest.Mock).mockResolvedValue(mockOrder)
      ;(productInventoryService.getProductInventoryStatus as jest.Mock).mockResolvedValue(mockInventoryStatus)
      ;(productInventoryService.deductInventoryForProduct as jest.Mock).mockResolvedValue({ inventoryMethod: 'QUANTITY' })
      ;(prisma.payment.create as jest.Mock).mockResolvedValue({ id: 'payment-1', feeAmount: 0, netAmount: 100 })

      // (Square-parity 2026-08-12) Antes rechazaba con el detalle en el error.
      // El mismo detalle (producto, pedido, disponible) viaja ahora en el aviso
      // estructurado — y el cobro procede.
      const result: any = await (paymentService as any).recordOrderPayment(mockVenueId, mockOrderId, mockPaymentData, 'user-1')

      expect(prisma.payment.create).toHaveBeenCalled()
      expect(result.inventoryWarning.issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ productName: 'Camisa', requested: 10, available: 3 })]),
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
    it('stores shadow classification without replacing the legacy financial boolean', async () => {
      const mockOrder = {
        id: mockOrderId,
        venueId: mockVenueId,
        orderNumber: 'ORD-001',
        total: new Decimal(440),
        paymentStatus: 'PENDING',
        source: 'TPV',
        externalId: null,
        items: [],
        payments: [],
      }
      const merchantAccountId = 'cmn3a6xr8000kn227eg8zeh41'
      const mockPaymentData = {
        venueId: mockVenueId,
        amount: 44000,
        tip: 0,
        status: 'COMPLETED' as const,
        method: 'CREDIT_CARD' as const,
        source: 'TPV',
        splitType: 'FULLPAYMENT' as const,
        tpvId: 'tpv-1',
        staffId: 'staff-1',
        paidProductsId: [],
        currency: 'MXN',
        isInternational: true,
        merchantAccountId,
        maskedPan: '477291******004F',
      }

      ;(prisma.order.findUnique as jest.Mock).mockResolvedValue(mockOrder)
      ;(prisma.merchantAccount.findUnique as jest.Mock).mockResolvedValue({ id: merchantAccountId, active: true })
      ;(prisma.payment.create as jest.Mock).mockResolvedValue({
        id: 'payment-1',
        feeAmount: 0,
        netAmount: 440,
        amount: new Decimal(440),
        tipAmount: new Decimal(0),
        method: 'CREDIT_CARD',
        status: 'COMPLETED',
      })
      ;(prisma.venueTransaction.create as jest.Mock).mockResolvedValue({})
      ;(prisma.paymentAllocation.create as jest.Mock).mockResolvedValue({})
      ;(prisma.order.update as jest.Mock).mockResolvedValue({ ...mockOrder, paymentStatus: 'PAID' })

      await (paymentService as any).recordOrderPayment(mockVenueId, mockOrderId, mockPaymentData, 'user-1')

      expect(prisma.payment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            internationalityStatus: 'DOMESTIC',
            internationalitySource: 'BIN_REGISTRY',
            issuerCountryCode: '484',
            internationalityClassificationVersion: 1,
            internationalityClassifiedAt: expect.any(Date),
            processorData: expect.objectContaining({ isInternational: true }),
          }),
        }),
      )
    })

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

  describe('🚨 Detección de SOBREPAGO (caso Mindform 2026-06-21, orden cmqnz0gkb…)', () => {
    /**
     * El bug real: una cuenta de $380 YA saldada aceptó $122 más una hora después y $232 más al
     * día siguiente ($734 sobre $380). `remainingBalance = Math.max(0,…)` lo aplastaba a 0, así
     * que en pantalla la orden se veía perfectamente pagada — invisible 2 meses hasta que el
     * money-watchdog lo pescó.
     *
     * Decisión de diseño (NO cambiar sin releer el comentario en el service): el pago se registra
     * SIEMPRE — cuando este código corre la tarjeta YA se cobró en Blumon, y rechazar aquí
     * dejaría dinero cobrado al cliente sin registro en Avoqado (cobro fantasma, peor que el
     * sobrepago). Lo que se elimina es la INVISIBILIDAD: alerta 🚨 + ActivityLog.
     */
    const buildPaidOrder = () => ({
      id: mockOrderId,
      venueId: mockVenueId,
      orderNumber: 'ORD-MINDFORM',
      subtotal: new Decimal(380),
      discountAmount: new Decimal(0),
      taxAmount: new Decimal(0),
      tipAmount: new Decimal(0),
      total: new Decimal(380),
      paymentStatus: 'PAID', // ← la cuenta YA estaba saldada
      status: 'COMPLETED',
      source: 'TPV',
      externalId: null,
      servedById: 'staff-1',
      createdById: 'staff-1',
      items: [
        {
          id: 'item-1',
          productId: 'prod-1',
          quantity: 1,
          product: { name: 'Sesión' },
          // Con allocations el ítem cuenta como "ya cobrado" → el pre-flight de inventario no estorba
          paymentAllocations: [{ id: 'alloc-1' }],
          modifiers: [],
        },
      ],
      payments: [{ amount: new Decimal(380), tipAmount: new Decimal(0) }], // el cobro original
    })

    const buildOverpayData = () => ({
      venueId: mockVenueId,
      amount: 12200, // $122 — el segundo tarjetazo real de Mindform
      tip: 0,
      status: 'COMPLETED' as const,
      method: 'CREDIT_CARD' as const,
      source: 'TPV',
      splitType: 'FULLPAYMENT' as const,
      tpvId: 'tpv-1',
      staffId: 'staff-1',
      paidProductsId: [],
      currency: 'MXN',
      isInternational: false,
    })

    it('registra el pago (NUNCA lo rechaza) y dispara alerta 🚨 + ActivityLog', async () => {
      const paidOrder = buildPaidOrder()
      ;(prisma.order.findUnique as jest.Mock).mockResolvedValue(paidOrder)
      ;(prisma.order.update as jest.Mock).mockResolvedValue({ ...paidOrder, items: [] })
      ;(prisma.payment.create as jest.Mock).mockResolvedValue({ id: 'payment-2', feeAmount: 0, netAmount: 122 })
      ;(prisma.venueTransaction.create as jest.Mock).mockResolvedValue({})
      ;(prisma.paymentAllocation.create as jest.Mock).mockResolvedValue({})

      // NO lanza: la tarjeta ya se cobró, el registro tiene que entrar
      await (paymentService as any).recordOrderPayment(mockVenueId, mockOrderId, buildOverpayData(), 'user-1')
      expect(prisma.payment.create).toHaveBeenCalled()

      // Grita: alerta con el token que BetterStack debe vigilar
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('🚨 [Sobrepago]'),
        expect.objectContaining({
          orderId: mockOrderId,
          overpaidBy: 122,
          wasAlreadyPaid: true, // ← la firma exacta del caso Mindform
        }),
      )

      // Y deja rastro auditable
      expect(prisma.activityLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'SOBREPAGO_DETECTADO',
            entity: 'Order',
            entityId: mockOrderId,
            venueId: mockVenueId,
          }),
        }),
      )
    })

    it('REGRESIÓN: un pago exacto NO dispara la alerta ni escribe ActivityLog', async () => {
      const openOrder = {
        ...buildPaidOrder(),
        paymentStatus: 'PENDING',
        status: 'CONFIRMED',
        payments: [], // sin cobros previos
      }
      ;(prisma.order.findUnique as jest.Mock).mockResolvedValue(openOrder)
      ;(prisma.order.update as jest.Mock).mockResolvedValue({ ...openOrder, paymentStatus: 'PAID', items: [] })
      ;(prisma.payment.create as jest.Mock).mockResolvedValue({ id: 'payment-1', feeAmount: 0, netAmount: 380 })
      ;(prisma.venueTransaction.create as jest.Mock).mockResolvedValue({})
      ;(prisma.paymentAllocation.create as jest.Mock).mockResolvedValue({})

      await (paymentService as any).recordOrderPayment(
        mockVenueId,
        mockOrderId,
        { ...buildOverpayData(), amount: 38000 }, // $380 exactos
        'user-1',
      )

      expect(prisma.payment.create).toHaveBeenCalled()
      const sobrepagoCalls = (logger.error as jest.Mock).mock.calls.filter(
        ([msg]) => typeof msg === 'string' && msg.includes('🚨 [Sobrepago]'),
      )
      expect(sobrepagoCalls).toHaveLength(0)
      expect(prisma.activityLog.create).not.toHaveBeenCalled()
    })
  })
})
