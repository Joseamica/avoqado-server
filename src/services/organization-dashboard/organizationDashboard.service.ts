/**
 * Organization Dashboard Service
 * Provides organization-level metrics, manager dashboards, and cross-venue analytics
 * for the PlayTelecom/White-Label dashboard.
 *
 * IMPORTANT: All date calculations use venue timezone (America/Mexico_City by default)
 * to ensure "today", "this week", "this month" match the business's operating timezone.
 */
import { Prisma } from '@prisma/client'
import { endOfDay, startOfDay } from 'date-fns'
import { fromZonedTime, toZonedTime } from 'date-fns-tz'
import {
  DEFAULT_TIMEZONE,
  parseDbDateRange,
  venueEndOfDay,
  venueStartOfDay,
  venueStartOfDayOffset,
  venueStartOfMonth,
} from '../../utils/datetime'
import prisma from '../../utils/prismaClient'

// Types for organization dashboard
export interface OrgCategoryBreakdown {
  id: string
  name: string
  sales: number
  units: number
  percentage: number
}

export interface OrgVisionGlobalSummary {
  todaySales: number
  todayCashSales: number
  weekSales: number
  monthSales: number
  unitsSold: number
  avgTicket: number
  activePromoters: number
  totalPromoters: number
  activeStores: number
  totalStores: number
  approvedDeposits: number
  categoryBreakdown: OrgCategoryBreakdown[]
}

export interface OrgStorePerformance {
  id: string
  name: string
  slug: string
  logo: string | null
  todaySales: number
  weekSales: number
  unitsSold: number
  promoterCount: number
  activePromoters: number
  trend: 'up' | 'down' | 'stable'
  rank: number
  performance?: number // Goal progress percentage (0-100+)
  goalAmount?: number // Configured goal amount
  goalType?: 'AMOUNT' | 'QUANTITY' // Type of goal (currency or unit count)
  goalPeriod?: 'DAILY' | 'WEEKLY' | 'MONTHLY'
  goalId?: string // ID of the active venue-wide sales goal
  goalSource?: 'venue' | 'organization' // Where the goal config came from
}

export interface OrgCrossStoreAnomaly {
  id: string
  type: 'LOW_PERFORMANCE' | 'NO_CHECKINS' | 'LOW_STOCK' | 'PENDING_DEPOSITS' | 'GPS_VIOLATION'
  severity: 'CRITICAL' | 'WARNING' | 'INFO'
  storeId: string
  storeName: string
  title: string
  description: string
}

export interface ManagerDashboard {
  manager: {
    id: string
    name: string
    email: string | null
    phone: string | null
  }
  stores: Array<{
    id: string
    name: string
    slug: string
    todaySales: number
    weekSales: number
    promoterCount: number
    activePromoters: number
    monthGoal: number
    goalProgress: number
  }>
  aggregateMetrics: {
    totalSales: number
    totalUnits: number
    avgGoalProgress: number
    promotersActive: number
    promotersTotal: number
  }
}

export interface OrgStockSummary {
  totalPieces: number
  totalValue: number
  lowStockAlerts: number
  criticalAlerts: number
  storeBreakdown: Array<{
    storeId: string
    storeName: string
    available: number
    value: number
    alertLevel: 'OK' | 'WARNING' | 'CRITICAL'
  }>
}

export interface OnlineStaffMember {
  staffId: string
  staffName: string
  venueId: string
  venueName: string
  clockInTime: Date
  role: string
}

export interface OrgOnlineStaff {
  onlineCount: number
  totalCount: number
  percentageOnline: number
  byVenue: Array<{
    venueId: string
    venueName: string
    onlineCount: number
    totalCount: number
  }>
  onlineStaff: OnlineStaffMember[]
}

export type ActivityType = 'sale' | 'checkin' | 'checkout' | 'gps_error' | 'alert' | 'other'
export type ActivitySeverity = 'normal' | 'warning' | 'error'

export interface ActivityEvent {
  id: string
  type: ActivityType
  title: string
  subtitle: string // "Staff Name • Venue Name"
  timestamp: Date
  severity: ActivitySeverity
  venueId: string
  venueName: string
  staffId?: string
  staffName?: string
  metadata?: Record<string, any>
}

export interface OrgActivityFeed {
  events: ActivityEvent[]
  total: number
}

export interface OrganizationGoalData {
  id: string
  organizationId: string
  period: string
  periodDate: Date
  salesTarget: number
  volumeTarget: number
}

export interface RevenueVsTargetData {
  day: string // "Lun", "Mar", "Mié", etc.
  actual: number // Actual revenue
  target: number // Target revenue for that day
  date: string // ISO date string
}

export interface VolumeVsTargetData {
  day: string
  actual: number // Actual count
  target: number // Target count
  date: string // ISO date string
}

class OrganizationDashboardService {
  /**
   * Get vision global summary for an organization (aggregate KPIs)
   *
   * IMPORTANT: Date calculations use venue timezone (America/Mexico_City by default)
   * to ensure "today", "this week", "this month" match the business's operating timezone,
   * not the server's timezone (which may be UTC).
   */
  async getVisionGlobalSummary(
    orgId: string,
    timezone: string = 'America/Mexico_City',
    startDate?: string,
    endDate?: string,
    filterVenueId?: string,
  ): Promise<OrgVisionGlobalSummary> {
    // Calculate dates in venue timezone for DB queries.
    // IMPORTANT: DB stores local time in `timestamp without time zone` columns
    // (PostgreSQL timezone = America/Mexico_City). Use parseDbDateRange/venueStartOf*
    // helpers which create Dates where UTC components = venue local time,
    // matching the DB's storage format.
    let todayStart: Date
    let rangeEnd: Date | undefined

    if (startDate || endDate) {
      const range = parseDbDateRange(startDate, endDate, timezone, 1)
      todayStart = range.from
      rangeEnd = range.to
    } else {
      todayStart = venueStartOfDay(timezone)
    }

    // Week start (7 days ago) in venue timezone
    const weekStart = venueStartOfDayOffset(timezone, -7)

    // Month start in venue timezone
    const monthStart = venueStartOfMonth(timezone)

    // Get all venues in organization (or just the filtered one)
    const venues = await prisma.venue.findMany({
      where: {
        organizationId: orgId,
        status: 'ACTIVE',
        ...(filterVenueId ? { id: filterVenueId } : {}),
      },
      select: { id: true },
    })
    const venueIds = venues.map(v => v.id)

    // Also get total venue count (unfiltered) for the totalStores metric
    const allVenuesCount = filterVenueId ? await prisma.venue.count({ where: { organizationId: orgId, status: 'ACTIVE' } }) : venues.length

    if (venueIds.length === 0) {
      return {
        todaySales: 0,
        todayCashSales: 0,
        weekSales: 0,
        monthSales: 0,
        unitsSold: 0,
        avgTicket: 0,
        activePromoters: 0,
        totalPromoters: 0,
        activeStores: 0,
        totalStores: 0,
        approvedDeposits: 0,
        categoryBreakdown: [],
      }
    }

    // Aggregate sales from completed orders
    const rangeFilter = rangeEnd ? { gte: todayStart, lte: rangeEnd } : { gte: todayStart }
    const [todayOrders, weekOrders, monthOrders] = await Promise.all([
      prisma.order.findMany({
        where: {
          venueId: { in: venueIds },
          status: 'COMPLETED',
          createdAt: rangeFilter,
        },
        select: { total: true, items: true },
      }),
      prisma.order.aggregate({
        where: {
          venueId: { in: venueIds },
          status: 'COMPLETED',
          createdAt: { gte: weekStart },
        },
        _sum: { total: true },
      }),
      prisma.order.aggregate({
        where: {
          venueId: { in: venueIds },
          status: 'COMPLETED',
          createdAt: { gte: monthStart },
        },
        _sum: { total: true },
      }),
    ])

    const todaySales = todayOrders.reduce((sum, o) => sum + Number(o.total || 0), 0)
    const unitsSold = todayOrders.reduce((sum, o) => sum + (o.items?.reduce((s: number, i: any) => s + (i.quantity || 0), 0) || 0), 0)
    const avgTicket = todayOrders.length > 0 ? todaySales / todayOrders.length : 0

    // Sum CASH payments only (money physically in the field)
    const cashPaymentsResult = await prisma.payment.aggregate({
      where: {
        venueId: { in: venueIds },
        method: 'CASH',
        status: 'COMPLETED',
        createdAt: rangeFilter,
      },
      _sum: { amount: true },
    })
    const todayCashSales = Number(cashPaymentsResult._sum?.amount) || 0

    // Count promoters (active check-ins in range using TimeEntry)
    const [activePromoters, totalPromoters] = await Promise.all([
      prisma.timeEntry.findMany({
        where: {
          venueId: { in: venueIds },
          clockInTime: rangeFilter,
        },
        distinct: ['staffId'],
        select: { staffId: true },
      }),
      prisma.staffVenue.count({
        where: {
          venueId: { in: venueIds },
          active: true,
          role: { in: ['CASHIER', 'WAITER'] },
        },
      }),
    ])

    // Count active stores (stores with sales in range)
    const storesWithSales = await prisma.order.groupBy({
      by: ['venueId'],
      where: {
        venueId: { in: venueIds },
        status: 'COMPLETED',
        createdAt: rangeFilter,
      },
    })

    // Sum approved cash deposits in the date range
    const approvedDepositsResult = await prisma.cashDeposit.aggregate({
      where: {
        venueId: { in: venueIds },
        status: 'APPROVED',
        timestamp: rangeFilter,
      },
      _sum: { amount: true },
    })
    const approvedDeposits = Number(approvedDepositsResult._sum?.amount) || 0

    // Aggregate sales by category from order items
    // For regular products: use denormalized categoryName
    // For serialized inventory (SIMs): categoryName is null, productName IS the category
    const categoryStats = new Map<string, { id: string; name: string; sales: number; units: number }>()
    for (const order of todayOrders) {
      for (const item of order.items) {
        const catName = item.categoryName || item.productName || 'Sin categoría'
        const existing = categoryStats.get(catName) || { id: catName, name: catName, sales: 0, units: 0 }
        existing.units += item.quantity
        existing.sales += Number(item.total || 0)
        categoryStats.set(catName, existing)
      }
    }
    const totalCategoryUnits = Array.from(categoryStats.values()).reduce((sum, cat) => sum + cat.units, 0)
    const categoryBreakdown: OrgCategoryBreakdown[] = Array.from(categoryStats.values())
      .sort((a, b) => b.units - a.units)
      .slice(0, 5)
      .map(cat => ({
        ...cat,
        sales: Math.round(cat.sales * 100) / 100,
        percentage: totalCategoryUnits > 0 ? Math.round((cat.units / totalCategoryUnits) * 100) : 0,
      }))

    return {
      todaySales: Math.round(todaySales * 100) / 100,
      todayCashSales: Math.round(todayCashSales * 100) / 100,
      weekSales: Math.round((Number(weekOrders._sum?.total) || 0) * 100) / 100,
      monthSales: Math.round((Number(monthOrders._sum?.total) || 0) * 100) / 100,
      unitsSold,
      avgTicket: Math.round(avgTicket * 100) / 100,
      activePromoters: activePromoters.length,
      totalPromoters,
      activeStores: storesWithSales.length,
      totalStores: allVenuesCount,
      approvedDeposits: Math.round(approvedDeposits * 100) / 100,
      categoryBreakdown,
    }
  }

