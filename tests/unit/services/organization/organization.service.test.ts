import { prismaMock } from '@tests/__helpers__/setup'
import {
  getRevenueTrends,
  getOrganizationOverview,
  getVenueBenchmarks,
  getOrganizationVenues,
} from '@/services/organization/organization.service'
import { NotFoundError } from '@/errors/AppError'

// Helper: Prisma Decimal mock with .toNumber()
const dec = (value: number) => ({
  toNumber: () => value,
  toString: () => String(value),
})

// Reusable fixtures
const ORG_ID = 'org-1'
const MOCK_ORG = { id: ORG_ID, name: 'Avoqado Corp', email: 'org@test.com', phone: '555-0000' }
const VENUE_A = { id: 'v-a', name: 'Venue A', slug: 'venue-a', logo: null, city: 'CDMX', status: 'ACTIVE' }
const VENUE_B = { id: 'v-b', name: 'Venue B', slug: 'venue-b', logo: 'logo.png', city: 'GDL', status: 'ACTIVE' }
const VENUE_C = { id: 'v-c', name: 'Venue C', slug: 'venue-c', logo: null, city: 'MTY', status: 'ACTIVE' }

const DATE_FILTER = {
  from: new Date('2025-01-01'),
  to: new Date('2025-01-31'),
}

