// src/services/organization/organization.service.ts

/**
 * Organization Service
 *
 * Provides organization-level data aggregation for OWNER dashboard.
 * Aggregates data across all venues belonging to an organization.
 *
 * Design Principle: HTTP-Agnostic Business Logic Layer
 * - Accept primitive types and DTOs
 * - Return data or throw errors (never touch req/res)
 * - Throw AppError subclasses for business rule violations
 */

import prisma from '../../utils/prismaClient'
import { NotFoundError } from '../../errors/AppError'
import { Prisma, VenueStatus, TransactionStatus } from '@prisma/client'

// Types for organization overview
export interface VenueMetrics {
  id: string
  name: string
  slug: string
  logo: string | null
  city: string | null
  status: VenueStatus
  revenue: number
  orderCount: number
  paymentCount: number
  staffCount: number
}

export interface OrganizationOverview {
  id: string
  name: string
  email: string
  phone: string
  totalRevenue: number
  totalOrders: number
  totalPayments: number
  totalStaff: number
  venueCount: number
  venues: VenueMetrics[]
  period: {
    from: Date
    to: Date
  }
}

export interface OrganizationVenue {
  id: string
  name: string
  slug: string
  logo: string | null
  address: string | null
  city: string | null
  state: string | null
  status: VenueStatus
  createdAt: Date
  metrics: {
    revenue: number
    orderCount: number
    paymentCount: number
    staffCount: number
    growth: number // Percentage vs previous period
  }
}

export interface OrganizationTeamMember {
  id: string
  firstName: string
  lastName: string
  email: string
  phone: string | null
  venues: Array<{
    venueId: string
    venueName: string
    venueSlug: string
    role: string
  }>
  createdAt: Date
}

// Filter options for queries
export interface DateRangeFilter {
  from?: Date
  to?: Date
  timeRange?: '7d' | '30d' | '90d' | 'ytd' | 'all'
}

// Enhanced overview types
export interface TopVenue {
  id: string
  name: string
  slug: string
  logo: string | null
  revenue: number
  rank: number
  trend: 'up' | 'down' | 'stable'
}

export interface PeriodComparison {
  totalRevenue: number
  totalOrders: number
  totalPayments: number
  averageTicketSize: number
}

export interface PercentageChanges {
  revenueChange: number
  ordersChange: number
  paymentsChange: number
  ticketSizeChange: number
}

export interface EnhancedOrganizationOverview extends OrganizationOverview {
  averageTicketSize: number
  previousPeriod: PeriodComparison
  changes: PercentageChanges
  topVenues: TopVenue[]
}

// Revenue trends types
export interface TrendDataPoint {
  date: string
  revenue: number
  orders: number
}

export interface RevenueTrendsResponse {
  currentPeriod: {
    from: Date
    to: Date
    dataPoints: TrendDataPoint[]
    totals: {
      revenue: number
      orders: number
    }
  }
  previousPeriod: {
    from: Date
    to: Date
    dataPoints: TrendDataPoint[]
    totals: {
      revenue: number
      orders: number
    }
  }
  comparison: {
    revenueChange: number
    ordersChange: number
  }
}

// Top items types
export interface TopItem {
  productId: string
  productName: string
  categoryName: string
  quantitySold: number
  totalRevenue: number
  averagePrice: number
  rank: number
}

// Venue benchmarks types
export interface VenueBenchmark {
  id: string
  name: string
  slug: string
  logo: string | null
  metrics: {
    revenue: number
    orders: number
    averageTicketSize: number
    payments: number
  }
  benchmarks: {
    revenueVsAverage: number
    ordersVsAverage: number
    ticketSizeVsAverage: number
  }
  rank: {
    byRevenue: number
    byOrders: number
    byTicketSize: number
  }
}

export interface VenueBenchmarksResponse {
  averages: {
    revenue: number
    orders: number
    averageTicketSize: number
    payments: number
  }
  venues: VenueBenchmark[]
}

/**
 * Get organization by ID with basic info
 */
export async function getOrganizationById(orgId: string) {
  const organization = await prisma.organization.findUnique({
    where: { id: orgId },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      taxId: true,
      type: true,
      billingEmail: true,
      billingAddress: true,
      createdAt: true,
      updatedAt: true,
    },
  })

  if (!organization) {
    throw new NotFoundError(`Organization with ID ${orgId} not found`)
  }

  return organization
}

