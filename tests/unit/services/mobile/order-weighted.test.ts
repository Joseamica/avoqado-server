/**
 * Venta por peso (soldByWeight) — mobile order service.
 * Spec: Avoqado-HQ/specs/2026-07-18-venta-por-peso-bascula.md
 *
 * Covers: server-authoritative weighted totals (round half-up, 2 decimals),
 * validation matrix (missing weight / weight on normal product / qty≠1 / range),
 * persisted weightQuantity/weightUnit, and the payCashOrder full-payment
 * inventory-deduction hook. Plus regression: normal orders unchanged.
 */
// El guard de ventas por sucursal (venueSalesGuard) NO es el objeto de esta suite:
// se prueba en tests/unit/services/venueSalesGuard.test.ts. Sin este mock, cada
// servicio de venta consulta venue.salesEnabled contra un prismaMock que no lo define.
jest.mock('@/services/venueSalesGuard', () => ({
  __esModule: true,
  assertVenueSalesEnabled: jest.fn(),
}))

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

// payCashOrder pulls these lazily (dynamic import) for the post-payment
// deduction hook — jest's module registry intercepts dynamic imports too.
const deductMock = jest.fn().mockResolvedValue(undefined)
jest.mock('@/services/tpv/order.tpv.service', () => ({
  __esModule: true,
  deductTrackedInventoryForFreeCart: (...args: unknown[]) => deductMock(...args),
}))
const autoReorderMock = jest.fn().mockResolvedValue({ ran: false })
jest.mock('@/services/dashboard/autoReorder.service', () => ({
  __esModule: true,
  runAutoReorderForVenue: (...args: unknown[]) => autoReorderMock(...args),
}))
jest.mock('@/services/referrals/referralQualification.service', () => ({
  __esModule: true,
  onOrderPaid: jest.fn().mockResolvedValue(undefined),
}))

const flushAsync = () => new Promise(resolve => setImmediate(resolve))

function mockStaff() {
  prismaMock.staff.findUnique.mockResolvedValue({ id: 'staff-1', venueId: 'venue-1' })
  prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1', staffId: 'staff-1', venueId: 'venue-1', active: true })
}

const WEIGHTED_PRODUCT = {
  id: 'prod-jamon',
  name: 'Jamón serrano (kg)',
  price: new Decimal(420),
  sku: 'LR-CHA-001',
  soldByWeight: true,
  category: { name: 'Charcutería' },
}

const NORMAL_PRODUCT = {
  id: 'prod-taco',
  name: 'Orden de tacos',
  price: new Decimal(98),
  sku: 'LR-TAC-001',
  soldByWeight: false,
  category: { name: 'Tacos' },
}

function mockOrderCreateEcho() {
  // Echo back a minimally-valid created order; assertions read the CREATE PAYLOAD.
  prismaMock.order.create.mockImplementation(async (args: any) => ({
    id: 'order-1',
    orderNumber: 'ORD-1',
    status: 'CONFIRMED',
    paymentStatus: 'PENDING',
    subtotal: args.data.subtotal,
    discountAmount: args.data.discountAmount ?? new Decimal(0),
    taxAmount: new Decimal(0),
    total: args.data.total,
    createdAt: new Date('2026-07-18T10:00:00.000Z'),
    items: (args.data.items?.create ?? []).map((it: any, i: number) => ({
      id: `oi-${i}`,
      productId: it.productId,
      productName: it.productName,
      quantity: it.quantity,
      unitPrice: it.unitPrice,
      total: it.total,
      discountAmount: it.discountAmount ?? new Decimal(0),
      appliedDiscountId: null,
      product: it.productId ? { id: it.productId, name: it.productName } : null,
      modifiers: [],
    })),
  }))
}

