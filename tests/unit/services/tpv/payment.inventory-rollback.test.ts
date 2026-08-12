/**
 * Regression tests — rollback compensatorio de deducción de inventario en
 * recordOrderPayment (modo standalone).
 *
 * Bugs (auditoría FIFO 2026-06-11):
 *  1. Cuando la deducción de un item fallaba, el "rollback" regresaba la orden
 *     a PENDING pero NO restauraba el stock de los items que SÍ se dedujeron →
 *     un reintento volvía a deducirlos (doble deducción).
 *  2. Errores de deducción clasificados como UNKNOWN (p.ej. receta con unidad
 *     incompatible) se tragaban en silencio: la venta completaba sin deducir.
 *
 * Estos tests fallan con el código roto y pasan con el fix. NO_RECIPE sigue
 * siendo benigno (test 3 lo fija para evitar sobre-corrección).
 */

// El guard de ventas por sucursal (venueSalesGuard) NO es el objeto de esta suite:
// se prueba en tests/unit/services/venueSalesGuard.test.ts. Sin este mock, cada
// servicio de venta consulta venue.salesEnabled contra un prismaMock que no lo define.
jest.mock('@/services/venueSalesGuard', () => ({
  __esModule: true,
  assertVenueSalesEnabled: jest.fn(),
}))

const lockAreaTicketCheckoutMock = jest.fn()
const finalizeAreaTicketPaymentMock = jest.fn()

jest.mock('@/services/mobile/areaTicketV7.mobile.service', () => ({
  lockAreaTicketCheckoutForPayment: (...args: unknown[]) => lockAreaTicketCheckoutMock(...args),
  finalizeAreaTicketPaymentInTransaction: (...args: unknown[]) => finalizeAreaTicketPaymentMock(...args),
}))

import prisma from '@/utils/prismaClient'
import * as paymentService from '@/services/tpv/payment.tpv.service'
import * as productInventoryService from '@/services/dashboard/productInventoryIntegration.service'
import * as inventoryRestockService from '@/services/dashboard/inventoryRestock.service'
import { Decimal } from '@prisma/client/runtime/library'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    order: { findUnique: jest.fn(), update: jest.fn() },
    payment: { create: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), findMany: jest.fn() },
    venueTransaction: { create: jest.fn() },
    shift: { findFirst: jest.fn(), update: jest.fn() },
    staffVenue: { findFirst: jest.fn() },
    paymentAllocation: { create: jest.fn() },
    review: { create: jest.fn() },
    serializedItem: { updateMany: jest.fn() },
    areaTicketInventoryReservation: { findMany: jest.fn() },
    areaTicketCheckoutSession: { findFirst: jest.fn(), updateMany: jest.fn() },
    areaTicketPaymentAttempt: { findFirst: jest.fn(), updateMany: jest.fn() },
    rawMaterial: { findUnique: jest.fn() },
    orderCustomer: { findMany: jest.fn() },
    $transaction: jest.fn(),
  },
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

jest.mock('@/services/dashboard/productInventoryIntegration.service', () => ({
  getProductInventoryStatus: jest.fn(),
  deductInventoryForProduct: jest.fn(),
}))

jest.mock('@/services/dashboard/inventoryRestock.service', () => ({
  restockItem: jest.fn(),
  restockOrderItems: jest.fn(),
}))

jest.mock('@/services/dashboard/activity-log.service', () => ({
  logAction: jest.fn(),
}))

