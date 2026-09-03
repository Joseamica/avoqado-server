// El guard de ventas por sucursal (venueSalesGuard) NO es el objeto de esta suite:
// se prueba en tests/unit/services/venueSalesGuard.test.ts. Sin este mock, cada
// servicio de venta consulta venue.salesEnabled contra un prismaMock que no lo define.
jest.mock('@/services/venueSalesGuard', () => ({
  __esModule: true,
  assertVenueSalesEnabled: jest.fn(),
}))

import { Decimal } from '@prisma/client/runtime/library'
import { Prisma } from '@prisma/client'
import { cancelOrder, createOrderWithItems, payCashOrder } from '@/services/mobile/order.mobile.service'
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

// Fase 2 (posting durable): payCashOrder crea el posting EN la tx del cobro y
// lo aplica post-commit. Defaults: posting creado + aplicado sin faltantes.
const mockCreateSalePosting = jest.fn()
const mockApplySalePosting = jest.fn()
jest.mock('@/services/inventory/inventoryPosting.service', () => ({
  __esModule: true,
  createSalePostingInTx: (...args: unknown[]) => mockCreateSalePosting(...args),
  applySalePosting: (...args: unknown[]) => mockApplySalePosting(...args),
}))
jest.mock('@/services/dashboard/autoReorder.service', () => ({
  __esModule: true,
  runAutoReorderForVenue: jest.fn().mockResolvedValue(undefined),
}))

