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

// El posting durable (fase 2/3.5) nace dentro de la tx del cobro. Esta suite no
// lo prueba — su atomicidad vive en payment.posting-atomicity.test.ts — así que
// se mockea para no tener que declarar el modelo en cada tx mock de aquí.
jest.mock('@/services/inventory/inventoryPosting.service', () => ({
  __esModule: true,
  createSalePostingInTx: jest.fn().mockResolvedValue({ id: 'posting-test', status: 'PENDING' }),
  applySalePosting: jest.fn(),
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
      // `settleStandalonePaymentInTx` relee la orden con su snapshot de artículos
      // (`payment.tpv.service.ts:522`). Sin esta entrada el TypeError sustituye a la aserción.
      // Devuelve una orden MÍNIMA y coherente: este test mide la clasificación en la sombra,
      // no la liquidación — pero la ruta la atraviesa y sin datos muere antes de su aserción.
      findFirstOrThrow: jest
        .fn()
        .mockResolvedValue({ id: 'order-123', venueId: 'venue-1', subtotal: 0, total: 0, discountAmount: 0, tipAmount: 0, items: [] }),
      findUniqueOrThrow: jest
        .fn()
        .mockResolvedValue({ id: 'order-123', venueId: 'venue-1', subtotal: 0, total: 0, discountAmount: 0, tipAmount: 0, items: [] }),
      update: jest.fn(),
    },
    payment: {
      create: jest.fn(),
      // El outbox relee el Payment fuente para comprobar que la orden coincide antes de encolar
      // (`paymentEffects.service.ts:22-27`); sin esto lanza PAYMENT_EFFECT_SOURCE_MISMATCH y
      // tumba la transacción del cobro entera.
      findFirst: jest.fn().mockResolvedValue({ orderId: 'order-123' }),
      // El camino post-cobro agrega los pagos de la orden y relee el Payment recién creado
      // (outbox de efectos y conciliación). Enumerar métodos uno a uno es la fragilidad que
      // este archivo ya documenta más abajo; se completan los que la ruta toca hoy.
      aggregate: jest.fn().mockResolvedValue({ _sum: { amount: null, tipAmount: null } }),
      findUniqueOrThrow: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    paymentEffect: {
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    commissionCalculation: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
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
      updateMany: jest.fn(),
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
    inventoryPosting: { findUnique: jest.fn(), create: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    inventoryPostingLine: { findMany: jest.fn().mockResolvedValue([]), update: jest.fn() },
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

// El módulo REAL con un solo reemplazo (no una lista fija de exports): el registrador también usa `tarifaCongeladaDeLaAfiliacion`
// y `tarifaConCapturaFallida` (Codex R10-1) — con la lista fija, la captura de la tarifa fallaba por `undefined` y el cobro
// «se registraba» con un snapshot que nunca existiría en producción (memoria: mock de módulo con lista fija).
jest.mock('@/services/payments/transactionCost.service', () => ({
  ...jest.requireActual('@/services/payments/transactionCost.service'),
  createTransactionCost: jest.fn(),
}))

describe('Payment TPV Service - Pre-Flight Validation', () => {
  const mockVenueId = 'venue-123'
  const mockOrderId = 'order-123'

  beforeEach(() => {
    jest.clearAllMocks()

    // Setup common mocks that all tests need
    ;(prisma.shift.findFirst as jest.Mock).mockResolvedValue({ id: 'shift-1', status: 'OPEN' })
    ;(prisma.shift.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
    ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue({ staffId: 'staff-1', venueId: mockVenueId })

    // Mock $transaction to execute the callback with a tx object
    ;(prisma.$transaction as jest.Mock).mockImplementation(async callback => {
      const tx = {
        // 🔑 Base heredada del mock global: los modelos que la ruta del cobro toca y este `tx`
        // no enumera (paymentEffect del outbox, order.findFirstOrThrow…) dejan de reventar con
        // un TypeError críptico en vez de su aserción real. Los overrides de abajo mandan.
        ...(prisma as any),
        // `findMany`: el candado del toque repetido en efectivo (`cobroEnEfectivoDuplicado.ts`)
        // relee los cobros COMPLETED de la orden DENTRO de la tx. Devuelve `[]` para quedar
        // COHERENTE con el `count: 0` de arriba —los dos contestan la misma pregunta— y así el
        // candado queda inerte en esta suite, que no es su objeto: se prueba en
        // `payment.cash-duplicado.test.ts` y en la integración `cobro-efectivo-duplicado`.
        payment: {
          ...(prisma as any).payment,
          // El rescate de la comisión relee el pago recién creado (bajo SAVEPOINT).
          findUniqueOrThrow: jest.fn().mockImplementation(async () => {
            const crear = (prisma as any).payment.create as jest.Mock
            const ultimo = crear.mock.results[crear.mock.results.length - 1]
            return ultimo ? await ultimo.value : null
          }),
          count: jest.fn().mockResolvedValue(0),
          create: prisma.payment.create,
          findMany: jest.fn().mockResolvedValue([]),
        },
        paymentAllocation: {
          create: prisma.paymentAllocation.create,
        },
        venueTransaction: {
          create: prisma.venueTransaction.create,
        },
        order: {
          ...(prisma as any).order,
          update: prisma.order.update,
        },
        shift: {
          findFirst: prisma.shift.findFirst,
          updateMany: prisma.shift.updateMany,
          update: prisma.shift.update,
        },
        activityLog: { create: prisma.activityLog.create },
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
        $queryRaw: jest.fn().mockResolvedValue([{ id: mockOrderId }]),
        // La comisión del cobro se encola bajo un SAVEPOINT para que su fallo NO tumbe el dinero.
        $executeRawUnsafe: jest.fn().mockResolvedValue(0),
        paymentEffect: {
          createMany: jest.fn().mockResolvedValue({ count: 1 }),
          findMany: jest.fn().mockResolvedValue([]),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        commissionCalculation: {
          findMany: jest.fn().mockResolvedValue([]),
          create: jest.fn(),
          aggregate: jest.fn().mockResolvedValue({ _sum: { baseAmount: null, tipAmount: null } }),
        },
      }
      return callback(tx)
    })
  })

  describe('recordOrderPayment - Priority 1C', () => {
    it('validates inventory ONCE, after the payment is committed (the pre-transaction pre-flight was removed 2026-08-25)', async () => {
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
      ;(prisma.payment.create as jest.Mock).mockResolvedValue({
        venueId: mockVenueId,
        orderId: mockOrderId,
        id: 'payment-1',
        feeAmount: 0,
        netAmount: 100,
      })
      ;(prisma.venueTransaction.create as jest.Mock).mockResolvedValue({})
      ;(prisma.paymentAllocation.create as jest.Mock).mockResolvedValue({})
      ;(productInventoryService.deductInventoryForProduct as jest.Mock).mockResolvedValue({})

      // Execute
      await (paymentService as any).recordOrderPayment(mockVenueId, mockOrderId, mockPaymentData, 'user-1')

      // Verify - the post-commit check consulted inventory for the product, exactly once
      // (before 2026-08-25 this ran twice: a pre-transaction pre-flight that only logged + this one)
      expect(productInventoryService.getProductInventoryStatus).toHaveBeenCalledWith(mockVenueId, 'prod-1')
      expect(productInventoryService.getProductInventoryStatus).toHaveBeenCalledTimes(1)
      // And the payment was committed BEFORE inventory was consulted
      const paymentCreateOrder = (prisma.payment.create as jest.Mock).mock.invocationCallOrder[0]
      const inventoryCheckOrder = (productInventoryService.getProductInventoryStatus as jest.Mock).mock.invocationCallOrder[0]
      expect(paymentCreateOrder).toBeLessThan(inventoryCheckOrder)
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
      ;(prisma.payment.create as jest.Mock).mockResolvedValue({
        venueId: mockVenueId,
        orderId: mockOrderId,
        id: 'payment-1',
        feeAmount: 0,
        netAmount: 100,
      })

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
      ;(prisma.payment.create as jest.Mock).mockResolvedValue({
        venueId: mockVenueId,
        orderId: mockOrderId,
        id: 'payment-1',
        feeAmount: 0,
        netAmount: 100,
      })

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
      ;(prisma.payment.create as jest.Mock).mockResolvedValue({
        venueId: mockVenueId,
        orderId: mockOrderId,
        id: 'payment-1',
        feeAmount: 0,
        netAmount: 100,
      })
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
      ;(prisma.payment.create as jest.Mock).mockResolvedValue({
        venueId: mockVenueId,
        orderId: mockOrderId,
        id: 'payment-1',
        feeAmount: 0,
        netAmount: 50,
      })
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
        // Un Payment REAL trae venue y orden: el outbox los usa para comprobar que el efecto
        // pertenece a la MISMA cuenta que el cobro.
        venueId: mockVenueId,
        orderId: mockOrderId,
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
      ;(prisma.payment.create as jest.Mock).mockResolvedValue({ venueId: mockVenueId, orderId: mockOrderId, id: 'payment-1' })
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

    /**
     * 🔴 CONTRATO DE LOS APK YA PUBLICADOS — no es un test de campos, es de VALORES.
     *
     * `PaymentResponse.kt` del TPV declara NO NULABLES en Kotlin: `data.id`, `data.amount` y
     * `data.tipAmount`. Si el servidor deja de enviarlos, o los envía `null`,
     * kotlinx.serialization LANZA al deserializar y el cobro se pierde en un aparato que YA está
     * en la calle y que no se puede actualizar en el momento — el cajero volvería a pasar la
     * tarjeta. `digitalReceipt` sí es nulable, pero cuando viaja, sus tres campos (`id`,
     * `accessKey`, `receiptUrl`) son obligatorios DENTRO del objeto.
     *
     * Que los nombres sigan existiendo en el código NO demuestra compatibilidad: esto ejercita
     * el servicio y comprueba lo que de verdad sale en `data`, que es lo que el APK parsea.
     */
    it('🔴 CONTRATO APK: el resultado del cobro trae con VALOR los campos no nulables que parsea el TPV', async () => {
      const mockOrder = {
        id: mockOrderId,
        venueId: mockVenueId,
        orderNumber: 'ORD-CONTRATO',
        total: new Decimal(100),
        subtotal: new Decimal(100),
        discountAmount: new Decimal(0),
        tipAmount: new Decimal(0),
        paymentStatus: 'PENDING',
        source: 'TPV',
        items: [],
        payments: [],
      }
      ;(prisma.order.findUnique as jest.Mock).mockResolvedValue(mockOrder)
      ;(prisma.order.update as jest.Mock).mockResolvedValue({ ...mockOrder, paymentStatus: 'PAID' })
      ;(productInventoryService.getProductInventoryStatus as jest.Mock).mockResolvedValue({
        inventoryMethod: 'RECIPE' as const,
        available: true,
        maxPortions: 5,
      })
      ;(prisma.payment.create as jest.Mock).mockResolvedValue({
        venueId: mockVenueId,
        orderId: mockOrderId,
        id: 'payment-contrato',
        amount: new Decimal(100),
        tipAmount: new Decimal(0),
        status: 'COMPLETED',
      })
      ;(prisma.venueTransaction.create as jest.Mock).mockResolvedValue({})
      ;(prisma.paymentAllocation.create as jest.Mock).mockResolvedValue({})

      const result: any = await (paymentService as any).recordOrderPayment(
        mockVenueId,
        mockOrderId,
        {
          amount: 10000,
          tipAmount: 0,
          method: 'CREDIT_CARD',
          staffId: 'staff-1',
          paidProductsId: [],
          currency: 'MXN',
          isInternational: false,
        },
        'user-1',
      )

      // `data` del 201 es exactamente este objeto (payment.tpv.controller.ts:115-118).
      expect(result).toBeDefined()
      // NO NULABLES en el DTO Kotlin: si alguno llega null/undefined, el APK publicado revienta.
      expect(typeof result.id).toBe('string')
      expect(result.id.length).toBeGreaterThan(0)
      expect(result.amount).not.toBeNull()
      expect(result.amount).not.toBeUndefined()
      expect(result.tipAmount).not.toBeNull()
      expect(result.tipAmount).not.toBeUndefined()
      // El recibo es opcional; si viaja, sus tres campos son obligatorios DENTRO del objeto.
      if (result.digitalReceipt != null) {
        expect(typeof result.digitalReceipt.id).toBe('string')
        expect(typeof result.digitalReceipt.accessKey).toBe('string')
        expect(typeof result.digitalReceipt.receiptUrl).toBe('string')
      }
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
      ;(prisma.payment.create as jest.Mock).mockResolvedValue({
        venueId: mockVenueId,
        orderId: mockOrderId,
        id: 'payment-1',
        feeAmount: 0,
        netAmount: 100,
      })
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
      ;(prisma.payment.create as jest.Mock).mockResolvedValue({
        venueId: mockVenueId,
        orderId: mockOrderId,
        id: 'payment-2',
        feeAmount: 0,
        netAmount: 122,
      })
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
      ;(prisma.payment.create as jest.Mock).mockResolvedValue({
        venueId: mockVenueId,
        orderId: mockOrderId,
        id: 'payment-1',
        feeAmount: 0,
        netAmount: 380,
      })
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
