/**
 * Command Center Service
 * Provides real-time KPIs, activity feeds, and operational insights
 * for the PlayTelecom/White-Label dashboard.
 */
import prisma from '../../utils/prismaClient'

// Types for the service responses - aligned with frontend expectations
export interface CommandCenterSummary {
  todaySales: number
  todayUnits: number
  avgTicket: number
  weekSales: number
  weekUnits: number
  monthSales: number
  monthUnits: number
  activePromoters: number
  totalPromoters: number
  activeStores: number
  totalStores: number
  topSellers: TopSeller[]
  categoryBreakdown: CategoryBreakdown[]
}

export interface ActivityItem {
  id: string
  type: 'SALE' | 'CHECK_IN' | 'CHECK_OUT' | 'DEPOSIT' | 'ALERT'
  timestamp: Date
  description: string
  metadata: Record<string, any>
}

export interface Insight {
  id: string
  type: 'WARNING' | 'CRITICAL' | 'INFO'
  title: string
  description: string
  actionRequired: boolean
}

export interface TopSeller {
  id: string
  name: string
  photoUrl: string | null
  sales: number
  units: number
  rank: number
}

export interface CategoryBreakdown {
  id: string
  name: string
  sales: number
  units: number
  percentage: number
}

export interface SalesTrendPoint {
  date: string
  sales: number
  units: number
  transactions: number
}

export interface SalesTrendResponse {
  trend: SalesTrendPoint[]
  comparison: {
    salesChange: number
    unitsChange: number
    transactionsChange: number
  }
}

class CommandCenterService {
  /**
   * Get summary stats for a venue (today's sales, units sold, etc.)
   * Returns all data needed for the Command Center dashboard in one call
   */
  async getSummary(venueId: string): Promise<CommandCenterSummary> {
    const now = new Date()
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const weekStart = new Date(todayStart)
    weekStart.setDate(weekStart.getDate() - 7)
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)

    // Get today's orders with items and creator info
    const todayOrders = await prisma.order.findMany({
      where: {
        venueId,
        status: 'COMPLETED',
        createdAt: { gte: todayStart },
      },
      include: {
        items: true,
        createdBy: {
          select: { id: true, firstName: true, lastName: true, photoUrl: true },
        },
      },
    })

    const todaySales = todayOrders.reduce((sum, order) => sum + Number(order.total || 0), 0)
    const todayUnits = todayOrders.reduce((sum, order) => sum + order.items.length, 0)
    const avgTicket = todayOrders.length > 0 ? todaySales / todayOrders.length : 0

    // Get week orders with items for units calculation
    const weekOrders = await prisma.order.findMany({
      where: {
        venueId,
        status: 'COMPLETED',
        createdAt: { gte: weekStart },
      },
      include: {
        items: true,
      },
    })
    const weekSales = weekOrders.reduce((sum, order) => sum + Number(order.total || 0), 0)
    const weekUnits = weekOrders.reduce((sum, order) => sum + order.items.length, 0)

    // Get month orders with items for units calculation
    const monthOrders = await prisma.order.findMany({
      where: {
        venueId,
        status: 'COMPLETED',
        createdAt: { gte: monthStart },
      },
      include: {
        items: true,
      },
    })
    const monthSales = monthOrders.reduce((sum, order) => sum + Number(order.total || 0), 0)
    const monthUnits = monthOrders.reduce((sum, order) => sum + order.items.length, 0)

    // Get active promoters (checked in today) - using TimeEntry model
    const activePromotersRecords = await prisma.timeEntry.findMany({
      where: {
        venueId,
        clockInTime: { gte: todayStart },
        status: 'CLOCKED_IN',
      },
      distinct: ['staffId'],
    })

    // Get total promoters (staff with promoter-like roles assigned to this venue)
    const totalPromoters = await prisma.staffVenue.count({
      where: {
        venueId,
        active: true,
        role: { in: ['CASHIER', 'WAITER'] },
      },
    })

