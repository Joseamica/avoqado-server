/**
 * Organization Dashboard Service
 * Provides organization-level metrics, manager dashboards, and cross-venue analytics
 * for the PlayTelecom/White-Label dashboard.
 */
import prisma from '../../utils/prismaClient'

// Types for organization dashboard
export interface OrgVisionGlobalSummary {
  todaySales: number
  weekSales: number
  monthSales: number
  unitsSold: number
  avgTicket: number
  activePromoters: number
  totalPromoters: number
  activeStores: number
  totalStores: number
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
}

export interface OrgCrossStoreAnomaly {
  id: string
  type: 'LOW_PERFORMANCE' | 'NO_CHECKINS' | 'LOW_STOCK' | 'PENDING_DEPOSITS'
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

class OrganizationDashboardService {
  /**
   * Get vision global summary for an organization (aggregate KPIs)
   */
  async getVisionGlobalSummary(orgId: string): Promise<OrgVisionGlobalSummary> {
    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)

    const weekStart = new Date()
    weekStart.setDate(weekStart.getDate() - 7)
    weekStart.setHours(0, 0, 0, 0)

    const monthStart = new Date()
    monthStart.setDate(1)
    monthStart.setHours(0, 0, 0, 0)

    // Get all venues in organization
    const venues = await prisma.venue.findMany({
      where: { organizationId: orgId, status: 'ACTIVE' },
      select: { id: true },
    })
    const venueIds = venues.map(v => v.id)

    if (venueIds.length === 0) {
      return {
        todaySales: 0,
        weekSales: 0,
        monthSales: 0,
        unitsSold: 0,
        avgTicket: 0,
        activePromoters: 0,
        totalPromoters: 0,
        activeStores: 0,
        totalStores: 0,
      }
    }

