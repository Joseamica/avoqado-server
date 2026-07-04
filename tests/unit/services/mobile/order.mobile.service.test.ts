import { Decimal } from '@prisma/client/runtime/library'
import { Prisma } from '@prisma/client'
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

  // ── Per-item discountId (mirrors TPV's itemDiscountId — order.tpv.service.ts) ──

  it('applies a PERCENTAGE item discount: reduces the line + rolls into order subtotal/discountAmount/total', async () => {
    prismaMock.staff.findUnique.mockResolvedValue({ id: 'staff-1', venueId: 'venue-1' })
    prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1', staffId: 'staff-1', venueId: 'venue-1', active: true })
    prismaMock.product.findMany.mockResolvedValue([{ id: 'prod-1', name: 'Hamburguesa', price: new Decimal(100), category: { name: 'Comida' } }])
    prismaMock.modifier.findMany.mockResolvedValue([])
    prismaMock.discount.findMany.mockResolvedValue([
      { id: 'disc-pct', venueId: 'venue-1', name: '20% off', type: 'PERCENTAGE', value: new Decimal(20), active: true },
    ])
    prismaMock.order.create.mockResolvedValue({
      id: 'order-1',
      orderNumber: 'ORD-1',
      status: 'CONFIRMED',
      paymentStatus: 'PENDING',
      subtotal: new Decimal(100),
      discountAmount: new Decimal(20),
      taxAmount: new Decimal(0),
      total: new Decimal(80),
      createdAt: new Date('2026-06-30T10:00:00.000Z'),
      items: [],
    })

    const result = await createOrderWithItems('venue-1', {
      staffId: 'staff-1',
      items: [{ productId: 'prod-1', quantity: 1, discountId: 'disc-pct' }],
      source: 'AVOQADO_IOS',
    })

    // product price $100, 20% discount -> line discount $20, subtotal $100, total $80
    expect(prismaMock.order.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          subtotal: new Decimal(100),
          discountAmount: new Decimal(20),
          total: new Decimal(80),
          items: {
            create: [
              expect.objectContaining({
                discountAmount: new Decimal(20),
                appliedDiscountId: 'disc-pct',
                total: new Decimal(100),
              }),
            ],
          },
        }),
      }),
    )
    expect(result.discountAmount).toBe(20)
    expect(result.total).toBe(80)
    expect(prismaMock.discount.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['disc-pct'] } },
      data: { currentUses: { increment: 1 } },
    })
  })

  it('applies a FIXED_AMOUNT item discount', async () => {
    prismaMock.staff.findUnique.mockResolvedValue({ id: 'staff-1', venueId: 'venue-1' })
    prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1', staffId: 'staff-1', venueId: 'venue-1', active: true })
    prismaMock.product.findMany.mockResolvedValue([{ id: 'prod-1', name: 'Hamburguesa', price: new Decimal(100), category: { name: 'Comida' } }])
    prismaMock.modifier.findMany.mockResolvedValue([])
    prismaMock.discount.findMany.mockResolvedValue([
      { id: 'disc-fixed', venueId: 'venue-1', name: '$15 off', type: 'FIXED_AMOUNT', value: new Decimal(15), active: true },
    ])
    prismaMock.order.create.mockResolvedValue({
      id: 'order-1',
      orderNumber: 'ORD-1',
      status: 'CONFIRMED',
      paymentStatus: 'PENDING',
      subtotal: new Decimal(100),
      discountAmount: new Decimal(15),
      taxAmount: new Decimal(0),
      total: new Decimal(85),
      createdAt: new Date('2026-06-30T10:00:00.000Z'),
      items: [],
    })

    const result = await createOrderWithItems('venue-1', {
      staffId: 'staff-1',
      items: [{ productId: 'prod-1', quantity: 1, discountId: 'disc-fixed' }],
      source: 'AVOQADO_IOS',
    })

    // product price $100, fixed $15 off -> line discount $15, total $85
    expect(prismaMock.order.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          subtotal: new Decimal(100),
          discountAmount: new Decimal(15),
          total: new Decimal(85),
        }),
      }),
    )
    expect(result.discountAmount).toBe(15)
    expect(result.total).toBe(85)
  })

  it('rejects the whole order when discountId is invalid/foreign (mirrors TPV: reject, not silently ignore)', async () => {
    prismaMock.staff.findUnique.mockResolvedValue({ id: 'staff-1', venueId: 'venue-1' })
    prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1', staffId: 'staff-1', venueId: 'venue-1', active: true })
    prismaMock.product.findMany.mockResolvedValue([{ id: 'prod-1', name: 'Hamburguesa', price: new Decimal(100), category: { name: 'Comida' } }])
    prismaMock.modifier.findMany.mockResolvedValue([])
    prismaMock.discount.findMany.mockResolvedValue([]) // not found / not in this venue

    await expect(
      createOrderWithItems('venue-1', {
        staffId: 'staff-1',
        items: [{ productId: 'prod-1', quantity: 1, discountId: 'disc-does-not-exist' }],
        source: 'AVOQADO_IOS',
      }),
    ).rejects.toThrow('Descuento no encontrado o no pertenece a este local: disc-does-not-exist')

    expect(prismaMock.order.create).not.toHaveBeenCalled()
  })

  // ── Fix 1: mobile item discounts write OrderDiscount audit rows (mirrors TPV) ──

  it('writes an OrderDiscount audit row for an applied item discount', async () => {
    prismaMock.staff.findUnique.mockResolvedValue({ id: 'staff-1', venueId: 'venue-1' })
    prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1', staffId: 'staff-1', venueId: 'venue-1', active: true })
    prismaMock.product.findMany.mockResolvedValue([{ id: 'prod-1', name: 'Hamburguesa', price: new Decimal(100), category: { name: 'Comida' } }])
    prismaMock.modifier.findMany.mockResolvedValue([])
    prismaMock.discount.findMany.mockResolvedValue([
      { id: 'disc-pct', venueId: 'venue-1', name: '20% off', type: 'PERCENTAGE', value: new Decimal(20), active: true },
    ])
    prismaMock.order.create.mockResolvedValue({
      id: 'order-1',
      orderNumber: 'ORD-1',
      status: 'CONFIRMED',
      paymentStatus: 'PENDING',
      subtotal: new Decimal(100),
      discountAmount: new Decimal(20),
      taxAmount: new Decimal(0),
      total: new Decimal(80),
      createdAt: new Date('2026-07-03T10:00:00.000Z'),
      items: [
        {
          id: 'oi-1',
          productId: 'prod-1',
          productName: 'Hamburguesa',
          quantity: 1,
          unitPrice: new Decimal(100),
          total: new Decimal(100),
          discountAmount: new Decimal(20),
          appliedDiscountId: 'disc-pct',
          product: { id: 'prod-1', name: 'Hamburguesa', price: new Decimal(100) },
          modifiers: [],
        },
      ],
    })
    prismaMock.orderDiscount.create.mockResolvedValue({ id: 'od-1' })

    await createOrderWithItems('venue-1', {
      staffId: 'staff-1',
      items: [{ productId: 'prod-1', quantity: 1, discountId: 'disc-pct' }],
      source: 'AVOQADO_IOS',
    })

    expect(prismaMock.orderDiscount.create).toHaveBeenCalledWith({
      data: {
        orderId: 'order-1',
        discountId: 'disc-pct',
        type: 'PERCENTAGE',
        name: '20% off',
        value: new Decimal(20),
        amount: new Decimal(20),
        taxReduction: 0,
        isComp: false,
        isManual: true,
        compReason: null,
        appliedById: 'sv-1',
        appliedToItemIds: ['oi-1'],
      },
    })
  })

  it('does not write an OrderDiscount row when no item discount was applied', async () => {
    mockBaseOrderCreate()

    await createOrderWithItems('venue-1', {
      staffId: 'staff-1',
      items: [{ productId: 'prod-class', quantity: 1 }],
      source: 'AVOQADO_ANDROID',
    })

    expect(prismaMock.orderDiscount.create).not.toHaveBeenCalled()
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

// ── Idempotency via externalId (offline-retry safety, mirrors TPV createOrder) ──

describe('createOrderWithItems idempotency (externalId)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.$transaction.mockImplementation(async (callback: any) => callback(prismaMock))
  })

  const existingOrderRow = {
    id: 'order-existing',
    orderNumber: 'ORD-OLD',
    status: 'CONFIRMED',
    paymentStatus: 'PENDING',
    subtotal: new Decimal(100),
    discountAmount: new Decimal(0),
    taxAmount: new Decimal(0),
    total: new Decimal(100),
    createdAt: new Date('2026-06-01T10:00:00.000Z'),
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
    ],
  }

  function mockHappyCreatePath() {
    prismaMock.staff.findUnique.mockResolvedValue({ id: 'staff-1', venueId: 'venue-1' })
    prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1', staffId: 'staff-1', venueId: 'venue-1', active: true })
    prismaMock.product.findMany.mockResolvedValue([
      { id: 'prod-1', name: 'Hamburguesa', price: new Decimal(100), sku: 'BURG-1', category: { name: 'Comida' } },
    ])
    prismaMock.modifier.findMany.mockResolvedValue([])
  }

  // 1. NEW FEATURE TESTS

  it('returns the existing order without creating when externalId matches', async () => {
    prismaMock.order.findUnique.mockResolvedValue(existingOrderRow)

    const result = await createOrderWithItems('venue-1', {
      staffId: 'staff-1',
      items: [{ productId: 'prod-1', quantity: 1 }],
      externalId: 'retry-key-1',
    })

    expect(prismaMock.order.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { venueId_externalId: { venueId: 'venue-1', externalId: 'retry-key-1' } },
      }),
    )
    expect(prismaMock.order.create).not.toHaveBeenCalled()
    expect(result.id).toBe('order-existing')
    expect(result.orderNumber).toBe('ORD-OLD')
  })

  it('persists the normalized externalId on the created order', async () => {
    mockHappyCreatePath()
    prismaMock.order.findUnique.mockResolvedValue(null)
    prismaMock.order.create.mockResolvedValue(existingOrderRow)

    await createOrderWithItems('venue-1', {
      staffId: 'staff-1',
      items: [{ productId: 'prod-1', quantity: 1 }],
      externalId: '  retry-key-2  ',
    })

    expect(prismaMock.order.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ externalId: 'retry-key-2' }),
      }),
    )
  })

  it('returns the winner when a concurrent duplicate is blocked by the unique index (P2002)', async () => {
    mockHappyCreatePath()
    prismaMock.order.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(existingOrderRow)
    const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target: ['venueId', 'externalId'] },
    } as any)
    prismaMock.order.create.mockRejectedValue(p2002)

    const result = await createOrderWithItems('venue-1', {
      staffId: 'staff-1',
      items: [{ productId: 'prod-1', quantity: 1 }],
      externalId: 'retry-key-3',
    })

    expect(result.id).toBe('order-existing')
  })

  it('treats blank externalId as absent (no lookup, created with null)', async () => {
    mockHappyCreatePath()
    prismaMock.order.create.mockResolvedValue(existingOrderRow)

    await createOrderWithItems('venue-1', {
      staffId: 'staff-1',
      items: [{ productId: 'prod-1', quantity: 1 }],
      externalId: '   ',
    })

    expect(prismaMock.order.findUnique).not.toHaveBeenCalled()
    expect(prismaMock.order.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ externalId: null }),
      }),
    )
  })

  // 2. REGRESSION TESTS

  it('still creates orders normally when externalId is not provided', async () => {
    mockHappyCreatePath()
    prismaMock.order.create.mockResolvedValue(existingOrderRow)

    const result = await createOrderWithItems('venue-1', {
      staffId: 'staff-1',
      items: [{ productId: 'prod-1', quantity: 1 }],
    })

    expect(prismaMock.order.findUnique).not.toHaveBeenCalled()
    expect(prismaMock.order.create).toHaveBeenCalledTimes(1)
    expect(result.id).toBe('order-existing')
  })

  it('still rethrows non-P2002 create errors unchanged', async () => {
    mockHappyCreatePath()
    prismaMock.order.findUnique.mockResolvedValue(null)
    prismaMock.order.create.mockRejectedValue(new Error('db down'))

    await expect(
      createOrderWithItems('venue-1', {
        staffId: 'staff-1',
        items: [{ productId: 'prod-1', quantity: 1 }],
        externalId: 'retry-key-4',
      }),
    ).rejects.toThrow('db down')
  })
})
