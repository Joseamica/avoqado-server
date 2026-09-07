/**
 * 🔴 DINERO — El toque repetido en «Efectivo» sobre una orden que YA quedó cubierta.
 *
 * SN00396 (BAE MEZQUITAL, 2026-09-04): la pantalla de la PAX se congela esperando el turno
 * por red, el cajero toca «Efectivo» cinco veces, las cinco corrutinas pasan el guard de
 * estado y al resolver registran CINCO cobros COMPLETED de $0 en 1.7 s. Cada uno llegó con
 * una `referenceNumber` `CASH-<ms>` distinta (se acuña por toque) y con `idempotencyKey`
 * VACÍA, así que ninguna de las dos defensas existentes lo vio.
 *
 * La guarda nueva mira el ESTADO de la orden, no las credenciales del cobro, y vive DENTRO
 * de la transacción — después del `FOR UPDATE` que serializa la ráfaga y antes de reclamar
 * el turno, que ya suma dinero. Responde con el cobro EXISTENTE (200), nunca con un 4xx:
 * un rechazo delante del cliente empuja al cajero a volver a cobrar.
 *
 * La serialización real (dos transacciones concurrentes contra Postgres) se prueba en
 * `tests/integration/tpv/cobro-efectivo-duplicado.integration.test.ts`; un mock no bloquea.
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

const lockAreaTicketCheckoutMock = jest.fn()
const finalizeAreaTicketPaymentMock = jest.fn()

jest.mock('@/services/mobile/areaTicketV7.mobile.service', () => ({
  lockAreaTicketCheckoutForPayment: (...args: unknown[]) => lockAreaTicketCheckoutMock(...args),
  finalizeAreaTicketPaymentInTransaction: (...args: unknown[]) => finalizeAreaTicketPaymentMock(...args),
}))

import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import * as paymentService from '@/services/tpv/payment.tpv.service'
import * as productInventoryService from '@/services/dashboard/productInventoryIntegration.service'
import { Decimal } from '@prisma/client/runtime/library'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    order: { findUnique: jest.fn(), update: jest.fn() },
    payment: { create: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), findMany: jest.fn() },
    venueTransaction: { create: jest.fn() },
    shift: { findFirst: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    staffVenue: { findFirst: jest.fn() },
    paymentAllocation: { create: jest.fn() },
    review: { create: jest.fn() },
    serializedItem: { updateMany: jest.fn() },
    areaTicketInventoryReservation: { findMany: jest.fn() },
    areaTicketCheckoutSession: { findFirst: jest.fn(), updateMany: jest.fn() },
    areaTicketPaymentAttempt: { findFirst: jest.fn(), updateMany: jest.fn() },
    rawMaterial: { findUnique: jest.fn() },
    orderCustomer: { findMany: jest.fn() },
    activityLog: { create: jest.fn().mockResolvedValue({}) },
    inventoryPosting: { findUnique: jest.fn(), create: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    inventoryPostingLine: { findMany: jest.fn().mockResolvedValue([]), update: jest.fn() },
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

const logActionMock = jest.fn()
jest.mock('@/services/dashboard/activity-log.service', () => ({
  logAction: (...args: unknown[]) => logActionMock(...args),
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

// La lealtad (puntos + sellos) al quedar pagada es UNA regla compartida con el cobro en
// efectivo de Android/iOS. Aquí sólo se fija que este camino la invoque.
jest.mock('@/services/shared/loyaltyOnPaidOrder', () => ({
  awardLoyaltyForPaidOrder: jest.fn().mockResolvedValue(undefined),
}))

const VENUE_ID = 'venue-123'
const ORDER_ID = 'order-123'

/** Orden estándar: $100 de subtotal, un solo producto, modo standalone (externalId null). */
function makeOrder(overrides: Record<string, unknown> = {}) {
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
    source: 'TPV',
    externalId: null,
    servedById: 'staff-1',
    createdById: 'staff-1',
    customer: null,
    items: [
      {
        id: 'item-1',
        productId: 'prod-1',
        quantity: 5,
        product: { name: 'Hamburguesa' },
        productName: 'Hamburguesa',
        productSku: null,
        paymentAllocations: [],
        modifiers: [],
        areaTicketLineId: null,
        weightQuantity: null,
      },
    ],
    payments: [],
    ...overrides,
  }
}

/** Pago con TARJETA por el total: es el escenario del doble cobro real. */
const paymentData = {
  venueId: VENUE_ID,
  amount: 10000, // centavos → $100, salda la cuenta completa
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
}

const STOCK_OK = { inventoryMethod: 'QUANTITY' as const, available: true, currentStock: 100 }