  /**
   * Get store performance ranking for organization
   *
   * IMPORTANT: Date calculations use venue timezone to match business operating hours.
   */
  async getStorePerformance(
    orgId: string,
    limit: number = 10,
    timezone: string = 'America/Mexico_City',
    startDate?: string,
    endDate?: string,
  ): Promise<OrgStorePerformance[]> {
    // DB stores local time in `timestamp without time zone` — use venue helpers
    let todayStart: Date
    let rangeEnd: Date | undefined

    if (startDate || endDate) {
      const range = parseDbDateRange(startDate, endDate, timezone, 1)
      todayStart = range.from
      rangeEnd = range.to
    } else {
      todayStart = venueStartOfDay(timezone)
    }

    const weekStart = venueStartOfDayOffset(timezone, -7)
    const prevWeekStart = venueStartOfDayOffset(timezone, -14)

    const monthStart = venueStartOfMonth(timezone)

    // Get all venues
    const venues = await prisma.venue.findMany({
      where: { organizationId: orgId },
      select: {
        id: true,
        name: true,
        slug: true,
        logo: true,
        status: true,
      },
    })

    // Fetch SalesGoals from VenueModule config for all venues (batch query)
    const serializedModule = await prisma.module.findUnique({
      where: { code: 'SERIALIZED_INVENTORY' },
    })

    type GoalConfig = {
      goal: number
      goalType: 'AMOUNT' | 'QUANTITY'
      period: 'DAILY' | 'WEEKLY' | 'MONTHLY'
      goalId: string
      source: 'venue' | 'organization'
    }
    const venueGoalsMap = new Map<string, GoalConfig>()

    if (serializedModule) {
      const venueModules = await prisma.venueModule.findMany({
        where: {
          venueId: { in: venues.map(v => v.id) },
          moduleId: serializedModule.id,
        },
        select: { venueId: true, config: true },
      })

      for (const vm of venueModules) {
        const config = vm.config as Record<string, unknown> | null
        const goals = Array.isArray(config?.salesGoals) ? (config.salesGoals as any[]) : []
        // Find the active venue-wide goal (staffId = null)
        const venueGoal = goals.find(g => g.staffId === null && g.active)
        if (venueGoal && venueGoal.goal > 0) {
          venueGoalsMap.set(vm.venueId, {
            goal: venueGoal.goal,
            goalType: venueGoal.goalType || 'AMOUNT',
            period: venueGoal.period,
            goalId: venueGoal.id,
            source: 'venue',
          })
        }
      }
    }

    // Fallback: for venues without a goal, check org-level goals
    const venuesWithoutGoal = venues.filter(v => !venueGoalsMap.has(v.id))
    if (venuesWithoutGoal.length > 0) {
      const orgGoals = await prisma.organizationSalesGoalConfig.findMany({
        where: { organizationId: orgId, active: true },
      })
      // Use the first matching org goal (prefer DAILY for daily dashboards, but use any available)
      const orgGoal = orgGoals.find(g => g.period === 'DAILY') || orgGoals.find(g => g.period === 'MONTHLY') || orgGoals[0]
      if (orgGoal && orgGoal.goal.toNumber() > 0) {
        for (const venue of venuesWithoutGoal) {
          venueGoalsMap.set(venue.id, {
            goal: orgGoal.goal.toNumber(),
            goalType: (orgGoal.goalType as 'AMOUNT' | 'QUANTITY') || 'AMOUNT',
            period: (orgGoal.period as 'DAILY' | 'WEEKLY' | 'MONTHLY') || 'MONTHLY',
            goalId: orgGoal.id,
            source: 'organization',
          })
        }
      }
    }

    const venueIds = venues.map(v => v.id)

    if (venueIds.length === 0) {
      return []
    }

    // Determine which conditional queries we need based on goal configs
    const goalConfigs = [...venueGoalsMap.values()]
    const needsMonthSales = goalConfigs.some(g => g.period === 'MONTHLY' && g.goalType === 'AMOUNT')
    const needsWeekUnits = goalConfigs.some(g => g.period === 'WEEKLY' && g.goalType === 'QUANTITY')
    const needsMonthUnits = goalConfigs.some(g => g.period === 'MONTHLY' && g.goalType === 'QUANTITY')

    const todayCreatedAtWhere = rangeEnd ? { gte: todayStart, lte: rangeEnd } : { gte: todayStart }

    // Bulk queries — replaces N per-venue loops with a constant number of queries
    const [
      todaySalesByVenue,
      todayUnitsByVenue,
      weekSalesByVenue,
      prevWeekSalesByVenue,
      staffCountsByVenue,
      activePromoterEntries,
      monthSalesByVenue,
      weekUnitsByVenue,
      monthUnitsByVenue,
    ] = await Promise.all([
      // 1. Today sales per venue
      prisma.order.groupBy({
        by: ['venueId'],
        where: { venueId: { in: venueIds }, status: 'COMPLETED', createdAt: todayCreatedAtWhere },
        _sum: { total: true },
      }),
      // 2. Today units per venue (SUM quantity — OrderItem has no venueId, needs raw SQL)
      rangeEnd
        ? prisma.$queryRaw<Array<{ venueId: string; unitsSold: any }>>`
            SELECT o."venueId", COALESCE(SUM(oi.quantity), 0) as "unitsSold"
            FROM "Order" o
            JOIN "OrderItem" oi ON oi."orderId" = o.id
            WHERE o."venueId" IN (${Prisma.join(venueIds)})
              AND o.status = 'COMPLETED'
              AND o."createdAt" >= ${todayStart}
              AND o."createdAt" <= ${rangeEnd}
            GROUP BY o."venueId"
          `
        : prisma.$queryRaw<Array<{ venueId: string; unitsSold: any }>>`
            SELECT o."venueId", COALESCE(SUM(oi.quantity), 0) as "unitsSold"
            FROM "Order" o
            JOIN "OrderItem" oi ON oi."orderId" = o.id
            WHERE o."venueId" IN (${Prisma.join(venueIds)})
              AND o.status = 'COMPLETED'
              AND o."createdAt" >= ${todayStart}
            GROUP BY o."venueId"
          `,
      // 3. Week sales per venue
      prisma.order.groupBy({
        by: ['venueId'],
        where: { venueId: { in: venueIds }, status: 'COMPLETED', createdAt: { gte: weekStart } },
        _sum: { total: true },
      }),
      // 4. Previous week sales per venue (for trend calculation)
      prisma.order.groupBy({
        by: ['venueId'],
        where: { venueId: { in: venueIds }, status: 'COMPLETED', createdAt: { gte: prevWeekStart, lt: weekStart } },
        _sum: { total: true },
      }),
      // 5. Staff counts per venue
      prisma.staffVenue.groupBy({
        by: ['venueId'],
        where: { venueId: { in: venueIds }, active: true, role: { in: ['CASHIER', 'WAITER'] } },
        _count: true,
      }),
      // 6. Active promoters per venue (distinct staffId entries)
      prisma.timeEntry.findMany({
        where: { venueId: { in: venueIds }, clockInTime: todayCreatedAtWhere },
        distinct: ['staffId', 'venueId'] as any,
        select: { staffId: true, venueId: true },
      }),
      // 7. Month sales per venue (conditional — only if MONTHLY AMOUNT goals exist)
      needsMonthSales
        ? prisma.order.groupBy({
            by: ['venueId'],
            where: { venueId: { in: venueIds }, status: 'COMPLETED', createdAt: { gte: monthStart } },
            _sum: { total: true },
          })
        : Promise.resolve([] as any[]),
      // 8. Week units per venue (conditional — only if QUANTITY WEEKLY goals exist)
      needsWeekUnits
        ? prisma.$queryRaw<Array<{ venueId: string; units: any }>>`
            SELECT o."venueId", COALESCE(SUM(oi.quantity), 0) as units
            FROM "Order" o
            JOIN "OrderItem" oi ON oi."orderId" = o.id
            WHERE o."venueId" IN (${Prisma.join(venueIds)})
              AND o.status = 'COMPLETED'
              AND o."createdAt" >= ${weekStart}
            GROUP BY o."venueId"
          `
        : Promise.resolve([] as any[]),
      // 9. Month units per venue (conditional — only if QUANTITY MONTHLY goals exist)
      needsMonthUnits
        ? prisma.$queryRaw<Array<{ venueId: string; units: any }>>`
            SELECT o."venueId", COALESCE(SUM(oi.quantity), 0) as units
            FROM "Order" o
            JOIN "OrderItem" oi ON oi."orderId" = o.id
            WHERE o."venueId" IN (${Prisma.join(venueIds)})
              AND o.status = 'COMPLETED'
              AND o."createdAt" >= ${monthStart}
            GROUP BY o."venueId"
          `
        : Promise.resolve([] as any[]),
    ])

    // Build lookup maps for O(1) access
    const todaySalesMap = new Map(todaySalesByVenue.map(r => [r.venueId, Number(r._sum.total) || 0]))
    const todayUnitsMap = new Map(todayUnitsByVenue.map((r: any) => [r.venueId, Number(r.unitsSold)]))
    const weekSalesMap = new Map(weekSalesByVenue.map(r => [r.venueId, Number(r._sum.total) || 0]))
    const prevWeekSalesMap = new Map(prevWeekSalesByVenue.map(r => [r.venueId, Number(r._sum.total) || 0]))
    const staffCountsMap = new Map(staffCountsByVenue.map(r => [r.venueId, r._count]))
    const monthSalesMap = new Map((monthSalesByVenue as any[]).map(r => [r.venueId, Number(r._sum?.total) || 0]))
    const weekUnitsMap = new Map((weekUnitsByVenue as any[]).map(r => [r.venueId, Number(r.units)]))
    const monthUnitsMap = new Map((monthUnitsByVenue as any[]).map(r => [r.venueId, Number(r.units)]))

    // Count distinct active promoters per venue
    const activePromotersMap = new Map<string, number>()
    for (const entry of activePromoterEntries) {
      activePromotersMap.set(entry.venueId, (activePromotersMap.get(entry.venueId) || 0) + 1)
    }

    // Map venues to results — no DB calls in this loop
    const results: OrgStorePerformance[] = venues.map(venue => {
      const goalConfig = venueGoalsMap.get(venue.id)
      const todaySales = todaySalesMap.get(venue.id) || 0
      const unitsSold = todayUnitsMap.get(venue.id) || 0
      const weekSales = weekSalesMap.get(venue.id) || 0
      const prevWeekSales = prevWeekSalesMap.get(venue.id) || 0

      // Determine trend
      let trend: 'up' | 'down' | 'stable' = 'stable'
      if (prevWeekSales > 0) {
        const change = ((weekSales - prevWeekSales) / prevWeekSales) * 100
        if (change > 10) trend = 'up'
        else if (change < -10) trend = 'down'
      }

      // Calculate goal performance
      let performance: number | undefined
      if (goalConfig && goalConfig.goal > 0) {
        let progressValue = 0

        if (goalConfig.goalType === 'QUANTITY') {
          switch (goalConfig.period) {
            case 'DAILY':
              progressValue = unitsSold
              break
            case 'WEEKLY':
              progressValue = weekUnitsMap.get(venue.id) || 0
              break
            case 'MONTHLY':
              progressValue = monthUnitsMap.get(venue.id) || 0
              break
          }
        } else {
          switch (goalConfig.period) {
            case 'DAILY':
              progressValue = todaySales
              break
            case 'WEEKLY':
              progressValue = weekSales
              break
            case 'MONTHLY':
              progressValue = monthSalesMap.get(venue.id) || 0
              break
          }
        }
        performance = Math.round((progressValue / goalConfig.goal) * 100)
      }

      return {
        id: venue.id,
        name: venue.name,
        slug: venue.slug,
        logo: venue.logo,
        todaySales: Math.round(todaySales * 100) / 100,
        weekSales: Math.round(weekSales * 100) / 100,
        unitsSold,
        promoterCount: staffCountsMap.get(venue.id) || 0,
        activePromoters: activePromotersMap.get(venue.id) || 0,
        trend,
        rank: 0, // Will be set after sorting
        performance,
        goalAmount: goalConfig?.goal,
        goalType: goalConfig?.goalType,
        goalPeriod: goalConfig?.period,
        goalId: goalConfig?.goalId,
        goalSource: goalConfig?.source,
      }
    })

    // Sort by week sales and assign ranks
    results.sort((a, b) => b.weekSales - a.weekSales)
    results.forEach((r, i) => (r.rank = i + 1))

    return results.slice(0, limit)
  }

