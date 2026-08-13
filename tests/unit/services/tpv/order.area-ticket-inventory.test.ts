const deductInventoryMock = jest.fn().mockResolvedValue(undefined)
const getInventoryMethodMock = jest.fn()
const finalizeAreaTicketPaymentMock = jest.fn()

jest.mock('@/services/venueSalesGuard', () => ({
  assertVenueSalesEnabled: jest.fn(),
}))

jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null) },
}))

jest.mock('@/services/dashboard/receipt.dashboard.service', () => ({
  generateAndStoreReceipt: jest.fn().mockResolvedValue({ id: 'receipt-1' }),
}))

jest.mock('@/services/tpv/payment.tpv.service', () => ({
  mapDigitalReceiptResponse: jest.fn(() => null),
  resolveAutofacturaAvailable: jest.fn().mockResolvedValue(false),
}))

jest.mock('@/services/mobile/areaTicketV7.mobile.service', () => ({
  lockAreaTicketCheckoutForPayment: jest.fn().mockResolvedValue({ sessionId: 'session-1', attemptId: 'attempt-1' }),
  finalizeAreaTicketPaymentInTransaction: (...args: unknown[]) => finalizeAreaTicketPaymentMock(...args),
}))

jest.mock('@/services/dashboard/autoReorder.service', () => ({
  runAutoReorderForVenue: jest.fn().mockResolvedValue({ ran: false }),
}))

jest.mock('@/services/referrals/referralQualification.service', () => ({
  onOrderPaid: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('@/services/dashboard/productInventoryIntegration.service', () => ({
  deductInventoryForProduct: (...args: unknown[]) => deductInventoryMock(...args),
  getProductInventoryMethod: (...args: unknown[]) => getInventoryMethodMock(...args),
  getProductInventoryStatus: jest.fn(),
}))

import { deductTrackedInventoryForFreeCart } from '@/services/tpv/order.tpv.service'
import { payCashOrder } from '@/services/mobile/order.mobile.service'
import { prismaMock } from '../../../__helpers__/setup'
import { Decimal } from '@prisma/client/runtime/library'

describe('deductTrackedInventoryForFreeCart — vales por área', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    getInventoryMethodMock.mockResolvedValue('QUANTITY')
  })

  it('delega toda la deducción de una orden con vales a la finalización transaccional', async () => {
    const baseOrder = {
      id: 'order-area',
      orderNumber: 'AREA-1',
      paymentStatus: 'PENDING',
      status: 'PENDING',
      subtotal: new Decimal(50.5),
      discountAmount: new Decimal(0),
      serviceChargeAmount: new Decimal(0),
      tipAmount: new Decimal(0),
      total: new Decimal(50.5),
      remainingBalance: new Decimal(50.5),
      venueId: 'venue-1',
      version: 1,
      areaTicketCode: 'AREA-CODE',
      areaTicketCheckoutSession: { id: 'session-1' },
    }
    const paidOrder = {
      ...baseOrder,
      items: [
        {
          id: 'item-held',
          areaTicketLineId: 'line-held',
          productId: 'prod-held',
          productName: 'Jamón reservado',
          quantity: 1,
          weightQuantity: new Decimal(0.125),
          modifiers: [],
        },
        {
          id: 'item-normal',
          areaTicketLineId: null,
          productId: 'prod-normal',
          productName: 'Coca-Cola',
          quantity: 2,
          weightQuantity: null,
          modifiers: [],
        },
      ],
    }
    prismaMock.$transaction.mockImplementation(async (callback: any) => callback(prismaMock))
    prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1', staffId: 'staff-1', venueId: 'venue-1', active: true })
    prismaMock.payment.findUnique.mockResolvedValue(null)
    prismaMock.payment.findMany.mockResolvedValue([])
    prismaMock.shift.findFirst.mockResolvedValue(null)
    prismaMock.order.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.payment.create.mockResolvedValue({ id: 'payment-1' })
    prismaMock.venueTransaction.create.mockResolvedValue({ id: 'transaction-1' })
    prismaMock.paymentAllocation.create.mockResolvedValue({ id: 'allocation-1' })
    prismaMock.order.findUnique.mockResolvedValueOnce(baseOrder).mockResolvedValueOnce(baseOrder).mockResolvedValueOnce(paidOrder)
    prismaMock.areaTicketInventoryReservation.findMany.mockResolvedValue([{ areaTicketLineId: 'line-held' }])
    finalizeAreaTicketPaymentMock.mockResolvedValue({ areaTicketOrder: true, sessionId: 'session-1' })

    await payCashOrder('venue-1', 'order-area', {
      amount: 5050,
      tip: 0,
      staffId: 'staff-1',
      idempotencyKey: 'area-payment-1',
    })
    await new Promise(resolve => setImmediate(resolve))

    expect(finalizeAreaTicketPaymentMock).toHaveBeenCalledWith(
      prismaMock,
      expect.objectContaining({
        venueId: 'venue-1',
        orderId: 'order-area',
        paymentId: 'payment-1',
        fullyPaid: true,
      }),
    )
    expect(deductInventoryMock).not.toHaveBeenCalled()
  })

  it('omite sólo la línea cubierta por reserva y descuenta las líneas normal y de vale sin reserva', async () => {
    prismaMock.areaTicketInventoryReservation.findMany.mockResolvedValue([{ areaTicketLineId: 'line-held' }])

    await deductTrackedInventoryForFreeCart(
      {
        id: 'order-mixed',
        venueId: 'venue-1',
        items: [
          {
            id: 'item-held',
            areaTicketLineId: 'line-held',
            productId: 'prod-held',
            productName: 'Jamón reservado',
            quantity: 1,
            weightQuantity: 0.125,
            modifiers: [],
          },
          {
            id: 'item-normal',
            areaTicketLineId: null,
            productId: 'prod-normal',
            productName: 'Coca-Cola',
            quantity: 2,
            weightQuantity: null,
            modifiers: [],
          },
          {
            id: 'item-ticket-none',
            areaTicketLineId: 'line-without-reservation',
            productId: 'prod-ticket-none',
            productName: 'Pan sin reserva',
            quantity: 1,
            weightQuantity: 0.375,
            modifiers: [],
          },
        ],
      },
      'staff-1',
    )

    expect(deductInventoryMock).toHaveBeenCalledTimes(2)
    expect(deductInventoryMock).toHaveBeenCalledWith('venue-1', 'prod-normal', 2, 'order-mixed', 'staff-1', [])
    expect(deductInventoryMock).toHaveBeenCalledWith('venue-1', 'prod-ticket-none', 0.375, 'order-mixed', 'staff-1', [])
    expect(deductInventoryMock).not.toHaveBeenCalledWith(
      'venue-1',
      'prod-held',
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    )
  })

  it('procesa modificadores inventariables aunque el producto base no rastree inventario', async () => {
    prismaMock.areaTicketInventoryReservation.findMany.mockResolvedValue([])
    getInventoryMethodMock.mockResolvedValue(null)

    const modifiers = [
      {
        quantity: 1,
        modifier: {
          id: 'modifier-cheese',
          name: 'Queso extra',
          groupId: 'group-1',
          rawMaterialId: 'raw-cheese',
          quantityPerUnit: 0.03,
          unit: 'KILOGRAM',
          inventoryMode: 'ADDITION',
        },
      },
    ]

    await deductTrackedInventoryForFreeCart(
      {
        id: 'order-modifier',
        venueId: 'venue-1',
        items: [
          {
            id: 'item-untracked',
            areaTicketLineId: null,
            productId: 'prod-untracked',
            productName: 'Producto sin tracking',
            quantity: 2,
            weightQuantity: null,
            modifiers,
          },
        ],
      },
      'staff-1',
    )

    expect(deductInventoryMock).toHaveBeenCalledWith('venue-1', 'prod-untracked', 2, 'order-modifier', 'staff-1', modifiers)
  })
})