jest.mock('@/services/referrals/referralQualification.service', () => ({
  onOrderPaid: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('@/services/tpv/digitalReceipt.tpv.service', () => ({
  generateDigitalReceipt: jest.fn(),
}))

jest.mock('@/communication/sockets/managers/socketManager', () => ({
  socketManager: { broadcastToVenue: jest.fn() },
}))

jest.mock('@/services/payments/transactionCost.service', () => ({
  createTransactionCost: jest.fn(),
}))

const VENUE_ID = 'venue-123'
const ORDER_ID = 'order-123'

function makeOrder(items: any[]) {
  return {
    id: ORDER_ID,
    venueId: VENUE_ID,
    orderNumber: 'ORD-001',
    total: new Decimal(100),
    subtotal: new Decimal(100),
    discountAmount: null,
    tipAmount: new Decimal(0),
    paymentStatus: 'PENDING',
    status: 'PENDING',
    splitType: null,
    source: 'TPV', // standalone (sin externalId) → backend maneja totales y deducción
    externalId: null,
    servedById: 'staff-1',
    createdById: 'staff-1',
    customer: null,
    items,
    payments: [],
  }
}

function makeItem(id: string, productId: string, quantity: number) {
  return {
    id,
    productId,
    quantity,
    product: { name: `Producto ${productId}` },
    productName: `Producto ${productId}`,
    productSku: null,
    paymentAllocations: [],
    modifiers: [],
  }
}

const paymentData = {
  venueId: VENUE_ID,
  amount: 10000, // centavos → $100, paga la orden completa
  tip: 0,
  status: 'COMPLETED' as const,
  method: 'CASH' as const,
  source: 'TPV',
  splitType: 'FULLPAYMENT' as const,
  tpvId: 'tpv-1',
  staffId: 'staff-1',
  paidProductsId: [],
  currency: 'MXN',
  isInternational: false,
}

beforeEach(() => {
  jest.clearAllMocks()
  ;(prisma.shift.findFirst as jest.Mock).mockResolvedValue({ id: 'shift-1', status: 'OPEN' })
  ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue({ id: 'sv-1', staffId: 'staff-1', venueId: VENUE_ID })
  ;(prisma.payment.create as jest.Mock).mockResolvedValue({ id: 'payment-1', status: 'COMPLETED' })
  ;(prisma.payment.findFirst as jest.Mock).mockResolvedValue(null)
  ;(prisma.venueTransaction.create as jest.Mock).mockResolvedValue({})
  ;(prisma.paymentAllocation.create as jest.Mock).mockResolvedValue({})
  ;(prisma.serializedItem.updateMany as jest.Mock).mockResolvedValue({ count: 0 })
  ;(prisma.orderCustomer.findMany as jest.Mock).mockResolvedValue([])
  ;(prisma.areaTicketInventoryReservation.findMany as jest.Mock).mockResolvedValue([])
  ;(prisma.areaTicketCheckoutSession.findFirst as jest.Mock).mockResolvedValue(null)
  ;(prisma.areaTicketPaymentAttempt.findFirst as jest.Mock).mockResolvedValue(null)
  lockAreaTicketCheckoutMock.mockResolvedValue(null)
  finalizeAreaTicketPaymentMock.mockResolvedValue({ areaTicketOrder: false })
  ;(prisma.$transaction as jest.Mock).mockImplementation(async (callback: any) => {
    const tx = {
      payment: { create: prisma.payment.create },
      paymentAllocation: { create: prisma.paymentAllocation.create },
      venueTransaction: { create: prisma.venueTransaction.create },
      order: { update: prisma.order.update },
      shift: { update: prisma.shift.update },
      // recordOrderPayment llama lockAreaTicketCheckoutForPayment(tx, …) — area
      // tickets v7. Este `tx` se arma A MANO, así que un modelo que la ruta toque
      // y no esté aquí sale undefined y el test truena con un TypeError en lugar
      // de su aserción real. findFirst devuelve null = "esta orden no es de area
      // tickets", que es el camino que estos tests ejercitan.
      areaTicketCheckoutSession: {
        findFirst: prisma.areaTicketCheckoutSession.findFirst,
        updateMany: prisma.areaTicketCheckoutSession.updateMany,
      },
      areaTicketPaymentAttempt: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: prisma.areaTicketPaymentAttempt.findFirst,
        updateMany: prisma.areaTicketPaymentAttempt.updateMany,
      },
      $queryRaw: jest.fn().mockResolvedValue([]),
    }
    return callback(tx)
  })
  // Pre-flight pasa: el fallo ocurre EN la deducción (TOCTOU / concurrencia real)
  ;(productInventoryService.getProductInventoryStatus as jest.Mock).mockResolvedValue({
    inventoryMethod: 'QUANTITY',
    available: true,
    currentStock: 100,
  })
})

describe('recordOrderPayment — rollback compensatorio de inventario', () => {
  it('en una orden mixta descuenta sólo líneas sin reserva, incluyendo vales NONE y peso efectivo', async () => {
    const order = makeOrder([
      { ...makeItem('item-held', 'prod-held', 1), areaTicketLineId: 'line-held', weightQuantity: new Decimal('0.125') },
      { ...makeItem('item-normal', 'prod-normal', 2), areaTicketLineId: null, weightQuantity: null },
      {
        ...makeItem('item-ticket-none', 'prod-ticket-none', 1),
        areaTicketLineId: 'line-without-reservation',
        weightQuantity: new Decimal('0.375'),
      },
    ])
    ;(prisma.order.findUnique as jest.Mock).mockResolvedValue(order)
    ;(prisma.order.update as jest.Mock).mockResolvedValue(order)
    ;(prisma.areaTicketInventoryReservation.findMany as jest.Mock).mockResolvedValue([{ areaTicketLineId: 'line-held' }])
    ;(productInventoryService.deductInventoryForProduct as jest.Mock).mockResolvedValue({ inventoryMethod: 'QUANTITY' })

    await paymentService.recordOrderPayment(VENUE_ID, ORDER_ID, { ...paymentData, idempotencyKey: 'mixed-area-payment' } as any, 'user-1')

    expect(productInventoryService.deductInventoryForProduct).toHaveBeenCalledTimes(2)
    expect(productInventoryService.deductInventoryForProduct).toHaveBeenCalledWith(VENUE_ID, 'prod-normal', 2, ORDER_ID, 'staff-1', [])
    expect(productInventoryService.deductInventoryForProduct).toHaveBeenCalledWith(
      VENUE_ID,
      'prod-ticket-none',
      0.375,
      ORDER_ID,
      'staff-1',
      [],
    )
    expect(productInventoryService.deductInventoryForProduct).not.toHaveBeenCalledWith(
      VENUE_ID,
      'prod-held',
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    )
  })

  it('rechaza el pago si un modificador inventariable no tiene stock aunque el producto base no rastree inventario', async () => {
    const modifier = {
      quantity: 1,
      modifier: {
        id: 'modifier-cheese',
        name: 'Queso extra',
        groupId: 'group-1',
        rawMaterialId: 'raw-cheese',
        quantityPerUnit: new Decimal('0.200'),
        unit: 'KILOGRAM',
        inventoryMode: 'ADDITION',
      },
    }
    const order = makeOrder([{ ...makeItem('item-untracked', 'prod-untracked', 1), modifiers: [modifier] }])
    ;(prisma.order.findUnique as jest.Mock).mockResolvedValue(order)
    ;(productInventoryService.getProductInventoryStatus as jest.Mock).mockResolvedValue({
      inventoryMethod: null,
      available: true,
    })
    ;(prisma.rawMaterial.findUnique as jest.Mock).mockResolvedValue({
      id: 'raw-cheese',
      name: 'Queso',
      currentStock: new Decimal('0.100'),
      unit: 'KILOGRAM',
    })

    await expect(paymentService.recordOrderPayment(VENUE_ID, ORDER_ID, paymentData as any, 'user-1')).rejects.toThrow(
      /insufficient inventory/i,
    )
    expect(prisma.payment.create).not.toHaveBeenCalled()
  })

  it('al fallar la deducción de un item, restaura el stock de los items YA deducidos antes de regresar la orden a PENDING', async () => {
    const order = makeOrder([makeItem('item-1', 'prod-1', 2), makeItem('item-2', 'prod-2', 3)])
    ;(prisma.order.findUnique as jest.Mock).mockResolvedValue(order)
    ;(prisma.order.update as jest.Mock).mockResolvedValue(order)
    // prod-1 se deduce OK; prod-2 falla por stock insuficiente
    ;(productInventoryService.deductInventoryForProduct as jest.Mock)
      .mockResolvedValueOnce({ inventoryMethod: 'QUANTITY' })
      .mockRejectedValueOnce(new Error('Insufficient stock. Needed: 3, Available: 1'))

    // 🔴 Antes esto era `.rejects.toThrow(BadRequestError)`. Esa aserción codificaba el
    // bug: cuando la deducción falla, el Payment YA está comiteado, así que fallar el
    // cobro no des-cobra nada — sólo hace que el cajero vuelva a pasar la tarjeta
    // (doble cobro). El propósito del test —que la compensación ocurra— NO cambió.
    const result: any = await paymentService.recordOrderPayment(VENUE_ID, ORDER_ID, paymentData as any, 'user-1')
    expect(result.inventoryWarning).toEqual(expect.objectContaining({ code: 'INVENTORY_NOT_DEDUCTED', inventoryDeducted: false }))

    // La deducción exitosa de prod-1 se revierte (antes: quedaba deducida para siempre)
    expect(inventoryRestockService.restockItem).toHaveBeenCalledWith(
      expect.objectContaining({ venueId: VENUE_ID, productId: 'prod-1', quantity: 2 }),
    )
    // prod-2 nunca se dedujo — no se restaura
    expect(inventoryRestockService.restockItem).not.toHaveBeenCalledWith(expect.objectContaining({ productId: 'prod-2' }))

    // Y la orden regresa a PENDING
    expect(prisma.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: ORDER_ID },
        data: expect.objectContaining({ status: 'PENDING' }),
      }),
    )
  })

  it('un error UNKNOWN (p.ej. unidades incompatibles en la receta) es crítico: se reporta al cajero y revierte la orden, en vez de tragarse en silencio', async () => {
    const order = makeOrder([makeItem('item-1', 'prod-1', 2)])
    ;(prisma.order.findUnique as jest.Mock).mockResolvedValue(order)
    ;(prisma.order.update as jest.Mock).mockResolvedValue(order)
    ;(productInventoryService.deductInventoryForProduct as jest.Mock).mockRejectedValueOnce(
      new Error('Recipe/modifier unit KILOGRAM is incompatible with raw material "Harina" stored in GRAM'),
    )

    // 🔴 Antes: `.rejects.toThrow(BadRequestError)`. El propósito del test es que un
    // UNKNOWN no se TRAGUE en silencio, y eso se sigue cumpliendo — ahora se reporta
    // como aviso estructurado con el motivo verbatim en vez de como cobro fallido.
    const result: any = await paymentService.recordOrderPayment(VENUE_ID, ORDER_ID, paymentData as any, 'user-1')
    expect(result.inventoryWarning.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ productId: 'prod-1', reason: expect.stringContaining('incompatible') })]),
    )

    // Nada se dedujo → nada que restaurar, pero la orden sí se revierte
    expect(inventoryRestockService.restockItem).not.toHaveBeenCalled()
    expect(prisma.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: ORDER_ID },
        data: expect.objectContaining({ status: 'PENDING' }),
      }),
    )
  })

  it('NO_RECIPE sigue siendo benigno: el pago completa aunque un producto no tenga receta', async () => {
    const order = makeOrder([makeItem('item-1', 'prod-1', 2)])
    ;(prisma.order.findUnique as jest.Mock).mockResolvedValue(order)
    ;(prisma.order.update as jest.Mock).mockResolvedValue(order)
    ;(productInventoryService.deductInventoryForProduct as jest.Mock).mockRejectedValueOnce(
      new Error('Product prod-1 does not have a recipe'),
    )

    await expect(paymentService.recordOrderPayment(VENUE_ID, ORDER_ID, paymentData as any, 'user-1')).resolves.toBeDefined()

    expect(inventoryRestockService.restockItem).not.toHaveBeenCalled()
    // No hubo rollback a PENDING
    const rollbackCalls = (prisma.order.update as jest.Mock).mock.calls.filter((c: any[]) => c[0]?.data?.status === 'PENDING')
    expect(rollbackCalls).toHaveLength(0)
  })
})

