/**
 * Shared Query Service - Single Source of Truth
 *
 * **CRITICAL: This service is the ONLY source for dashboard metrics.**
 *
 * WHY THIS EXISTS:
 * - Dashboard endpoints and AI chatbot MUST return identical results
 * - Before: Dashboard used Home.tsx logic, Chatbot used SQL generation
 * - Result: Same question → different answers → user confusion
 * - After: Both use this service → impossible to have inconsistency
 *
 * **WORLD-CLASS PATTERN (Stripe, Salesforce, AWS):**
 * - Single Source of Truth: One function per metric
 * - Type-safe contracts: Strong TypeScript interfaces
 * - Performance optimized: Prisma query optimization
 * - Multi-tenant isolation: Automatic venueId filtering
 * - Timezone-aware: Uses venue timezone for date calculations
 *
 * **ARCHITECTURE:**
 * ```
 * Dashboard API ──┐
 *                 ├──> SharedQueryService (THIS FILE) ──> Database
 * AI Chatbot   ──┘
 * ```
 *
 * **USAGE:**
 * ```typescript
 * // In dashboard controller:
 * const sales = await SharedQueryService.getSalesForPeriod(venueId, 'last7days')
 *
 * // In chatbot service:
 * if (intent === 'sales' && period === 'last7days') {
 *   return await SharedQueryService.getSalesForPeriod(venueId, 'last7days')
 * }
 * ```
 *
 * @see /docs/DATETIME_SYNC.md - Date synchronization architecture
 */

import prisma from '@/utils/prismaClient'
import { getVenueDateRange, type RelativeDateRange } from '@/utils/datetime'
import { Prisma } from '@prisma/client'

/**
 * Date range specification - supports both predefined periods and custom ranges
 */
export type DateRangeSpec =
  | RelativeDateRange
  | {
      from: Date
      to: Date
    }

/**
 * Sales summary for a time period
 */
export interface SalesSummary {
  totalRevenue: number
  averageTicket: number
  orderCount: number
  paymentCount: number
  currency: string
  period: RelativeDateRange | 'custom'
  dateRange: {
    from: Date
    to: Date
  }
}

/**
 * Top product with sales metrics
 */
export interface TopProduct {
  productId: string
  productName: string
  categoryName: string | null
  quantitySold: number
  revenue: number
  orderCount: number
}

/**
 * Staff performance metrics
 */
export interface StaffPerformance {
  staffId: string
  staffName: string
  role: string
  totalOrders: number
  totalRevenue: number
  totalTips: number
  averageOrderValue: number
  shiftsWorked: number
}

/**
 * Review statistics
 */
export interface ReviewStats {
  averageRating: number
  totalReviews: number
  distribution: {
    oneStar: number
    twoStar: number
    threeStar: number
    fourStar: number
    fiveStar: number
  }
  recentReviews: Array<{
    id: string
    rating: number
    comment: string | null
    createdAt: Date
    source: string
  }>
  unansweredNegative: number
}

/**
 * Shared Query Service
 *
 * All dashboard metrics MUST use this service to ensure consistency.
 */
export class SharedQueryService {
  /**
   * Helper: Normalize date range specification to actual dates
   */
  private static getDateRange(period: DateRangeSpec, timezone: string): { from: Date; to: Date; periodName: RelativeDateRange | 'custom' } {
    if (typeof period === 'string') {
      // RelativeDateRange (e.g., 'today', 'last7days')
      const { from, to } = getVenueDateRange(period, timezone)
      return { from, to, periodName: period }
    } else {
      // Custom date range object
      return { from: period.from, to: period.to, periodName: 'custom' }
    }
  }

