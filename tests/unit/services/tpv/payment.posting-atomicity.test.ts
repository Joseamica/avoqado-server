/**
 * Tests: en el camino TPV, el posting durable debe nacer en la MISMA transacción
 * que marca la orden PAID.
 *
 * Contexto (audit Codex gpt-5.6-sol xhigh, 2026-08-14 — RECHAZO del plan de fase 5):
 * la fase 2 dejó TRES commits separados en TPV — Payment, luego `order.update` a
 * PAID (suelto), luego el posting en su propia transacción. Ventana viva:
 *
 *     orden marcada PAID → crash → el posting nunca nació → el sweeper no ve nada
 *
 * El sweeper sólo puede rescatar postings que existen; no puede inventar el que
 * nunca se creó. El invariante que estos tests fijan es:
 *
 *     orden PAID  ⟺  posting existe
 *
 * Con eso, cualquier venta cobrada que no haya deducido queda SIEMPRE visible y
 * reintentables por el sweeper.
 */

import { Decimal } from '@prisma/client/runtime/library'

jest.mock('@/services/venueSalesGuard', () => ({
  __esModule: true,
  assertVenueSalesEnabled: jest.fn(),
}))

const lockAreaTicketCheckoutMock = jest.fn()
const finalizeAreaTicketPaymentMock = jest.fn()
jest.mock('@/services/mobile/areaTicketV7.mobile.service', () => ({
  __esModule: true,
  lockAreaTicketCheckoutForPayment: (...a: unknown[]) => lockAreaTicketCheckoutMock(...a),
  finalizeAreaTicketPaymentInTransaction: (...a: unknown[]) => finalizeAreaTicketPaymentMock(...a),
  getAreaTicketLineIdsCoveredByInventoryReservations: jest.fn().mockResolvedValue(new Set()),
}))

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
    activityLog: { create: jest.fn().mockResolvedValue({}) },
    inventoryPosting: { findUnique: jest.fn(), create: jest.fn(), updateMany: jest.fn() },
    inventoryPostingLine: { findMany: jest.fn() },
    $transaction: jest.fn(),
  },
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

jest.mock('@/services/dashboard/productInventoryIntegration.service', () => ({
  deductInventoryForProduct: jest.fn(),
  getProductInventoryStatus: jest.fn(),
  getProductInventoryMethod: jest.fn(),
  getProductInventoryMethods: jest.fn(),
}))

jest.mock('@/services/dashboard/inventoryRestock.service', () => ({
  restockOrderItems: jest.fn(),
  restockItem: jest.fn(),
}))

jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('@/services/referrals/referralQualification.service', () => ({ onOrderPaid: jest.fn() }))
jest.mock('@/services/tpv/digitalReceipt.tpv.service', () => ({ generateDigitalReceipt: jest.fn() }))
jest.mock('@/communication/sockets/managers/socketManager', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null) },
}))
jest.mock('@/services/payments/transactionCost.service', () => ({ createTransactionCost: jest.fn() }))
jest.mock('@/services/dashboard/autoReorder.service', () => ({ runAutoReorderForVenue: jest.fn() }))

// El servicio de posting se mockea para poder observar CON QUÉ cliente de
// transacción se le llama — que es exactamente el invariante bajo prueba.
const createSalePostingInTxMock = jest.fn()
jest.mock('@/services/inventory/inventoryPosting.service', () => ({
  __esModule: true,
  createSalePostingInTx: (...a: unknown[]) => createSalePostingInTxMock(...a),
  applySalePosting: jest.fn(),
}))

import prisma from '@/utils/prismaClient'
import * as productInventoryService from '@/services/dashboard/productInventoryIntegration.service'
const paymentService = require('@/services/tpv/payment.tpv.service')

const VENUE_ID = 'venue-123'
const ORDER_ID = 'order-123'

const makeOrder = (overrides: Record<string, unknown> = {}) => ({
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
})