describe('order.mobile.service', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.$transaction.mockImplementation(async (callback: any) => callback(prismaMock))
    // payCashOrder sums prior COMPLETED payments (split-the-bill); default: none.
    prismaMock.payment.findMany.mockResolvedValue([])
    prismaMock.orderItem.findMany.mockResolvedValue([])
    mockCreateSalePosting.mockResolvedValue({ id: 'posting-1', status: 'PENDING' })
    mockApplySalePosting.mockResolvedValue({ postingId: 'posting-1', applied: true, issues: [] })
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
    prismaMock.product.findMany.mockResolvedValue([
      { id: 'prod-1', name: 'Hamburguesa', price: new Decimal(100), category: { name: 'Comida' } },
    ])
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
    prismaMock.product.findMany.mockResolvedValue([
      { id: 'prod-1', name: 'Hamburguesa', price: new Decimal(100), category: { name: 'Comida' } },
    ])
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
    prismaMock.product.findMany.mockResolvedValue([
      { id: 'prod-1', name: 'Hamburguesa', price: new Decimal(100), category: { name: 'Comida' } },
    ])
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
    prismaMock.product.findMany.mockResolvedValue([
      { id: 'prod-1', name: 'Hamburguesa', price: new Decimal(100), category: { name: 'Comida' } },
    ])
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

  // ── Fix 2: ITEM/CATEGORY discount scope enforcement (shared discount.service) ──

  it('rejects an ITEM discount applied to a non-targeted product', async () => {
    prismaMock.staff.findUnique.mockResolvedValue({ id: 'staff-1', venueId: 'venue-1' })
    prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1', staffId: 'staff-1', venueId: 'venue-1', active: true })
    prismaMock.product.findMany.mockResolvedValue([
      { id: 'prod-2', name: 'Refresco', price: new Decimal(30), category: { name: 'Bebidas' }, categoryId: 'cat-bebidas' },
    ])
    prismaMock.modifier.findMany.mockResolvedValue([])
    prismaMock.discount.findMany.mockResolvedValue([
      {
        id: 'disc-item',
        venueId: 'venue-1',
        name: 'Solo hamburguesas',
        type: 'PERCENTAGE',
        value: new Decimal(20),
        active: true,
        scope: 'ITEM',
        targetItemIds: ['prod-1'], // does NOT include prod-2
      },
    ])

    await expect(
      createOrderWithItems('venue-1', {
        staffId: 'staff-1',
        items: [{ productId: 'prod-2', quantity: 1, discountId: 'disc-item' }],
        source: 'AVOQADO_IOS',
      }),
    ).rejects.toThrow('Descuento "Solo hamburguesas" no aplica a este producto')

    expect(prismaMock.order.create).not.toHaveBeenCalled()
  })

  it('applies a CATEGORY discount when the product category matches', async () => {
    prismaMock.staff.findUnique.mockResolvedValue({ id: 'staff-1', venueId: 'venue-1' })
    prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1', staffId: 'staff-1', venueId: 'venue-1', active: true })
    prismaMock.product.findMany.mockResolvedValue([
      { id: 'prod-1', name: 'Hamburguesa', price: new Decimal(100), category: { name: 'Comida' }, categoryId: 'cat-comida' },
    ])
    prismaMock.modifier.findMany.mockResolvedValue([])
    prismaMock.discount.findMany.mockResolvedValue([
      {
        id: 'disc-cat',
        venueId: 'venue-1',
        name: '10% Comida',
        type: 'PERCENTAGE',
        value: new Decimal(10),
        active: true,
        scope: 'CATEGORY',
        targetCategoryIds: ['cat-comida'],
      },
    ])
    prismaMock.order.create.mockResolvedValue({
      id: 'order-1',
      orderNumber: 'ORD-1',
      status: 'CONFIRMED',
      paymentStatus: 'PENDING',
      subtotal: new Decimal(100),
      discountAmount: new Decimal(10),
      taxAmount: new Decimal(0),
      total: new Decimal(90),
      createdAt: new Date('2026-07-03T10:00:00.000Z'),
      items: [],
    })

    const result = await createOrderWithItems('venue-1', {
      staffId: 'staff-1',
      items: [{ productId: 'prod-1', quantity: 1, discountId: 'disc-cat' }],
      source: 'AVOQADO_IOS',
    })

    expect(result.discountAmount).toBe(10)
    expect(result.total).toBe(90)
  })

  it('rejects a CATEGORY discount when the product category does not match', async () => {
    prismaMock.staff.findUnique.mockResolvedValue({ id: 'staff-1', venueId: 'venue-1' })
    prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1', staffId: 'staff-1', venueId: 'venue-1', active: true })
    prismaMock.product.findMany.mockResolvedValue([
      { id: 'prod-2', name: 'Refresco', price: new Decimal(30), category: { name: 'Bebidas' }, categoryId: 'cat-bebidas' },
    ])
    prismaMock.modifier.findMany.mockResolvedValue([])
    prismaMock.discount.findMany.mockResolvedValue([
      {
        id: 'disc-cat',
        venueId: 'venue-1',
        name: '10% Comida',
        type: 'PERCENTAGE',
        value: new Decimal(10),
        active: true,
        scope: 'CATEGORY',
        targetCategoryIds: ['cat-comida'], // does NOT include cat-bebidas
      },
    ])

    await expect(
      createOrderWithItems('venue-1', {
        staffId: 'staff-1',
        items: [{ productId: 'prod-2', quantity: 1, discountId: 'disc-cat' }],
        source: 'AVOQADO_IOS',
      }),
    ).rejects.toThrow('Descuento "10% Comida" no aplica a la categoría de este producto')

    expect(prismaMock.order.create).not.toHaveBeenCalled()
  })

  it('applies an ITEM discount with empty targetItemIds to any product (wildcard)', async () => {
    prismaMock.staff.findUnique.mockResolvedValue({ id: 'staff-1', venueId: 'venue-1' })
    prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1', staffId: 'staff-1', venueId: 'venue-1', active: true })
    prismaMock.product.findMany.mockResolvedValue([
      { id: 'prod-2', name: 'Refresco', price: new Decimal(30), category: { name: 'Bebidas' }, categoryId: 'cat-bebidas' },
    ])
    prismaMock.modifier.findMany.mockResolvedValue([])
    prismaMock.discount.findMany.mockResolvedValue([
      {
        id: 'disc-item-wildcard',
        venueId: 'venue-1',
        name: '5% cualquier producto',
        type: 'PERCENTAGE',
        value: new Decimal(5),
        active: true,
        scope: 'ITEM',
        targetItemIds: [], // empty = applies to all products
      },
    ])
    prismaMock.order.create.mockResolvedValue({
      id: 'order-1',
      orderNumber: 'ORD-1',
      status: 'CONFIRMED',
      paymentStatus: 'PENDING',
      subtotal: new Decimal(30),
      discountAmount: new Decimal(1.5),
      taxAmount: new Decimal(0),
      total: new Decimal(28.5),
      createdAt: new Date('2026-07-03T10:00:00.000Z'),
      items: [],
    })

    const result = await createOrderWithItems('venue-1', {
      staffId: 'staff-1',
      items: [{ productId: 'prod-2', quantity: 1, discountId: 'disc-item-wildcard' }],
      source: 'AVOQADO_IOS',
    })

    expect(result.discountAmount).toBe(1.5)
    expect(result.total).toBe(28.5)
  })

  it('applies a CATEGORY discount with empty targetCategoryIds to any category (wildcard)', async () => {
    prismaMock.staff.findUnique.mockResolvedValue({ id: 'staff-1', venueId: 'venue-1' })
    prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1', staffId: 'staff-1', venueId: 'venue-1', active: true })
    prismaMock.product.findMany.mockResolvedValue([
      { id: 'prod-1', name: 'Hamburguesa', price: new Decimal(100), category: { name: 'Comida' }, categoryId: 'cat-comida' },
    ])
    prismaMock.modifier.findMany.mockResolvedValue([])
    prismaMock.discount.findMany.mockResolvedValue([
      {
        id: 'disc-cat-wildcard',
        venueId: 'venue-1',
        name: '10% cualquier categoría',
        type: 'PERCENTAGE',
        value: new Decimal(10),
        active: true,
        scope: 'CATEGORY',
        targetCategoryIds: [], // empty = applies to all categories
      },
    ])
    prismaMock.order.create.mockResolvedValue({
      id: 'order-1',
      orderNumber: 'ORD-1',
      status: 'CONFIRMED',
      paymentStatus: 'PENDING',
      subtotal: new Decimal(100),
      discountAmount: new Decimal(10),
      taxAmount: new Decimal(0),
      total: new Decimal(90),
      createdAt: new Date('2026-07-03T10:00:00.000Z'),
      items: [],
    })

    const result = await createOrderWithItems('venue-1', {
      staffId: 'staff-1',
      items: [{ productId: 'prod-1', quantity: 1, discountId: 'disc-cat-wildcard' }],
      source: 'AVOQADO_IOS',
    })

    expect(result.discountAmount).toBe(10)
    expect(result.total).toBe(90)
  })

  it('rejects an ORDER-scoped discount sent as a per-item discountId', async () => {
    prismaMock.staff.findUnique.mockResolvedValue({ id: 'staff-1', venueId: 'venue-1' })
    prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1', staffId: 'staff-1', venueId: 'venue-1', active: true })
    prismaMock.product.findMany.mockResolvedValue([
      { id: 'prod-1', name: 'Hamburguesa', price: new Decimal(100), category: { name: 'Comida' }, categoryId: 'cat-comida' },
    ])
    prismaMock.modifier.findMany.mockResolvedValue([])
    prismaMock.discount.findMany.mockResolvedValue([
      {
        id: 'disc-order',
        venueId: 'venue-1',
        name: 'Descuento de orden',
        type: 'FIXED_AMOUNT',
        value: new Decimal(15),
        active: true,
        scope: 'ORDER',
      },
    ])

    await expect(
      createOrderWithItems('venue-1', {
        staffId: 'staff-1',
        items: [{ productId: 'prod-1', quantity: 1, discountId: 'disc-order' }],
        source: 'AVOQADO_IOS',
      }),
    ).rejects.toThrow('Descuento "Descuento de orden" es de alcance de orden y no puede aplicarse a un artículo individual')

    expect(prismaMock.order.create).not.toHaveBeenCalled()
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
    // Cobro atómico (§5.4): la transición de pago es un `updateMany` CONDICIONAL
    // (CAS sobre `version`) evaluado DENTRO de la transacción, no un `update` ciego.
    prismaMock.order.updateMany.mockResolvedValue({ count: 1 })

    await payCashOrder('venue-1', 'order-1', {
      amount: 9000,
      tip: 0,
      staffId: 'staff-1',
    })

    expect(prismaMock.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'order-1', venueId: 'venue-1', paymentStatus: { in: ['PENDING', 'PARTIAL'] } }),
        data: expect.objectContaining({
          paymentStatus: 'PAID',
          status: 'COMPLETED',
          paidAmount: new Decimal(90),
          remainingBalance: 0,
          total: new Decimal(90),
          version: { increment: 1 },
        }),
      }),
    )
  })

  // Split-the-bill: payments accumulate across calls — the FIRST half marks the
  // order PARTIAL, the SECOND half (with a prior COMPLETED payment on file)
  // converges to PAID. Regression for the bug where each payment was compared
  // to the full total in isolation and a split check never reached PAID.
  it('marks order PARTIAL on a half payment and PAID once cumulative payments cover the total', async () => {
    const orderRow = {
      id: 'order-1',
      orderNumber: 'ORD-1',
      paymentStatus: 'PENDING',
      subtotal: new Decimal(100),
      discountAmount: new Decimal(0),
      total: new Decimal(100),
      remainingBalance: new Decimal(100),
      venueId: 'venue-1',
    }
    prismaMock.order.findUnique.mockResolvedValue(orderRow)
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
    prismaMock.order.updateMany.mockResolvedValue({ count: 1 })

    // First half: no prior payments → PARTIAL with $50 remaining.
    prismaMock.payment.findMany.mockResolvedValue([])
    await payCashOrder('venue-1', 'order-1', { amount: 5000, tip: 0, staffId: 'staff-1' })
    expect(prismaMock.order.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          paymentStatus: 'PARTIAL',
          paidAmount: new Decimal(50),
          remainingBalance: 50,
        }),
      }),
    )
    // 🔴 El abono parcial ya NO escribe `status`. Antes ponía `PENDING`, o sea
    // que devolvía de etapa una comanda ya CONFIRMED/PREPARING por un evento de
    // caja. Detalle y la regla completa:
    // `tests/unit/services/mobile/orderStatus.partialPayment.test.ts`.
    expect(prismaMock.order.updateMany.mock.calls.at(-1)![0].data).not.toHaveProperty('status')

    // Second half: one COMPLETED $50 payment on file → cumulative $100 → PAID.
    prismaMock.order.findUnique.mockResolvedValue({ ...orderRow, paymentStatus: 'PARTIAL' })
    prismaMock.payment.findMany.mockResolvedValue([{ amount: new Decimal(50), tipAmount: new Decimal(0) }])
    await payCashOrder('venue-1', 'order-1', { amount: 5000, tip: 0, staffId: 'staff-1' })
    // `toHaveBeenCalledWith`, no `Last`: al quedar PAID corre `awardLoyaltyForPaidOrder`,
    // que escribe DESPUÉS su propio `order.updateMany` con la marca de lealtad
    // (`loyaltyProcessedAt`). Esa marca lleva otro `where` y sólo toca campos de lealtad,
    // así que no revierte nada — pero deja de ser la última. Lo que esta prueba cuida es
    // que el cobro haya escrito PAID/COMPLETED, no que nadie escriba después.
    // (El abono PARCIAL de arriba conserva `Last`: no queda pagada, así que no hay lealtad.)
    expect(prismaMock.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          paymentStatus: 'PAID',
          status: 'COMPLETED',
          paidAmount: new Decimal(100),
          remainingBalance: 0,
        }),
      }),
    )
  })

  // 🔴 La COSTURA que no cubría nadie. `loyaltyOnPaidOrder.test.ts` prueba el helper con su
  // PROPIO mock de Prisma, y `payCashOrder.loyalty.test.ts` prueba la llamada con el helper
  // MOCKEADO. El helper real corriendo dentro de `payCashOrder` —que es lo que pasa en
  // producción— no lo ejercitaba ninguna de las dos, y por ahí se coló que `orderCustomer`
  // faltara en el mock global (2026-09-02): cada cobro en efectivo entraba al catch del
  // helper y marcaba `loyaltyLastError`, con las pruebas en verde. Esto caza esa familia
  // entera — cualquier modelo que el helper consulte y el mock no declare la tumba.
  it('🔴 al saldar la cuenta la lealtad COMPLETA: la orden queda procesada y sin loyaltyLastError', async () => {
    prismaMock.order.findUnique.mockResolvedValue({
      id: 'order-1',
      orderNumber: 'ORD-1',
      paymentStatus: 'PENDING',
      subtotal: new Decimal(100),
      discountAmount: new Decimal(0),
      total: new Decimal(100),
      remainingBalance: new Decimal(100),
      venueId: 'venue-1',
    })
    prismaMock.staff.findUnique.mockResolvedValue({ id: 'staff-1' })
    prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1', staffId: 'staff-1', venueId: 'venue-1', active: true })
    prismaMock.shift.findFirst.mockResolvedValue(null)
    prismaMock.payment.create.mockResolvedValue({ id: 'payment-1' })
    prismaMock.venueTransaction.create.mockResolvedValue({ id: 'vtx-1' })
    prismaMock.paymentAllocation.create.mockResolvedValue({ id: 'alloc-1' })
    prismaMock.order.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.payment.findMany.mockResolvedValue([])

    await payCashOrder('venue-1', 'order-1', { amount: 10000, tip: 0, staffId: 'staff-1' })

    const marcas = prismaMock.order.updateMany.mock.calls.map((call: unknown[]) => (call[0] as { data: Record<string, unknown> }).data)
    expect(marcas).toContainEqual(expect.objectContaining({ loyaltyProcessedAt: expect.any(Date), loyaltyLastError: null }))
    expect(marcas.filter((d: Record<string, unknown>) => d.loyaltyLastError)).toEqual([])
  })

  // ── Aviso de inventario post-cobro (Square-parity, mockup ②) ──
  // La deducción corre DESPUÉS de registrar el cobro y nunca lo bloquea; lo que
  // cambia es que la respuesta ahora trae `inventoryWarning` para que el POS
  // pinte el toast ámbar. El contrato es el mismo OrderInventoryWarning del TPV.
  describe('payCashOrder — inventoryWarning post-cobro', () => {
    const arrangeFullyPaid = () => {
      prismaMock.order.findUnique.mockResolvedValue({
        id: 'order-1',
        orderNumber: 'ORD-1',
        paymentStatus: 'PENDING',
        subtotal: new Decimal(45),
        discountAmount: new Decimal(0),
        total: new Decimal(45),
        remainingBalance: new Decimal(45),
        venueId: 'venue-1',
      })
      prismaMock.staff.findUnique.mockResolvedValue({ id: 'staff-1' })
      prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1', staffId: 'staff-1', venueId: 'venue-1', active: true })
      prismaMock.shift.findFirst.mockResolvedValue(null)
      prismaMock.payment.create.mockResolvedValue({ id: 'payment-1' })
      prismaMock.venueTransaction.create.mockResolvedValue({ id: 'vtx-1' })
      prismaMock.paymentAllocation.create.mockResolvedValue({ id: 'alloc-1' })
      prismaMock.order.updateMany.mockResolvedValue({ count: 1 })
    }

    it('trae INSUFFICIENT_INVENTORY cuando la venta dejó stock en negativo (la deducción SÍ corrió)', async () => {
      arrangeFullyPaid()
      mockApplySalePosting.mockResolvedValue({
        postingId: 'posting-1',
        applied: true,
        issues: [
          { productId: 'p1', productName: 'Cerveza Corona', requested: 1, available: -1, reason: 'la venta dejó el stock en negativo' },
        ],
      })

      const res = await payCashOrder('venue-1', 'order-1', { amount: 4500, tip: 0, staffId: 'staff-1' })

      expect(res.inventoryWarning).toBeDefined()
      expect(res.inventoryWarning!.code).toBe('INSUFFICIENT_INVENTORY')
      expect(res.inventoryWarning!.inventoryDeducted).toBe(true)
      expect(res.inventoryWarning!.message).toContain('Cerveza Corona')
      expect(res.status).toBe('COMPLETED')
    })

    it('trae INVENTORY_NOT_DEDUCTED cuando la deducción de un producto falló', async () => {
      arrangeFullyPaid()
      mockApplySalePosting.mockResolvedValue({
        postingId: 'posting-1',
        applied: false,
        issues: [{ productId: 'p1', productName: 'Hamburguesa BBQ', requested: 2, available: null, reason: 'DB timeout' }],
      })

      const res = await payCashOrder('venue-1', 'order-1', { amount: 4500, tip: 0, staffId: 'staff-1' })

      expect(res.inventoryWarning!.code).toBe('INVENTORY_NOT_DEDUCTED')
      expect(res.inventoryWarning!.inventoryDeducted).toBe(false)
      expect(res.status).toBe('COMPLETED')
    })

    it('sin faltantes NO incluye inventoryWarning (campo aditivo)', async () => {
      arrangeFullyPaid()
      mockApplySalePosting.mockResolvedValue({ postingId: 'posting-1', applied: true, issues: [] })

      const res = await payCashOrder('venue-1', 'order-1', { amount: 4500, tip: 0, staffId: 'staff-1' })

      expect(res.inventoryWarning).toBeUndefined()
      expect(res.status).toBe('COMPLETED')
      // El posting nació DENTRO de la transacción del cobro.
      expect(mockCreateSalePosting).toHaveBeenCalled()
    })

    it('si la deducción revienta, el cobro responde COMPLETED igual (never-throws)', async () => {
      arrangeFullyPaid()
      mockApplySalePosting.mockRejectedValue(new Error('boom'))

      const res = await payCashOrder('venue-1', 'order-1', { amount: 4500, tip: 0, staffId: 'staff-1' })

      expect(res.status).toBe('COMPLETED')
      expect(res.inventoryWarning).toBeUndefined()
    })

    it('un pago PARCIAL no deduce ni trae aviso', async () => {
      arrangeFullyPaid()

      const res = await payCashOrder('venue-1', 'order-1', { amount: 2000, tip: 0, staffId: 'staff-1' })

      // Pago PARCIAL: ni posting ni aplicación.
      expect(mockCreateSalePosting).not.toHaveBeenCalled()
      expect(mockApplySalePosting).not.toHaveBeenCalled()
      expect(res.inventoryWarning).toBeUndefined()
    })
  })
})

