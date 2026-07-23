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

import prisma from '@/utils/prismaClient'
import * as paymentService from '@/services/tpv/payment.tpv.service'
import * as productInventoryService from '@/services/dashboard/productInventoryIntegration.service'
import * as inventoryRestockService from '@/services/dashboard/inventoryRestock.service'
import { BadRequestError } from '@/errors/AppError'
import { Decimal } from '@prisma/client/runtime/library'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    order: { findUnique: jest.fn(), update: jest.fn() },
    payment: { create: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn() },
    venueTransaction: { create: jest.fn() },
    shift: { findFirst: jest.fn(), update: jest.fn() },
    staffVenue: { findFirst: jest.fn() },
    paymentAllocation: { create: jest.fn() },
    review: { create: jest.fn() },
    serializedItem: { updateMany: jest.fn() },
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
  ;(prisma.$transaction as jest.Mock).mockImplementation(async (callback: any) => {
    const tx = {
      payment: { create: prisma.payment.create },
      paymentAllocation: { create: prisma.paymentAllocation.create },
      venueTransaction: { create: prisma.venueTransaction.create },
      order: { update: prisma.order.update },
      shift: { update: prisma.shift.update },
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
  it('al fallar la deducción de un item, restaura el stock de los items YA deducidos antes de regresar la orden a PENDING', async () => {
    const order = makeOrder([makeItem('item-1', 'prod-1', 2), makeItem('item-2', 'prod-2', 3)])
    ;(prisma.order.findUnique as jest.Mock).mockResolvedValue(order)
    ;(prisma.order.update as jest.Mock).mockResolvedValue(order)
    // prod-1 se deduce OK; prod-2 falla por stock insuficiente
    ;(productInventoryService.deductInventoryForProduct as jest.Mock)
      .mockResolvedValueOnce({ inventoryMethod: 'QUANTITY' })
      .mockRejectedValueOnce(new Error('Insufficient stock. Needed: 3, Available: 1'))

    await expect(paymentService.recordOrderPayment(VENUE_ID, ORDER_ID, paymentData as any, 'user-1')).rejects.toThrow(BadRequestError)

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

  it('un error UNKNOWN (p.ej. unidades incompatibles en la receta) es crítico: falla el pago en vez de tragarse en silencio', async () => {
    const order = makeOrder([makeItem('item-1', 'prod-1', 2)])
    ;(prisma.order.findUnique as jest.Mock).mockResolvedValue(order)
    ;(prisma.order.update as jest.Mock).mockResolvedValue(order)
    ;(productInventoryService.deductInventoryForProduct as jest.Mock).mockRejectedValueOnce(
      new Error('Recipe/modifier unit KILOGRAM is incompatible with raw material "Harina" stored in GRAM'),
    )

    await expect(paymentService.recordOrderPayment(VENUE_ID, ORDER_ID, paymentData as any, 'user-1')).rejects.toThrow(BadRequestError)

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
