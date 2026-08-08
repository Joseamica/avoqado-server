/**
 * Supplier scorecard: honest on-time delivery and fill rate.
 *
 * PITS decides who they buy from with these numbers, so a flattering calculation does more
 * damage than having no number at all.
 *
 * THE DEFECT BEING FIXED: on-time delivery returned `false` when the committed date was
 * missing, and that `false` was taken out of the numerator but STAYED in the denominator.
 * A supplier nobody ever set a date for showed up with 0% on-time delivery — graded as
 * terrible because of data that was never captured.
 *
 * WHAT WAS MISSING: the fill rate (the "IF" in OTIF). We knew whether it arrived on time,
 * not whether it arrived complete. In a convenience store, the shortfall is what empties
 * the shelf.
 */

import prisma from '@/utils/prismaClient'
import { getSupplierPerformance } from '@/services/dashboard/supplier.service'
import { Decimal } from '@prisma/client/runtime/library'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    supplier: { findFirst: jest.fn() },
    purchaseOrder: { findMany: jest.fn() },
  },
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

const mockedPrisma = prisma as unknown as {
  supplier: { findFirst: jest.Mock }
  purchaseOrder: { findMany: jest.Mock }
}

const VENUE = 'venue-1'
const SUPPLIER = 'supplier-1'

function order(over: Partial<any> = {}) {
  return {
    id: 'po-1',
    status: 'RECEIVED',
    total: new Decimal(1000),
    orderDate: new Date('2026-07-01'),
    expectedDeliveryDate: new Date('2026-07-05'),
    receivedDate: new Date('2026-07-04'),
    items: [{ quantityOrdered: new Decimal(100), quantityReceived: new Decimal(100) }],
    ...over,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockedPrisma.supplier.findFirst.mockResolvedValue({
    id: SUPPLIER,
    name: 'Distribuidora del Bajío',
    rating: new Decimal(4),
    reliabilityScore: new Decimal(0.8),
  })
})

describe('fill rate', () => {
  it('🔴 out of what was ordered, how much actually arrived', async () => {
    mockedPrisma.purchaseOrder.findMany.mockResolvedValue([
      order({ items: [{ quantityOrdered: new Decimal(100), quantityReceived: new Decimal(80) }] }),
    ])

    const r = await getSupplierPerformance(VENUE, SUPPLIER)

    expect(r.fillRate).toBe(80)
  })

  it('🔴 an over-delivery does NOT cover up a shortfall on another line', async () => {
    // Ordered 100 and 100. Received 200 and 0. Raw, that reads as 100% and the buyer never
    // finds out a whole item was missing. Capped per line: 50%.
    mockedPrisma.purchaseOrder.findMany.mockResolvedValue([
      order({
        items: [
          { quantityOrdered: new Decimal(100), quantityReceived: new Decimal(200) },
          { quantityOrdered: new Decimal(100), quantityReceived: new Decimal(0) },
        ],
      }),
    ])

    const r = await getSupplierPerformance(VENUE, SUPPLIER)

    expect(r.fillRate).toBe(50)
    expect(r.linesFullyDelivered).toBe(1)
    expect(r.linesShort).toBe(1)
  })

  it('a perfect delivery is 100%', async () => {
    mockedPrisma.purchaseOrder.findMany.mockResolvedValue([order()])

    const r = await getSupplierPerformance(VENUE, SUPPLIER)

    expect(r.fillRate).toBe(100)
    expect(r.linesShort).toBe(0)
  })

  it('a line that was never received counts as zero, it is not ignored', async () => {
    mockedPrisma.purchaseOrder.findMany.mockResolvedValue([
      order({ items: [{ quantityOrdered: new Decimal(50), quantityReceived: null }] }),
    ])

    const r = await getSupplierPerformance(VENUE, SUPPLIER)

    expect(r.fillRate).toBe(0)
  })

  it('with no received orders it returns null, NOT 0%', async () => {
    // "There is nothing to compute it from" and "they filled 0%" are different things.
    // Confusing them sinks a brand-new supplier in any table sorted by performance.
    mockedPrisma.purchaseOrder.findMany.mockResolvedValue([order({ status: 'SENT' })])

    const r = await getSupplierPerformance(VENUE, SUPPLIER)

    expect(r.fillRate).toBeNull()
    expect(r.otifRate).toBeNull()
  })

  it('with no orders at all in the period it also returns null', async () => {
    mockedPrisma.purchaseOrder.findMany.mockResolvedValue([])

    const r = await getSupplierPerformance(VENUE, SUPPLIER)

    expect(r.fillRate).toBeNull()
    expect(r.otifRate).toBeNull()
    // This one stays at 0 on purpose: the deployed dashboard already consumes it and
    // changing its type would break clients in production.
    expect(r.onTimeDeliveryRate).toBe(0)
  })
})

