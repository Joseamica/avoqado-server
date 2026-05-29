import { Decimal } from '@prisma/client/runtime/library'
import { createOrderWithItems, payCashOrder } from '@/services/mobile/order.mobile.service'
import { prismaMock } from '../../../__helpers__/setup'

jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: {
    getBroadcastingService: jest.fn(() => null),
  },
}))

jest.mock('@/services/dashboard/receipt.dashboard.service', () => ({
  generateAndStoreReceipt: jest.fn().mockResolvedValue({ id: 'receipt-1' }),
}))

describe('order.mobile.service', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.$transaction.mockImplementation(async (callback: any) => callback(prismaMock))
  })

  it('persists discountAmount and computes total as subtotal - discount + tip when creating an order', async () => {
    prismaMock.staff.findUnique.mockResolvedValue({
      id: 'staff-1',
      venueId: 'venue-1',
    })
    // validateStaffVenue (added in src/utils/staff-venue.util.ts) requires this mock
    prismaMock.staffVenue.findFirst.mockResolvedValue({
      id: 'sv-1',
      staffId: 'staff-1',
      venueId: 'venue-1',
      active: true,
    })
    prismaMock.product.findMany.mockResolvedValue([
      {
        id: 'prod-1',
        name: 'Hamburguesa',
        price: new Decimal(100),
        sku: 'BURG-1',
        category: { name: 'Comida' },
      },
    ])
    prismaMock.modifier.findMany.mockResolvedValue([])
    prismaMock.order.create.mockResolvedValue({
      id: 'order-1',
      orderNumber: 'ORD-1',
      status: 'CONFIRMED',
      paymentStatus: 'PENDING',
      subtotal: new Decimal(125),
      discountAmount: new Decimal(10),
      taxAmount: new Decimal(0),
      total: new Decimal(120),
      createdAt: new Date('2026-04-18T10:00:00.000Z'),
      items: [
        {
          id: 'oi-1',
          productId: 'prod-1',
          productName: 'Hamburguesa',
          quantity: 1,
          unitPrice: new Decimal(100),
          total: new Decimal(100),
          product: { id: 'prod-1', name: 'Hamburguesa', price: new Decimal(100) },
          modifiers: [],
        },
        {
          id: 'oi-2',
          productId: null,
          productName: 'Otro importe',
          quantity: 1,
          unitPrice: new Decimal(25),
          total: new Decimal(25),
          product: null,
          modifiers: [],
        },
      ],
    })

    const result = await createOrderWithItems('venue-1', {
      staffId: 'staff-1',
      items: [
        { productId: 'prod-1', quantity: 1 },
        { name: 'Otro importe', quantity: 1, unitPrice: 2500 },
      ],
      discount: 1000,
      tip: 500,
      source: 'AVOQADO_ANDROID',
    })

    expect(prismaMock.order.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          subtotal: new Decimal(125),
          discountAmount: new Decimal(10),
          tipAmount: new Decimal(5),
          total: new Decimal(120),
          remainingBalance: new Decimal(120),
        }),
      }),
    )
    expect(result.discountAmount).toBe(10)
    expect(result.total).toBe(120)
  })

  // ── Walk-in class flow: link the sale to its reservation ──

  function mockBaseOrderCreate() {
    prismaMock.staff.findUnique.mockResolvedValue({ id: 'staff-1', venueId: 'venue-1' })
    prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1', staffId: 'staff-1', venueId: 'venue-1', active: true })
    prismaMock.product.findMany.mockResolvedValue([
      { id: 'prod-class', name: 'Yoga', price: new Decimal(300), sku: 'YOGA-1', category: { name: 'Clases' } },
    ])
    prismaMock.modifier.findMany.mockResolvedValue([])
    prismaMock.order.create.mockResolvedValue({
      id: 'order-1',
      orderNumber: 'ORD-1',
      status: 'CONFIRMED',
      paymentStatus: 'PENDING',
      subtotal: new Decimal(300),
      discountAmount: new Decimal(0),
      taxAmount: new Decimal(0),
      total: new Decimal(300),
      createdAt: new Date('2026-05-28T10:00:00.000Z'),
      items: [],
    })
  }

  it('links the order to the reservation when reservationId belongs to the venue', async () => {
    mockBaseOrderCreate()
    prismaMock.reservation.findFirst.mockResolvedValue({ id: 'res-1' })

    await createOrderWithItems('venue-1', {
      staffId: 'staff-1',
      items: [{ productId: 'prod-class', quantity: 1 }],
      source: 'AVOQADO_ANDROID',
      reservationId: 'res-1',
    })

    expect(prismaMock.reservation.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'res-1', venueId: 'venue-1' } }))
    expect(prismaMock.order.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ reservationId: 'res-1' }) }),
    )
  })

  it('drops a reservationId that does not belong to the venue (no FK break, sale still created)', async () => {
    mockBaseOrderCreate()
    prismaMock.reservation.findFirst.mockResolvedValue(null) // foreign / unknown

    await createOrderWithItems('venue-1', {
      staffId: 'staff-1',
      items: [{ productId: 'prod-class', quantity: 1 }],
      source: 'AVOQADO_ANDROID',
      reservationId: 'res-from-other-venue',
    })

    expect(prismaMock.order.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ reservationId: null }) }),
    )
  })

  it('does not query reservations when no reservationId is provided (regression)', async () => {
    mockBaseOrderCreate()

    await createOrderWithItems('venue-1', {
      staffId: 'staff-1',
      items: [{ productId: 'prod-class', quantity: 1 }],
      source: 'AVOQADO_ANDROID',
    })

    expect(prismaMock.reservation.findFirst).not.toHaveBeenCalled()
    expect(prismaMock.order.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ reservationId: null }) }),
    )
  })

  it('marks discounted cash order as paid when customer pays the discounted total', async () => {
    prismaMock.order.findUnique.mockResolvedValue({
      id: 'order-1',
      orderNumber: 'ORD-1',
      paymentStatus: 'PENDING',
      subtotal: new Decimal(100),
      discountAmount: new Decimal(10),
      total: new Decimal(90),
      remainingBalance: new Decimal(90),
      venueId: 'venue-1',
    })
    prismaMock.staff.findUnique.mockResolvedValue({ id: 'staff-1' })
    prismaMock.staffVenue.findFirst.mockResolvedValue({
      id: 'sv-1',
      staffId: 'staff-1',
      venueId: 'venue-1',
      active: true,
    })
    prismaMock.shift.findFirst.mockResolvedValue(null)
    prismaMock.payment.create.mockResolvedValue({ id: 'payment-1' })
    prismaMock.venueTransaction.create.mockResolvedValue({ id: 'vtx-1' })
    prismaMock.paymentAllocation.create.mockResolvedValue({ id: 'alloc-1' })
    prismaMock.order.update.mockResolvedValue({ id: 'order-1' })

    await payCashOrder('venue-1', 'order-1', {
      amount: 9000,
      tip: 0,
      staffId: 'staff-1',
    })

    expect(prismaMock.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'order-1' },
        data: expect.objectContaining({
          paymentStatus: 'PAID',
          status: 'COMPLETED',
          remainingBalance: 0,
          total: new Decimal(90),
        }),
      }),
    )
  })
})