const paymentData = {
  venueId: VENUE_ID,
  amount: 10000, // salda el total
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

/** Transacciones abiertas durante la corrida, con las operaciones que vieron. */
type TxRecord = { client: any; ops: string[] }
let transacciones: TxRecord[] = []

beforeEach(() => {
  jest.clearAllMocks()
  transacciones = []

  const order = makeOrder()
  ;(prisma.order.findUnique as jest.Mock).mockResolvedValue(order)
  ;(prisma.order.update as jest.Mock).mockResolvedValue({ ...order, paymentStatus: 'PAID', status: 'COMPLETED' })
  ;(prisma.shift.findFirst as jest.Mock).mockResolvedValue({ id: 'shift-1', status: 'OPEN' })
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
  ;(prisma.inventoryPostingLine.findMany as jest.Mock).mockResolvedValue([])
  ;(prisma.inventoryPosting.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
  lockAreaTicketCheckoutMock.mockResolvedValue(null)
  finalizeAreaTicketPaymentMock.mockResolvedValue({ areaTicketOrder: false })
  ;(productInventoryService.deductInventoryForProduct as jest.Mock).mockResolvedValue({ inventoryMethod: 'QUANTITY' })
  ;(productInventoryService.getProductInventoryStatus as jest.Mock).mockResolvedValue({
    inventoryMethod: 'QUANTITY',
    available: true,
    currentStock: 100,
  })
  createSalePostingInTxMock.mockResolvedValue({ id: 'posting-1', status: 'PENDING' })
  ;(prisma.$transaction as jest.Mock).mockImplementation(async (callback: any) => {
    const ops: string[] = []
    const record: TxRecord = { client: null, ops }
    const tx: any = {
      payment: { create: prisma.payment.create },
      paymentAllocation: { create: prisma.paymentAllocation.create },
      venueTransaction: { create: prisma.venueTransaction.create },
      order: {
        update: jest.fn(async (args: any) => {
          ops.push('order.update')
          return (prisma.order.update as jest.Mock)(args)
        }),
      },
      shift: { update: prisma.shift.update },
      areaTicketCheckoutSession: {
        findFirst: prisma.areaTicketCheckoutSession.findFirst,
        updateMany: prisma.areaTicketCheckoutSession.updateMany,
      },
      areaTicketPaymentAttempt: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: prisma.areaTicketPaymentAttempt.findFirst,
        updateMany: prisma.areaTicketPaymentAttempt.updateMany,
      },
      inventoryPosting: prisma.inventoryPosting,
      $queryRaw: jest.fn().mockResolvedValue([]),
    }
    record.client = tx
    transacciones.push(record)
    return callback(tx)
  })
})

describe('recordOrderPayment — el posting nace atómico con la transición a PAID', () => {
  it('el posting se crea con el MISMO cliente de transacción que marcó la orden PAID', async () => {
    await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, paymentData, 'user-1')

    expect(createSalePostingInTxMock).toHaveBeenCalled()
    const clienteDelPosting = createSalePostingInTxMock.mock.calls[0][0]

    // La transacción que creó el vale tiene que ser la MISMA que marcó PAID.
    // (Se busca POR el cliente del posting, no al revés: el cobro abre varias
    // transacciones y todas lucen igual desde el mock.) Si el posting abre su
    // propia transacción, sus `ops` vienen vacías y la ventana sigue abierta.
    const txDelPosting = transacciones.find(t => t.client === clienteDelPosting)
    expect(txDelPosting).toBeDefined()
    expect(txDelPosting!.ops).toContain('order.update')
  })

  it('el posting NUNCA se crea con el prisma global (eso sería una tx aparte)', async () => {
    await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, paymentData, 'user-1')

    expect(createSalePostingInTxMock).toHaveBeenCalled()
    expect(createSalePostingInTxMock.mock.calls[0][0]).not.toBe(prisma)
  })

  it('si la transición a PAID falla, NO queda un posting huérfano', async () => {
    ;(prisma.order.update as jest.Mock).mockRejectedValue(new Error('deadlock en el update de la orden'))

    await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, paymentData, 'user-1').catch(() => undefined)

    // El posting va DESPUÉS del update dentro de la misma tx: si el update
    // truena, nunca se llega a crearlo (y de haberse creado, el rollback de la
    // transacción lo borra).
    expect(createSalePostingInTxMock).not.toHaveBeenCalled()
  })
})