  /**
   * Get sales summary for a time period
   *
   * Used by:
   * - Dashboard /api/v1/dashboard/sales/summary endpoint
   * - AI Chatbot for "¿cuánto vendí esta semana?" queries
   *
   * @param venueId - Venue ID (multi-tenant isolation)
   * @param period - Date range (RelativeDateRange OR custom { from, to } object)
   * @param timezone - Venue timezone (defaults to venue's configured timezone)
   * @returns Sales summary with revenue, average ticket, order count
   *
   * @example
   * // Using RelativeDateRange:
   * const sales = await SharedQueryService.getSalesForPeriod(venueId, 'last7days')
   * console.log(`Revenue: $${sales.totalRevenue}`) // $12,525.77
   *
   * // Using custom date range:
   * const sales = await SharedQueryService.getSalesForPeriod(venueId, {
   *   from: new Date('2024-01-01'),
   *   to: new Date('2024-01-15')
   * })
   */
  static async getSalesForPeriod(venueId: string, period: DateRangeSpec, timezone?: string): Promise<SalesSummary> {
    // Get venue to access timezone
    const venue = await prisma.venue.findUnique({
      where: { id: venueId },
      select: { timezone: true, currency: true },
    })

    if (!venue) {
      throw new Error(`Venue not found: ${venueId}`)
    }

    const venueTimezone = timezone || venue.timezone

    // Get date range (supports both RelativeDateRange and custom dates)
    const { from, to, periodName } = this.getDateRange(period, venueTimezone)

    // Query payments (completed only)
    const [paymentsAgg, ordersAgg] = await Promise.all([
      prisma.payment.aggregate({
        where: {
          venueId,
          createdAt: { gte: from, lte: to },
          status: 'COMPLETED',
        },
        _sum: { amount: true },
        _count: true,
      }),
      prisma.order.aggregate({
        where: {
          venueId,
          createdAt: { gte: from, lte: to },
        },
        _count: true,
      }),
    ])

    const totalRevenue = paymentsAgg._sum.amount?.toNumber() || 0
    const paymentCount = paymentsAgg._count || 0
    const orderCount = ordersAgg._count || 0
    const averageTicket = orderCount > 0 ? totalRevenue / orderCount : 0

    return {
      totalRevenue,
      averageTicket,
      orderCount,
      paymentCount,
      currency: venue.currency,
      period: periodName,
      dateRange: { from, to },
    }
  }

  /**
   * Get top selling products for a time period
   *
   * Used by:
   * - Dashboard /api/v1/dashboard/products/top-sellers endpoint
   * - AI Chatbot for "¿cuáles son mis productos más vendidos?" queries
   *
   * @param venueId - Venue ID
   * @param period - Date range (RelativeDateRange OR custom { from, to } object)
   * @param limit - Maximum number of products to return (default: 10)
   * @param timezone - Venue timezone
   * @returns Top products sorted by revenue descending
   *
   * @example
   * const topProducts = await SharedQueryService.getTopProducts(venueId, 'last30days', 5)
   * console.log(topProducts[0].productName) // "Hamburguesa Clásica"
   */
  static async getTopProducts(venueId: string, period: DateRangeSpec, limit: number = 10, timezone?: string): Promise<TopProduct[]> {
    const venue = await prisma.venue.findUnique({
      where: { id: venueId },
      select: { timezone: true },
    })

    if (!venue) {
      throw new Error(`Venue not found: ${venueId}`)
    }

    const venueTimezone = timezone || venue.timezone
    const { from, to } = this.getDateRange(period, venueTimezone)

    // Query order items grouped by product
    const topProducts = await prisma.$queryRaw<
      Array<{
        productId: string
        productName: string
        categoryName: string | null
        quantitySold: bigint
        revenue: Prisma.Decimal
        orderCount: bigint
      }>
    >`
      SELECT
        p."id" as "productId",
        p."name" as "productName",
        c."name" as "categoryName",
        SUM(oi."quantity")::bigint as "quantitySold",
        SUM(oi."quantity" * oi."unitPrice") as "revenue",
        COUNT(DISTINCT o."id")::bigint as "orderCount"
      FROM "OrderItem" oi
      INNER JOIN "Product" p ON oi."productId" = p."id"
      INNER JOIN "Order" o ON oi."orderId" = o."id"
      LEFT JOIN "Category" c ON p."categoryId" = c."id"
      WHERE o."venueId" = ${venueId}::uuid
        AND o."createdAt" >= ${from}::timestamp
        AND o."createdAt" <= ${to}::timestamp
      GROUP BY p."id", p."name", c."name"
      ORDER BY "revenue" DESC
      LIMIT ${limit}
    `

    // Convert BigInt to Number for JSON serialization
    return topProducts.map(product => ({
      productId: product.productId,
      productName: product.productName,
      categoryName: product.categoryName,
      quantitySold: Number(product.quantitySold),
      revenue: product.revenue.toNumber(),
      orderCount: Number(product.orderCount),
    }))
  }