// ── Idempotency via externalId (offline-retry safety, mirrors TPV createOrder) ──

describe('createOrderWithItems — enums del body validados ANTES de tocar la DB (/full-testing 2026-08-18)', () => {
  // Un `source`/`orderType` fuera del enum llegaba a `tx.order.create()` y Prisma reventaba con 500
  // + ruta absoluta del servicio en el body. Es un dato inválido del cliente: 400 en español.
  it('source fuera del enum → BadRequestError, sin llamar a order.create', async () => {
    await expect(
      createOrderWithItems('venue-1', { staffId: 'staff-1', items: [{ productId: 'prod-1', quantity: 1 }], source: 'WHATEVER' } as any),
    ).rejects.toThrow(/origen de la orden/i)
    expect(prismaMock.order.create).not.toHaveBeenCalled()
  })

  it('orderType fuera del enum → BadRequestError, sin llamar a order.create', async () => {
    await expect(
      createOrderWithItems('venue-1', {
        staffId: 'staff-1',
        items: [{ productId: 'prod-1', quantity: 1 }],
        source: 'AVOQADO_ANDROID',
        orderType: 'NOPE',
      } as any),
    ).rejects.toThrow(/tipo de orden/i)
    expect(prismaMock.order.create).not.toHaveBeenCalled()
  })
})

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

