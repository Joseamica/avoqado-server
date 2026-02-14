import { prismaMock } from '@tests/__helpers__/setup'
import { commandCenterService } from '@/services/command-center/commandCenter.service'

// Helper: creates a mock order for getSummary tests
function createMockOrder(overrides: {
  total: number
  staffId: string
  staffFirst: string
  staffLast: string
  photoUrl?: string | null
  items: Array<{ categoryName: string; productId: string; quantity: number; total: number }>
}) {
  return {
    total: overrides.total,
    createdBy: {
      id: overrides.staffId,
      firstName: overrides.staffFirst,
      lastName: overrides.staffLast,
      photoUrl: overrides.photoUrl ?? null,
    },
    items: overrides.items.map(i => ({
      categoryName: i.categoryName,
      productId: i.productId,
      quantity: i.quantity,
      total: i.total,
    })),
  }
}

describe('CommandCenterService', () => {
  const venueId = 'venue-1'

  // ─── getSummary ───────────────────────────────────────────────

  describe('getSummary', () => {
    it('should return complete summary with realistic data', async () => {
      const orders = [
        createMockOrder({
          total: 150,
          staffId: 'staff-1',
          staffFirst: 'Juan',
          staffLast: 'Perez',
          items: [
            { categoryName: 'Bebidas', productId: 'prod-1', quantity: 2, total: 80 },
            { categoryName: 'Comida', productId: 'prod-2', quantity: 1, total: 70 },
          ],
        }),
        createMockOrder({
          total: 200,
          staffId: 'staff-2',
          staffFirst: 'Ana',
          staffLast: 'Lopez',
          photoUrl: 'photo.jpg',
          items: [
            { categoryName: 'Bebidas', productId: 'prod-1', quantity: 3, total: 120 },
            { categoryName: 'Postres', productId: 'prod-3', quantity: 1, total: 80 },
          ],
        }),
      ]

      prismaMock.order.findMany.mockResolvedValue(orders)
      prismaMock.order.aggregate
        .mockResolvedValueOnce({ _sum: { total: 1000 } }) // week
        .mockResolvedValueOnce({ _sum: { total: 3000 } }) // month
      prismaMock.orderItem.aggregate
        .mockResolvedValueOnce({ _sum: { quantity: 15 } }) // week
        .mockResolvedValueOnce({ _sum: { quantity: 40 } }) // month
      prismaMock.timeEntry.findMany.mockResolvedValue([{ staffId: 'staff-1' }, { staffId: 'staff-2' }])
      prismaMock.staffVenue.count.mockResolvedValue(5)

      const result = await commandCenterService.getSummary(venueId)

      // Sales
      expect(result.todaySales).toBe(350)
      expect(result.todayUnits).toBe(7) // sum of quantities: (2+1) + (3+1)
      expect(result.avgTicket).toBe(175) // 350 / 2 orders
      expect(result.weekSales).toBe(1000)
      expect(result.weekUnits).toBe(15)
      expect(result.monthSales).toBe(3000)
      expect(result.monthUnits).toBe(40)

      // Promoters
      expect(result.activePromoters).toBe(2)
      expect(result.totalPromoters).toBe(5)

      // Top sellers - Ana has higher sales so ranks first
      expect(result.topSellers).toHaveLength(2)
      expect(result.topSellers[0]).toEqual(expect.objectContaining({ name: 'Ana Lopez', sales: 200, rank: 1 }))
      expect(result.topSellers[1]).toEqual(expect.objectContaining({ name: 'Juan Perez', sales: 150, rank: 2 }))

      // Category breakdown
      expect(result.categoryBreakdown.length).toBeGreaterThan(0)
      const bebidas = result.categoryBreakdown.find(c => c.name === 'Bebidas')
      expect(bebidas).toBeDefined()
      expect(bebidas!.units).toBe(5) // quantity 2 + 3
      expect(bebidas!.sales).toBe(200) // 80 + 120
    })

    it('should return zeros and empty arrays for venue with no data', async () => {
      prismaMock.order.findMany.mockResolvedValue([])
      prismaMock.order.aggregate.mockResolvedValueOnce({ _sum: { total: 0 } }).mockResolvedValueOnce({ _sum: { total: 0 } })
      prismaMock.orderItem.aggregate.mockResolvedValueOnce({ _sum: { quantity: 0 } }).mockResolvedValueOnce({ _sum: { quantity: 0 } })
      prismaMock.timeEntry.findMany.mockResolvedValue([])
      prismaMock.staffVenue.count.mockResolvedValue(0)

      const result = await commandCenterService.getSummary(venueId)

      expect(result.todaySales).toBe(0)
      expect(result.todayUnits).toBe(0)
      expect(result.avgTicket).toBe(0)
      expect(result.weekSales).toBe(0)
      expect(result.weekUnits).toBe(0)
      expect(result.monthSales).toBe(0)
      expect(result.monthUnits).toBe(0)
      expect(result.topSellers).toEqual([])
      expect(result.categoryBreakdown).toEqual([])
    })

    it('should not divide by zero when there are no orders', async () => {
      prismaMock.order.findMany.mockResolvedValue([])
      prismaMock.order.aggregate.mockResolvedValueOnce({ _sum: { total: null } }).mockResolvedValueOnce({ _sum: { total: null } })
      prismaMock.orderItem.aggregate.mockResolvedValueOnce({ _sum: { quantity: 0 } }).mockResolvedValueOnce({ _sum: { quantity: 0 } })
      prismaMock.timeEntry.findMany.mockResolvedValue([])
      prismaMock.staffVenue.count.mockResolvedValue(0)

      const result = await commandCenterService.getSummary(venueId)

      expect(result.avgTicket).toBe(0)
      expect(Number.isFinite(result.avgTicket)).toBe(true)
    })

    it('should default to 0 when aggregate _sum.total is null', async () => {
      prismaMock.order.findMany.mockResolvedValue([])
      prismaMock.order.aggregate.mockResolvedValueOnce({ _sum: { total: null } }).mockResolvedValueOnce({ _sum: { total: null } })
      prismaMock.orderItem.aggregate.mockResolvedValueOnce({ _sum: { quantity: 0 } }).mockResolvedValueOnce({ _sum: { quantity: 0 } })
      prismaMock.timeEntry.findMany.mockResolvedValue([])
      prismaMock.staffVenue.count.mockResolvedValue(0)

      const result = await commandCenterService.getSummary(venueId)

      expect(result.weekSales).toBe(0)
      expect(result.monthSales).toBe(0)
    })
  })

  // ─── getStockVsSales ──────────────────────────────────────────

  describe('getStockVsSales', () => {
    it('should return trend array and comparison with current + previous data', async () => {
      const now = new Date()

      prismaMock.order.findMany.mockResolvedValue([
        { total: 100, createdAt: now, _count: { items: 3 } },
        { total: 200, createdAt: now, _count: { items: 5 } },
      ])
      prismaMock.order.aggregate.mockResolvedValue({
        _sum: { total: 80 },
        _count: 2,
      })
      prismaMock.orderItem.count.mockResolvedValue(4)

      const result = await commandCenterService.getStockVsSales(venueId, { days: 7 })

      expect(result.trend).toHaveLength(7)
      expect(result.comparison).toBeDefined()
      // Current: 300 sales, 8 units, 2 transactions
      // Previous: 80 sales, 4 units, 2 transactions
      // salesChange = ((300-80)/80)*100 = 275%
      expect(result.comparison.salesChange).toBeGreaterThan(0)
    })

    it('should return zero comparisons when previous period has no data', async () => {
      prismaMock.order.findMany.mockResolvedValue([{ total: 100, createdAt: new Date(), _count: { items: 2 } }])
      prismaMock.order.aggregate.mockResolvedValue({
        _sum: { total: null },
        _count: 0,
      })
      prismaMock.orderItem.count.mockResolvedValue(0)

      const result = await commandCenterService.getStockVsSales(venueId, { days: 7 })

      expect(result.comparison.salesChange).toBe(0)
      expect(result.comparison.unitsChange).toBe(0)
      expect(result.comparison.transactionsChange).toBe(0)
    })

    it('should return trend with zero values for empty current period', async () => {
      prismaMock.order.findMany.mockResolvedValue([])
      prismaMock.order.aggregate.mockResolvedValue({
        _sum: { total: null },
        _count: 0,
      })
      prismaMock.orderItem.count.mockResolvedValue(0)

      const result = await commandCenterService.getStockVsSales(venueId, { days: 3 })

      expect(result.trend).toHaveLength(3)
      for (const point of result.trend) {
        expect(point.sales).toBe(0)
        expect(point.units).toBe(0)
        expect(point.transactions).toBe(0)
      }
    })
  })
})