  /**
   * Get average ticket (order value) for a time period
   *
   * Used by:
   * - Dashboard KPI cards
   * - AI Chatbot for "¿cuál fue mi ticket promedio?" queries
   *
   * @param venueId - Venue ID
   * @param period - Date range (RelativeDateRange OR custom { from, to } object)
   * @param timezone - Venue timezone
   * @returns Average order value
   *
   * @example
   * const avg = await SharedQueryService.getAverageTicket(venueId, 'yesterday')
   * console.log(`Avg ticket: $${avg.toFixed(2)}`) // $45.32
   */
  static async getAverageTicket(venueId: string, period: DateRangeSpec, timezone?: string): Promise<number> {
    const sales = await this.getSalesForPeriod(venueId, period, timezone)
    return sales.averageTicket
  }

  /**
   * Get staff performance metrics for a time period
   *
   * Used by:
   * - Dashboard /api/v1/dashboard/staff/performance endpoint
   * - AI Chatbot for "¿quién es el mesero con más propinas?" queries
   *
   * @param venueId - Venue ID
   * @param period - Date range (RelativeDateRange OR custom { from, to } object)
   * @param limit - Maximum number of staff to return (default: 10)
   * @param timezone - Venue timezone
   * @returns Staff performance sorted by revenue descending
   *
   * @example
   * const staff = await SharedQueryService.getStaffPerformance(venueId, 'last30days', 5)
   * console.log(staff[0].staffName) // "Juan Pérez"
   */
  static async getStaffPerformance(
    venueId: string,
    period: DateRangeSpec,
    limit: number = 10,
    timezone?: string,
  ): Promise<StaffPerformance[]> {
    const venue = await prisma.venue.findUnique({
      where: { id: venueId },
      select: { timezone: true },
    })

    if (!venue) {
      throw new Error(`Venue not found: ${venueId}`)
    }

    const venueTimezone = timezone || venue.timezone
    const { from, to } = this.getDateRange(period, venueTimezone)

    // Query staff performance using Prisma.sql for proper type handling
    const staffPerf = await prisma.$queryRaw<
      Array<{
        staffId: string
        staffName: string
        role: string
        totalOrders: bigint
        totalRevenue: Prisma.Decimal
        totalTips: Prisma.Decimal
        shiftsWorked: bigint
      }>
    >(
      Prisma.sql`
        SELECT
          s."id" as "staffId",
          CONCAT(s."firstName", ' ', s."lastName") as "staffName",
          sv."role" as "role",
          COUNT(DISTINCT o."id")::bigint as "totalOrders",
          COALESCE(SUM(p."amount"), 0) as "totalRevenue",
          COALESCE(SUM(p."tipAmount"), 0) as "totalTips",
          COUNT(DISTINCT sh."id")::bigint as "shiftsWorked"
        FROM "Staff" s
        INNER JOIN "StaffVenue" sv ON s."id" = sv."staffId" AND sv."venueId" = ${venueId}
        LEFT JOIN "Order" o ON (o."servedById" = s."id" OR o."createdById" = s."id")
          AND o."createdAt" >= ${from}
          AND o."createdAt" <= ${to}
        LEFT JOIN "Payment" p ON p."orderId" = o."id" AND p."status" = 'COMPLETED'
        LEFT JOIN "Shift" sh ON sh."staffId" = s."id"
          AND sh."startTime" >= ${from}
          AND sh."startTime" <= ${to}
        WHERE sv."venueId" = ${venueId}
        GROUP BY s."id", s."firstName", s."lastName", sv."role"
        HAVING COUNT(DISTINCT o."id") > 0
        ORDER BY "totalRevenue" DESC
        LIMIT ${limit}
      `,
    )

    // Convert BigInt to Number
    return staffPerf.map(staff => ({
      staffId: staff.staffId,
      staffName: staff.staffName,
      role: staff.role,
      totalOrders: Number(staff.totalOrders),
      totalRevenue: staff.totalRevenue.toNumber(),
      totalTips: staff.totalTips.toNumber(),
      averageOrderValue: Number(staff.totalOrders) > 0 ? staff.totalRevenue.toNumber() / Number(staff.totalOrders) : 0,
      shiftsWorked: Number(staff.shiftsWorked),
    }))
  }