/**
 * Calculate percentage change between two values
 */
function calculatePercentageChange(current: number, previous: number): number {
  if (previous === 0) {
    return current > 0 ? 100 : 0
  }
  return Math.round(((current - previous) / previous) * 100 * 100) / 100
}

/**
 * Calculate previous period based on current period duration
 */
function calculatePreviousPeriod(from: Date, to: Date): { from: Date; to: Date } {
  const periodDuration = to.getTime() - from.getTime()
  return {
    from: new Date(from.getTime() - periodDuration),
    to: new Date(from.getTime() - 1),
  }
}

/**
 * Calculate date range from filter options
 */
function calculateDateRange(filter?: DateRangeFilter): { from: Date; to: Date } {
  const to = filter?.to || new Date()
  let from: Date

  if (filter?.from) {
    from = filter.from
  } else if (filter?.timeRange) {
    const now = new Date()
    switch (filter.timeRange) {
      case '7d':
        from = new Date(now.setDate(now.getDate() - 7))
        break
      case '30d':
        from = new Date(now.setDate(now.getDate() - 30))
        break
      case '90d':
        from = new Date(now.setDate(now.getDate() - 90))
        break
      case 'ytd':
        from = new Date(now.getFullYear(), 0, 1) // Jan 1 of current year
        break
      case 'all':
      default:
        from = new Date(2020, 0, 1) // Far past date
    }
  } else {
    // Default to last 30 days
    const now = new Date()
    from = new Date(now.setDate(now.getDate() - 30))
  }

  return { from, to }
}

/**
 * Get organization overview with aggregated metrics from all venues
 */
export async function getOrganizationOverview(orgId: string, filter?: DateRangeFilter): Promise<OrganizationOverview> {
  // First verify organization exists
  const organization = await prisma.organization.findUnique({
    where: { id: orgId },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
    },
  })

  if (!organization) {
    throw new NotFoundError(`Organization with ID ${orgId} not found`)
  }

  const { from, to } = calculateDateRange(filter)

  // Get all venues for the organization
  const venues = await prisma.venue.findMany({
    where: { organizationId: orgId },
    select: {
      id: true,
      name: true,
      slug: true,
      logo: true,
      city: true,
      status: true,
    },
  })

  const venueIds = venues.map(v => v.id)

  // Aggregate payments for all venues
  const paymentsAgg = await prisma.payment.aggregate({
    where: {
      venueId: { in: venueIds },
      status: TransactionStatus.COMPLETED,
      createdAt: { gte: from, lte: to },
    },
    _sum: { amount: true },
    _count: true,
  })

  // Aggregate orders for all venues
  const ordersAgg = await prisma.order.aggregate({
    where: {
      venueId: { in: venueIds },
      createdAt: { gte: from, lte: to },
    },
    _count: true,
  })

  // Count total staff
  const staffCount = await prisma.staff.count({
    where: { organizations: { some: { organizationId: orgId } } },
  })

  // Get metrics per venue
  const venueMetrics: VenueMetrics[] = await Promise.all(
    venues.map(async venue => {
      const venuePayments = await prisma.payment.aggregate({
        where: {
          venueId: venue.id,
          status: TransactionStatus.COMPLETED,
          createdAt: { gte: from, lte: to },
        },
        _sum: { amount: true },
        _count: true,
      })

      const venueOrders = await prisma.order.count({
        where: {
          venueId: venue.id,
          createdAt: { gte: from, lte: to },
        },
      })

      const venueStaff = await prisma.staffVenue.count({
        where: { venueId: venue.id },
      })

      return {
        id: venue.id,
        name: venue.name,
        slug: venue.slug,
        logo: venue.logo,
        city: venue.city,
        status: venue.status,
        revenue: venuePayments._sum.amount?.toNumber() || 0,
        orderCount: venueOrders,
        paymentCount: venuePayments._count,
        staffCount: venueStaff,
      }
    }),
  )

  return {
    id: organization.id,
    name: organization.name,
    email: organization.email,
    phone: organization.phone,
    totalRevenue: paymentsAgg._sum.amount?.toNumber() || 0,
    totalOrders: ordersAgg._count,
    totalPayments: paymentsAgg._count,
    totalStaff: staffCount,
    venueCount: venues.length,
    venues: venueMetrics,
    period: { from, to },
  }
}