  /**
   * Get cross-store anomalies for organization
   *
   * IMPORTANT: Uses venue timezone for date calculations.
   */
  async getCrossStoreAnomalies(orgId: string, timezone: string = DEFAULT_TIMEZONE): Promise<OrgCrossStoreAnomaly[]> {
    // DB stores local time — use venue helpers
    const now = new Date()
    const nowInTz = toZonedTime(now, timezone)
    const todayStart = venueStartOfDay(timezone)

    const anomalies: OrgCrossStoreAnomaly[] = []

    // Get all venues
    const venues = await prisma.venue.findMany({
      where: { organizationId: orgId, status: 'ACTIVE' },
      select: { id: true, name: true, latitude: true, longitude: true },
    })

    const venueIds = venues.map(v => v.id)
    const venuesWithGps = venues.filter(v => v.latitude && v.longitude)
    const venuesWithGpsIds = venuesWithGps.map(v => v.id)

    // 5 bulk queries replace all per-venue queries
    const [checkInsByVenue, pendingDepositsByVenue, allAlertConfigs, stockLevelsByVenueCategory, gpsEntries] = await Promise.all([
      // 1. Check-in counts per venue
      prisma.timeEntry.groupBy({
        by: ['venueId'],
        where: { venueId: { in: venueIds }, clockInTime: { gte: todayStart } },
        _count: true,
      }),
      // 2. Pending deposits per venue
      prisma.cashDeposit.groupBy({
        by: ['venueId'],
        where: { venueId: { in: venueIds }, status: 'PENDING' },
        _count: true,
      }),
      // 3. All stock alert configs across venues (replaces count + findMany per venue)
      prisma.stockAlertConfig.findMany({
        where: { venueId: { in: venueIds }, alertEnabled: true },
        include: { category: true },
      }),
      // 4. Available stock per venue+category (replaces N×serializedItem.count)
      prisma.serializedItem.groupBy({
        by: ['venueId', 'categoryId'],
        where: { venueId: { in: venueIds }, status: 'AVAILABLE' },
        _count: true,
      }),
      // 5. GPS entries for venues with coordinates
      venuesWithGpsIds.length > 0
        ? prisma.timeEntry.findMany({
            where: {
              venueId: { in: venuesWithGpsIds },
              clockInTime: { gte: todayStart },
              status: 'CLOCKED_IN',
              clockInLatitude: { not: null },
              clockInLongitude: { not: null },
            },
            include: {
              staff: {
                select: { firstName: true, lastName: true },
              },
            },
          })
        : Promise.resolve([] as any[]),
    ])

    // Build lookup maps
    const checkInsMap = new Map(checkInsByVenue.map(r => [r.venueId, r._count]))
    const depositsMap = new Map(pendingDepositsByVenue.map(r => [r.venueId, r._count]))

    // Group alert configs by venueId
    const alertConfigsByVenue = new Map<string, typeof allAlertConfigs>()
    for (const config of allAlertConfigs) {
      const list = alertConfigsByVenue.get(config.venueId) || []
      list.push(config)
      alertConfigsByVenue.set(config.venueId, list)
    }

    // Stock levels map: "venueId:categoryId" → count
    const stockMap = new Map(stockLevelsByVenueCategory.map(r => [`${r.venueId}:${r.categoryId}`, r._count]))

    // Process anomalies from bulk data — no DB calls in this loop
    const currentHour = nowInTz.getHours()

    for (const venue of venues) {
      // 1. No check-ins after 10 AM
      if (currentHour >= 10) {
        const checkIns = checkInsMap.get(venue.id) || 0
        if (checkIns === 0) {
          anomalies.push({
            id: `no-checkins-${venue.id}`,
            type: 'NO_CHECKINS',
            severity: 'CRITICAL',
            storeId: venue.id,
            storeName: venue.name,
            title: 'Sin Check-ins',
            description: `${venue.name} no tiene registros de entrada hoy`,
          })
        }
      }

      // 2. Pending deposits
      const pendingCount = depositsMap.get(venue.id) || 0
      if (pendingCount > 5) {
        anomalies.push({
          id: `pending-deposits-${venue.id}`,
          type: 'PENDING_DEPOSITS',
          severity: pendingCount > 10 ? 'CRITICAL' : 'WARNING',
          storeId: venue.id,
          storeName: venue.name,
          title: 'Depósitos Pendientes',
          description: `${venue.name} tiene ${pendingCount} depósitos pendientes`,
        })
      }

      // 3. Low stock alerts
      const configs = alertConfigsByVenue.get(venue.id) || []
      for (const config of configs) {
        const available = stockMap.get(`${venue.id}:${config.categoryId}`) || 0
        if (available <= config.minimumStock) {
          anomalies.push({
            id: `low-stock-${venue.id}-${config.categoryId}`,
            type: 'LOW_STOCK',
            severity: available === 0 ? 'CRITICAL' : 'WARNING',
            storeId: venue.id,
            storeName: venue.name,
            title: 'Stock Bajo',
            description: `${venue.name}: ${config.category.name} tiene ${available} unidades`,
          })
        }
      }
    }

    // 4. GPS violations (process from bulk gpsEntries)
    const venueGpsMap = new Map(venuesWithGps.map(v => [v.id, v]))
    for (const entry of gpsEntries) {
      const venue = venueGpsMap.get(entry.venueId)
      if (!venue || !entry.clockInLatitude || !entry.clockInLongitude) continue

      const distance = this.calculateDistance(
        Number(venue.latitude),
        Number(venue.longitude),
        Number(entry.clockInLatitude),
        Number(entry.clockInLongitude),
      )

      if (distance > 0.5) {
        anomalies.push({
          id: `gps-violation-${entry.id}`,
          type: 'GPS_VIOLATION',
          severity: distance > 1 ? 'CRITICAL' : 'WARNING',
          storeId: venue.id,
          storeName: venue.name,
          title: 'Violación GPS',
          description: `${entry.staff.firstName} ${entry.staff.lastName} hizo check-in ${distance.toFixed(1)}km fuera del rango en ${venue.name}`,
        })
      }
    }

    // Sort by severity
    anomalies.sort((a, b) => {
      const severityOrder = { CRITICAL: 0, WARNING: 1, INFO: 2 }
      return severityOrder[a.severity] - severityOrder[b.severity]
    })

    return anomalies
  }

