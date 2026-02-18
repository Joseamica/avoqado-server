import { prismaMock } from '@tests/__helpers__/setup'
import { organizationDashboardService } from '@/services/organization-dashboard/organizationDashboard.service'

// Mock datetime utilities to return predictable dates
jest.mock('@/utils/datetime', () => {
  const todayStart = new Date('2026-02-13T00:00:00.000Z')
  const weekStart = new Date('2026-02-06T00:00:00.000Z')
  const prevWeekStart = new Date('2026-01-30T00:00:00.000Z')
  const monthStart = new Date('2026-02-01T00:00:00.000Z')
  return {
    DEFAULT_TIMEZONE: 'America/Mexico_City',
    venueStartOfDay: jest.fn(() => todayStart),
    venueStartOfDayOffset: jest.fn((tz: string, days: number) => {
      if (days === -7) return weekStart
      if (days === -14) return prevWeekStart
      const d = new Date(todayStart)
      d.setDate(d.getDate() + days)
      return d
    }),
    venueStartOfMonth: jest.fn(() => monthStart),
    venueEndOfDay: jest.fn(() => new Date('2026-02-13T23:59:59.999Z')),
    parseDbDateRange: jest.fn((start: string, end: string) => ({
      from: new Date(start),
      to: new Date(end),
    })),
  }
})

// Mock date-fns-tz — return a date with local hours = 15 so NO_CHECKINS logic fires
jest.mock('date-fns-tz', () => ({
  toZonedTime: jest.fn(() => {
    const d = new Date()
    d.setHours(15, 0, 0, 0)
    return d
  }),
  fromZonedTime: jest.fn((date: Date) => date),
}))

const orgId = 'org-1'