/**
 * Get enhanced organization overview with comparisons and rankings
 */
export async function getEnhancedOrganizationOverview(orgId: string, filter?: DateRangeFilter): Promise<EnhancedOrganizationOverview> {
  // First verify organization exists
  const organization = await prisma.organization.findUnique({
    where: { id: orgId },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
    },
  })

  if (!organization) {
    throw new NotFoundError(`Organization with ID ${orgId} not found`)
  }

  const { from, to } = calculateDateRange(filter)
  const previousPeriodDates = calculatePreviousPeriod(from, to)

  // Get all venues for the organization
  const venues = await prisma.venue.findMany({
    where: { organizationId: orgId },
    select: {
      id: true,
      name: true,
      slug: true,
      logo: true,
      city: true,
      status: true,
    },
  })

  const venueIds = venues.map(v => v.id)

  // Current period aggregations
  const [currentPayments, currentOrders, staffCount] = await Promise.all([
    prisma.payment.aggregate({
      where: {
        venueId: { in: venueIds },
        status: TransactionStatus.COMPLETED,
        createdAt: { gte: from, lte: to },
      },
      _sum: { amount: true },
      _count: true,
    }),
    prisma.order.aggregate({
      where: {
        venueId: { in: venueIds },
        createdAt: { gte: from, lte: to },
      },
      _count: true,
    }),
    prisma.staff.count({
      where: { organizations: { some: { organizationId: orgId } } },
    }),
  ])

  // Previous period aggregations
  const [previousPayments, previousOrders] = await Promise.all([
    prisma.payment.aggregate({
      where: {
        venueId: { in: venueIds },
        status: TransactionStatus.COMPLETED,
        createdAt: { gte: previousPeriodDates.from, lte: previousPeriodDates.to },
      },
      _sum: { amount: true },
      _count: true,
    }),
    prisma.order.aggregate({
      where: {
        venueId: { in: venueIds },
        createdAt: { gte: previousPeriodDates.from, lte: previousPeriodDates.to },
      },
      _count: true,
    }),
  ])

  // Calculate current period metrics
  const totalRevenue = currentPayments._sum.amount?.toNumber() || 0
  const totalOrders = currentOrders._count
  const totalPayments = currentPayments._count
  const averageTicketSize = totalOrders > 0 ? totalRevenue / totalOrders : 0

  // Calculate previous period metrics
  const prevRevenue = previousPayments._sum.amount?.toNumber() || 0
  const prevOrders = previousOrders._count
  const prevPayments = previousPayments._count
  const prevAverageTicketSize = prevOrders > 0 ? prevRevenue / prevOrders : 0

  // Get metrics per venue for current AND previous periods
  const venueMetricsPromises = venues.map(async venue => {
    const [currentVenuePayments, currentVenueOrders, previousVenuePayments, venueStaff] = await Promise.all([
      prisma.payment.aggregate({
        where: {
          venueId: venue.id,
          status: TransactionStatus.COMPLETED,
          createdAt: { gte: from, lte: to },
        },
        _sum: { amount: true },
        _count: true,
      }),
      prisma.order.count({
        where: {
          venueId: venue.id,
          createdAt: { gte: from, lte: to },
        },
      }),
      prisma.payment.aggregate({
        where: {
          venueId: venue.id,
          status: TransactionStatus.COMPLETED,
          createdAt: { gte: previousPeriodDates.from, lte: previousPeriodDates.to },
        },
        _sum: { amount: true },
      }),
      prisma.staffVenue.count({
        where: { venueId: venue.id },
      }),
    ])

    const currentVenueRevenue = currentVenuePayments._sum.amount?.toNumber() || 0
    const previousVenueRevenue = previousVenuePayments._sum.amount?.toNumber() || 0

    return {
      venue,
      currentRevenue: currentVenueRevenue,
      previousRevenue: previousVenueRevenue,
      orderCount: currentVenueOrders,
      paymentCount: currentVenuePayments._count,
      staffCount: venueStaff,
    }
  })

  const venueMetricsData = await Promise.all(venueMetricsPromises)

  // Build venue metrics array
  const venueMetrics: VenueMetrics[] = venueMetricsData.map(data => ({
    id: data.venue.id,
    name: data.venue.name,
    slug: data.venue.slug,
    logo: data.venue.logo,
    city: data.venue.city,
    status: data.venue.status,
    revenue: data.currentRevenue,
    orderCount: data.orderCount,
    paymentCount: data.paymentCount,
    staffCount: data.staffCount,
  }))

  // Build top venues (sorted by revenue, top 5)
  const sortedVenues = [...venueMetricsData].sort((a, b) => b.currentRevenue - a.currentRevenue)

  const topVenues: TopVenue[] = sortedVenues.slice(0, 5).map((data, index) => {
    // Determine trend based on revenue change
    const revenueChange = calculatePercentageChange(data.currentRevenue, data.previousRevenue)
    let trend: 'up' | 'down' | 'stable' = 'stable'
    if (revenueChange > 5) trend = 'up'
    else if (revenueChange < -5) trend = 'down'

    return {
      id: data.venue.id,
      name: data.venue.name,
      slug: data.venue.slug,
      logo: data.venue.logo,
      revenue: data.currentRevenue,
      rank: index + 1,
      trend,
    }
  })

  return {
    id: organization.id,
    name: organization.name,
    email: organization.email,
    phone: organization.phone,
    totalRevenue,
    totalOrders,
    totalPayments,
    totalStaff: staffCount,
    venueCount: venues.length,
    venues: venueMetrics,
    period: { from, to },
    averageTicketSize: Math.round(averageTicketSize * 100) / 100,
    previousPeriod: {
      totalRevenue: prevRevenue,
      totalOrders: prevOrders,
      totalPayments: prevPayments,
      averageTicketSize: Math.round(prevAverageTicketSize * 100) / 100,
    },
    changes: {
      revenueChange: calculatePercentageChange(totalRevenue, prevRevenue),
      ordersChange: calculatePercentageChange(totalOrders, prevOrders),
      paymentsChange: calculatePercentageChange(totalPayments, prevPayments),
      ticketSizeChange: calculatePercentageChange(averageTicketSize, prevAverageTicketSize),
    },
    topVenues,
  }
}