// ── Issues que la deducción devuelve al cajero (Square-parity, toast post-cobro) ──
describe('deductTrackedInventoryForFreeCart — issues de inventario', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    getInventoryMethodMock.mockResolvedValue('QUANTITY')
    prismaMock.areaTicketInventoryReservation.findMany.mockResolvedValue([])
  })

  const orderWith = (items: unknown[]) => ({ id: 'order-1', venueId: 'venue-1', items })

  it('reporta el producto cuya venta dejó el stock en negativo', async () => {
    deductInventoryMock.mockResolvedValue({ inventoryMethod: 'QUANTITY', remainingStock: -1, productName: 'Cerveza Corona' })

    const issues = await deductTrackedInventoryForFreeCart(
      orderWith([
        {
          id: 'i1',
          areaTicketLineId: null,
          productId: 'p1',
          productName: 'Cerveza Corona',
          quantity: 1,
          weightQuantity: null,
          modifiers: [],
        },
      ]),
      'staff-1',
    )

    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ productId: 'p1', productName: 'Cerveza Corona', requested: 1, available: -1 })
  })

  it('reporta con available null la línea que no se pudo descontar, sin frenar las demás', async () => {
    deductInventoryMock
      .mockRejectedValueOnce(new Error('DB timeout'))
      .mockResolvedValueOnce({ inventoryMethod: 'QUANTITY', remainingStock: 5, productName: 'Coca-Cola' })

    const issues = await deductTrackedInventoryForFreeCart(
      orderWith([
        {
          id: 'i1',
          areaTicketLineId: null,
          productId: 'p1',
          productName: 'Hamburguesa BBQ',
          quantity: 2,
          weightQuantity: null,
          modifiers: [],
        },
        { id: 'i2', areaTicketLineId: null, productId: 'p2', productName: 'Coca-Cola', quantity: 1, weightQuantity: null, modifiers: [] },
      ]),
      'staff-1',
    )

    expect(deductInventoryMock).toHaveBeenCalledTimes(2)
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ productId: 'p1', available: null, reason: 'DB timeout' })
  })

  it('devuelve [] cuando todo descontó con stock suficiente', async () => {
    deductInventoryMock.mockResolvedValue({ inventoryMethod: 'QUANTITY', remainingStock: 10, productName: 'Coca-Cola' })

    const issues = await deductTrackedInventoryForFreeCart(
      orderWith([
        { id: 'i1', areaTicketLineId: null, productId: 'p1', productName: 'Coca-Cola', quantity: 1, weightQuantity: null, modifiers: [] },
      ]),
      'staff-1',
    )

    expect(issues).toEqual([])
  })
})