  /**
   * Calculate distance between two GPS coordinates using Haversine formula
   * @returns distance in kilometers
   */
  private calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371 // Earth's radius in kilometers
    const dLat = this.toRadians(lat2 - lat1)
    const dLon = this.toRadians(lon2 - lon1)

    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.toRadians(lat1)) * Math.cos(this.toRadians(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2)

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
    return R * c
  }

  /**
   * Convert degrees to radians
   */
  private toRadians(degrees: number): number {
    return degrees * (Math.PI / 180)
  }

  /**
   * Get manager dashboard with stores they oversee
   *
   * IMPORTANT: Uses venue timezone for date calculations.
   */
  async getManagerDashboard(orgId: string, managerId: string, timezone: string = DEFAULT_TIMEZONE): Promise<ManagerDashboard | null> {
    // DB stores local time — use venue helpers
    const todayStart = venueStartOfDay(timezone)
    const weekStart = venueStartOfDayOffset(timezone, -7)

    // Get manager info
    const manager = await prisma.staff.findFirst({
      where: {
        id: managerId,
        organizations: { some: { organizationId: orgId } },
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
      },
    })

    if (!manager) {
      return null
    }

    // Get stores managed by this manager (ADMIN or MANAGER role)
    const managedStores = await prisma.staffVenue.findMany({
      where: {
        staffId: managerId,
        role: { in: ['ADMIN', 'MANAGER'] },
        active: true,
      },
      include: {
        venue: {
          select: {
            id: true,
            name: true,
            slug: true,
          },
        },
      },
    })

    const monthStart = venueStartOfMonth(timezone)
    const allVenueIds = managedStores.map(sv => sv.venueId)

    // 5 bulk queries instead of 5N (avoids N+1 per store)
    const [todayByVenue, weekByVenue, promotersByVenue, activeEntries, goals] = await Promise.all([
      prisma.order.groupBy({
        by: ['venueId'],
        where: { venueId: { in: allVenueIds }, status: 'COMPLETED', createdAt: { gte: todayStart } },
        _sum: { total: true },
      }),
      prisma.order.groupBy({
        by: ['venueId'],
        where: { venueId: { in: allVenueIds }, status: 'COMPLETED', createdAt: { gte: weekStart } },
        _sum: { total: true },
      }),
      prisma.staffVenue.groupBy({
        by: ['venueId'],
        where: { venueId: { in: allVenueIds }, active: true, role: { in: ['CASHIER', 'WAITER'] } },
        _count: true,
      }),
      prisma.timeEntry.findMany({
        where: { venueId: { in: allVenueIds }, clockInTime: { gte: todayStart } },
        distinct: ['staffId', 'venueId'],
        select: { staffId: true, venueId: true },
      }),
      prisma.performanceGoal.findMany({
        where: { staffId: managerId, venueId: { in: allVenueIds }, month: monthStart },
      }),
    ])

    const todayMap = new Map(todayByVenue.map(o => [o.venueId, Number(o._sum.total) || 0]))
    const weekMap = new Map(weekByVenue.map(o => [o.venueId, Number(o._sum.total) || 0]))
    const promoterMap = new Map(promotersByVenue.map(p => [p.venueId, p._count]))
    const goalMap = new Map(goals.map(g => [g.venueId, g]))

    // Count distinct active staff per venue
    const activeByVenue = new Map<string, number>()
    for (const entry of activeEntries) {
      activeByVenue.set(entry.venueId, (activeByVenue.get(entry.venueId) || 0) + 1)
    }

    const stores = managedStores.map(sv => {
      const todaySales = todayMap.get(sv.venueId) || 0
      const weekSales = weekMap.get(sv.venueId) || 0
      const goal = goalMap.get(sv.venueId)
      const monthGoal = goal ? Number(goal.salesGoal) : 50000

      const dayOfMonth = new Date().getDate()
      const estimatedMonthSales = (weekSales / 7) * dayOfMonth
      const goalProgress = monthGoal > 0 ? (estimatedMonthSales / monthGoal) * 100 : 0

      return {
        id: sv.venue.id,
        name: sv.venue.name,
        slug: sv.venue.slug,
        todaySales: Math.round(todaySales * 100) / 100,
        weekSales: Math.round(weekSales * 100) / 100,
        promoterCount: promoterMap.get(sv.venueId) || 0,
        activePromoters: activeByVenue.get(sv.venueId) || 0,
        monthGoal: Math.round(monthGoal * 100) / 100,
        goalProgress: Math.round(goalProgress),
      }
    })

    // Calculate aggregate metrics
    const aggregateMetrics = {
      totalSales: Math.round(stores.reduce((sum, s) => sum + s.todaySales, 0) * 100) / 100,
      totalUnits: 0, // Would need more detailed calculation
      avgGoalProgress: stores.length > 0 ? Math.round(stores.reduce((sum, s) => sum + s.goalProgress, 0) / stores.length) : 0,
      promotersActive: stores.reduce((sum, s) => sum + s.activePromoters, 0),
      promotersTotal: stores.reduce((sum, s) => sum + s.promoterCount, 0),
    }

    return {
      manager: {
        id: manager.id,
        name: `${manager.firstName} ${manager.lastName}`.trim(),
        email: manager.email,
        phone: manager.phone,
      },
      stores,
      aggregateMetrics,
    }
  }

  /**
   * Get organization-wide stock summary
   */
  async getOrgStockSummary(orgId: string): Promise<OrgStockSummary> {
    // Get all venues
    const venues = await prisma.venue.findMany({
      where: { organizationId: orgId, status: 'ACTIVE' },
      select: { id: true, name: true },
    })

    const venueIds = venues.map(v => v.id)

    // Single groupBy query gives us counts per venue+category (replaces all nested loops)
    const [countsByVenueCategory, categories, alertConfigs] = await Promise.all([
      prisma.serializedItem.groupBy({
        by: ['venueId', 'categoryId'],
        where: {
          venueId: { in: venueIds },
          status: 'AVAILABLE',
        },
        _count: true,
      }),
      prisma.itemCategory.findMany({
        where: { venueId: { in: venueIds }, active: true },
        select: { id: true, venueId: true, suggestedPrice: true },
      }),
      prisma.stockAlertConfig.findMany({
        where: { venueId: { in: venueIds }, alertEnabled: true },
      }),
    ])

    // Build lookup: "venueId:categoryId" → count
    const countMap = new Map<string, number>()
    let totalPieces = 0
    const venueCountMap = new Map<string, number>()

    for (const row of countsByVenueCategory) {
      const key = `${row.venueId}:${row.categoryId}`
      countMap.set(key, row._count)
      totalPieces += row._count
      venueCountMap.set(row.venueId, (venueCountMap.get(row.venueId) || 0) + row._count)
    }

    // Calculate total value using pre-fetched counts
    let totalValue = 0
    for (const cat of categories) {
      if (cat.suggestedPrice) {
        const count = countMap.get(`${cat.venueId}:${cat.id}`) || 0
        totalValue += count * Number(cat.suggestedPrice)
      }
    }

    // Calculate alert counts using pre-fetched counts
    let lowStockAlerts = 0
    let criticalAlerts = 0

    for (const config of alertConfigs) {
      const available = countMap.get(`${config.venueId}:${config.categoryId}`) || 0
      if (available <= config.minimumStock) {
        lowStockAlerts++
        if (available === 0) criticalAlerts++
      }
    }

    // Build store breakdown using pre-fetched counts (no additional queries)
    const storeBreakdown = venues.map(venue => {
      const available = venueCountMap.get(venue.id) || 0

      // Calculate value for this store
      const storeCats = categories.filter(c => c.venueId === venue.id)
      let storeValue = 0
      for (const cat of storeCats) {
        if (cat.suggestedPrice) {
          const count = countMap.get(`${cat.venueId}:${cat.id}`) || 0
          storeValue += count * Number(cat.suggestedPrice)
        }
      }

      // Check alert level using pre-fetched counts
      const storeAlerts = alertConfigs.filter(a => a.venueId === venue.id)
      let alertLevel: 'OK' | 'WARNING' | 'CRITICAL' = 'OK'

      for (const config of storeAlerts) {
        const catAvailable = countMap.get(`${venue.id}:${config.categoryId}`) || 0
        if (catAvailable === 0) {
          alertLevel = 'CRITICAL'
          break
        } else if (catAvailable <= config.minimumStock) {
          alertLevel = 'WARNING'
        }
      }

      return {
        storeId: venue.id,
        storeName: venue.name,
        available,
        value: Math.round(storeValue * 100) / 100,
        alertLevel,
      }
    })

    return {
      totalPieces,
      totalValue: Math.round(totalValue * 100) / 100,
      lowStockAlerts,
      criticalAlerts,
      storeBreakdown,
    }
  }

  /**
   * Get online staff (promoters with active TimeEntry today)
   */
  async getOnlineStaff(orgId: string): Promise<OrgOnlineStaff> {
    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)

    // Get all venues in organization
    const venues = await prisma.venue.findMany({
      where: { organizationId: orgId, status: 'ACTIVE' },
      select: { id: true, name: true },
    })
    const venueIds = venues.map(v => v.id)

    if (venueIds.length === 0) {
      return {
        onlineCount: 0,
        totalCount: 0,
        percentageOnline: 0,
        byVenue: [],
        onlineStaff: [],
      }
    }

    // Get all active TimeEntry records for today (clockIn without clockOut)
    const activeTimeEntries = await prisma.timeEntry.findMany({
      where: {
        venueId: { in: venueIds },
        clockInTime: { gte: todayStart },
        clockOutTime: null, // Only entries that haven't clocked out
      },
      include: {
        staff: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
          },
        },
        venue: {
          select: {
            id: true,
            name: true,
          },
        },
      },
      orderBy: {
        clockInTime: 'desc',
      },
    })

    // Get total staff count (CASHIER and WAITER roles)
    const totalStaff = await prisma.staffVenue.count({
      where: {
        venueId: { in: venueIds },
        active: true,
        role: { in: ['CASHIER', 'WAITER'] },
      },
    })

    // Build online staff list
    const onlineStaff: OnlineStaffMember[] = activeTimeEntries.map(entry => ({
      staffId: entry.staffId,
      staffName: `${entry.staff.firstName} ${entry.staff.lastName}`.trim(),
      venueId: entry.venueId,
      venueName: entry.venue.name,
      clockInTime: entry.clockInTime,
      role: entry.jobRole || 'Staff',
    }))

    // Bulk query: staff counts per venue (replaces N individual count queries)
    const staffCountsByVenue = await prisma.staffVenue.groupBy({
      by: ['venueId'],
      where: { venueId: { in: venueIds }, active: true, role: { in: ['CASHIER', 'WAITER'] } },
      _count: true,
    })
    const staffCountsMap = new Map(staffCountsByVenue.map(r => [r.venueId, r._count]))

    // Pre-build online counts per venue from in-memory data
    const onlineCountsByVenue = new Map<string, number>()
    for (const entry of activeTimeEntries) {
      onlineCountsByVenue.set(entry.venueId, (onlineCountsByVenue.get(entry.venueId) || 0) + 1)
    }

    const byVenue = venues.map(venue => ({
      venueId: venue.id,
      venueName: venue.name,
      onlineCount: onlineCountsByVenue.get(venue.id) || 0,
      totalCount: staffCountsMap.get(venue.id) || 0,
    }))

    return {
      onlineCount: activeTimeEntries.length,
      totalCount: totalStaff,
      percentageOnline: totalStaff > 0 ? Math.round((activeTimeEntries.length / totalStaff) * 100) : 0,
      byVenue,
      onlineStaff,
    }
  }

  /**
   * Get organization-wide activity feed
   *
   * Aggregates events from multiple sources:
   * - Sales (Order table)
   * - Check-ins (TimeEntry table)
   * - System alerts
   *
   * @param orgId - Organization ID
   * @param limit - Max events to return (default 50)
   */
  async getActivityFeed(
    orgId: string,
    limit: number = 50,
    startDate?: string,
    endDate?: string,
    filterVenueId?: string,
  ): Promise<OrgActivityFeed> {
    let rangeStart: Date
    let rangeEnd: Date | undefined

    if (startDate || endDate) {
      const range = parseDbDateRange(startDate, endDate)
      rangeStart = range.from
      rangeEnd = range.to
    } else {
      // Default: today in venue timezone
      rangeStart = venueStartOfDay()
    }

    // Get venues (filtered or all)
    const venues = await prisma.venue.findMany({
      where: {
        organizationId: orgId,
        status: 'ACTIVE',
        ...(filterVenueId ? { id: filterVenueId } : {}),
      },
      select: { id: true, name: true },
    })
    const venueIds = venues.map(v => v.id)

    if (venueIds.length === 0) {
      return { events: [], total: 0 }
    }

    const events: ActivityEvent[] = []
    const timeFilter = rangeEnd ? { gte: rangeStart, lte: rangeEnd } : { gte: rangeStart }

    // Fetch recent sales (completed orders in range)
    // Include items → serializedItem → category to get ICCID and category name
    const recentOrders = await prisma.order.findMany({
      where: {
        venueId: { in: venueIds },
        status: 'COMPLETED',
        createdAt: timeFilter,
      },
      include: {
        venue: { select: { id: true, name: true } },
        servedBy: { select: { id: true, firstName: true, lastName: true } },
        items: {
          take: 1,
          include: {
            serializedItem: {
              select: { serialNumber: true, category: { select: { name: true, color: true } } },
            },
          },
        },
        payments: {
          take: 1,
          orderBy: { createdAt: 'desc' as const },
          select: {
            method: true,
            cardBrand: true,
            saleVerification: { select: { photos: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: Math.ceil(limit * 0.6), // Allocate 60% of limit to sales
    })

    for (const order of recentOrders) {
      const firstItem = order.items?.[0]
      const categoryName = firstItem?.serializedItem?.category?.name || firstItem?.categoryName || undefined
      const categoryColor = firstItem?.serializedItem?.category?.color || undefined
      const iccid = firstItem?.serializedItem?.serialNumber || undefined

      const firstPayment = order.payments?.[0]
      const photos = firstPayment?.saleVerification?.photos ?? []

      events.push({
        id: `sale-${order.id}`,
        type: 'sale',
        title: `Venta: ${order.total ? `$${Number(order.total).toFixed(2)}` : 'Sin monto'}`,
        subtitle: `${order.servedBy ? `${order.servedBy.firstName} ${order.servedBy.lastName}` : 'Staff desconocido'} • ${order.venue.name}`,
        timestamp: order.createdAt,
        severity: 'normal',
        venueId: order.venueId,
        venueName: order.venue.name,
        staffId: order.servedById || undefined,
        staffName: order.servedBy ? `${order.servedBy.firstName} ${order.servedBy.lastName}` : undefined,
        metadata: {
          orderId: order.id,
          total: order.total ? Number(order.total) : 0,
          categoryName,
          categoryColor,
          iccid,
          paymentMethod: firstPayment?.method || undefined,
          cardBrand: firstPayment?.cardBrand || undefined,
          tags: order.tags?.length ? order.tags : undefined,
          photos: photos.length ? photos : undefined,
        },
      })
    }

    // Fetch recent check-ins and checkouts (TimeEntry in range)
    const recentTimeEntries = await prisma.timeEntry.findMany({
      where: {
        venueId: { in: venueIds },
        clockInTime: timeFilter,
      },
      include: {
        venue: { select: { id: true, name: true } },
        staff: { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: { clockInTime: 'desc' },
      take: Math.ceil(limit * 0.4), // Allocate 40% of limit to time entries
    })

    for (const entry of recentTimeEntries) {
      // Add check-in event
      events.push({
        id: `checkin-${entry.id}`,
        type: 'checkin',
        title: `Check-in: ${entry.staff.firstName} ${entry.staff.lastName}`,
        subtitle: `${entry.jobRole || 'CASHIER'} • ${entry.venue.name}`,
        timestamp: entry.clockInTime,
        severity: 'normal',
        venueId: entry.venueId,
        venueName: entry.venue.name,
        staffId: entry.staffId,
        staffName: `${entry.staff.firstName} ${entry.staff.lastName}`,
        metadata: {
          timeEntryId: entry.id,
          role: entry.jobRole,
        },
      })

      // Add checkout event if it exists
      if (entry.clockOutTime) {
        events.push({
          id: `checkout-${entry.id}`,
          type: 'checkout',
          title: `Check-out: ${entry.staff.firstName} ${entry.staff.lastName}`,
          subtitle: `${entry.jobRole || 'CASHIER'} • ${entry.venue.name}`,
          timestamp: entry.clockOutTime,
          severity: 'normal',
          venueId: entry.venueId,
          venueName: entry.venue.name,
          staffId: entry.staffId,
          staffName: `${entry.staff.firstName} ${entry.staff.lastName}`,
          metadata: {
            timeEntryId: entry.id,
            role: entry.jobRole,
          },
        })
      }
    }

    // Sort all events by timestamp descending
    events.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())

    // Limit to requested size
    const limitedEvents = events.slice(0, limit)

    return {
      events: limitedEvents,
      total: events.length,
    }
  }

  /**
   * Get or create daily goals for current week
   */
  async getOrCreateWeeklyGoals(orgId: string): Promise<OrganizationGoalData[]> {
    // Use venue timezone for date calculations
    // Default to Mexico City if organization doesn't have timezone set
    const timezone = 'America/Mexico_City' // TODO: Get from organization settings

    const today = new Date()
    // Get current time in venue timezone
    const nowVenue = toZonedTime(today, timezone)

    // Calculate week start (Sunday) in venue timezone
    const weekStartVenue = new Date(nowVenue)
    weekStartVenue.setDate(nowVenue.getDate() - nowVenue.getDay()) // Sunday
    weekStartVenue.setHours(0, 0, 0, 0)

    // Convert back to UTC for database query
    const weekStart = fromZonedTime(weekStartVenue, timezone)

    const weekEnd = new Date(weekStart)
    weekEnd.setDate(weekStart.getDate() + 7)

    const monthStartVenue = new Date(weekStartVenue)
    monthStartVenue.setDate(1)
    monthStartVenue.setHours(0, 0, 0, 0)
    const monthStartUtc = new Date(Date.UTC(weekStartVenue.getFullYear(), weekStartVenue.getMonth(), 1))
    const monthEndUtc = new Date(Date.UTC(weekStartVenue.getFullYear(), weekStartVenue.getMonth() + 1, 1))
    const daysInMonth = new Date(monthStartVenue.getFullYear(), monthStartVenue.getMonth() + 1, 0).getDate()

    // Fetch all daily goals for the week in one query
    const existingGoals = await prisma.organizationGoal.findMany({
      where: {
        organizationId: orgId,
        period: 'daily',
        periodDate: {
          gte: weekStart,
          lt: weekEnd,
        },
      },
    })

    const weekStartUtc = new Date(Date.UTC(weekStartVenue.getFullYear(), weekStartVenue.getMonth(), weekStartVenue.getDate()))
    const weekEndUtc = new Date(weekStartUtc)
    weekEndUtc.setUTCDate(weekEndUtc.getUTCDate() + 7)

    const weeklyGoal = await prisma.organizationGoal.findFirst({
      where: {
        organizationId: orgId,
        period: 'weekly',
        periodDate: {
          gte: weekStartUtc,
          lt: weekEndUtc,
        },
      },
      orderBy: { periodDate: 'asc' },
    })

    const monthlyGoal = await prisma.organizationGoal.findFirst({
      where: {
        organizationId: orgId,
        period: 'monthly',
        periodDate: {
          gte: monthStartUtc,
          lt: monthEndUtc,
        },
      },
      orderBy: { periodDate: 'asc' },
    })

    const defaultSalesTarget = 19285.71
    const defaultVolumeTarget = 71

    const baseSalesTarget = weeklyGoal
      ? Number(weeklyGoal.salesTarget) / 7
      : monthlyGoal
        ? Number(monthlyGoal.salesTarget) / daysInMonth
        : defaultSalesTarget

    const baseVolumeTarget = weeklyGoal
      ? Math.round(weeklyGoal.volumeTarget / 7)
      : monthlyGoal
        ? Math.round(monthlyGoal.volumeTarget / daysInMonth)
        : defaultVolumeTarget

    const dailySalesTarget = Math.round(baseSalesTarget * 100) / 100

    const goals: OrganizationGoalData[] = []

    // Create/fetch goals for each day of the week
    for (let i = 0; i < 7; i++) {
      const dayDate = new Date(weekStart)
      dayDate.setUTCDate(weekStart.getUTCDate() + i)

      // Find existing goal by comparing date strings (avoids timezone issues)
      let goal = existingGoals.find(g => g.periodDate.toDateString() === dayDate.toDateString())

      const shouldNormalizeDailyGoal =
        !!goal &&
        (weeklyGoal || monthlyGoal) &&
        (Math.abs(Number(goal.salesTarget) - dailySalesTarget) > 0.01 || goal.volumeTarget !== baseVolumeTarget)

      if (!goal) {
        goal = await prisma.organizationGoal.create({
          data: {
            organizationId: orgId,
            period: 'daily',
            periodDate: dayDate,
            salesTarget: dailySalesTarget,
            volumeTarget: baseVolumeTarget,
          },
        })
      } else if (shouldNormalizeDailyGoal) {
        goal = await prisma.organizationGoal.update({
          where: { id: goal.id },
          data: {
            salesTarget: dailySalesTarget,
            volumeTarget: baseVolumeTarget,
          },
        })
      }

      goals.push({
        id: goal.id,
        organizationId: goal.organizationId,
        period: goal.period,
        periodDate: goal.periodDate,
        salesTarget: Number(goal.salesTarget),
        volumeTarget: goal.volumeTarget,
      })
    }

    return goals
  }

  /**
   * Get revenue vs target chart data for current week
   */
  async getRevenueVsTarget(
    orgId: string,
    venueId?: string,
  ): Promise<{ days: RevenueVsTargetData[]; weekTotal: { actual: number; target: number } }> {
    // IMPORTANT: Database timestamps are stored in UTC (timestamp without time zone treated as UTC)
    // We calculate dates in venue timezone, then convert to UTC for queries
    const timezone = 'America/Mexico_City' // TODO: Get from organization settings

    const today = new Date()
    const nowVenue = toZonedTime(today, timezone)

    // Calculate week start (Sunday) in venue timezone
    const weekStartVenue = new Date(nowVenue)
    weekStartVenue.setDate(nowVenue.getDate() - nowVenue.getDay()) // Sunday
    weekStartVenue.setHours(0, 0, 0, 0)

    // Convert to UTC for database query (timestamps in DB are UTC)
    const _weekStart = fromZonedTime(weekStartVenue, timezone)

    // Get venues
    const venues = await prisma.venue.findMany({
      where: {
        organizationId: orgId,
        status: 'ACTIVE',
        ...(venueId ? { id: venueId } : {}),
      },
      select: { id: true },
    })
    const venueIds = venues.map(v => v.id)

    // Get goals for the week
    const goals = await this.getOrCreateWeeklyGoals(orgId)

    const days: RevenueVsTargetData[] = []
    const dayNames = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb']
    let totalActual = 0
    let totalTarget = 0

    for (let i = 0; i < 7; i++) {
      // Calculate each day in venue timezone
      const dayStartVenue = new Date(weekStartVenue)
      dayStartVenue.setDate(weekStartVenue.getDate() + i)

      const dayEndVenue = new Date(dayStartVenue)
      dayEndVenue.setDate(dayStartVenue.getDate() + 1)

      // Convert to UTC for database query (timestamps in DB are UTC)
      const dayStart = fromZonedTime(dayStartVenue, timezone)
      const dayEnd = fromZonedTime(dayEndVenue, timezone)

      // Get actual revenue for this day
      const orders = await prisma.order.aggregate({
        where: {
          venueId: { in: venueIds },
          status: 'COMPLETED',
          createdAt: { gte: dayStart, lt: dayEnd },
        },
        _sum: { total: true },
      })

      const goal = goals.find(g => g.periodDate.toDateString() === dayStart.toDateString())
      const actual = Math.round((Number(orders._sum?.total) || 0) * 100) / 100
      const target = goal ? goal.salesTarget : 0

      totalActual += actual
      totalTarget += target

      days.push({
        day: dayNames[i],
        actual: actual,
        target: target,
        date: dayStart.toISOString(),
      })
    }

    return {
      days,
      weekTotal: {
        actual: Math.round(totalActual * 100) / 100,
        target: Math.round(totalTarget * 100) / 100,
      },
    }
  }

  /**
   * Get volume vs target chart data for current week
   */
  async getVolumeVsTarget(
    orgId: string,
    venueId?: string,
  ): Promise<{ days: VolumeVsTargetData[]; weekTotal: { actual: number; target: number } }> {
    // IMPORTANT: Database timestamps are stored in UTC (timestamp without time zone treated as UTC)
    // We calculate dates in venue timezone, then convert to UTC for queries
    const timezone = 'America/Mexico_City' // TODO: Get from organization settings

    const today = new Date()
    const nowVenue = toZonedTime(today, timezone)

    // Calculate week start (Sunday) in venue timezone
    const weekStartVenue = new Date(nowVenue)
    weekStartVenue.setDate(nowVenue.getDate() - nowVenue.getDay()) // Sunday
    weekStartVenue.setHours(0, 0, 0, 0)

    // Convert to UTC for database query (timestamps in DB are UTC)
    const _weekStart = fromZonedTime(weekStartVenue, timezone)

    // Get venues
    const venues = await prisma.venue.findMany({
      where: {
        organizationId: orgId,
        status: 'ACTIVE',
        ...(venueId ? { id: venueId } : {}),
      },
      select: { id: true },
    })
    const venueIds = venues.map(v => v.id)

    // Get goals for the week
    const goals = await this.getOrCreateWeeklyGoals(orgId)

    const days: VolumeVsTargetData[] = []
    const dayNames = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb']
    let totalActual = 0
    let totalTarget = 0

    for (let i = 0; i < 7; i++) {
      // Calculate each day in venue timezone
      const dayStartVenue = new Date(weekStartVenue)
      dayStartVenue.setDate(weekStartVenue.getDate() + i)

      const dayEndVenue = new Date(dayStartVenue)
      dayEndVenue.setDate(dayStartVenue.getDate() + 1)

      // Convert to UTC for database query (timestamps in DB are UTC)
      const dayStart = fromZonedTime(dayStartVenue, timezone)
      const dayEnd = fromZonedTime(dayEndVenue, timezone)

      // Get actual order count for this day
      const orderCount = await prisma.order.count({
        where: {
          venueId: { in: venueIds },
          status: 'COMPLETED',
          createdAt: { gte: dayStart, lt: dayEnd },
        },
      })

      const goal = goals.find(g => g.periodDate.toDateString() === dayStart.toDateString())
      const target = goal ? goal.volumeTarget : 0

      totalActual += orderCount
      totalTarget += target

      days.push({
        day: dayNames[i],
        actual: orderCount,
        target: target,
        date: dayStart.toISOString(),
      })
    }

    return {
      days,
      weekTotal: {
        actual: totalActual,
        target: totalTarget,
      },
    }
  }

  /**
   * Update goals for a specific period
   */
  async updateOrganizationGoal(
    orgId: string,
    period: string,
    periodDate: Date,
    salesTarget: number,
    volumeTarget: number,
  ): Promise<OrganizationGoalData> {
    const goal = await prisma.organizationGoal.upsert({
      where: {
        organizationId_period_periodDate: {
          organizationId: orgId,
          period,
          periodDate,
        },
      },
      update: {
        salesTarget,
        volumeTarget,
      },
      create: {
        organizationId: orgId,
        period,
        periodDate,
        salesTarget,
        volumeTarget,
      },
    })

    return {
      id: goal.id,
      organizationId: goal.organizationId,
      period: goal.period,
      periodDate: goal.periodDate,
      salesTarget: Number(goal.salesTarget),
      volumeTarget: goal.volumeTarget,
    }
  }

  /**
   * Get list of managers in organization
   */
  async getOrgManagers(orgId: string): Promise<
    Array<{
      id: string
      name: string
      email: string | null
      storeCount: number
      activeStores: number
      todaySales: number
    }>
  > {
    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)

    // Get all staff with ADMIN or MANAGER role in any venue
    const managers = await prisma.staffVenue.findMany({
      where: {
        venue: { organizationId: orgId },
        role: { in: ['ADMIN', 'MANAGER'] },
        active: true,
      },
      include: {
        staff: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
        venue: {
          select: {
            id: true,
          },
        },
      },
    })

    // Group by staff ID
    const managerMap = new Map<
      string,
      {
        staff: (typeof managers)[0]['staff']
        venues: string[]
      }
    >()

    for (const m of managers) {
      const existing = managerMap.get(m.staffId) || { staff: m.staff, venues: [] }
      existing.venues.push(m.venueId)
      managerMap.set(m.staffId, existing)
    }

    // Single bulk query for all managers' venues (avoids 2M queries)
    const allVenueIds = Array.from(managerMap.values()).flatMap(d => d.venues)

    const salesByVenue = await prisma.order.groupBy({
      by: ['venueId'],
      where: {
        venueId: { in: allVenueIds },
        status: 'COMPLETED',
        createdAt: { gte: todayStart },
      },
      _sum: { total: true },
    })

    const venueSalesMap = new Map(salesByVenue.map(s => [s.venueId, Number(s._sum.total) || 0]))

    // Distribute results per manager based on their venues
    const results = Array.from(managerMap.entries()).map(([staffId, data]) => {
      let todaySales = 0
      let activeStores = 0

      for (const venueId of data.venues) {
        const sales = venueSalesMap.get(venueId)
        if (sales && sales > 0) {
          todaySales += sales
          activeStores++
        }
      }

      return {
        id: staffId,
        name: `${data.staff.firstName} ${data.staff.lastName}`.trim(),
        email: data.staff.email,
        storeCount: data.venues.length,
        activeStores,
        todaySales: Math.round(todaySales * 100) / 100,
      }
    })

    // Sort by today's sales descending
    return results.sort((a, b) => b.todaySales - a.todaySales)
  }

  /**
   * Get top promoter by sales count (completed orders today)
   */
  async getTopPromoter(orgId: string): Promise<{
    staffId: string
    staffName: string
    venueId: string
    venueName: string
    salesCount: number
  } | null> {
    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)

    // Get all venues in organization
    const venues = await prisma.venue.findMany({
      where: { organizationId: orgId },
      select: { id: true, name: true },
    })

    if (venues.length === 0) return null

    const venueIds = venues.map(v => v.id)

    // Get all completed orders today with staff info
    const orders = await prisma.order.findMany({
      where: {
        venueId: { in: venueIds },
        status: 'COMPLETED',
        createdAt: { gte: todayStart },
        createdById: { not: null },
      },
      select: {
        createdById: true,
        venueId: true,
        createdBy: {
          select: {
            firstName: true,
            lastName: true,
          },
        },
        venue: {
          select: {
            name: true,
          },
        },
      },
    })

    if (orders.length === 0) return null

    // Group by staff and count sales
    const staffSalesMap = new Map<
      string,
      {
        staffId: string
        staffName: string
        venueId: string
        venueName: string
        salesCount: number
      }
    >()

    for (const order of orders) {
      if (!order.createdById) continue

      const existing = staffSalesMap.get(order.createdById)
      if (existing) {
        existing.salesCount++
      } else {
        staffSalesMap.set(order.createdById, {
          staffId: order.createdById,
          staffName: `${order.createdBy?.firstName || ''} ${order.createdBy?.lastName || ''}`.trim(),
          venueId: order.venueId,
          venueName: order.venue?.name || '',
          salesCount: 1,
        })
      }
    }

    // Find top promoter
    const topPromoter = Array.from(staffSalesMap.values()).sort((a, b) => b.salesCount - a.salesCount)[0]

    return topPromoter || null
  }

  /**
   * Get worst attendance (store with lowest percentage of active staff today)
   */
  async getWorstAttendance(orgId: string): Promise<{
    venueId: string
    venueName: string
    totalStaff: number
    activeStaff: number
    absences: number
    attendanceRate: number
  } | null> {
    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)

    // Get all venues in organization
    const venues = await prisma.venue.findMany({
      where: { organizationId: orgId },
      select: { id: true, name: true },
    })

    if (venues.length === 0) return null

    // Bulk queries: staff count and active entries per venue (avoids 2V queries)
    const venueIds = venues.map(v => v.id)

    const [staffByVenue, activeByVenue] = await Promise.all([
      prisma.staffVenue.groupBy({
        by: ['venueId'],
        where: { venueId: { in: venueIds }, active: true },
        _count: true,
      }),
      prisma.timeEntry.groupBy({
        by: ['venueId'],
        where: {
          venueId: { in: venueIds },
          clockInTime: { gte: todayStart },
          clockOutTime: null,
        },
        _count: true,
      }),
    ])

    const staffMap = new Map(staffByVenue.map(s => [s.venueId, s._count]))
    const activeMap = new Map(activeByVenue.map(a => [a.venueId, a._count]))

    const venueAttendance = venues.map(venue => {
      const totalStaff = staffMap.get(venue.id) || 0
      if (totalStaff === 0) return null

      const activeStaff = activeMap.get(venue.id) || 0
      const absences = totalStaff - activeStaff
      const attendanceRate = totalStaff > 0 ? (activeStaff / totalStaff) * 100 : 0

      return {
        venueId: venue.id,
        venueName: venue.name,
        totalStaff,
        activeStaff,
        absences,
        attendanceRate: Math.round(attendanceRate * 10) / 10,
      }
    })

    // Filter out nulls and find worst attendance
    const validVenues = venueAttendance.filter(v => v !== null)
    if (validVenues.length === 0) return null

    const worstAttendance = validVenues.sort((a, b) => a.attendanceRate - b.attendanceRate)[0]

    return worstAttendance || null
  }

  /**
   * Get staff attendance with TimeEntry data for promoter audit
   * Returns all staff with their TimeEntry for the specified date
   */
  async getStaffAttendance(
    orgId: string,
    dateStr?: string,
    venueId?: string,
    statusFilter?: string,
    startDateStr?: string,
    endDateStr?: string,
  ): Promise<{
    staff: Array<{
      id: string
      name: string
      email: string
      avatar?: string | null
      venueId: string
      venueName: string
      status: 'ACTIVE' | 'INACTIVE'
      validationStatus: 'PENDING' | 'APPROVED' | 'REJECTED'
      checkInTime?: string | null
      checkInLocation?: { lat: number; lng: number } | null
      checkInPhotoUrl?: string | null
      checkOutTime?: string | null
      checkOutLocation?: { lat: number; lng: number } | null
      checkOutPhotoUrl?: string | null
      break: boolean
      breakMinutes: number
      sales: number
      attendancePercent: number
    }>
  }> {
    // Parse date range — convert venue-local dates to UTC for Prisma queries.
    // DB stores UTC (Prisma sends JS Date as UTC). Frontend sends YYYY-MM-DD venue-local dates.
    // We convert venue midnight/end-of-day to real UTC boundaries using fromZonedTime.
    let dayStart: Date
    let dayEnd: Date
    if (startDateStr && endDateStr) {
      dayStart = fromZonedTime(new Date(`${startDateStr}T00:00:00`), DEFAULT_TIMEZONE)
      dayEnd = fromZonedTime(new Date(`${endDateStr}T23:59:59.999`), DEFAULT_TIMEZONE)
    } else if (dateStr) {
      dayStart = fromZonedTime(new Date(`${dateStr}T00:00:00`), DEFAULT_TIMEZONE)
      dayEnd = fromZonedTime(new Date(`${dateStr}T23:59:59.999`), DEFAULT_TIMEZONE)
    } else {
      // No date specified → today in venue timezone
      const nowVenue = toZonedTime(new Date(), DEFAULT_TIMEZONE)
      dayStart = fromZonedTime(startOfDay(nowVenue), DEFAULT_TIMEZONE)
      dayEnd = fromZonedTime(endOfDay(nowVenue), DEFAULT_TIMEZONE)
    }

    // Get all venues in organization
    const venues = await prisma.venue.findMany({
      where: { organizationId: orgId },
      select: { id: true, name: true },
    })

    const venueIds = venueId ? [venueId] : venues.map(v => v.id)

    // Get all staff in these venues
    const staffVenues = await prisma.staffVenue.findMany({
      where: {
        venueId: { in: venueIds },
        active: true,
      },
      include: {
        staff: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            photoUrl: true,
          },
        },
        venue: { select: { name: true } },
      },
    })

    // Get TimeEntry for the specified date
    const timeEntries = await prisma.timeEntry.findMany({
      where: {
        venueId: { in: venueIds },
        clockInTime: { gte: dayStart, lte: dayEnd },
      },
      select: {
        id: true,
        staffId: true,
        venueId: true,
        clockInTime: true,
        clockOutTime: true,
        clockInLatitude: true,
        clockInLongitude: true,
        clockOutLatitude: true,
        clockOutLongitude: true,
        checkInPhotoUrl: true,
        checkOutPhotoUrl: true,
        depositPhotoUrl: true,
        status: true,
        validationStatus: true,
      },
    })

    // Get sales for each staff member per venue from completed payments
    const salesData = await prisma.payment.groupBy({
      by: ['processedById', 'venueId'],
      where: {
        venueId: { in: venueIds },
        createdAt: { gte: dayStart, lte: dayEnd },
        status: 'COMPLETED',
        processedById: { not: null },
      },
      _sum: { amount: true },
    })

    // Get CASH-only sales per staff (for deposit verification)
    const cashSalesData = await prisma.payment.groupBy({
      by: ['processedById', 'venueId'],
      where: {
        venueId: { in: venueIds },
        createdAt: { gte: dayStart, lte: dayEnd },
        status: 'COMPLETED',
        processedById: { not: null },
        method: 'CASH',
      },
      _sum: { amount: true },
    })

    // Get individual CASH payments for per-time-entry breakdown
    const cashPayments = await prisma.payment.findMany({
      where: {
        venueId: { in: venueIds },
        createdAt: { gte: dayStart, lte: dayEnd },
        status: 'COMPLETED',
        processedById: { not: null },
        method: 'CASH',
      },
      select: {
        processedById: true,
        venueId: true,
        amount: true,
        createdAt: true,
      },
    })

    // Key: staffId:venueId -> sales amount
    const salesByStaffVenue: Record<string, number> = {}
    salesData.forEach(s => {
      if (s.processedById) {
        const key = `${s.processedById}:${s.venueId}`
        salesByStaffVenue[key] = Number(s._sum.amount) || 0
      }
    })

    // Key: staffId:venueId -> cash sales amount
    const cashSalesByStaffVenue: Record<string, number> = {}
    cashSalesData.forEach(s => {
      if (s.processedById) {
        const key = `${s.processedById}:${s.venueId}`
        cashSalesByStaffVenue[key] = Number(s._sum.amount) || 0
      }
    })

    // Calculate attendance percentage for last 30 days
    const thirtyDaysAgo = new Date()
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)

    const attendanceData = await prisma.timeEntry.groupBy({
      by: ['staffId'],
      where: {
        venueId: { in: venueIds },
        clockInTime: { gte: thirtyDaysAgo },
      },
      _count: { id: true },
    })

    const attendanceByStaff: Record<string, number> = {}
    attendanceData.forEach(a => {
      // Simplified: count / 30 days * 100
      attendanceByStaff[a.staffId] = Math.round((a._count.id / 30) * 100)
    })

    // Build response
    const staffData = staffVenues.map(sv => {
      // Get ALL TimeEntries for this staff member at this venue (sorted most recent first)
      const staffTimeEntries = timeEntries
        .filter(te => te.staffId === sv.staffId && te.venueId === sv.venueId)
        .sort((a, b) => b.clockInTime.getTime() - a.clockInTime.getTime())

      const mostRecentEntry = staffTimeEntries[0] // Most recent for status
      const isActive = mostRecentEntry && !mostRecentEntry.clockOutTime
      const status = isActive ? 'ACTIVE' : 'INACTIVE'

      // Apply status filter
      if (statusFilter && status !== statusFilter) {
        return null
      }

      const fullName = `${sv.staff.firstName} ${sv.staff.lastName}`

      // Transform all time entries for this staff member
      const staffCashPayments = cashPayments.filter(p => p.processedById === sv.staffId && p.venueId === sv.venueId)
      const allTimeEntries = staffTimeEntries.map(te => {
        // Calculate cash sales for this specific time entry (clockIn → clockOut)
        const teStartMs = te.clockInTime.getTime()
        const teEndMs = te.clockOutTime ? te.clockOutTime.getTime() : Infinity
        const matchingPayments = staffCashPayments.filter(p => p.createdAt.getTime() >= teStartMs && p.createdAt.getTime() <= teEndMs)
        const teCashSales = matchingPayments.reduce((sum, p) => sum + (Number(p.amount) || 0), 0)
        // DEBUG: remove after verifying

        return {
          id: te.id,
          clockInTime: te.clockInTime.toISOString(),
          clockInLocation: te.clockInLatitude && te.clockInLongitude ? { lat: te.clockInLatitude, lng: te.clockInLongitude } : null,
          checkInPhotoUrl: te.checkInPhotoUrl,
          clockOutTime: te.clockOutTime?.toISOString() || null,
          clockOutLocation: te.clockOutLatitude && te.clockOutLongitude ? { lat: te.clockOutLatitude, lng: te.clockOutLongitude } : null,
          checkOutPhotoUrl: te.checkOutPhotoUrl,
          depositPhotoUrl: te.depositPhotoUrl,
          status: te.status,
          validationStatus: te.validationStatus,
          cashSales: teCashSales,
        }
      })

      // Calculate break time (time between clock out of one entry and clock in of next)
      let breakMinutes = 0
      const sortedEntriesAsc = [...staffTimeEntries].reverse() // Oldest first for break calculation
      for (let i = 0; i < sortedEntriesAsc.length - 1; i++) {
        const currentEntry = sortedEntriesAsc[i]
        const nextEntry = sortedEntriesAsc[i + 1]
        if (currentEntry.clockOutTime && nextEntry.clockInTime) {
          const breakMs = nextEntry.clockInTime.getTime() - currentEntry.clockOutTime.getTime()
          if (breakMs > 0) {
            breakMinutes += Math.round(breakMs / 60000) // Convert to minutes
          }
        }
      }

      return {
        id: sv.staffId,
        timeEntryId: mostRecentEntry?.id || null,
        validationStatus: mostRecentEntry?.validationStatus || 'PENDING',
        name: fullName,
        email: sv.staff.email,
        avatar: sv.staff.photoUrl,
        venueId: sv.venueId,
        venueName: sv.venue.name,
        status,
        // Most recent entry info for table display
        checkInTime: mostRecentEntry?.clockInTime?.toISOString() || null,
        checkInLocation:
          mostRecentEntry?.clockInLatitude && mostRecentEntry?.clockInLongitude
            ? { lat: mostRecentEntry.clockInLatitude, lng: mostRecentEntry.clockInLongitude }
            : null,
        checkInPhotoUrl: mostRecentEntry?.checkInPhotoUrl || null,
        checkOutTime: mostRecentEntry?.clockOutTime?.toISOString() || null,
        checkOutLocation:
          mostRecentEntry?.clockOutLatitude && mostRecentEntry?.clockOutLongitude
            ? { lat: mostRecentEntry.clockOutLatitude, lng: mostRecentEntry.clockOutLongitude }
            : null,
        checkOutPhotoUrl: mostRecentEntry?.checkOutPhotoUrl || null,
        break: mostRecentEntry?.status === 'ON_BREAK',
        breakMinutes,
        sales: salesByStaffVenue[`${sv.staffId}:${sv.venueId}`] || 0,
        cashSales: cashSalesByStaffVenue[`${sv.staffId}:${sv.venueId}`] || 0,
        attendancePercent: attendanceByStaff[sv.staffId] || 0,
        // All time entries for the day
        allTimeEntries,
      }
    })

    return {
      // Only return staff with actual activity (check-in or sales) for the day
      staff: staffData.filter(s => s !== null && (s.checkInTime !== null || s.sales > 0)) as any,
    }
  }

  /**
   * Get sales trend for a staff member (last 7 days)
   */
  async getStaffSalesTrend(orgId: string, staffId: string) {
    const today = new Date()
    const sevenDaysAgo = new Date(today)
    sevenDaysAgo.setDate(today.getDate() - 7)
    sevenDaysAgo.setHours(0, 0, 0, 0)

    // Get all orders created by this staff member in the last 7 days
    const orders = await prisma.order.findMany({
      where: {
        createdById: staffId,
        createdAt: { gte: sevenDaysAgo },
        status: 'COMPLETED',
      },
      select: {
        createdAt: true,
        total: true,
      },
    })

    // Group by day
    const salesByDay: Record<string, number> = {}
    const dayNames = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb']

    // Initialize last 7 days
    for (let i = 6; i >= 0; i--) {
      const date = new Date(today)
      date.setDate(today.getDate() - i)
      const dayName = dayNames[date.getDay()]
      salesByDay[dayName] = 0
    }

    // Aggregate sales
    orders.forEach(order => {
      const dayName = dayNames[order.createdAt.getDay()]
      if (salesByDay[dayName] !== undefined) {
        salesByDay[dayName] += Number(order.total)
      }
    })

    const salesData = Object.entries(salesByDay).map(([day, sales]) => ({
      day,
      sales,
    }))

    return { salesData }
  }

  /**
   * Get sales mix by category for a staff member
   */
  async getStaffSalesMix(orgId: string, staffId: string) {
    // Get orders with items created by this staff member
    const orders = await prisma.order.findMany({
      where: {
        createdById: staffId,
        status: 'COMPLETED',
      },
      include: {
        items: {
          include: {
            product: {
              select: {
                category: {
                  select: {
                    name: true,
                  },
                },
              },
            },
          },
        },
      },
    })

    // Aggregate by category
    const categoryTotals: Record<string, number> = {}
    let totalSales = 0

    orders.forEach(order => {
      order.items.forEach(item => {
        const categoryName = item.product?.category?.name || 'Sin categoría'
        const itemTotal = Number(item.total)
        categoryTotals[categoryName] = (categoryTotals[categoryName] || 0) + itemTotal
        totalSales += itemTotal
      })
    })

    // Convert to percentages
    const salesMix = Object.entries(categoryTotals)
      .map(([category, amount]) => ({
        category,
        percentage: totalSales > 0 ? Math.round((amount / totalSales) * 100) : 0,
        amount,
      }))
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 4) // Top 4 categories

    return { salesMix }
  }

  /**
   * Get attendance calendar for current month
   */
  async getStaffAttendanceCalendar(orgId: string, staffId: string) {
    const now = new Date()
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999)

    // Get all TimeEntry for this month with full details for dialog
    const timeEntries = await prisma.timeEntry.findMany({
      where: {
        staffId,
        clockInTime: {
          gte: monthStart,
          lte: monthEnd,
        },
      },
      select: {
        clockInTime: true,
        clockOutTime: true,
        clockInLatitude: true,
        clockInLongitude: true,
        clockOutLatitude: true,
        clockOutLongitude: true,
        checkInPhotoUrl: true,
        checkOutPhotoUrl: true,
        status: true,
      },
      orderBy: {
        clockInTime: 'desc',
      },
    })

    // Transform entries to include location objects for frontend compatibility
    const transformedEntries = timeEntries.map(entry => ({
      clockInTime: entry.clockInTime,
      clockOutTime: entry.clockOutTime,
      clockInLocation: entry.clockInLatitude && entry.clockInLongitude ? { lat: entry.clockInLatitude, lng: entry.clockInLongitude } : null,
      clockOutLocation:
        entry.clockOutLatitude && entry.clockOutLongitude ? { lat: entry.clockOutLatitude, lng: entry.clockOutLongitude } : null,
      checkInPhotoUrl: entry.checkInPhotoUrl,
      checkOutPhotoUrl: entry.checkOutPhotoUrl,
      status: entry.status,
    }))

    // Create calendar array with attendance info
    const daysInMonth = monthEnd.getDate()
    const calendar = Array.from({ length: daysInMonth }, (_, idx) => {
      const dayNumber = idx + 1
      const date = new Date(now.getFullYear(), now.getMonth(), dayNumber)
      const dateString = date.toISOString().split('T')[0]

      // Get all TimeEntry for this specific day
      const dayTimeEntries = transformedEntries.filter(entry => {
        const entryDate = entry.clockInTime.toISOString().split('T')[0]
        return entryDate === dateString
      })

      const hasAttendance = dayTimeEntries.length > 0
      const isToday = dayNumber === now.getDate()
      const isFutureDay = date > now

      return {
        day: dayNumber,
        date: dateString,
        isPresent: hasAttendance,
        isToday,
        isFutureDay,
        timeEntries: dayTimeEntries, // Include full time entries for the dialog
      }
    })

    // Calculate stats
    const presentDays = calendar.filter(d => !d.isFutureDay && d.isPresent).length
    const absentDays = calendar.filter(d => !d.isFutureDay && !d.isPresent).length

    return {
      calendar,
      stats: {
        present: presentDays,
        absent: absentDays,
      },
    }
  }

  // ==========================================
  // TIME ENTRY VALIDATION
  // ==========================================

  async validateTimeEntry(
    timeEntryId: string,
    orgId: string,
    validatedById: string,
    status: 'APPROVED' | 'REJECTED',
    note?: string,
    depositAmount?: number,
  ) {
    // Verify the time entry belongs to a venue in this org
    const timeEntry = await prisma.timeEntry.findFirst({
      where: {
        id: timeEntryId,
        venue: { organizationId: orgId },
      },
    })

    if (!timeEntry) {
      throw new Error('Time entry not found in this organization')
    }

    return prisma.$transaction(async tx => {
      const updated = await tx.timeEntry.update({
        where: { id: timeEntryId },
        data: {
          validationStatus: status,
          validatedBy: validatedById,
          validatedAt: new Date(),
          validationNote: note || null,
        },
      })

      // Create CashDeposit when approving with a deposit amount
      if (status === 'APPROVED' && depositAmount != null && depositAmount > 0) {
        await tx.cashDeposit.create({
          data: {
            staffId: timeEntry.staffId,
            venueId: timeEntry.venueId,
            amount: new Prisma.Decimal(depositAmount),
            method: 'BANK_TRANSFER',
            status: 'APPROVED',
            approvedById: validatedById,
            approvedAt: new Date(),
          },
        })
      }

      return updated
    })
  }

  /**
   * Reset a time entry validation back to PENDING
   * Also deletes any associated CashDeposit created during approval
   */
  async resetTimeEntryValidation(timeEntryId: string, orgId: string) {
    const timeEntry = await prisma.timeEntry.findFirst({
      where: {
        id: timeEntryId,
        venue: { organizationId: orgId },
      },
    })

    if (!timeEntry) {
      throw new Error('Time entry not found in this organization')
    }

    return prisma.$transaction(async tx => {
      // Delete any CashDeposit created around the same time as validation
      if (timeEntry.validatedAt) {
        const windowStart = new Date(timeEntry.validatedAt.getTime() - 5000)
        const windowEnd = new Date(timeEntry.validatedAt.getTime() + 5000)
        await tx.cashDeposit.deleteMany({
          where: {
            staffId: timeEntry.staffId,
            venueId: timeEntry.venueId,
            status: 'APPROVED',
            createdAt: { gte: windowStart, lte: windowEnd },
          },
        })
      }

      return tx.timeEntry.update({
        where: { id: timeEntryId },
        data: {
          validationStatus: 'PENDING',
          validatedBy: null,
          validatedAt: null,
          validationNote: null,
        },
      })
    })
  }

  // ==========================================
  // ZONES CRUD
  // ==========================================

  async getZones(orgId: string) {
    return prisma.zone.findMany({
      where: { organizationId: orgId },
      include: {
        venues: { select: { id: true, name: true, slug: true } },
      },
      orderBy: { name: 'asc' },
    })
  }

  async createZone(orgId: string, name: string, slug: string) {
    return prisma.zone.create({
      data: { organizationId: orgId, name, slug },
    })
  }

  async updateZone(zoneId: string, data: { name?: string; slug?: string }) {
    return prisma.zone.update({
      where: { id: zoneId },
      data,
    })
  }

  async deleteZone(zoneId: string) {
    // Set null on venues referencing this zone, then delete
    await prisma.venue.updateMany({
      where: { zoneId },
      data: { zoneId: null },
    })
    return prisma.zone.delete({ where: { id: zoneId } })
  }

  // ==========================================
  // CLOSING REPORT
  // ==========================================

  async getClosingReportData(orgId: string, dateStr?: string, venueId?: string) {
    const timezone = 'America/Mexico_City'
    // DB stores local time — use venue helpers
    const targetDate = dateStr ? new Date(dateStr) : new Date()
    const startOfDayDb = venueStartOfDay(timezone, targetDate)
    const endOfDayDb = venueEndOfDay(timezone, targetDate)

    const startUtc = startOfDayDb
    const endUtc = endOfDayDb

    const venueWhere = venueId ? { id: venueId, organizationId: orgId } : { organizationId: orgId }

    // Get completed orders with serialized items
    const orders = await prisma.order.findMany({
      where: {
        venue: venueWhere,
        createdAt: { gte: startUtc, lte: endUtc },
        status: 'COMPLETED',
      },
      include: {
        venue: { select: { name: true, city: true, state: true } },
        createdBy: { select: { firstName: true, lastName: true } },
        payments: { select: { amount: true, status: true } },
        items: { select: { productName: true, productSku: true, unitPrice: true } },
      },
      orderBy: { createdAt: 'asc' },
    })

    const rows = orders.map((order: any, idx: number) => {
      const totalPaid = (order.payments || [])
        .filter((p: any) => p.status === 'COMPLETED')
        .reduce((sum: number, p: any) => sum + Number(p.amount), 0)

      // Try to extract ICCID from product SKU (serialized items)
      const iccid = order.items?.[0]?.productSku || ''
      const productName = order.items?.[0]?.productName || 'Venta'

      return {
        row: idx + 1,
        city: order.venue?.city || order.venue?.state || '',
        store: order.venue?.name || '',
        iccid,
        saleType: productName,
        promoter: order.createdBy ? `${order.createdBy.firstName} ${order.createdBy.lastName}` : 'N/A',
        date: order.createdAt.toISOString().split('T')[0],
        amount: totalPaid,
      }
    })

    const totalAmount = rows.reduce((sum, r) => sum + r.amount, 0)

    return { rows, totalAmount, date: dateStr || startOfDayDb.toISOString().split('T')[0] }
  }

  async exportClosingReport(orgId: string, dateStr?: string, venueId?: string): Promise<Buffer> {
    const XLSX = await import('xlsx')
    const data = await this.getClosingReportData(orgId, dateStr, venueId)

    const worksheetData = [
      ['#', 'Ciudad', 'Tienda', 'ICCID', 'Tipo Venta', 'Promotor', 'Fecha', 'Monto Cobrado'],
      ...data.rows.map(r => [r.row, r.city, r.store, r.iccid, r.saleType, r.promoter, r.date, r.amount]),
      [],
      ['', '', '', '', '', '', 'TOTAL COBRADO:', data.totalAmount],
    ]

    const wb = XLSX.utils.book_new()
    const ws = XLSX.utils.aoa_to_sheet(worksheetData)
    XLSX.utils.book_append_sheet(wb, ws, 'Reporte de Cierre')

    return Buffer.from(XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' }))
  }

  // ==========================================
  // ADMIN PASSWORD RESET
  // ==========================================

  async resetUserPassword(orgId: string, userId: string) {
    // Verify user belongs to org
    const staffOrg = await prisma.staffOrganization.findFirst({
      where: { staffId: userId, organizationId: orgId },
    })

    if (!staffOrg) {
      throw new Error('User not found in this organization')
    }

    // Generate a temp password
    const tempPassword = Math.random().toString(36).slice(-8)
    const bcrypt = await import('bcryptjs')
    const hashedPassword = await bcrypt.hash(tempPassword, 12)

    await prisma.staff.update({
      where: { id: userId },
      data: { password: hashedPassword },
    })

    return { tempPassword, message: 'Password reset successfully. Share the temporary password securely.' }
  }
}

export const organizationDashboardService = new OrganizationDashboardService()