/**
 * Get revenue trends with time series data
 */
export async function getRevenueTrends(orgId: string, filter?: DateRangeFilter): Promise<RevenueTrendsResponse> {
  // First verify organization exists
  const organization = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { id: true },
  })

  if (!organization) {
    throw new NotFoundError(`Organization with ID ${orgId} not found`)
  }

  const { from, to } = calculateDateRange(filter)
  const previousPeriodDates = calculatePreviousPeriod(from, to)

  // Get all venue IDs
  const venues = await prisma.venue.findMany({
    where: { organizationId: orgId },
    select: { id: true },
  })
  const venueIds = venues.map(v => v.id)

  // Get daily aggregated data for current period
  const currentPeriodPayments = await prisma.payment.findMany({
    where: {
      venueId: { in: venueIds },
      status: TransactionStatus.COMPLETED,
      createdAt: { gte: from, lte: to },
    },
    select: {
      amount: true,
      createdAt: true,
    },
  })

  const currentPeriodOrders = await prisma.order.findMany({
    where: {
      venueId: { in: venueIds },
      createdAt: { gte: from, lte: to },
    },
    select: {
      createdAt: true,
    },
  })

  // Get daily aggregated data for previous period
  const previousPeriodPayments = await prisma.payment.findMany({
    where: {
      venueId: { in: venueIds },
      status: TransactionStatus.COMPLETED,
      createdAt: { gte: previousPeriodDates.from, lte: previousPeriodDates.to },
    },
    select: {
      amount: true,
      createdAt: true,
    },
  })

  const previousPeriodOrders = await prisma.order.findMany({
    where: {
      venueId: { in: venueIds },
      createdAt: { gte: previousPeriodDates.from, lte: previousPeriodDates.to },
    },
    select: {
      createdAt: true,
    },
  })

  // Aggregate by date
  const aggregateByDate = (payments: Array<{ amount: any; createdAt: Date }>, orders: Array<{ createdAt: Date }>): TrendDataPoint[] => {
    const dateMap = new Map<string, { revenue: number; orders: number }>()

    payments.forEach(p => {
      const dateKey = p.createdAt.toISOString().split('T')[0]
      const existing = dateMap.get(dateKey) || { revenue: 0, orders: 0 }
      existing.revenue += p.amount?.toNumber() || 0
      dateMap.set(dateKey, existing)
    })

    orders.forEach(o => {
      const dateKey = o.createdAt.toISOString().split('T')[0]
      const existing = dateMap.get(dateKey) || { revenue: 0, orders: 0 }
      existing.orders += 1
      dateMap.set(dateKey, existing)
    })

    // Sort by date and return
    return Array.from(dateMap.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, data]) => ({
        date,
        revenue: Math.round(data.revenue * 100) / 100,
        orders: data.orders,
      }))
  }

  const currentDataPoints = aggregateByDate(currentPeriodPayments, currentPeriodOrders)
  const previousDataPoints = aggregateByDate(previousPeriodPayments, previousPeriodOrders)

  // Calculate totals
  const currentTotals = currentDataPoints.reduce(
    (acc, dp) => ({
      revenue: acc.revenue + dp.revenue,
      orders: acc.orders + dp.orders,
    }),
    { revenue: 0, orders: 0 },
  )

  const previousTotals = previousDataPoints.reduce(
    (acc, dp) => ({
      revenue: acc.revenue + dp.revenue,
      orders: acc.orders + dp.orders,
    }),
    { revenue: 0, orders: 0 },
  )

  return {
    currentPeriod: {
      from,
      to,
      dataPoints: currentDataPoints,
      totals: {
        revenue: Math.round(currentTotals.revenue * 100) / 100,
        orders: currentTotals.orders,
      },
    },
    previousPeriod: {
      from: previousPeriodDates.from,
      to: previousPeriodDates.to,
      dataPoints: previousDataPoints,
      totals: {
        revenue: Math.round(previousTotals.revenue * 100) / 100,
        orders: previousTotals.orders,
      },
    },
    comparison: {
      revenueChange: calculatePercentageChange(currentTotals.revenue, previousTotals.revenue),
      ordersChange: calculatePercentageChange(currentTotals.orders, previousTotals.orders),
    },
  }
}