beforeEach(() => {
  jest.clearAllMocks()
  logActionMock.mockReset()
  ;(prisma.shift.findFirst as jest.Mock).mockResolvedValue({ id: 'shift-1', status: 'OPEN' })
  ;(prisma.shift.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
  ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue({ id: 'sv-1', staffId: 'staff-1', venueId: VENUE_ID })
  ;(prisma.payment.create as jest.Mock).mockResolvedValue({ id: 'payment-1', status: 'COMPLETED', feeAmount: 0, netAmount: 100 })
  ;(prisma.payment.findFirst as jest.Mock).mockResolvedValue(null)
  ;(prisma.venueTransaction.create as jest.Mock).mockResolvedValue({})
  ;(prisma.paymentAllocation.create as jest.Mock).mockResolvedValue({})
  ;(prisma.serializedItem.updateMany as jest.Mock).mockResolvedValue({ count: 0 })
  ;(prisma.orderCustomer.findMany as jest.Mock).mockResolvedValue([])
  ;(prisma.areaTicketInventoryReservation.findMany as jest.Mock).mockResolvedValue([])
  ;(prisma.areaTicketCheckoutSession.findFirst as jest.Mock).mockResolvedValue(null)
  ;(prisma.areaTicketPaymentAttempt.findFirst as jest.Mock).mockResolvedValue(null)
  ;(prisma.activityLog.create as jest.Mock).mockResolvedValue({})
  lockAreaTicketCheckoutMock.mockResolvedValue(null)
  finalizeAreaTicketPaymentMock.mockResolvedValue({ areaTicketOrder: false })
  ;(productInventoryService.deductInventoryForProduct as jest.Mock).mockResolvedValue({ inventoryMethod: 'QUANTITY' })
  ;(prisma.$transaction as jest.Mock).mockImplementation(async (callback: any) => {
    const tx = {
      payment: { count: jest.fn().mockResolvedValue(0), create: prisma.payment.create, findMany: prisma.payment.findMany },
      paymentAllocation: { create: prisma.paymentAllocation.create },
      venueTransaction: { create: prisma.venueTransaction.create },
      order: { update: prisma.order.update },
      shift: { findFirst: prisma.shift.findFirst, updateMany: prisma.shift.updateMany, update: prisma.shift.update },
      activityLog: { create: prisma.activityLog.create },
      areaTicketCheckoutSession: {
        findFirst: prisma.areaTicketCheckoutSession.findFirst,
        updateMany: prisma.areaTicketCheckoutSession.updateMany,
      },
      areaTicketPaymentAttempt: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: prisma.areaTicketPaymentAttempt.findFirst,
        updateMany: prisma.areaTicketPaymentAttempt.updateMany,
      },
      $queryRaw: jest.fn().mockResolvedValue([{ id: ORDER_ID }]),
    }
    return callback(tx)
  })
})

/** El cobro exacto de la evidencia: efectivo de $0, SIN llave de idempotencia. */
const COBRO_CASH_CERO = {
  venueId: VENUE_ID,
  amount: 0,
  tip: 0,
  status: 'COMPLETED' as const,
  method: 'CASH' as const,
  source: 'TPV',
  splitType: 'FULLPAYMENT' as const,
  staffId: 'staff-1',
  paidProductsId: [],
  currency: 'MXN',
  isInternational: false,
  referenceNumber: 'CASH-1788481077703',
  authorizationNumber: 'EFECTIVO',
  // sin idempotencyKey a propósito: es la forma exacta de la evidencia de producción
}

function huboAvisoDeDuplicado() {
  return (logger.warn as jest.Mock).mock.calls.some(([msg]) =>
    String(msg).includes('[recordOrderPayment] Cobro en EFECTIVO sobre una orden ya saldada'),
  )
}