describe('OrganizationDashboardService', () => {
  // ─── getStorePerformance ──────────────────────────────────────

  describe('getStorePerformance', () => {
    const venues = [
      { id: 'v1', name: 'Store A', slug: 'store-a', logo: null, status: 'ACTIVE' },
      { id: 'v2', name: 'Store B', slug: 'store-b', logo: 'logo.png', status: 'ACTIVE' },
    ]

    it('should use bulk queries and return correct performance data', async () => {
      prismaMock.venue.findMany.mockResolvedValue(venues)
      prismaMock.module.findUnique.mockResolvedValue(null) // no serialized inventory module
      prismaMock.organizationSalesGoalConfig.findMany.mockResolvedValue([])

      // Bulk query mocks
      prismaMock.order.groupBy
        .mockResolvedValueOnce([
          // todaySalesByVenue
          { venueId: 'v1', _sum: { total: 500 } },
          { venueId: 'v2', _sum: { total: 300 } },
        ])
        .mockResolvedValueOnce([
          // weekSalesByVenue
          { venueId: 'v1', _sum: { total: 3000 } },
          { venueId: 'v2', _sum: { total: 2000 } },
        ])
        .mockResolvedValueOnce([
          // prevWeekSalesByVenue
          { venueId: 'v1', _sum: { total: 2500 } },
          { venueId: 'v2', _sum: { total: 2500 } },
        ])

      // todayUnitsByVenue (raw SQL)
      prismaMock.$queryRaw.mockResolvedValueOnce([
        { venueId: 'v1', unitsSold: 25 },
        { venueId: 'v2', unitsSold: 15 },
      ])

      // staffCountsByVenue
      prismaMock.staffVenue.groupBy.mockResolvedValue([
        { venueId: 'v1', _count: 5 },
        { venueId: 'v2', _count: 3 },
      ])

      // activePromoterEntries
      prismaMock.timeEntry.findMany.mockResolvedValue([
        { staffId: 's1', venueId: 'v1' },
        { staffId: 's2', venueId: 'v1' },
        { staffId: 's3', venueId: 'v2' },
      ])

      const result = await organizationDashboardService.getStorePerformance(orgId, 10)

      // Should return 2 venues ranked by weekSales
      expect(result).toHaveLength(2)
      expect(result[0].name).toBe('Store A') // 3000 > 2000
      expect(result[0].rank).toBe(1)
      expect(result[0].todaySales).toBe(500)
      expect(result[0].unitsSold).toBe(25)
      expect(result[0].weekSales).toBe(3000)
      expect(result[0].promoterCount).toBe(5)
      expect(result[0].activePromoters).toBe(2)

      expect(result[1].name).toBe('Store B')
      expect(result[1].rank).toBe(2)
      expect(result[1].todaySales).toBe(300)
      expect(result[1].unitsSold).toBe(15)
      expect(result[1].promoterCount).toBe(3)
      expect(result[1].activePromoters).toBe(1)

      // Trend: v1 weekSales=3000 vs prevWeek=2500 → +20% → 'up'
      expect(result[0].trend).toBe('up')
      // Trend: v2 weekSales=2000 vs prevWeek=2500 → -20% → 'down'
      expect(result[1].trend).toBe('down')
    })

    it('should return empty array when no venues exist', async () => {
      prismaMock.venue.findMany.mockResolvedValue([])
      prismaMock.module.findUnique.mockResolvedValue(null)
      prismaMock.organizationSalesGoalConfig.findMany.mockResolvedValue([])

      const result = await organizationDashboardService.getStorePerformance(orgId, 10)

      expect(result).toEqual([])
    })

    it('should handle venues with no sales data', async () => {
      prismaMock.venue.findMany.mockResolvedValue([venues[0]])
      prismaMock.module.findUnique.mockResolvedValue(null)
      prismaMock.organizationSalesGoalConfig.findMany.mockResolvedValue([])

      prismaMock.order.groupBy
        .mockResolvedValueOnce([]) // no today sales
        .mockResolvedValueOnce([]) // no week sales
        .mockResolvedValueOnce([]) // no prev week sales
      prismaMock.$queryRaw.mockResolvedValueOnce([]) // no units
      prismaMock.staffVenue.groupBy.mockResolvedValue([])
      prismaMock.timeEntry.findMany.mockResolvedValue([])

      const result = await organizationDashboardService.getStorePerformance(orgId, 10)

      expect(result).toHaveLength(1)
      expect(result[0].todaySales).toBe(0)
      expect(result[0].unitsSold).toBe(0)
      expect(result[0].weekSales).toBe(0)
      expect(result[0].trend).toBe('stable')
      expect(result[0].promoterCount).toBe(0)
      expect(result[0].activePromoters).toBe(0)
    })
  })

  // ─── getCrossStoreAnomalies ───────────────────────────────────

  describe('getCrossStoreAnomalies', () => {
    const venues = [
      { id: 'v1', name: 'Store A', latitude: null, longitude: null },
      { id: 'v2', name: 'Store B', latitude: 19.4326, longitude: -99.1332 },
    ]

    it('should detect no-checkins, pending deposits, and low stock in bulk', async () => {
      prismaMock.organizationAttendanceConfig.findUnique.mockResolvedValue(null)
      prismaMock.venue.findMany.mockResolvedValue(venues)

      // checkInsByVenue: v1 has 0 check-ins (not in result), v2 has 3
      prismaMock.timeEntry.groupBy.mockResolvedValue([{ venueId: 'v2', _count: 3 }])

      // pendingDepositsByVenue: v1 has 8 pending
      prismaMock.cashDeposit.groupBy.mockResolvedValue([{ venueId: 'v1', _count: 8 }])

      // allAlertConfigs: v1 has one config with minStock=10
      prismaMock.stockAlertConfig.findMany.mockResolvedValue([
        { venueId: 'v1', categoryId: 'cat-1', minimumStock: 10, category: { name: 'Chips' } },
      ])

      // stockLevels: v1:cat-1 has 5 available (below minimum of 10)
      prismaMock.serializedItem.groupBy.mockResolvedValue([{ venueId: 'v1', categoryId: 'cat-1', _count: 5 }])

      // GPS entries: v2 has one entry far away
      prismaMock.timeEntry.findMany.mockResolvedValue([
        {
          id: 'te-1',
          venueId: 'v2',
          clockInLatitude: 20.5, // far from venue
          clockInLongitude: -100.5,
          staff: { firstName: 'Pedro', lastName: 'Garcia' },
        },
      ])

      const result = await organizationDashboardService.getCrossStoreAnomalies(orgId)

      // v1 should have: NO_CHECKINS + PENDING_DEPOSITS + LOW_STOCK
      const v1Anomalies = result.filter(a => a.storeId === 'v1')
      expect(v1Anomalies.some(a => a.type === 'NO_CHECKINS')).toBe(true)
      expect(v1Anomalies.some(a => a.type === 'PENDING_DEPOSITS')).toBe(true)
      expect(v1Anomalies.some(a => a.type === 'LOW_STOCK')).toBe(true)

      // v2 should have: GPS_VIOLATION
      const v2Anomalies = result.filter(a => a.storeId === 'v2')
      expect(v2Anomalies.some(a => a.type === 'GPS_VIOLATION')).toBe(true)

      // Should be sorted by severity (CRITICAL first)
      const severities = result.map(a => a.severity)
      const criticalIdx = severities.indexOf('CRITICAL')
      const warningIdx = severities.indexOf('WARNING')
      if (criticalIdx !== -1 && warningIdx !== -1) {
        expect(criticalIdx).toBeLessThan(warningIdx)
      }
    })

    it('should return empty array when no anomalies exist', async () => {
      prismaMock.organizationAttendanceConfig.findUnique.mockResolvedValue(null)
      prismaMock.venue.findMany.mockResolvedValue([{ id: 'v1', name: 'Good Store', latitude: null, longitude: null }])

      // All check-ins present, no pending deposits, no stock alerts
      prismaMock.timeEntry.groupBy.mockResolvedValue([{ venueId: 'v1', _count: 5 }])
      prismaMock.cashDeposit.groupBy.mockResolvedValue([]) // no pending deposits
      prismaMock.stockAlertConfig.findMany.mockResolvedValue([]) // no alert configs
      prismaMock.serializedItem.groupBy.mockResolvedValue([])
      prismaMock.timeEntry.findMany.mockResolvedValue([]) // no GPS entries (no lat/lng)

      const result = await organizationDashboardService.getCrossStoreAnomalies(orgId)

      expect(result).toEqual([])
    })
  })

  // ─── getOnlineStaff ───────────────────────────────────────────

  describe('getOnlineStaff', () => {
    it('should return online staff with bulk venue counts', async () => {
      prismaMock.venue.findMany.mockResolvedValue([
        { id: 'v1', name: 'Store A' },
        { id: 'v2', name: 'Store B' },
      ])

      // Active time entries (clocked in, not out)
      prismaMock.timeEntry.findMany.mockResolvedValue([
        {
          staffId: 's1',
          venueId: 'v1',
          clockInTime: new Date('2026-02-13T09:00:00Z'),
          jobRole: 'CASHIER',
          staff: { id: 's1', firstName: 'Juan', lastName: 'Perez' },
          venue: { id: 'v1', name: 'Store A' },
        },
        {
          staffId: 's2',
          venueId: 'v1',
          clockInTime: new Date('2026-02-13T09:30:00Z'),
          jobRole: 'WAITER',
          staff: { id: 's2', firstName: 'Ana', lastName: 'Lopez' },
          venue: { id: 'v1', name: 'Store A' },
        },
        {
          staffId: 's3',
          venueId: 'v2',
          clockInTime: new Date('2026-02-13T10:00:00Z'),
          jobRole: null,
          staff: { id: 's3', firstName: 'Pedro', lastName: 'Garcia' },
          venue: { id: 'v2', name: 'Store B' },
        },
      ])

      // Total staff count across all venues
      prismaMock.staffVenue.count.mockResolvedValue(8)

      // Bulk staff counts per venue (groupBy)
      prismaMock.staffVenue.groupBy.mockResolvedValue([
        { venueId: 'v1', _count: 5 },
        { venueId: 'v2', _count: 3 },
      ])

      const result = await organizationDashboardService.getOnlineStaff(orgId)

      expect(result.onlineCount).toBe(3)
      expect(result.totalCount).toBe(8)
      expect(result.percentageOnline).toBe(38) // Math.round(3/8 * 100)

      // Online staff list
      expect(result.onlineStaff).toHaveLength(3)
      expect(result.onlineStaff[0].staffName).toBe('Juan Perez')
      expect(result.onlineStaff[2].role).toBe('Staff') // null jobRole defaults to 'Staff'

      // By venue breakdown
      expect(result.byVenue).toHaveLength(2)
      const storeA = result.byVenue.find(v => v.venueId === 'v1')!
      expect(storeA.onlineCount).toBe(2)
      expect(storeA.totalCount).toBe(5)

      const storeB = result.byVenue.find(v => v.venueId === 'v2')!
      expect(storeB.onlineCount).toBe(1)
      expect(storeB.totalCount).toBe(3)
    })

    it('should return zeros when no venues exist', async () => {
      prismaMock.venue.findMany.mockResolvedValue([])

      const result = await organizationDashboardService.getOnlineStaff(orgId)

      expect(result.onlineCount).toBe(0)
      expect(result.totalCount).toBe(0)
      expect(result.percentageOnline).toBe(0)
      expect(result.byVenue).toEqual([])
      expect(result.onlineStaff).toEqual([])
    })
  })
})