    // Aggregate sales from completed orders
    const [todayOrders, weekOrders, monthOrders] = await Promise.all([
      prisma.order.findMany({
        where: {
          venueId: { in: venueIds },
          status: 'COMPLETED',
          createdAt: { gte: todayStart },
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
    const unitsSold = todayOrders.reduce((sum, o) => sum + (o.items?.length || 0), 0)
    const avgTicket = todayOrders.length > 0 ? todaySales / todayOrders.length : 0

    // Count promoters (active check-ins today using TimeEntry)
    const [activePromoters, totalPromoters] = await Promise.all([
      prisma.timeEntry.findMany({
        where: {
          venueId: { in: venueIds },
          clockInTime: { gte: todayStart },
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

    // Count active stores (stores with sales today)
    const storesWithSales = await prisma.order.groupBy({
      by: ['venueId'],
      where: {
        venueId: { in: venueIds },
        status: 'COMPLETED',
        createdAt: { gte: todayStart },
      },
    })

    return {
      todaySales: Math.round(todaySales * 100) / 100,
      weekSales: Math.round((Number(weekOrders._sum?.total) || 0) * 100) / 100,
      monthSales: Math.round((Number(monthOrders._sum?.total) || 0) * 100) / 100,
      unitsSold,
      avgTicket: Math.round(avgTicket * 100) / 100,
      activePromoters: activePromoters.length,
      totalPromoters,
      activeStores: storesWithSales.length,
      totalStores: venues.length,
    }
  }

  /**
   * Get store performance ranking for organization
   */
  async getStorePerformance(orgId: string, limit: number = 10): Promise<OrgStorePerformance[]> {
    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)

    const weekStart = new Date()
    weekStart.setDate(weekStart.getDate() - 7)
    weekStart.setHours(0, 0, 0, 0)

    const prevWeekStart = new Date()
    prevWeekStart.setDate(prevWeekStart.getDate() - 14)
    prevWeekStart.setHours(0, 0, 0, 0)

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

    const results: OrgStorePerformance[] = []

    for (const venue of venues) {
      // Get today's and week's orders
      const [todayOrders, weekOrders, prevWeekOrders, totalPromoters, activePromoters] = await Promise.all([
        prisma.order.findMany({
          where: {
            venueId: venue.id,
            status: 'COMPLETED',
            createdAt: { gte: todayStart },
          },
          include: { items: true },
        }),
        prisma.order.aggregate({
          where: {
            venueId: venue.id,
            status: 'COMPLETED',
            createdAt: { gte: weekStart },
          },
          _sum: { total: true },
        }),
        prisma.order.aggregate({
          where: {
            venueId: venue.id,
            status: 'COMPLETED',
            createdAt: { gte: prevWeekStart, lt: weekStart },
          },
          _sum: { total: true },
        }),
        prisma.staffVenue.count({
          where: {
            venueId: venue.id,
            active: true,
            role: { in: ['CASHIER', 'WAITER'] },
          },
        }),
        prisma.timeEntry.findMany({
          where: {
            venueId: venue.id,
            clockInTime: { gte: todayStart },
          },
          distinct: ['staffId'],
        }),
      ])

      const todaySales = todayOrders.reduce((sum, o) => sum + Number(o.total || 0), 0)
      const unitsSold = todayOrders.reduce((sum, o) => sum + o.items.length, 0)
      const weekSales = Number(weekOrders._sum?.total) || 0
      const prevWeekSales = Number(prevWeekOrders._sum?.total) || 0

      // Determine trend
      let trend: 'up' | 'down' | 'stable' = 'stable'
      if (prevWeekSales > 0) {
        const change = ((weekSales - prevWeekSales) / prevWeekSales) * 100
        if (change > 10) trend = 'up'
        else if (change < -10) trend = 'down'
      }

      results.push({
        id: venue.id,
        name: venue.name,
        slug: venue.slug,
        logo: venue.logo,
        todaySales: Math.round(todaySales * 100) / 100,
        weekSales: Math.round(weekSales * 100) / 100,
        unitsSold,
        promoterCount: totalPromoters,
        activePromoters: activePromoters.length,
        trend,
        rank: 0, // Will be set after sorting
      })
    }

    // Sort by week sales and assign ranks
    results.sort((a, b) => b.weekSales - a.weekSales)
    results.forEach((r, i) => (r.rank = i + 1))

    return results.slice(0, limit)
  }

  /**
   * Get cross-store anomalies for organization
   */
  async getCrossStoreAnomalies(orgId: string): Promise<OrgCrossStoreAnomaly[]> {
    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)

    const anomalies: OrgCrossStoreAnomaly[] = []

    // Get all venues
    const venues = await prisma.venue.findMany({
      where: { organizationId: orgId, status: 'ACTIVE' },
      select: { id: true, name: true },
    })

    for (const venue of venues) {
      // Check for no check-ins after 10 AM (using TimeEntry)
      const currentHour = new Date().getHours()
      if (currentHour >= 10) {
        const checkIns = await prisma.timeEntry.count({
          where: {
            venueId: venue.id,
            clockInTime: { gte: todayStart },
          },
        })

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

      // Check for pending deposits
      const pendingDeposits = await prisma.cashDeposit.count({
        where: {
          venueId: venue.id,
          status: 'PENDING',
        },
      })

      if (pendingDeposits > 5) {
        anomalies.push({
          id: `pending-deposits-${venue.id}`,
          type: 'PENDING_DEPOSITS',
          severity: pendingDeposits > 10 ? 'CRITICAL' : 'WARNING',
          storeId: venue.id,
          storeName: venue.name,
          title: 'Depósitos Pendientes',
          description: `${venue.name} tiene ${pendingDeposits} depósitos pendientes`,
        })
      }

      // Check for low stock alerts
      const lowStockAlerts = await prisma.stockAlertConfig.count({
        where: {
          venueId: venue.id,
          alertEnabled: true,
        },
      })

      if (lowStockAlerts > 0) {
        // Check actual stock levels
        const configs = await prisma.stockAlertConfig.findMany({
          where: { venueId: venue.id, alertEnabled: true },
          include: { category: true },
        })

        for (const config of configs) {
          const available = await prisma.serializedItem.count({
            where: {
              venueId: venue.id,
              categoryId: config.categoryId,
              status: 'AVAILABLE',
            },
          })

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
    }

    // Sort by severity
    anomalies.sort((a, b) => {
      const severityOrder = { CRITICAL: 0, WARNING: 1, INFO: 2 }
      return severityOrder[a.severity] - severityOrder[b.severity]
    })

    return anomalies
  }

  /**
   * Get manager dashboard with stores they oversee
   */
  async getManagerDashboard(orgId: string, managerId: string): Promise<ManagerDashboard | null> {
    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)

    const weekStart = new Date()
    weekStart.setDate(weekStart.getDate() - 7)
    weekStart.setHours(0, 0, 0, 0)

    // Get manager info
    const manager = await prisma.staff.findFirst({
      where: {
        id: managerId,
        organizationId: orgId,
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

    const monthStart = new Date()
    monthStart.setDate(1)
    monthStart.setHours(0, 0, 0, 0)

    const stores = await Promise.all(
      managedStores.map(async sv => {
        const [todayOrders, weekOrders, promoterCount, activePromoters, goal] = await Promise.all([
          prisma.order.aggregate({
            where: {
              venueId: sv.venueId,
              status: 'COMPLETED',
              createdAt: { gte: todayStart },
            },
            _sum: { total: true },
          }),
          prisma.order.aggregate({
            where: {
              venueId: sv.venueId,
              status: 'COMPLETED',
              createdAt: { gte: weekStart },
            },
            _sum: { total: true },
          }),
          prisma.staffVenue.count({
            where: {
              venueId: sv.venueId,
              active: true,
              role: { in: ['CASHIER', 'WAITER'] },
            },
          }),
          prisma.timeEntry.findMany({
            where: {
              venueId: sv.venueId,
              clockInTime: { gte: todayStart },
            },
            distinct: ['staffId'],
          }),
          prisma.performanceGoal.findFirst({
            where: {
              staffId: managerId,
              venueId: sv.venueId,
              month: monthStart,
            },
          }),
        ])

        const todaySales = Number(todayOrders._sum?.total) || 0
        const weekSales = Number(weekOrders._sum?.total) || 0
        const monthGoal = goal ? Number(goal.salesGoal) : 50000 // Default goal

        // Calculate approximate month sales for goal progress
        const daysInMonth = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0).getDate()
        const dayOfMonth = new Date().getDate()
        const estimatedMonthSales = (weekSales / 7) * dayOfMonth
        const goalProgress = monthGoal > 0 ? (estimatedMonthSales / monthGoal) * 100 : 0

        return {
          id: sv.venue.id,
          name: sv.venue.name,
          slug: sv.venue.slug,
          todaySales: Math.round(todaySales * 100) / 100,
          weekSales: Math.round(weekSales * 100) / 100,
          promoterCount,
          activePromoters: activePromoters.length,
          monthGoal: Math.round(monthGoal * 100) / 100,
          goalProgress: Math.round(goalProgress),
        }
      }),
    )

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

    // Get total stock
    const totalPieces = await prisma.serializedItem.count({
      where: {
        venueId: { in: venueIds },
        status: 'AVAILABLE',
      },
    })

    // Calculate total value
    const categories = await prisma.itemCategory.findMany({
      where: { venueId: { in: venueIds }, active: true },
      select: { id: true, venueId: true, suggestedPrice: true },
    })

    let totalValue = 0
    for (const cat of categories) {
      if (cat.suggestedPrice) {
        const count = await prisma.serializedItem.count({
          where: { categoryId: cat.id, status: 'AVAILABLE' },
        })
        totalValue += count * Number(cat.suggestedPrice)
      }
    }

    // Get alert counts
    const alertConfigs = await prisma.stockAlertConfig.findMany({
      where: { venueId: { in: venueIds }, alertEnabled: true },
    })

    let lowStockAlerts = 0
    let criticalAlerts = 0

    for (const config of alertConfigs) {
      const available = await prisma.serializedItem.count({
        where: {
          venueId: config.venueId,
          categoryId: config.categoryId,
          status: 'AVAILABLE',
        },
      })

      if (available <= config.minimumStock) {
        lowStockAlerts++
        if (available === 0) criticalAlerts++
      }
    }

    // Get store breakdown
    const storeBreakdown = await Promise.all(
      venues.map(async venue => {
        const available = await prisma.serializedItem.count({
          where: { venueId: venue.id, status: 'AVAILABLE' },
        })

        // Calculate value for this store
        const storeCats = categories.filter(c => c.venueId === venue.id)
        let storeValue = 0
        for (const cat of storeCats) {
          if (cat.suggestedPrice) {
            const count = await prisma.serializedItem.count({
              where: { categoryId: cat.id, status: 'AVAILABLE' },
            })
            storeValue += count * Number(cat.suggestedPrice)
          }
        }

        // Check if any alert is triggered
        const storeAlerts = alertConfigs.filter(a => a.venueId === venue.id)
        let alertLevel: 'OK' | 'WARNING' | 'CRITICAL' = 'OK'

        for (const config of storeAlerts) {
          const catAvailable = await prisma.serializedItem.count({
            where: {
              venueId: venue.id,
              categoryId: config.categoryId,
              status: 'AVAILABLE',
            },
          })
          if (catAvailable === 0) {
            alertLevel = 'CRITICAL'
            break // CRITICAL is highest severity, stop checking
          } else if (catAvailable <= config.minimumStock) {
            alertLevel = 'WARNING'
            // Continue checking - might find a CRITICAL
          }
        }

        return {
          storeId: venue.id,
          storeName: venue.name,
          available,
          value: Math.round(storeValue * 100) / 100,
          alertLevel,
        }
      }),
    )

    return {
      totalPieces,
      totalValue: Math.round(totalValue * 100) / 100,
      lowStockAlerts,
      criticalAlerts,
      storeBreakdown,
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

    // Calculate metrics for each manager
    const results = await Promise.all(
      Array.from(managerMap.entries()).map(async ([staffId, data]) => {
        // Get stores with sales today
        const storesWithSales = await prisma.order.groupBy({
          by: ['venueId'],
          where: {
            venueId: { in: data.venues },
            status: 'COMPLETED',
            createdAt: { gte: todayStart },
          },
        })

        // Get total sales
        const sales = await prisma.order.aggregate({
          where: {
            venueId: { in: data.venues },
            status: 'COMPLETED',
            createdAt: { gte: todayStart },
          },
          _sum: { total: true },
        })

        return {
          id: staffId,
          name: `${data.staff.firstName} ${data.staff.lastName}`.trim(),
          email: data.staff.email,
          storeCount: data.venues.length,
          activeStores: storesWithSales.length,
          todaySales: Math.round((Number(sales._sum?.total) || 0) * 100) / 100,
        }
      }),
    )

    // Sort by today's sales descending
    return results.sort((a, b) => b.todaySales - a.todaySales)
  }
}

export const organizationDashboardService = new OrganizationDashboardService()