describe('on-time delivery', () => {
  it('🔴 an order with NO committed date does not count as late', async () => {
    // Before: `false` was taken out of the numerator but stayed in the denominator → 0%
    // on-time delivery because of data that was never captured.
    mockedPrisma.purchaseOrder.findMany.mockResolvedValue([
      order(), // on time
      order({ id: 'po-2', expectedDeliveryDate: null }), // no committed date
    ])

    const r = await getSupplierPerformance(VENUE, SUPPLIER)

    expect(r.onTimeDeliveryRate).toBe(100)
    expect(r.ordersWithoutCommittedDate).toBe(1)
  })

  it('reports how many were left out of the calculation', async () => {
    // If that number is high, the on-time rate is not representative and whoever reads it
    // has to be able to see that, not guess it.
    mockedPrisma.purchaseOrder.findMany.mockResolvedValue([
      order({ expectedDeliveryDate: null }),
      order({ id: 'po-2', receivedDate: null }),
      order({ id: 'po-3' }),
    ])

    const r = await getSupplierPerformance(VENUE, SUPPLIER)

    expect(r.ordersWithoutCommittedDate).toBe(2)
    expect(r.onTimeDeliveryRate).toBe(100) // the only measurable one arrived on time
  })

  it('REGRESSION: a late delivery still drags the on-time rate down', async () => {
    mockedPrisma.purchaseOrder.findMany.mockResolvedValue([
      order(),
      order({ id: 'po-2', receivedDate: new Date('2026-07-10') }), // 5 days late
    ])

    const r = await getSupplierPerformance(VENUE, SUPPLIER)

    expect(r.onTimeDeliveryRate).toBe(50)
  })
})

describe('OTIF: on time AND complete', () => {
  it('🔴 on time but incomplete does NOT count as OTIF', async () => {
    // This is the number a buyer actually uses: a punctual delivery that is missing half of
    // it is no good for running the business.
    mockedPrisma.purchaseOrder.findMany.mockResolvedValue([
      order({ items: [{ quantityOrdered: new Decimal(100), quantityReceived: new Decimal(50) }] }),
    ])

    const r = await getSupplierPerformance(VENUE, SUPPLIER)

    expect(r.onTimeDeliveryRate).toBe(100)
    expect(r.otifRate).toBe(0)
  })

  it('complete but late does not count either', async () => {
    mockedPrisma.purchaseOrder.findMany.mockResolvedValue([order({ receivedDate: new Date('2026-07-20') })])

    const r = await getSupplierPerformance(VENUE, SUPPLIER)

    expect(r.fillRate).toBe(100)
    expect(r.otifRate).toBe(0)
  })

  it('on time and complete does', async () => {
    mockedPrisma.purchaseOrder.findMany.mockResolvedValue([order()])

    const r = await getSupplierPerformance(VENUE, SUPPLIER)

    expect(r.otifRate).toBe(100)
  })
})

describe('regressions in the rest of the report', () => {
  it('total spend and average order value are unchanged', async () => {
    mockedPrisma.purchaseOrder.findMany.mockResolvedValue([order(), order({ id: 'po-2', total: new Decimal(3000) })])

    const r = await getSupplierPerformance(VENUE, SUPPLIER)

    expect(r.totalSpent).toBe(4000)
    expect(r.averageOrderValue).toBe(2000)
    expect(r.orderCount).toBe(2)
  })

  it('TENANT: only looks at orders from the venue in the request', async () => {
    mockedPrisma.purchaseOrder.findMany.mockResolvedValue([order()])

    await getSupplierPerformance(VENUE, SUPPLIER)

    expect(mockedPrisma.purchaseOrder.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ venueId: VENUE, supplierId: SUPPLIER }) }),
    )
  })
})