/**
 * Get top selling items across organization
 */
export async function getTopItems(orgId: string, filter?: DateRangeFilter, limit: number = 10): Promise<TopItem[]> {
  // First verify organization exists
  const organization = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { id: true },
  })

  if (!organization) {
    throw new NotFoundError(`Organization with ID ${orgId} not found`)
  }

  const { from, to } = calculateDateRange(filter)

  // Get all venue IDs
  const venues = await prisma.venue.findMany({
    where: { organizationId: orgId },
    select: { id: true },
  })
  const venueIds = venues.map(v => v.id)

  // Get order items with product info grouped by product
  const orderItems = await prisma.orderItem.groupBy({
    by: ['productId'],
    where: {
      order: {
        venueId: { in: venueIds },
        createdAt: { gte: from, lte: to },
      },
    },
    _sum: {
      quantity: true,
      total: true,
    },
    orderBy: {
      _sum: {
        quantity: 'desc',
      },
    },
    take: limit,
  })

  // Get product details for top items (filter out null productIds from deleted products)
  const productIds = orderItems.map(item => item.productId).filter((id): id is string => id !== null)
  const products = await prisma.product.findMany({
    where: { id: { in: productIds } },
    select: {
      id: true,
      name: true,
      category: {
        select: {
          name: true,
        },
      },
    },
  })

  const productMap = new Map(products.map(p => [p.id, p]))

  return orderItems.map((item, index) => {
    const product = item.productId ? productMap.get(item.productId) : null
    const quantitySold = item._sum?.quantity || 0
    const totalRevenue = item._sum?.total?.toNumber() || 0

    return {
      productId: item.productId || 'deleted',
      productName: product?.name || 'Deleted Product',
      categoryName: product?.category?.name || 'Uncategorized',
      quantitySold,
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      averagePrice: quantitySold > 0 ? Math.round((totalRevenue / quantitySold) * 100) / 100 : 0,
      rank: index + 1,
    }
  })
}

/**
 * Get venue benchmarks comparing venues against organization averages
 */