    // Calculate top sellers from today's orders
    const sellerStats = new Map<string, { id: string; name: string; photoUrl: string | null; sales: number; units: number }>()
    for (const order of todayOrders) {
      if (!order.createdBy) continue
      const sellerId = order.createdBy.id
      const existing = sellerStats.get(sellerId) || {
        id: sellerId,
        name: `${order.createdBy.firstName} ${order.createdBy.lastName}`.trim(),
        photoUrl: order.createdBy.photoUrl || null,
        sales: 0,
        units: 0,
      }
      existing.sales += Number(order.total || 0)
      existing.units += order.items.length
      sellerStats.set(sellerId, existing)
    }
    const topSellers: TopSeller[] = Array.from(sellerStats.values())
      .sort((a, b) => b.sales - a.sales)
      .slice(0, 5)
      .map((seller, index) => ({
        ...seller,
        rank: index + 1,
        sales: Math.round(seller.sales * 100) / 100,
      }))

    // Get category breakdown from today's order items using denormalized categoryName
    const categoryStats = new Map<string, { id: string; name: string; sales: number; units: number }>()

    for (const order of todayOrders) {
      for (const item of order.items) {
        // Use denormalized categoryName from OrderItem, or "Sin categoría" as fallback
        const catName = item.categoryName || 'Sin categoría'
        const catId = item.productId || catName // Use productId as key or categoryName if no product

        const existing = categoryStats.get(catId) || {
          id: catId,
          name: catName,
          sales: 0,
          units: 0,
        }
        existing.units += item.quantity
        existing.sales += Number(item.total || 0)
        categoryStats.set(catId, existing)
      }
    }

    // Calculate percentages
    const totalCategoryUnits = Array.from(categoryStats.values()).reduce((sum, cat) => sum + cat.units, 0)
    const categoryBreakdown: CategoryBreakdown[] = Array.from(categoryStats.values())
      .sort((a, b) => b.units - a.units)
      .slice(0, 5)
      .map(cat => ({
        ...cat,
        sales: Math.round(cat.sales * 100) / 100,
        percentage: totalCategoryUnits > 0 ? Math.round((cat.units / totalCategoryUnits) * 100) : 0,
      }))