describe('recordOrderPayment — consistencia post-captura de vales por área', () => {
  function areaOrder() {
    return {
      ...makeOrder([
        { ...makeItem('item-held', 'prod-held', 1), areaTicketLineId: 'line-held' },
        { ...makeItem('item-normal', 'prod-normal', 1), areaTicketLineId: null },
      ]),
      serviceChargeAmount: new Decimal(0),
    }
  }

  it('conserva el Payment capturado y congela el mismo intento si la finalización atómica falla', async () => {
    const order = areaOrder()
    ;(prisma.order.findUnique as jest.Mock).mockImplementation(async (args: any) => {
      if (args.select?.paymentStatus) return { paymentStatus: 'PAID' }
      return order
    })
    ;(prisma.order.update as jest.Mock).mockResolvedValue({ ...order, paymentStatus: 'PAID', status: 'COMPLETED' })
    ;(prisma.areaTicketInventoryReservation.findMany as jest.Mock).mockResolvedValue([
      {
        areaTicketLineId: 'line-held',
      },
    ])
    lockAreaTicketCheckoutMock.mockResolvedValue({ sessionId: 'session-1', attemptId: 'attempt-1' })
    finalizeAreaTicketPaymentMock.mockRejectedValue(new Error('reserved capacity changed'))
    ;(productInventoryService.deductInventoryForProduct as jest.Mock).mockResolvedValue({ inventoryMethod: 'QUANTITY' })

    const result = await paymentService.recordOrderPayment(
      VENUE_ID,
      ORDER_ID,
      { ...paymentData, idempotencyKey: 'area-capture-1' } as any,
      'user-1',
    )

    expect(result).toMatchObject({ id: 'payment-1', areaTicketCheckoutState: 'RECONCILIATION_REQUIRED' })
    expect(prisma.payment.create).toHaveBeenCalledTimes(1)
    expect(productInventoryService.deductInventoryForProduct).not.toHaveBeenCalled()
    expect(prisma.order.update).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'PENDING' }) }))
    expect(prisma.areaTicketPaymentAttempt.updateMany).toHaveBeenCalledWith({
      where: { id: 'attempt-1', checkoutSessionId: 'session-1' },
      data: expect.objectContaining({
        status: 'UNKNOWN',
        paymentId: 'payment-1',
      }),
    })
    expect(prisma.areaTicketCheckoutSession.updateMany).toHaveBeenCalledWith({
      where: { id: 'session-1', venueId: VENUE_ID },
      data: expect.objectContaining({
        status: 'RECONCILIATION_REQUIRED',
        activePaymentAttemptId: 'attempt-1',
      }),
    })
  })

  it('reanuda el mismo intento por idempotencyKey sin crear un segundo cobro', async () => {
    const existingPayment = {
      id: 'payment-captured',
      venueId: VENUE_ID,
      orderId: ORDER_ID,
      amount: new Decimal(100),
      tipAmount: new Decimal(0),
      status: 'COMPLETED',
      receipts: [],
    }
    ;(prisma.payment.findUnique as jest.Mock).mockResolvedValue(existingPayment)
    ;(prisma.areaTicketCheckoutSession.findFirst as jest.Mock).mockResolvedValue({
      id: 'session-1',
      venueId: VENUE_ID,
      orderId: ORDER_ID,
      status: 'RECONCILIATION_REQUIRED',
      activePaymentAttemptId: 'attempt-1',
    })
    ;(prisma.areaTicketPaymentAttempt.findFirst as jest.Mock).mockResolvedValue({
      id: 'attempt-1',
      checkoutSessionId: 'session-1',
      orderId: ORDER_ID,
      idempotencyKey: 'area-capture-retry',
      paymentId: 'payment-captured',
      status: 'UNKNOWN',
    })
    finalizeAreaTicketPaymentMock.mockResolvedValue({
      areaTicketOrder: true,
      sessionId: 'session-1',
      fullyPaid: true,
    })

    const result = await paymentService.recordOrderPayment(
      VENUE_ID,
      ORDER_ID,
      { ...paymentData, idempotencyKey: 'area-capture-retry' } as any,
      'user-1',
    )

    expect(result).toMatchObject({ id: 'payment-captured', areaTicketCheckoutState: 'PAID' })
    expect(prisma.payment.create).not.toHaveBeenCalled()
    expect(lockAreaTicketCheckoutMock).not.toHaveBeenCalled()
    expect(finalizeAreaTicketPaymentMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        venueId: VENUE_ID,
        orderId: ORDER_ID,
        paymentId: 'payment-captured',
        locked: { sessionId: 'session-1', attemptId: 'attempt-1' },
      }),
    )
  })

  it('un reintento PROCESSING no concilia ni finaliza el vale antes de que el dinero esté capturado', async () => {
    const processingPayment = {
      id: 'payment-processing',
      venueId: VENUE_ID,
      orderId: ORDER_ID,
      amount: new Decimal(100),
      tipAmount: new Decimal(0),
      status: 'PROCESSING',
      receipts: [],
    }
    ;(prisma.payment.findUnique as jest.Mock).mockResolvedValue(processingPayment)
    ;(prisma.areaTicketCheckoutSession.findFirst as jest.Mock).mockResolvedValue({
      id: 'session-1',
      venueId: VENUE_ID,
      orderId: ORDER_ID,
      status: 'PAYMENT_PENDING',
      activePaymentAttemptId: 'attempt-1',
    })
    ;(prisma.areaTicketPaymentAttempt.findFirst as jest.Mock).mockResolvedValue({
      id: 'attempt-1',
      checkoutSessionId: 'session-1',
      orderId: ORDER_ID,
      idempotencyKey: 'area-processing-retry',
      paymentId: null,
      status: 'PREPARED',
    })
    finalizeAreaTicketPaymentMock.mockResolvedValue({
      areaTicketOrder: true,
      sessionId: 'session-1',
      fullyPaid: false,
    })

    const result = await paymentService.recordOrderPayment(
      VENUE_ID,
      ORDER_ID,
      { ...paymentData, status: 'PROCESSING', idempotencyKey: 'area-processing-retry' } as any,
      'user-1',
    )

    expect(result).toMatchObject({ id: 'payment-processing', status: 'PROCESSING' })
    expect(prisma.areaTicketCheckoutSession.findFirst).not.toHaveBeenCalled()
    expect(prisma.areaTicketPaymentAttempt.findFirst).not.toHaveBeenCalled()
    expect(finalizeAreaTicketPaymentMock).not.toHaveBeenCalled()
  })
})