export async function getVenueBenchmarks(orgId: string, filter?: DateRangeFilter): Promise<VenueBenchmarksResponse> {
  // First verify organization exists
  const organization = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { id: true },
  })

  if (!organization) {
    throw new NotFoundError(`Organization with ID ${orgId} not found`)
  }

  const { from, to } = calculateDateRange(filter)

  // Get all venues with their metrics
  const venues = await prisma.venue.findMany({
    where: { organizationId: orgId },
    select: {
      id: true,
      name: true,
      slug: true,
      logo: true,
    },
  })

  // Get metrics for each venue
  const venueMetricsPromises = venues.map(async venue => {
    const [payments, orders] = await Promise.all([
      prisma.payment.aggregate({
        where: {
          venueId: venue.id,
          status: TransactionStatus.COMPLETED,
          createdAt: { gte: from, lte: to },
        },
        _sum: { amount: true },
        _count: true,
      }),
      prisma.order.count({
        where: {
          venueId: venue.id,
          createdAt: { gte: from, lte: to },
        },
      }),
    ])

    const revenue = payments._sum.amount?.toNumber() || 0
    const averageTicketSize = orders > 0 ? revenue / orders : 0

    return {
      venue,
      revenue,
      orders,
      payments: payments._count,
      averageTicketSize,
    }
  })

  const venueMetricsData = await Promise.all(venueMetricsPromises)

  // Calculate organization averages
  const totalVenues = venueMetricsData.length
  const avgRevenue = totalVenues > 0 ? venueMetricsData.reduce((sum, v) => sum + v.revenue, 0) / totalVenues : 0
  const avgOrders = totalVenues > 0 ? venueMetricsData.reduce((sum, v) => sum + v.orders, 0) / totalVenues : 0
  const avgPayments = totalVenues > 0 ? venueMetricsData.reduce((sum, v) => sum + v.payments, 0) / totalVenues : 0
  const avgTicketSize = totalVenues > 0 ? venueMetricsData.reduce((sum, v) => sum + v.averageTicketSize, 0) / totalVenues : 0

  // Sort venues for rankings
  const byRevenue = [...venueMetricsData].sort((a, b) => b.revenue - a.revenue)
  const byOrders = [...venueMetricsData].sort((a, b) => b.orders - a.orders)
  const byTicketSize = [...venueMetricsData].sort((a, b) => b.averageTicketSize - a.averageTicketSize)

  // Build venue benchmarks
  const venueBenchmarks: VenueBenchmark[] = venueMetricsData.map(data => {
    const revenueVsAverage = avgRevenue > 0 ? ((data.revenue - avgRevenue) / avgRevenue) * 100 : 0
    const ordersVsAverage = avgOrders > 0 ? ((data.orders - avgOrders) / avgOrders) * 100 : 0
    const ticketSizeVsAverage = avgTicketSize > 0 ? ((data.averageTicketSize - avgTicketSize) / avgTicketSize) * 100 : 0

    return {
      id: data.venue.id,
      name: data.venue.name,
      slug: data.venue.slug,
      logo: data.venue.logo,
      metrics: {
        revenue: Math.round(data.revenue * 100) / 100,
        orders: data.orders,
        averageTicketSize: Math.round(data.averageTicketSize * 100) / 100,
        payments: data.payments,
      },
      benchmarks: {
        revenueVsAverage: Math.round(revenueVsAverage * 100) / 100,
        ordersVsAverage: Math.round(ordersVsAverage * 100) / 100,
        ticketSizeVsAverage: Math.round(ticketSizeVsAverage * 100) / 100,
      },
      rank: {
        byRevenue: byRevenue.findIndex(v => v.venue.id === data.venue.id) + 1,
        byOrders: byOrders.findIndex(v => v.venue.id === data.venue.id) + 1,
        byTicketSize: byTicketSize.findIndex(v => v.venue.id === data.venue.id) + 1,
      },
    }
  })

  return {
    averages: {
      revenue: Math.round(avgRevenue * 100) / 100,
      orders: Math.round(avgOrders * 100) / 100,
      averageTicketSize: Math.round(avgTicketSize * 100) / 100,
      payments: Math.round(avgPayments * 100) / 100,
    },
    venues: venueBenchmarks.sort((a, b) => a.rank.byRevenue - b.rank.byRevenue),
  }
}

/**
 * Get all venues for an organization with detailed metrics
 */
