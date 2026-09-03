/**
 * Fase 1 del «turno de caja del negocio» (decisión del founder, 2-sep-2026).
 *
 * Antes, cada cobro buscaba «el turno abierto de QUIEN cobra». El selector «Vendedor»
 * de Cobrar cambia ese `staffId` en cada cobro, así que quien nunca abrió turno cobraba
 * FUERA de todo turno: Testarudo, 1-sep-2026, 78 de 92 cobros ($10,337 de $12,002).
 *
 * Lo que fija esta prueba: dos cajeros distintos cobrando en el MISMO negocio caen en el
 * MISMO `Shift`, y cada cobro conserva quién lo hizo en `processedById`. El andamiaje de
 * mocks se copia de `payment.posting-atomicity.test.ts` (mismo servicio bajo prueba).
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

describe('fase 1 — el cobro cae en el turno abierto del NEGOCIO', () => {
  it('dos cobros de dos personas distintas caen en el MISMO turno y cada uno conserva quién cobró', async () => {
    ;(prisma.shift.findFirst as jest.Mock).mockResolvedValue({ id: 'shift-negocio' })
    ;(prisma.staffVenue.findFirst as jest.Mock).mockImplementation(async ({ where }: any) => ({
      id: `sv-${where.staffId}`,
      staffId: where.staffId,
      venueId: VENUE_ID,
    }))

    await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, { ...paymentData, amount: 4000, staffId: 'viridiana' }, 'user-1')
    await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, { ...paymentData, amount: 6000, staffId: 'hector' }, 'user-1')

    const creados = (prisma.payment.create as jest.Mock).mock.calls.map(c => c[0].data)
    expect(creados).toHaveLength(2)
    expect(creados.map(d => d.shiftId)).toEqual(['shift-negocio', 'shift-negocio'])
    expect(creados.map(d => d.processedById)).toEqual(['viridiana', 'hector'])

    // y el turno se resolvió por NEGOCIO, nunca por persona
    for (const call of (prisma.shift.findFirst as jest.Mock).mock.calls) {
      expect(call[0].where).toEqual({ venueId: VENUE_ID, status: 'OPEN', endTime: null })
    }
  })
})
