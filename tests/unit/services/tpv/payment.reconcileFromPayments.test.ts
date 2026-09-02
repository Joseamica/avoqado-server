/**
 * Tests: `reconcileOrderFromPayments` cierra —SIN cobro nuevo— la orden cuyos `Payment`
 * COMPLETED ya la cubren pero que se quedó abierta (CONFIRMED/PENDING).
 *
 * Caso semilla ORD-1788276418170 (Testarudo, 1-sep-2026): el cobro quedó COMPLETED y la
 * transición a PAID nunca aterrizó, así que la cuenta seguía pidiendo dinero que el cliente
 * ya había pagado. Lo que fijan estos tests:
 *
 *   1. el cierre lo hace la MISMA transacción del camino de cobro
 *      (`updateOrderTotalsForStandalonePayment`), no una escritura paralela; y NO nace ningún
 *      `Payment` — un cobro fantasma de $0 sería peor que la orden abierta;
 *   2. una orden cuyos cobros NO la cubren se queda como estaba (PARTIAL): reconciliar no
 *      puede cerrar una cuenta a medio pagar.
 *
 * El andamiaje de mocks se copia de `payment.posting-atomicity.test.ts`: la función envuelta
 * arrastra medio módulo (vales por área, inventario, posting durable, lealtad), y necesita a
 * todos sus colaboradores en pie para poder correr de verdad bajo mocks.
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

// El vale de inventario se mockea para poder observar si NACE: reconciliar una orden que ya
// estaba cubierta no puede volver a mover stock.
const createSalePostingInTxMock = jest.fn()
jest.mock('@/services/inventory/inventoryPosting.service', () => ({
  __esModule: true,
  createSalePostingInTx: (...a: unknown[]) => createSalePostingInTxMock(...a),
  applySalePosting: jest.fn(),
}))

import prisma from '@/utils/prismaClient'
import * as productInventoryService from '@/services/dashboard/productInventoryIntegration.service'
import { reconcileOrderFromPayments } from '@/services/tpv/payment.tpv.service'

const p = prisma as unknown as Record<string, Record<string, jest.Mock>> & { $transaction: jest.Mock }

describe('reconcileOrderFromPayments — la orden cobrada que quedó abierta (ORD-1788276418170)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    // Orden CONFIRMED/PENDING con un cobro COMPLETED que la cubre (65 + 9.75 de propina).
    p.order.findUnique.mockResolvedValue({
      id: 'ord-1',
      venueId: 'v1',
      status: 'CONFIRMED',
      paymentStatus: 'PENDING',
      subtotal: new Decimal(65),
      discountAmount: new Decimal(0),
      tipAmount: new Decimal(9.75),
      total: new Decimal(74.75),
      servedById: 'staff-1',
      createdById: 'staff-1',
      tableId: null,
      customer: null,
      payments: [{ amount: new Decimal(65), tipAmount: new Decimal(9.75), type: 'REGULAR' }],
      items: [
        {
          id: 'it-1',
          productId: 'prod-1',
          quantity: 1,
          areaTicketLineId: null,
          product: { id: 'prod-1', name: 'Café', trackInventory: false },
          modifiers: [],
          paymentAllocations: [],
        },
      ],
    })
    p.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({
        order: {
          update: jest.fn().mockResolvedValue({ id: 'ord-1', venueId: 'v1', status: 'COMPLETED', paymentStatus: 'PAID', items: [] }),
        },
        inventoryPosting: { findUnique: jest.fn(), create: jest.fn() },
      }),
    )

    // Colaboradores del camino de cobro: no deciden nada aquí, pero la función envuelta los
    // consulta y sin ellos reventaría por el andamiaje, no por el comportamiento bajo prueba.
    createSalePostingInTxMock.mockResolvedValue({ id: 'posting-1', status: 'PENDING' })
    lockAreaTicketCheckoutMock.mockResolvedValue(null)
    finalizeAreaTicketPaymentMock.mockResolvedValue({ areaTicketOrder: false })
    p.orderCustomer.findMany.mockResolvedValue([])
    p.areaTicketInventoryReservation.findMany.mockResolvedValue([])
    p.inventoryPostingLine.findMany.mockResolvedValue([])
    p.inventoryPosting.updateMany.mockResolvedValue({ count: 1 })
    ;(productInventoryService.deductInventoryForProduct as jest.Mock).mockResolvedValue({ inventoryMethod: 'QUANTITY' })
    ;(productInventoryService.getProductInventoryStatus as jest.Mock).mockResolvedValue({
      inventoryMethod: 'QUANTITY',
      available: true,
      currentStock: 100,
    })
  })

  it('marca la orden PAID + COMPLETED con sus cobros existentes, sin crear ningún Payment nuevo', async () => {
    const fakeTx = {
      order: {
        update: jest.fn().mockResolvedValue({ id: 'ord-1', venueId: 'v1', status: 'COMPLETED', paymentStatus: 'PAID', items: [] }),
      },
      inventoryPosting: { findUnique: jest.fn(), create: jest.fn() },
    }
    p.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(fakeTx))

    const resultado = await reconcileOrderFromPayments('ord-1')

    // El contrato que consume el barrido: la orden que cerró y su aviso de inventario.
    expect(resultado).toEqual({ orderId: 'ord-1', warning: null })
    expect(p.$transaction).toHaveBeenCalledTimes(1)
    expect(fakeTx.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'ord-1' },
        data: expect.objectContaining({ paymentStatus: 'PAID', status: 'COMPLETED', remainingBalance: 0, paidAmount: 74.75 }),
      }),
    )
    expect(p.payment.create).not.toHaveBeenCalled()
    // Los cobros ya cubrían la cuenta ANTES de este cierre (`settledBeforeThisPayment`), así
    // que no nace un segundo vale: reconciliar no puede volver a descontar mercancía.
    expect(createSalePostingInTxMock).not.toHaveBeenCalled()
  })

  it('no toca una orden cuyos cobros NO la cubren', async () => {
    p.order.findUnique.mockResolvedValue({
      id: 'ord-2',
      venueId: 'v1',
      status: 'CONFIRMED',
      paymentStatus: 'PARTIAL',
      subtotal: new Decimal(100),
      discountAmount: new Decimal(0),
      tipAmount: new Decimal(0),
      total: new Decimal(100),
      servedById: 'staff-1',
      createdById: 'staff-1',
      tableId: null,
      customer: null,
      payments: [{ amount: new Decimal(40), tipAmount: new Decimal(0), type: 'REGULAR' }],
      items: [],
    })
    const fakeTx = {
      order: {
        update: jest.fn().mockResolvedValue({ id: 'ord-2', venueId: 'v1', status: 'CONFIRMED', paymentStatus: 'PARTIAL', items: [] }),
      },
      inventoryPosting: { findUnique: jest.fn(), create: jest.fn() },
    }
    p.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(fakeTx))

    await reconcileOrderFromPayments('ord-2')

    const data = fakeTx.order.update.mock.calls[0][0].data
    expect(data).not.toHaveProperty('status')
    expect(data).toMatchObject({ paymentStatus: 'PARTIAL', paidAmount: 40, remainingBalance: 60 })
  })
})