export async function getOrganizationVenues(orgId: string, filter?: DateRangeFilter): Promise<OrganizationVenue[]> {
  const { from, to } = calculateDateRange(filter)

  // Calculate previous period for growth comparison
  const periodDuration = to.getTime() - from.getTime()
  const previousFrom = new Date(from.getTime() - periodDuration)
  const previousTo = new Date(from.getTime() - 1)

  const venues = await prisma.venue.findMany({
    where: { organizationId: orgId },
    select: {
      id: true,
      name: true,
      slug: true,
      logo: true,
      address: true,
      city: true,
      state: true,
      status: true,
      createdAt: true,
    },
    orderBy: { name: 'asc' },
  })

  return Promise.all(
    venues.map(async venue => {
      // Current period metrics
      const currentPayments = await prisma.payment.aggregate({
        where: {
          venueId: venue.id,
          status: TransactionStatus.COMPLETED,
          createdAt: { gte: from, lte: to },
        },
        _sum: { amount: true },
        _count: true,
      })

      const currentOrders = await prisma.order.count({
        where: {
          venueId: venue.id,
          createdAt: { gte: from, lte: to },
        },
      })

      // Previous period metrics for growth calculation
      const previousPayments = await prisma.payment.aggregate({
        where: {
          venueId: venue.id,
          status: TransactionStatus.COMPLETED,
          createdAt: { gte: previousFrom, lte: previousTo },
        },
        _sum: { amount: true },
      })

      const staffCount = await prisma.staffVenue.count({
        where: { venueId: venue.id },
      })

      // Calculate growth percentage
      const currentRevenue = currentPayments._sum.amount?.toNumber() || 0
      const previousRevenue = previousPayments._sum.amount?.toNumber() || 0
      const growth = previousRevenue > 0 ? ((currentRevenue - previousRevenue) / previousRevenue) * 100 : currentRevenue > 0 ? 100 : 0

      return {
        id: venue.id,
        name: venue.name,
        slug: venue.slug,
        logo: venue.logo,
        address: venue.address,
        city: venue.city,
        state: venue.state,
        status: venue.status,
        createdAt: venue.createdAt,
        metrics: {
          revenue: currentRevenue,
          orderCount: currentOrders,
          paymentCount: currentPayments._count,
          staffCount,
          growth: Math.round(growth * 100) / 100, // Round to 2 decimal places
        },
      }
    }),
  )
}

/**
 * Get all team members across all venues in the organization
 */
export async function getOrganizationTeam(orgId: string): Promise<OrganizationTeamMember[]> {
  const staff = await prisma.staff.findMany({
    where: { organizations: { some: { organizationId: orgId } } },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      phone: true,
      createdAt: true,
      venues: {
        select: {
          venueId: true,
          role: true,
          venue: {
            select: {
              name: true,
              slug: true,
            },
          },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  })

  return staff.map(member => ({
    id: member.id,
    firstName: member.firstName,
    lastName: member.lastName,
    email: member.email,
    phone: member.phone,
    createdAt: member.createdAt,
    venues: member.venues.map(v => ({
      venueId: v.venueId,
      venueName: v.venue.name,
      venueSlug: v.venue.slug,
      role: v.role,
    })),
  }))
}

/**
 * Update organization details
 */
export async function updateOrganization(
  orgId: string,
  data: {
    name?: string
    email?: string
    phone?: string
    taxId?: string | null
    billingEmail?: string | null
    billingAddress?: Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput
  },
) {
  const organization = await prisma.organization.findUnique({
    where: { id: orgId },
  })

  if (!organization) {
    throw new NotFoundError(`Organization with ID ${orgId} not found`)
  }

  return prisma.organization.update({
    where: { id: orgId },
    data,
  })
}

/**
 * Get organization statistics summary (lightweight version for header/nav)
 */
export async function getOrganizationStats(orgId: string) {
  const [venueCount, staffCount, organization] = await Promise.all([
    prisma.venue.count({ where: { organizationId: orgId } }),
    prisma.staff.count({ where: { organizations: { some: { organizationId: orgId } } } }),
    prisma.organization.findUnique({
      where: { id: orgId },
      select: { id: true, name: true },
    }),
  ])

  if (!organization) {
    throw new NotFoundError(`Organization with ID ${orgId} not found`)
  }

  return {
    id: organization.id,
    name: organization.name,
    venueCount,
    staffCount,
  }
}