describe('cancelOrder — guard against live terminal charges', () => {
  // The activity-log service is mocked globally in tests/__helpers__/setup.ts —
  // assert against the mocked logAction, not prisma.activityLog.
  const { logAction } = require('@/services/dashboard/activity-log.service')

  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.order.findUnique.mockResolvedValue({ id: 'order-1', paymentStatus: 'PENDING', status: 'CONFIRMED' })
    prismaMock.order.update.mockResolvedValue({ id: 'order-1', status: 'CANCELLED' })
  })

  it('409s when the order has a LIVE terminal charge (PENDING/SENT/UNKNOWN) — the order must stay open', async () => {
    prismaMock.terminalPaymentRequest.findFirst.mockResolvedValue({ requestId: 'REQ-LIVE' })

    await expect(cancelOrder('venue-1', 'order-1', 'cliente se fue', 'staff-1')).rejects.toMatchObject({ statusCode: 409 })
    expect(prismaMock.order.update).not.toHaveBeenCalled()
  })

  it('cancels normally when no live charge exists (a CANCEL_REQUESTED row does not match the guard query) and audits ORDER_CANCELLED', async () => {
    prismaMock.terminalPaymentRequest.findFirst.mockResolvedValue(null)

    await cancelOrder('venue-1', 'order-1', 'cliente se fue', 'staff-1')

    expect(prismaMock.order.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'CANCELLED' }) }),
    )
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ORDER_CANCELLED', entity: 'Order', entityId: 'order-1', staffId: 'staff-1', venueId: 'venue-1' }),
    )
  })

  it('regression: still rejects cancelling a PAID order before ever consulting the terminal guard', async () => {
    prismaMock.order.findUnique.mockResolvedValue({ id: 'order-1', paymentStatus: 'PAID', status: 'CONFIRMED' })

    await expect(cancelOrder('venue-1', 'order-1')).rejects.toMatchObject({ statusCode: 400 })
    expect(prismaMock.terminalPaymentRequest.findFirst).not.toHaveBeenCalled()
    expect(prismaMock.order.update).not.toHaveBeenCalled()
  })

  // 🔴 Auditoría de permisos de piso, caso #9: esta ruta pasó al permiso ACOTADO
  // `orders:cancel-unpaid`, que le da al mostrador deshacer la venta que el POS acaba de
  // crear. Para que "sin cobrar" sea verdad y no un nombre bonito, la cancelación tiene
  // que ser INCAPAZ de tocar una orden con dinero encima. PAID ya se rechazaba; PARTIAL
  // no, y una cuenta a medio pagar que se cancelaba se llevaba el registro del dinero ya
  // cobrado. Aplica a todos, MANAGER+ incluido: con pagos hechos se reembolsa primero.
  it('rechaza cancelar una orden PARTIAL: ese dinero ya se cobró y hay que reembolsarlo primero', async () => {
    prismaMock.order.findUnique.mockResolvedValue({ id: 'order-1', paymentStatus: 'PARTIAL', status: 'CONFIRMED' })

    await expect(cancelOrder('venue-1', 'order-1')).rejects.toMatchObject({ statusCode: 400 })
    expect(prismaMock.terminalPaymentRequest.findFirst).not.toHaveBeenCalled()
    expect(prismaMock.order.update).not.toHaveBeenCalled()
  })

  it('una orden PENDING (sin un solo peso encima) sí se cancela — es el caso del cliente que se arrepiente', async () => {
    prismaMock.order.findUnique.mockResolvedValue({ id: 'order-1', paymentStatus: 'PENDING', status: 'CONFIRMED' })
    prismaMock.terminalPaymentRequest.findFirst.mockResolvedValue(null)

    await cancelOrder('venue-1', 'order-1', 'cliente se arrepintió', 'staff-1')

    expect(prismaMock.order.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'CANCELLED' }) }),
    )
  })
})