describe('recordOrderPayment — toque repetido en Efectivo sobre una orden ya saldada', () => {
  it('devuelve el cobro existente y NO crea otro (orden de $0 con un cobro previo)', async () => {
    const order = makeOrder({ total: new Decimal(0), subtotal: new Decimal(0) })
    ;(prisma.order.findUnique as jest.Mock).mockResolvedValue(order)
    ;(prisma.payment.findFirst as jest.Mock).mockResolvedValue(null) // no hay match por referencia
    ;(prisma.payment.findMany as jest.Mock).mockResolvedValue([
      { id: 'pay-prev', amount: new Decimal(0), tipAmount: new Decimal(0), type: 'REGULAR', method: 'CASH', createdAt: new Date() },
    ])
    ;(prisma.payment.findUnique as jest.Mock).mockResolvedValue({ id: 'pay-prev', status: 'COMPLETED', receipts: [] })

    const result: any = await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, COBRO_CASH_CERO, 'user-1')

    expect(result.id).toBe('pay-prev')
    expect(prisma.payment.create).not.toHaveBeenCalled()
    expect(huboAvisoDeDuplicado()).toBe(true)
  })

  it('el PRIMER cobro de una orden de $0 sí se crea (sin cobros previos)', async () => {
    const order = makeOrder({ total: new Decimal(0), subtotal: new Decimal(0) })
    ;(prisma.order.findUnique as jest.Mock).mockResolvedValue(order)
    ;(prisma.order.update as jest.Mock).mockResolvedValue({ ...order, items: order.items })
    ;(productInventoryService.getProductInventoryStatus as jest.Mock).mockResolvedValue(STOCK_OK)
    ;(prisma.payment.findFirst as jest.Mock).mockResolvedValue(null)
    ;(prisma.payment.findMany as jest.Mock).mockResolvedValue([])
    ;(prisma.payment.create as jest.Mock).mockResolvedValue({
      id: 'pay-new',
      status: 'COMPLETED',
      amount: new Decimal(0),
      tipAmount: new Decimal(0),
      feeAmount: 0,
      netAmount: 0,
      order: { ...order, items: order.items, venue: {} },
      processedBy: null,
    })

    const result: any = await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, COBRO_CASH_CERO, 'user-1')

    expect(prisma.payment.create).toHaveBeenCalledTimes(1)
    expect(result.id).toBe('pay-new')
    expect(huboAvisoDeDuplicado()).toBe(false)
  })

  it('la lectura de los cobros previos pide `type` y `method` (sin `type` un reembolso resta del saldo)', async () => {
    const order = makeOrder({ total: new Decimal(0), subtotal: new Decimal(0) })
    ;(prisma.order.findUnique as jest.Mock).mockResolvedValue(order)
    ;(prisma.payment.findFirst as jest.Mock).mockResolvedValue(null)
    ;(prisma.payment.findMany as jest.Mock).mockResolvedValue([
      { id: 'pay-prev', amount: new Decimal(0), tipAmount: new Decimal(0), type: 'REGULAR', method: 'CASH', createdAt: new Date() },
    ])
    ;(prisma.payment.findUnique as jest.Mock).mockResolvedValue({ id: 'pay-prev', status: 'COMPLETED', receipts: [] })

    await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, COBRO_CASH_CERO, 'user-1')

    const llamada = (prisma.payment.findMany as jest.Mock).mock.calls[0][0]
    expect(llamada.where).toMatchObject({ venueId: VENUE_ID, orderId: ORDER_ID, status: 'COMPLETED' })
    expect(llamada.select).toMatchObject({ id: true, amount: true, tipAmount: true, type: true, method: true, createdAt: true })
    // 🔴 Acotado: un findMany sin tope sobre Payment es la clase de consulta que tumbó
    // producción el 2026-09-01, y aquí corre DENTRO de la transacción del cobro.
    expect(typeof llamada.take).toBe('number')
  })

  // ── Regresión: lo que NUNCA debe deduplicarse ──────────────────────────────────────
  it('una TARJETA sobre una orden ya saldada SÍ se registra — el dinero ya se movió en el banco', async () => {
    const order = makeOrder()
    ;(prisma.order.findUnique as jest.Mock).mockResolvedValue(order)
    ;(prisma.order.update as jest.Mock).mockResolvedValue({ ...order, items: order.items })
    ;(productInventoryService.getProductInventoryStatus as jest.Mock).mockResolvedValue(STOCK_OK)
    ;(prisma.payment.findFirst as jest.Mock).mockResolvedValue(null)
    ;(prisma.payment.findMany as jest.Mock).mockResolvedValue([
      {
        id: 'pay-prev',
        amount: new Decimal(100),
        tipAmount: new Decimal(0),
        type: 'REGULAR',
        method: 'CREDIT_CARD',
        createdAt: new Date(),
      },
    ])
    ;(prisma.payment.create as jest.Mock).mockResolvedValue({
      id: 'pay-tarjeta',
      status: 'COMPLETED',
      amount: new Decimal(100),
      tipAmount: new Decimal(0),
      feeAmount: 0,
      netAmount: 100,
      order: { ...order, items: order.items, venue: {} },
      processedBy: null,
    })

    const result: any = await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, paymentData, 'user-1')

    expect(prisma.payment.create).toHaveBeenCalledTimes(1)
    expect(result.id).toBe('pay-tarjeta')
    expect(huboAvisoDeDuplicado()).toBe(false)
  })
})