  /**
   * Get review statistics for a time period
   *
   * Used by:
   * - Dashboard /api/v1/dashboard/reviews/stats endpoint
   * - AI Chatbot for "¿cómo están mis reseñas?" queries
   *
   * @param venueId - Venue ID
   * @param period - Date range (RelativeDateRange OR custom { from, to } object)
   * @param timezone - Venue timezone
   * @returns Review statistics including average rating, distribution, recent reviews
   *
   * @example
   * const reviews = await SharedQueryService.getReviewStats(venueId, 'last30days')
   * console.log(`Average: ${reviews.averageRating.toFixed(1)} stars`) // 4.2 stars
   */
  static async getReviewStats(venueId: string, period: DateRangeSpec, timezone?: string): Promise<ReviewStats> {
    const venue = await prisma.venue.findUnique({
      where: { id: venueId },
      select: { timezone: true },
    })

    if (!venue) {
      throw new Error(`Venue not found: ${venueId}`)
    }

    const venueTimezone = timezone || venue.timezone
    const { from, to } = this.getDateRange(period, venueTimezone)

    // Get all reviews in period
    const reviews = await prisma.review.findMany({
      where: {
        venueId,
        createdAt: { gte: from, lte: to },
      },
      select: {
        id: true,
        overallRating: true,
        comment: true,
        createdAt: true,
        source: true,
        responseText: true,
      },
      orderBy: { createdAt: 'desc' },
    })

    // Calculate statistics
    const totalReviews = reviews.length
    const averageRating = totalReviews > 0 ? reviews.reduce((sum, r) => sum + r.overallRating, 0) / totalReviews : 0

    const distribution = {
      oneStar: reviews.filter(r => r.overallRating === 1).length,
      twoStar: reviews.filter(r => r.overallRating === 2).length,
      threeStar: reviews.filter(r => r.overallRating === 3).length,
      fourStar: reviews.filter(r => r.overallRating === 4).length,
      fiveStar: reviews.filter(r => r.overallRating === 5).length,
    }

    const recentReviews = reviews.slice(0, 10).map(r => ({
      id: r.id,
      rating: r.overallRating,
      comment: r.comment,
      createdAt: r.createdAt,
      source: r.source,
    }))

    const unansweredNegative = reviews.filter(r => r.overallRating <= 3 && !r.responseText).length

    return {
      averageRating,
      totalReviews,
      distribution,
      recentReviews,
      unansweredNegative,
    }
  }

  /**
   * Validate that a chatbot response matches dashboard data
   *
   * **CRITICAL WORLD-CLASS FEATURE:**
   * - After chatbot generates a response, validate it against dashboard
   * - If mismatch > 1%, flag as inconsistent
   * - This prevents chatbot from hallucinating different numbers
   *
   * @param venueId - Venue ID
   * @param metric - Metric type (e.g., 'sales', 'averageTicket')
   * @param period - Date range (RelativeDateRange OR custom { from, to } object)
   * @param chatbotValue - Value returned by chatbot
   * @param tolerance - Acceptable difference percentage (default: 0.01 = 1%)
   * @returns Validation result with dashboard value and match status
   *
   * @example
   * const validation = await SharedQueryService.validateChatbotResponse(
   *   venueId,
   *   'sales',
   *   'last7days',
   *   12525.77,
   *   0.01
   * )
   * if (!validation.isMatch) {
   *   logger.error('Chatbot-dashboard mismatch!', validation)
   * }
   */
  static async validateChatbotResponse(
    venueId: string,
    metric: 'sales' | 'averageTicket' | 'orderCount',
    period: DateRangeSpec,
    chatbotValue: number,
    tolerance: number = 0.01,
  ): Promise<{
    isMatch: boolean
    dashboardValue: number
    chatbotValue: number
    difference: number
    differencePercent: number
    tolerance: number
  }> {
    let dashboardValue: number

    switch (metric) {
      case 'sales': {
        const sales = await this.getSalesForPeriod(venueId, period)
        dashboardValue = sales.totalRevenue
        break
      }
      case 'averageTicket': {
        dashboardValue = await this.getAverageTicket(venueId, period)
        break
      }
      case 'orderCount': {
        const sales = await this.getSalesForPeriod(venueId, period)
        dashboardValue = sales.orderCount
        break
      }
      default:
        throw new Error(`Unsupported metric: ${metric}`)
    }

    const difference = Math.abs(dashboardValue - chatbotValue)
    const differencePercent = dashboardValue > 0 ? difference / dashboardValue : 0
    const isMatch = differencePercent <= tolerance

    return {
      isMatch,
      dashboardValue,
      chatbotValue,
      difference,
      differencePercent,
      tolerance,
    }
  }
}