describe('venta por peso — createOrderWithItems (mobile)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.$transaction.mockImplementation(async (callback: any) => callback(prismaMock))
    prismaMock.payment.findMany.mockResolvedValue([])
    prismaMock.modifier.findMany.mockResolvedValue([])
    mockStaff()
    mockOrderCreateEcho()
  })

  it('computes total = round(price × weightKg, 2) server-side and persists weightQuantity/weightUnit', async () => {
    prismaMock.product.findMany.mockResolvedValue([WEIGHTED_PRODUCT])

    await createOrderWithItems('venue-1', {
      staffId: 'staff-1',
      items: [{ productId: 'prod-jamon', quantity: 1, weightQuantity: 0.435 }],
      source: 'POS',
    })

    const createArgs = prismaMock.order.create.mock.calls[0][0]
    const line = createArgs.data.items.create[0]
    // 0.435 × 420 = 182.70 exactly
    expect(Number(line.total)).toBeCloseTo(182.7, 2)
    expect(Number(line.unitPrice)).toBe(420) // price per kg, NOT the line total
    expect(line.quantity).toBe(1)
    expect(Number(line.weightQuantity)).toBeCloseTo(0.435, 3)
    expect(line.weightUnit).toBe('KILOGRAM')
    expect(Number(createArgs.data.subtotal)).toBeCloseTo(182.7, 2)
  })

  it('rounds half-up to 2 decimals (0.335 kg × $419.99 = $140.70)', async () => {
    prismaMock.product.findMany.mockResolvedValue([{ ...WEIGHTED_PRODUCT, price: new Decimal(419.99) }])

    await createOrderWithItems('venue-1', {
      staffId: 'staff-1',
      items: [{ productId: 'prod-jamon', quantity: 1, weightQuantity: 0.335 }],
      source: 'POS',
    })

    const line = prismaMock.order.create.mock.calls[0][0].data.items.create[0]
    expect(Number(line.total)).toBe(140.7) // 140.69665 → 140.70
  })

  it('quantizes a >3-decimal weight to 3dp BEFORE the money math (review fix #3): 0.1235 → 0.124, total stays derivable', async () => {
    // A scale reporting more than 3 decimals must not let Order.total diverge from
    // the stored (Decimal 12,3) weight. 0.1235 kg → 0.124 kg; total = round(100 × 0.124) = 12.40.
    prismaMock.product.findMany.mockResolvedValue([{ ...WEIGHTED_PRODUCT, price: new Decimal(100) }])

    await createOrderWithItems('venue-1', {
      staffId: 'staff-1',
      items: [{ productId: 'prod-jamon', quantity: 1, weightQuantity: 0.1235 }],
      source: 'POS',
    })

    const line = prismaMock.order.create.mock.calls[0][0].data.items.create[0]
    expect(Number(line.weightQuantity)).toBe(0.124) // quantized to 3dp
    expect(Number(line.total)).toBe(12.4) // round(100 × 0.124) — derivable from the STORED weight
    // Invariant: total == round(price × storedWeight, 2) — no reprint/preview drift.
    expect(Number(line.total)).toBe(Math.round(100 * Number(line.weightQuantity) * 100) / 100)
  })

  it('rejects a weighted product without weightQuantity (400, Spanish)', async () => {
    prismaMock.product.findMany.mockResolvedValue([WEIGHTED_PRODUCT])

    await expect(
      createOrderWithItems('venue-1', {
        staffId: 'staff-1',
        items: [{ productId: 'prod-jamon', quantity: 1 }],
        source: 'POS',
      }),
    ).rejects.toThrow(/se vende por peso/)
  })

  it('rejects weightQuantity on a NON-weighted product', async () => {
    prismaMock.product.findMany.mockResolvedValue([NORMAL_PRODUCT])

    await expect(
      createOrderWithItems('venue-1', {
        staffId: 'staff-1',
        items: [{ productId: 'prod-taco', quantity: 1, weightQuantity: 0.5 }],
        source: 'POS',
      }),
    ).rejects.toThrow(/no se vende por peso/)
  })

  it('rejects quantity ≠ 1 on a weighted line (each weighing is its own line)', async () => {
    prismaMock.product.findMany.mockResolvedValue([WEIGHTED_PRODUCT])

    await expect(
      createOrderWithItems('venue-1', {
        staffId: 'staff-1',
        items: [{ productId: 'prod-jamon', quantity: 2, weightQuantity: 0.435 }],
        source: 'POS',
      }),
    ).rejects.toThrow(/cantidad 1/)
  })

  it('rejects out-of-range weights (> 99.999 kg)', async () => {
    prismaMock.product.findMany.mockResolvedValue([WEIGHTED_PRODUCT])

    await expect(
      createOrderWithItems('venue-1', {
        staffId: 'staff-1',
        items: [{ productId: 'prod-jamon', quantity: 1, weightQuantity: 150 }],
        source: 'POS',
      }),
    ).rejects.toThrow(/fuera de rango/)
  })

  it('REGRESSION: normal products keep price × quantity and null weight fields', async () => {
    prismaMock.product.findMany.mockResolvedValue([NORMAL_PRODUCT])

    await createOrderWithItems('venue-1', {
      staffId: 'staff-1',
      items: [{ productId: 'prod-taco', quantity: 3 }],
      source: 'POS',
    })

    const line = prismaMock.order.create.mock.calls[0][0].data.items.create[0]
    expect(Number(line.total)).toBe(294) // 98 × 3
    expect(line.quantity).toBe(3)
    expect(line.weightQuantity).toBeNull()
    expect(line.weightUnit).toBeNull()
  })
})