describe('Organization Service', () => {
  // ─── getRevenueTrends ─────────────────────────────────────────

  describe('getRevenueTrends', () => {
    it('should return trend data with revenue + orders for 2 venues', async () => {
      prismaMock.organization.findUnique.mockResolvedValue({ id: ORG_ID })
      prismaMock.venue.findMany.mockResolvedValue([VENUE_A, VENUE_B])

      // Current revenue by date
      prismaMock.$queryRaw
        .mockResolvedValueOnce([
          { date: '2025-01-15', revenue: 500 },
          { date: '2025-01-16', revenue: 700 },
        ])
        // Current orders by date
        .mockResolvedValueOnce([
          { date: '2025-01-15', count: BigInt(5) },
          { date: '2025-01-16', count: BigInt(8) },
        ])
        // Previous revenue by date
        .mockResolvedValueOnce([{ date: '2024-12-15', revenue: 400 }])
        // Previous orders by date
        .mockResolvedValueOnce([{ date: '2024-12-15', count: BigInt(4) }])

      const result = await getRevenueTrends(ORG_ID, DATE_FILTER)

      // Current period
      expect(result.currentPeriod.dataPoints).toHaveLength(2)
      expect(result.currentPeriod.dataPoints[0]).toEqual({ date: '2025-01-15', revenue: 500, orders: 5 })
      expect(result.currentPeriod.totals.revenue).toBe(1200)
      expect(result.currentPeriod.totals.orders).toBe(13)

      // Previous period
      expect(result.previousPeriod.dataPoints).toHaveLength(1)
      expect(result.previousPeriod.totals.revenue).toBe(400)

      // Comparison
      expect(result.comparison.revenueChange).toBeGreaterThan(0)
      expect(result.comparison.ordersChange).toBeGreaterThan(0)
    })

    it('should early-return with empty structure when organization has 0 venues', async () => {
      prismaMock.organization.findUnique.mockResolvedValue({ id: ORG_ID })
      prismaMock.venue.findMany.mockResolvedValue([])

      const result = await getRevenueTrends(ORG_ID, DATE_FILTER)

      expect(result.currentPeriod.dataPoints).toEqual([])
      expect(result.currentPeriod.totals).toEqual({ revenue: 0, orders: 0 })
      expect(result.previousPeriod.dataPoints).toEqual([])
      expect(result.comparison).toEqual({ revenueChange: 0, ordersChange: 0 })

      // $queryRaw should NOT have been called (early return)
      expect(prismaMock.$queryRaw).not.toHaveBeenCalled()
    })

    it('should throw NotFoundError when organization does not exist', async () => {
      prismaMock.organization.findUnique.mockResolvedValue(null)

      await expect(getRevenueTrends('nonexistent')).rejects.toThrow(NotFoundError)
    })

    it('should handle BigInt count values from $queryRaw without error', async () => {
      prismaMock.organization.findUnique.mockResolvedValue({ id: ORG_ID })
      prismaMock.venue.findMany.mockResolvedValue([VENUE_A])

      prismaMock.$queryRaw
        .mockResolvedValueOnce([{ date: '2025-01-10', revenue: 999 }])
        .mockResolvedValueOnce([{ date: '2025-01-10', count: BigInt(42) }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])

      const result = await getRevenueTrends(ORG_ID, DATE_FILTER)

      expect(result.currentPeriod.dataPoints[0].orders).toBe(42)
      expect(typeof result.currentPeriod.dataPoints[0].orders).toBe('number')
    })
  })

  // ─── getOrganizationOverview ──────────────────────────────────

  describe('getOrganizationOverview', () => {
    it('should return overview with aggregated metrics for 3 venues', async () => {
      prismaMock.organization.findUnique.mockResolvedValue(MOCK_ORG)
      prismaMock.venue.findMany.mockResolvedValue([VENUE_A, VENUE_B, VENUE_C])

      // Global aggregates
      prismaMock.payment.aggregate.mockResolvedValue({
        _sum: { amount: dec(10000) },
        _count: 50,
      })
      prismaMock.order.aggregate.mockResolvedValue({ _count: 120 })
      prismaMock.staff.count.mockResolvedValue(15)

      // Per-venue groupBy
      prismaMock.payment.groupBy.mockResolvedValue([
        { venueId: 'v-a', _sum: { amount: dec(5000) }, _count: 25 },
        { venueId: 'v-b', _sum: { amount: dec(3000) }, _count: 15 },
        { venueId: 'v-c', _sum: { amount: dec(2000) }, _count: 10 },
      ])
      prismaMock.order.groupBy.mockResolvedValue([
        { venueId: 'v-a', _count: 60 },
        { venueId: 'v-b', _count: 40 },
        { venueId: 'v-c', _count: 20 },
      ])
      prismaMock.staffVenue.groupBy.mockResolvedValue([
        { venueId: 'v-a', _count: 5 },
        { venueId: 'v-b', _count: 6 },
        { venueId: 'v-c', _count: 4 },
      ])

      const result = await getOrganizationOverview(ORG_ID, DATE_FILTER)

      expect(result.totalRevenue).toBe(10000)
      expect(result.totalOrders).toBe(120)
      expect(result.totalPayments).toBe(50)
      expect(result.totalStaff).toBe(15)
      expect(result.venueCount).toBe(3)
      expect(result.venues).toHaveLength(3)

      const venueA = result.venues.find(v => v.id === 'v-a')!
      expect(venueA.revenue).toBe(5000)
      expect(venueA.orderCount).toBe(60)
      expect(venueA.paymentCount).toBe(25)
      expect(venueA.staffCount).toBe(5)
    })

    it('should throw NotFoundError when organization does not exist', async () => {
      prismaMock.organization.findUnique.mockResolvedValue(null)

      await expect(getOrganizationOverview('nonexistent')).rejects.toThrow(NotFoundError)
    })

    it('should default venue metrics to 0 when venue has no data in groupBy results', async () => {
      prismaMock.organization.findUnique.mockResolvedValue(MOCK_ORG)
      prismaMock.venue.findMany.mockResolvedValue([VENUE_A])

      prismaMock.payment.aggregate.mockResolvedValue({
        _sum: { amount: null },
        _count: 0,
      })
      prismaMock.order.aggregate.mockResolvedValue({ _count: 0 })
      prismaMock.staff.count.mockResolvedValue(0)

      // Empty groupBy results - venue not present in any group
      prismaMock.payment.groupBy.mockResolvedValue([])
      prismaMock.order.groupBy.mockResolvedValue([])
      prismaMock.staffVenue.groupBy.mockResolvedValue([])

      const result = await getOrganizationOverview(ORG_ID, DATE_FILTER)

      expect(result.totalRevenue).toBe(0)
      const venueA = result.venues.find(v => v.id === 'v-a')!
      expect(venueA.revenue).toBe(0)
      expect(venueA.orderCount).toBe(0)
      expect(venueA.paymentCount).toBe(0)
      expect(venueA.staffCount).toBe(0)
    })
  })

  // ─── getOrganizationVenues ────────────────────────────────────

  describe('getOrganizationVenues', () => {
    const venueRow = (id: string, name: string) => ({
      id,
      name,
      slug: name.toLowerCase().replace(/\s/g, '-'),
      logo: null,
      address: '123 Main St',
      city: 'CDMX',
      state: 'CDMX',
      status: 'ACTIVE',
      createdAt: new Date('2024-06-01'),
    })

    it('should return venues with correct metrics and growth', async () => {
      prismaMock.venue.findMany.mockResolvedValue([venueRow('v-1', 'Cafe Norte'), venueRow('v-2', 'Cafe Sur')])

      prismaMock.payment.groupBy
        // Current period
        .mockResolvedValueOnce([
          { venueId: 'v-1', _sum: { amount: dec(1500) }, _count: 30 },
          { venueId: 'v-2', _sum: { amount: dec(800) }, _count: 20 },
        ])
        // Previous period
        .mockResolvedValueOnce([
          { venueId: 'v-1', _sum: { amount: dec(1000) } },
          { venueId: 'v-2', _sum: { amount: dec(800) } },
        ])

      prismaMock.order.groupBy.mockResolvedValue([
        { venueId: 'v-1', _count: 45 },
        { venueId: 'v-2', _count: 25 },
      ])
      prismaMock.staffVenue.groupBy.mockResolvedValue([
        { venueId: 'v-1', _count: 5 },
        { venueId: 'v-2', _count: 3 },
      ])

      const result = await getOrganizationVenues(ORG_ID, DATE_FILTER)

      expect(result).toHaveLength(2)
      const v1 = result.find(v => v.id === 'v-1')!
      expect(v1.metrics.revenue).toBe(1500)
      expect(v1.metrics.orderCount).toBe(45)
      expect(v1.metrics.staffCount).toBe(5)

      // Growth: (1500-1000)/1000 * 100 = 50%
      expect(v1.metrics.growth).toBe(50)

      // Venue B: no growth (800 → 800) = 0%
      const v2 = result.find(v => v.id === 'v-2')!
      expect(v2.metrics.growth).toBe(0)
    })

    it('should calculate 50% growth for 100→150 revenue', async () => {
      prismaMock.venue.findMany.mockResolvedValue([venueRow('v-1', 'Test')])

      prismaMock.payment.groupBy
        .mockResolvedValueOnce([{ venueId: 'v-1', _sum: { amount: dec(150) }, _count: 5 }])
        .mockResolvedValueOnce([{ venueId: 'v-1', _sum: { amount: dec(100) } }])
      prismaMock.order.groupBy.mockResolvedValue([{ venueId: 'v-1', _count: 10 }])
      prismaMock.staffVenue.groupBy.mockResolvedValue([{ venueId: 'v-1', _count: 2 }])

      const result = await getOrganizationVenues(ORG_ID, DATE_FILTER)

      // (150-100)/100 * 100 = 50
      expect(result[0].metrics.growth).toBe(50)
    })

    it('should return 100% growth when previous revenue is 0 but current > 0', async () => {
      prismaMock.venue.findMany.mockResolvedValue([venueRow('v-1', 'New Venue')])

      prismaMock.payment.groupBy
        .mockResolvedValueOnce([{ venueId: 'v-1', _sum: { amount: dec(500) }, _count: 10 }])
        .mockResolvedValueOnce([]) // No previous period data
      prismaMock.order.groupBy.mockResolvedValue([{ venueId: 'v-1', _count: 15 }])
      prismaMock.staffVenue.groupBy.mockResolvedValue([{ venueId: 'v-1', _count: 3 }])

      const result = await getOrganizationVenues(ORG_ID, DATE_FILTER)

      expect(result[0].metrics.growth).toBe(100)
    })
  })

  // ─── getVenueBenchmarks ───────────────────────────────────────

  describe('getVenueBenchmarks', () => {
    it('should return averages, benchmarks, and rankings for 3 venues', async () => {
      prismaMock.organization.findUnique.mockResolvedValue({ id: ORG_ID })
      prismaMock.venue.findMany.mockResolvedValue([
        { id: 'v-a', name: 'Venue A', slug: 'venue-a', logo: null },
        { id: 'v-b', name: 'Venue B', slug: 'venue-b', logo: null },
        { id: 'v-c', name: 'Venue C', slug: 'venue-c', logo: null },
      ])

      prismaMock.payment.groupBy.mockResolvedValue([
        { venueId: 'v-a', _sum: { amount: dec(3000) }, _count: 30 },
        { venueId: 'v-b', _sum: { amount: dec(2000) }, _count: 20 },
        { venueId: 'v-c', _sum: { amount: dec(1000) }, _count: 10 },
      ])
      prismaMock.order.groupBy.mockResolvedValue([
        { venueId: 'v-a', _count: 60 },
        { venueId: 'v-b', _count: 40 },
        { venueId: 'v-c', _count: 20 },
      ])

      const result = await getVenueBenchmarks(ORG_ID, DATE_FILTER)

      // Averages: revenue = (3000+2000+1000)/3 = 2000
      expect(result.averages.revenue).toBe(2000)
      // Averages: orders = (60+40+20)/3 = 40
      expect(result.averages.orders).toBeCloseTo(40, 0)

      expect(result.venues).toHaveLength(3)

      // Venue A is ranked #1 by revenue (highest)
      const venueA = result.venues.find(v => v.id === 'v-a')!
      expect(venueA.rank.byRevenue).toBe(1)
      // Venue A is above average: (3000-2000)/2000 * 100 = 50%
      expect(venueA.benchmarks.revenueVsAverage).toBe(50)

      // Venue C is ranked #3 by revenue (lowest)
      const venueC = result.venues.find(v => v.id === 'v-c')!
      expect(venueC.rank.byRevenue).toBe(3)
      // Venue C is below average: (1000-2000)/2000 * 100 = -50%
      expect(venueC.benchmarks.revenueVsAverage).toBe(-50)
    })
  })
})