    return {
      todaySales: Math.round(todaySales * 100) / 100,
      todayUnits,
      avgTicket: Math.round(avgTicket * 100) / 100,
      weekSales: Math.round(weekSales * 100) / 100,
      weekUnits,
      monthSales: Math.round(monthSales * 100) / 100,
      monthUnits,
      activePromoters: activePromotersRecords.length,
      totalPromoters,
      activeStores: 1,
      totalStores: 1, // Single venue context
      topSellers,
      categoryBreakdown,
    }
  }

  /**
   * Get recent activity feed (sales, check-ins, deposits)
   */
  async getActivity(venueId: string, limit: number = 20): Promise<ActivityItem[]> {
    const activities: ActivityItem[] = []

    // Get recent sales with creator info
    const recentSales = await prisma.order.findMany({
      where: {
        venueId,
        status: 'COMPLETED',
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        createdBy: {
          select: { firstName: true, lastName: true },
        },
      },
    })

    for (const sale of recentSales) {
      const sellerName = sale.createdBy ? `${sale.createdBy.firstName} ${sale.createdBy.lastName}`.trim() : 'Unknown'
      activities.push({
        id: `sale-${sale.id}`,
        type: 'SALE',
        timestamp: sale.createdAt,
        description: `Venta de $${Number(sale.total).toFixed(2)}`,
        metadata: {
          orderId: sale.id,
          total: Number(sale.total),
          seller: sellerName,
        },
      })
    }

    // Get recent time entries (check-ins/check-outs) - using TimeEntry model
    const recentTimeEntries = await prisma.timeEntry.findMany({
      where: {
        venueId,
      },
      orderBy: { clockInTime: 'desc' },
      take: limit,
      include: {
        staff: {
          select: { firstName: true, lastName: true },
        },
      },
    })

    for (const entry of recentTimeEntries) {
      // Add check-in activity
      activities.push({
        id: `checkin-${entry.id}`,
        type: 'CHECK_IN' as const,
        timestamp: entry.clockInTime,
        description: `${entry.staff.firstName} ${entry.staff.lastName} - Entrada`,
        metadata: {
          staffId: entry.staffId,
          method: 'GPS_PHOTO',
          verified: true,
        },
      })
      // Add check-out activity if exists
      if (entry.clockOutTime) {
        activities.push({
          id: `checkout-${entry.id}`,
          type: 'CHECK_OUT' as const,
          timestamp: entry.clockOutTime,
          description: `${entry.staff.firstName} ${entry.staff.lastName} - Salida`,
          metadata: {
            staffId: entry.staffId,
            method: 'GPS_PHOTO',
            verified: true,
          },
        })
      }
    }

    // Get recent deposits
    const recentDeposits = await prisma.cashDeposit.findMany({
      where: { venueId },
      orderBy: { timestamp: 'desc' },
      take: limit,
      include: {
        staff: {
          select: { firstName: true, lastName: true },
        },
      },
    })

    for (const deposit of recentDeposits) {
      activities.push({
        id: `deposit-${deposit.id}`,
        type: 'DEPOSIT',
        timestamp: deposit.timestamp,
        description: `Depósito de $${Number(deposit.amount).toFixed(2)} - ${deposit.status}`,
        metadata: {
          depositId: deposit.id,
          amount: Number(deposit.amount),
          status: deposit.status,
          staff: `${deposit.staff.firstName} ${deposit.staff.lastName}`.trim(),
        },
      })
    }

    // Sort all activities by timestamp descending and return top N
    return activities.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime()).slice(0, limit)
  }

  /**
   * Get operational insights (alerts requiring attention)
   */
  async getInsights(venueId: string): Promise<Insight[]> {
    const insights: Insight[] = []

    // Check for pending deposits
    const pendingDeposits = await prisma.cashDeposit.count({
      where: {
        venueId,
        status: 'PENDING',
      },
    })

    if (pendingDeposits > 0) {
      insights.push({
        id: 'pending-deposits',
        type: pendingDeposits > 5 ? 'CRITICAL' : 'WARNING',
        title: 'Depósitos Pendientes',
        description: `${pendingDeposits} depósito(s) esperando aprobación`,
        actionRequired: true,
      })
    }

    // Check for low stock alerts
    const stockAlerts = await prisma.stockAlertConfig.findMany({
      where: {
        venueId,
        alertEnabled: true,
      },
      include: {
        category: true,
      },
    })

    for (const alert of stockAlerts) {
      const availableCount = await prisma.serializedItem.count({
        where: {
          venueId,
          categoryId: alert.categoryId,
          status: 'AVAILABLE',
        },
      })

      if (availableCount <= alert.minimumStock) {
        insights.push({
          id: `low-stock-${alert.categoryId}`,
          type: availableCount === 0 ? 'CRITICAL' : 'WARNING',
          title: 'Stock Bajo',
          description: `${alert.category.name}: ${availableCount} unidades (mínimo: ${alert.minimumStock})`,
          actionRequired: true,
        })
      }
    }

    // Check for missing check-ins today
    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)

    const scheduledStaff = await prisma.staffVenue.count({
      where: {
        venueId,
        active: true,
        role: { in: ['CASHIER', 'WAITER'] },
      },
    })

    const checkedInToday = await prisma.timeEntry.findMany({
      where: {
        venueId,
        clockInTime: { gte: todayStart },
      },
      distinct: ['staffId'],
    })

    const missingCheckIns = scheduledStaff - checkedInToday.length
    if (missingCheckIns > 0 && new Date().getHours() >= 10) {
      // After 10 AM
      insights.push({
        id: 'missing-checkins',
        type: 'WARNING',
        title: 'Check-ins Faltantes',
        description: `${missingCheckIns} promotor(es) no han registrado entrada`,
        actionRequired: false,
      })
    }

    return insights
  }

  /**
   * Get top sellers for today
   */
  async getTopSellers(venueId: string, limit: number = 5): Promise<TopSeller[]> {
    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)

    // Get orders grouped by creator
    const orders = await prisma.order.findMany({
      where: {
        venueId,
        status: 'COMPLETED',
        createdAt: { gte: todayStart },
      },
      include: {
        createdBy: {
          select: { id: true, firstName: true, lastName: true, photoUrl: true },
        },
        items: true,
      },
    })

    // Aggregate by seller
    const sellerStats = new Map<string, { id: string; name: string; photoUrl: string | null; sales: number; units: number }>()

    for (const order of orders) {
      if (!order.createdBy) continue

      const sellerId = order.createdBy.id
      const existing = sellerStats.get(sellerId) || {
        id: sellerId,
        name: `${order.createdBy.firstName} ${order.createdBy.lastName}`.trim(),
        photoUrl: order.createdBy.photoUrl || null,
        sales: 0,
        units: 0,
      }

      existing.sales += Number(order.total || 0)
      existing.units += order.items.length
      sellerStats.set(sellerId, existing)
    }

    // Sort by sales and return top N
    return Array.from(sellerStats.values())
      .sort((a, b) => b.sales - a.sales)
      .slice(0, limit)
      .map((seller, index) => ({
        ...seller,
        rank: index + 1,
        sales: Math.round(seller.sales * 100) / 100,
      }))
  }

  /**
   * Get sales breakdown by category
   */
  async getCategoryBreakdown(venueId: string): Promise<CategoryBreakdown[]> {
    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)

    // Get sold items grouped by category
    const soldItems = await prisma.serializedItem.findMany({
      where: {
        venueId,
        status: 'SOLD',
        soldAt: { gte: todayStart },
      },
      include: {
        category: true,
        orderItem: true,
      },
    })

    // Aggregate by category
    const categoryStats = new Map<string, { id: string; name: string; sales: number; units: number }>()

    for (const item of soldItems) {
      const categoryId = item.categoryId
      const existing = categoryStats.get(categoryId) || {
        id: categoryId,
        name: item.category.name,
        sales: 0,
        units: 0,
      }

      existing.sales += Number(item.orderItem?.unitPrice || 0)
      existing.units += 1
      categoryStats.set(categoryId, existing)
    }

    // Calculate total for percentages
    const totalSales = Array.from(categoryStats.values()).reduce((sum, cat) => sum + cat.sales, 0)

    // Return with percentages
    return Array.from(categoryStats.values())
      .sort((a, b) => b.sales - a.sales)
      .map(cat => ({
        ...cat,
        sales: Math.round(cat.sales * 100) / 100,
        percentage: totalSales > 0 ? Math.round((cat.sales / totalSales) * 100) : 0,
      }))
  }

  /**
   * Get sales trend for charts with comparison to previous period
   * @param days - Number of days for the current period (default: 7)
   * @param startDate - Custom start date (overrides days if provided with endDate)
   * @param endDate - Custom end date (overrides days if provided with startDate)
   */
  async getStockVsSales(
    venueId: string,
    options: { days?: number; startDate?: string; endDate?: string } = {},
  ): Promise<SalesTrendResponse> {
    const { days = 7, startDate, endDate } = options

    const today = new Date()
    today.setHours(23, 59, 59, 999)

    let currentPeriodStart: Date
    let currentPeriodEnd: Date

    // Determine date range
    if (startDate && endDate) {
      currentPeriodStart = new Date(startDate)
      currentPeriodStart.setHours(0, 0, 0, 0)
      currentPeriodEnd = new Date(endDate)
      currentPeriodEnd.setHours(23, 59, 59, 999)
    } else {
      currentPeriodEnd = today
      currentPeriodStart = new Date(today)
      currentPeriodStart.setDate(currentPeriodStart.getDate() - days + 1)
      currentPeriodStart.setHours(0, 0, 0, 0)
    }

    // Calculate previous period (same duration, immediately before)
    const periodDuration = Math.ceil((currentPeriodEnd.getTime() - currentPeriodStart.getTime()) / (1000 * 60 * 60 * 24))
    const previousPeriodEnd = new Date(currentPeriodStart)
    previousPeriodEnd.setDate(previousPeriodEnd.getDate() - 1)
    previousPeriodEnd.setHours(23, 59, 59, 999)
    const previousPeriodStart = new Date(previousPeriodEnd)
    previousPeriodStart.setDate(previousPeriodStart.getDate() - periodDuration + 1)
    previousPeriodStart.setHours(0, 0, 0, 0)

    // Get current period orders
    const currentOrders = await prisma.order.findMany({
      where: {
        venueId,
        status: 'COMPLETED',
        createdAt: {
          gte: currentPeriodStart,
          lte: currentPeriodEnd,
        },
      },
      include: { items: true },
    })

    // Get previous period orders for comparison
    const previousOrders = await prisma.order.findMany({
      where: {
        venueId,
        status: 'COMPLETED',
        createdAt: {
          gte: previousPeriodStart,
          lte: previousPeriodEnd,
        },
      },
      include: { items: true },
    })

    // Build trend data grouped by day
    const trendMap = new Map<string, SalesTrendPoint>()

    // Initialize all days in range
    const iterDate = new Date(currentPeriodStart)
    while (iterDate <= currentPeriodEnd) {
      const dateKey = iterDate.toISOString().split('T')[0]
      // Format as "DD MMM" for display
      const displayDate = iterDate.toLocaleDateString('es-MX', { day: '2-digit', month: 'short' })
      trendMap.set(dateKey, {
        date: displayDate,
        sales: 0,
        units: 0,
        transactions: 0,
      })
      iterDate.setDate(iterDate.getDate() + 1)
    }

    // Aggregate current period data
    for (const order of currentOrders) {
      const dateKey = order.createdAt.toISOString().split('T')[0]
      const existing = trendMap.get(dateKey)
      if (existing) {
        existing.sales += Number(order.total || 0)
        existing.units += order.items.length
        existing.transactions += 1
      }
    }

    // Round sales values
    const trend = Array.from(trendMap.values()).map(point => ({
      ...point,
      sales: Math.round(point.sales * 100) / 100,
    }))

    // Calculate totals for comparison
    const currentTotalSales = currentOrders.reduce((sum, o) => sum + Number(o.total || 0), 0)
    const currentTotalUnits = currentOrders.reduce((sum, o) => sum + o.items.length, 0)
    const currentTotalTransactions = currentOrders.length

    const previousTotalSales = previousOrders.reduce((sum, o) => sum + Number(o.total || 0), 0)
    const previousTotalUnits = previousOrders.reduce((sum, o) => sum + o.items.length, 0)
    const previousTotalTransactions = previousOrders.length

    // Calculate percentage changes
    const salesChange = previousTotalSales > 0 ? ((currentTotalSales - previousTotalSales) / previousTotalSales) * 100 : 0

    const unitsChange = previousTotalUnits > 0 ? ((currentTotalUnits - previousTotalUnits) / previousTotalUnits) * 100 : 0

    const transactionsChange =
      previousTotalTransactions > 0 ? ((currentTotalTransactions - previousTotalTransactions) / previousTotalTransactions) * 100 : 0

    return {
      trend,
      comparison: {
        salesChange: Math.round(salesChange * 10) / 10,
        unitsChange: Math.round(unitsChange * 10) / 10,
        transactionsChange: Math.round(transactionsChange * 10) / 10,
      },
    }
  }
}

export const commandCenterService = new CommandCenterService()