describe('venta por peso — payCashOrder full-payment inventory deduction hook', () => {
  const baseOrder = {
    id: 'order-1',
    orderNumber: 'ORD-1',
    paymentStatus: 'PENDING',
    subtotal: new Decimal(182.7),
    discountAmount: new Decimal(0),
    total: new Decimal(182.7),
    remainingBalance: new Decimal(182.7),
    venueId: 'venue-1',
  }

  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.$transaction.mockImplementation(async (callback: any) => callback(prismaMock))
    mockStaff()
    prismaMock.payment.findMany.mockResolvedValue([])
    prismaMock.shift.findFirst.mockResolvedValue(null)
    prismaMock.payment.create.mockResolvedValue({ id: 'pay-1' })
    prismaMock.venueTransaction.create.mockResolvedValue({ id: 'vt-1' })
    prismaMock.paymentAllocation.create.mockResolvedValue({ id: 'pa-1' })
    prismaMock.order.update.mockResolvedValue({ id: 'order-1' })
  })

  it('deducts inventory (weight-aware helper) + fires auto-reorder when the order becomes fully paid', async () => {
    const paidOrderWithItems = {
      ...baseOrder,
      items: [
        {
          id: 'oi-1',
          productId: 'prod-jamon',
          quantity: 1,
          weightQuantity: new Decimal(0.435),
          modifiers: [],
        },
      ],
    }
    prismaMock.order.findUnique.mockResolvedValueOnce(baseOrder).mockResolvedValueOnce(paidOrderWithItems)

    await payCashOrder('venue-1', 'order-1', { venueId: 'venue-1', amount: 18270, tip: 0, staffId: 'staff-1' } as any)
    await flushAsync()

    expect(deductMock).toHaveBeenCalledTimes(1)
    expect(deductMock.mock.calls[0][0]).toMatchObject({ id: 'order-1' })
    expect(autoReorderMock).toHaveBeenCalledWith('venue-1')
  })

  it('does NOT deduct on a partial payment', async () => {
    prismaMock.order.findUnique.mockResolvedValue(baseOrder)

    // Pay only half — remaining stays > 0 → PARTIAL, no deduction.
    await payCashOrder('venue-1', 'order-1', { venueId: 'venue-1', amount: 9000, tip: 0, staffId: 'staff-1' } as any)
    await flushAsync()

    expect(deductMock).not.toHaveBeenCalled()
    expect(autoReorderMock).not.toHaveBeenCalled()
  })
})
