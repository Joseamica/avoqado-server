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
import { sanitizeTimezone } from '@/utils/sanitizeTimezone'
import { PaymentMethod, Prisma, ReservationStatus } from '@prisma/client'
import * as availableBalanceService from './availableBalance.dashboard.service'
import * as commissionCalculationService from './commission/commission-calculation.service'
import * as customerDashboardService from './customer.dashboard.service'
import * as paymentDashboardService from './payment.dashboard.service'
import * as paymentLinkService from './paymentLink.service'
import * as reservationService from './reservation.dashboard.service'
import * as teamDashboardService from './team.dashboard.service'

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
 * Sales data point for time series visualization
 */
export interface SalesDataPoint {
  date: string // ISO date string (YYYY-MM-DD) or hour (HH:00)
  revenue: number
  orderCount: number
  averageTicket: number
}

/**
 * Sales time series for charting
 */
export interface SalesTimeSeries {
  dataPoints: SalesDataPoint[]
  totalRevenue: number
  totalOrders: number
  currency: string
  period: RelativeDateRange | 'custom'
  granularity: 'hour' | 'day'
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
 * Product-specific sales metrics resolved by product name.
 */
export interface ProductSales {
  searchTerm: string
  productName: string | null
  quantitySold: number
  revenue: number
  orderCount: number
  matchedProducts: Array<{
    productName: string
    quantitySold: number
    revenue: number
    orderCount: number
  }>
  currency: string
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
 * Inventory alert for low stock items
 */
export interface InventoryAlert {
  rawMaterialId: string
  rawMaterialName: string
  currentStock: number
  minimumStock: number
  unit: string
  stockPercentage: number
  estimatedDaysRemaining: number | null
  lastPurchaseDate: Date | null
}

/**
 * Recipe count summary for the current venue.
 */
export interface RecipeCountSummary {
  totalRecipes: number
}

/**
 * Recipe list item for the current venue.
 */
export interface RecipeListItem {
  id: string
  name: string | null
  productName: string
  portionYield: number
  totalCost: number
}

export interface RecipeListSummary {
  totalRecipes: number
  recipes: RecipeListItem[]
  limit: number
  hasMore: boolean
}

/**
 * Recipe usage ranking for the current venue.
 */
export interface RecipeUsageItem {
  recipeId: string
  productId: string
  recipeName: string
  productName: string
  quantityUsed: number
  orderCount: number
  revenue: number
}

export interface RecipeUsageSummary {
  totalRecipes: number
  topRecipes: RecipeUsageItem[]
  limit: number
}

export interface NewCustomerTimingPattern {
  count: number
  periodLabel: RelativeDateRange | 'custom'
  peakDay: { day: string; count: number } | null
  peakHour: { hour: string; count: number } | null
  byDayOfWeek: Array<{ day: string; count: number }>
  byHour: Array<{ hour: string; count: number }>
}

/**
 * Pending orders statistics by status
 */
export interface PendingOrdersStats {
  total: number
  byStatus: {
    pending: number
    confirmed: number
    preparing: number
    ready: number
  }
  oldestOrderMinutes: number | null
  averageWaitMinutes: number
}

/**
 * Active shift information
 */
export interface ActiveShiftInfo {
  shiftId: string
  staffId: string
  staffName: string
  role: string
  startTime: Date
  durationMinutes: number
  salesTotal: number
  ordersCount: number
  tipsTotal: number
}

/**
 * Profit analysis for a period
 */
export interface ProfitAnalysis {
  totalRevenue: number
  totalCost: number
  grossProfit: number
  grossMarginPercent: number
  currency: string
  topProfitableProducts: Array<{
    productId: string
    productName: string
    revenue: number
    cost: number
    profit: number
    marginPercent: number
    quantitySold: number
  }>
}

/**
 * Payment method breakdown
 */
export interface PaymentMethodBreakdown {
  total: number
  methods: Array<{
    method: string
    amount: number
    count: number
    percentage: number
    tipAmount: number
  }>
  currency: string
}

export interface SettlementCalendarSummary {
  totalNetAmount: number
  transactionCount: number
  currency: string
  period: RelativeDateRange | 'custom'
  dateRange: {
    from: Date
    to: Date
  }
  entries: Array<{
    settlementDate: Date
    totalNetAmount: number
    transactionCount: number
    status: string
    byCardType: Array<{
      cardType: string
      netAmount: number
      transactionCount: number
    }>
  }>
}

export interface PaymentLinksSummary {
  total: number
  limit: number
  offset: number
  hasMore: boolean
  links: Array<{
    id: string
    title: string
    shortCode: string
    status: string
    purpose: string
    amountType: string
    amount: number | null
    currency: string
    isReusable: boolean
    totalCollected: number
    paymentCount: number
    checkoutSessionCount: number
    createdAt: Date
    expiresAt: Date | null
    createdByName: string | null
  }>
}

export interface PaymentLinksAggregateSummary {
  totalLinks: number
  activeLinks: number
  pausedLinks: number
  fixedAmountLinks: number
  openAmountLinks: number
  totalCollected: number
  paymentCount: number
  checkoutSessionCount: number
  currency: string
}

export interface CustomerSummary {
  totalCustomers: number
  activeCustomers: number
  newCustomersThisMonth: number
  vipCustomers: number
  averageLifetimeValue: number
  averageVisitsPerCustomer: number
  topSpenders: Array<{
    name: string
    totalSpent: number
    totalVisits: number
  }>
}

export interface TeamMembersSummary {
  total: number
  limit: number
  members: Array<{
    staffVenueId: string
    staffId: string
    name: string
    role: string
    active: boolean
    totalSales: number
    totalTips: number
    totalOrders: number
    permissionSetName: string | null
  }>
}

export interface CommissionsSummary {
  totalPaid: number
  totalPending: number
  totalApproved: number
  staffWithCommissions: number
  averageCommission: number
  topEarners: Array<{
    staffName: string
    totalEarned: number
    calculationCount: number
  }>
}

export interface PaymentsSummary {
  totalPayments: number
  completedPayments: number
  refundedPayments: number
  totalAmount: number
  totalTips: number
  currency: string
  period: RelativeDateRange | 'custom'
  dateRange: {
    from: Date
    to: Date
  }
}

export interface PaymentsListSummary {
  total: number
  page: number
  pageSize: number
  pageCount: number
  period: RelativeDateRange | 'custom'
  dateRange: {
    from: Date
    to: Date
  }
  payments: Array<{
    id: string
    amount: number
    tipAmount: number
    currency: string
    status: string
    method: string
    source: string | null
    cardBrand: string | null
    last4: string | null
    createdAt: Date
    processedByName: string | null
    orderNumber: string | null
    tableNumber: string | null
    merchantName: string | null
  }>
}

export interface ReservationSummary {
  total: number
  byStatus: Record<string, number>
  byChannel: Record<string, number>
  noShowRate: number
  period: RelativeDateRange | 'custom'
  dateRange: {
    from: Date
    to: Date
  }
}

export interface ReservationListSummary {
  total: number
  page: number
  pageSize: number
  totalPages: number
  period: RelativeDateRange | 'custom'
  dateRange: {
    from: Date
    to: Date
  }
  reservations: Array<{
    confirmationCode: string
    status: string
    channel: string
    startsAt: Date
    endsAt: Date
    partySize: number
    guestName: string | null
    customerName: string | null
    tableNumber: string | null
    productName: string | null
    assignedStaffName: string | null
  }>
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
   * Get sales time series data for charting
   *
   * Used by:
   * - AI Chatbot for "dame una gráfica de ventas" queries
   * - Dashboard charts
   *
   * Automatically selects granularity:
   * - 'hour' for 'today' or 'yesterday'
   * - 'day' for longer periods
   *
   * @param venueId - Venue ID
   * @param period - Date range
   * @param timezone - Venue timezone
   * @returns Sales time series with data points for charting
   *
   * @example
   * const series = await SharedQueryService.getSalesTimeSeries(venueId, 'last7days')
   * // Returns: { dataPoints: [{ date: '2025-12-20', revenue: 5000, ... }, ...] }
   */
  static async getSalesTimeSeries(venueId: string, period: DateRangeSpec, timezone?: string): Promise<SalesTimeSeries> {
    const venue = await prisma.venue.findUnique({
      where: { id: venueId },
      select: { timezone: true, currency: true },
    })

    if (!venue) {
      throw new Error(`Venue not found: ${venueId}`)
    }

    const venueTimezone = timezone || venue.timezone
    const { from, to, periodName } = this.getDateRange(period, venueTimezone)

    // Determine granularity based on period
    const isShortPeriod = periodName === 'today' || periodName === 'yesterday'
    const granularity: 'hour' | 'day' = isShortPeriod ? 'hour' : 'day'

    const safeTz = sanitizeTimezone(venueTimezone)

    // SQL for grouping by date or hour
    const dateGroupSql =
      granularity === 'hour'
        ? `TO_CHAR("createdAt" AT TIME ZONE '${safeTz}', 'HH24:00')`
        : `TO_CHAR("createdAt" AT TIME ZONE '${safeTz}', 'YYYY-MM-DD')`

    const dataPoints = await prisma.$queryRaw<
      Array<{
        date: string
        revenue: number
        orderCount: bigint
      }>
    >`
      SELECT
        ${Prisma.raw(dateGroupSql)} as date,
        COALESCE(SUM("amount")::numeric, 0) as revenue,
        COUNT(DISTINCT "orderId")::bigint as "orderCount"
      FROM "Payment"
      WHERE "venueId" = ${venueId}
        AND "createdAt" >= ${from}
        AND "createdAt" <= ${to}
        AND "status" = 'COMPLETED'
      GROUP BY ${Prisma.raw(dateGroupSql)}
      ORDER BY date ASC
    `

    // Transform to proper types
    const transformedPoints: SalesDataPoint[] = dataPoints.map(point => ({
      date: point.date,
      revenue: Number(point.revenue) || 0,
      orderCount: Number(point.orderCount) || 0,
      averageTicket: Number(point.orderCount) > 0 ? Number(point.revenue) / Number(point.orderCount) : 0,
    }))

    const totalRevenue = transformedPoints.reduce((sum, p) => sum + p.revenue, 0)
    const totalOrders = transformedPoints.reduce((sum, p) => sum + p.orderCount, 0)

    return {
      dataPoints: transformedPoints,
      totalRevenue,
      totalOrders,
      currency: venue.currency,
      period: periodName,
      granularity,
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
      select: { timezone: true, currency: true },
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
      LEFT JOIN "MenuCategory" c ON p."categoryId" = c."id"
      WHERE o."venueId"::text = ${venueId}
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
   * Get sales for a specific product name using the same approved order-item
   * aggregation as top products. This keeps product-specific questions out of
   * free-form SQL generation while still answering from real backend data.
   */
  static async getProductSalesByName(
    venueId: string,
    productName: string,
    period: DateRangeSpec,
    timezone?: string,
  ): Promise<ProductSales> {
    const venue = await prisma.venue.findUnique({
      where: { id: venueId },
      select: { timezone: true, currency: true },
    })

    if (!venue) {
      throw new Error(`Venue not found: ${venueId}`)
    }

    const searchTerm = productName.trim().replace(/\s+/g, ' ')
    if (!searchTerm) {
      return {
        searchTerm,
        productName: null,
        quantitySold: 0,
        revenue: 0,
        orderCount: 0,
        matchedProducts: [],
        currency: 'MXN',
      }
    }

    const venueTimezone = timezone || venue.timezone
    const { from, to } = this.getDateRange(period, venueTimezone)
    const searchPattern = `%${searchTerm}%`

    const rows = await prisma.$queryRaw<
      Array<{
        productName: string
        quantitySold: bigint
        revenue: Prisma.Decimal
        orderCount: bigint
      }>
    >`
      SELECT
        COALESCE(oi."productName", p."name", 'Producto sin nombre') as "productName",
        SUM(oi."quantity")::bigint as "quantitySold",
        SUM(oi."quantity" * oi."unitPrice") as "revenue",
        COUNT(DISTINCT o."id")::bigint as "orderCount"
      FROM "OrderItem" oi
      INNER JOIN "Order" o ON oi."orderId" = o."id"
      LEFT JOIN "Product" p ON oi."productId" = p."id"
      WHERE o."venueId"::text = ${venueId}
        AND o."createdAt" >= ${from}::timestamp
        AND o."createdAt" <= ${to}::timestamp
        AND COALESCE(oi."productName", p."name", '') ILIKE ${searchPattern}
      GROUP BY COALESCE(oi."productName", p."name", 'Producto sin nombre')
      ORDER BY "revenue" DESC
      LIMIT 5
    `

    const matchedProducts = rows.map(row => ({
      productName: row.productName,
      quantitySold: Number(row.quantitySold),
      revenue: row.revenue.toNumber(),
      orderCount: Number(row.orderCount),
    }))

    return {
      searchTerm,
      productName: matchedProducts[0]?.productName || null,
      quantitySold: matchedProducts.reduce((sum, row) => sum + row.quantitySold, 0),
      revenue: matchedProducts.reduce((sum, row) => sum + row.revenue, 0),
      orderCount: matchedProducts.reduce((sum, row) => sum + row.orderCount, 0),
      matchedProducts,
      currency: 'MXN',
    }
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
   * Get inventory alerts for low stock items
   *
   * Used by:
   * - Dashboard /api/v1/dashboard/inventory/alerts endpoint
   * - AI Chatbot for "¿hay stock bajo?" or "¿qué ingredientes necesito?" queries
   *
   * @param venueId - Venue ID
   * @param threshold - Percentage threshold for low stock (default: 50 = 50%)
   * @returns Array of inventory alerts sorted by stock percentage ascending
   *
   * @example
   * const alerts = await SharedQueryService.getInventoryAlerts(venueId, 25)
   * console.log(alerts[0].rawMaterialName) // "Tortillas"
   */
  static async getInventoryAlerts(venueId: string, threshold: number = 50): Promise<InventoryAlert[]> {
    // Get raw materials with current stock
    const rawMaterials = await prisma.rawMaterial.findMany({
      where: { venueId },
      select: {
        id: true,
        name: true,
        currentStock: true,
        minimumStock: true,
        unit: true,
        updatedAt: true,
      },
    })

    // Calculate stock percentage and filter low stock items
    const alerts: InventoryAlert[] = rawMaterials
      .map(rm => {
        const currentStock = rm.currentStock?.toNumber() || 0
        const minimumStock = rm.minimumStock?.toNumber() || 1
        const stockPercentage = minimumStock > 0 ? (currentStock / minimumStock) * 100 : 100

        return {
          rawMaterialId: rm.id,
          rawMaterialName: rm.name,
          currentStock,
          minimumStock,
          unit: rm.unit,
          stockPercentage,
          estimatedDaysRemaining: null, // TODO: Calculate based on usage history
          lastPurchaseDate: null, // TODO: Get from purchase orders
        }
      })
      .filter(alert => alert.stockPercentage < threshold)
      .sort((a, b) => a.stockPercentage - b.stockPercentage)

    return alerts
  }

  /**
   * Get total active recipes for a venue.
   *
   * Used by:
   * - AI Chatbot for "¿cuántas recetas tengo?" queries
   *
   * @param venueId - Venue ID (multi-tenant isolation)
   * @returns Total number of active recipes linked to active, non-deleted products
   */
  static async getRecipeCount(venueId: string): Promise<RecipeCountSummary> {
    const totalRecipes = await prisma.recipe.count({
      where: {
        product: {
          venueId,
          active: true,
          deletedAt: null,
        },
      },
    })

    return { totalRecipes }
  }

  /**
   * Get active recipes for a venue.
   *
   * Used by:
   * - AI Chatbot for "¿cuáles son mis recetas?" queries
   *
   * @param venueId - Venue ID (multi-tenant isolation)
   * @param limit - Max recipes to return in chat response
   * @returns Active recipes linked to active, non-deleted products
   */
  static async getRecipeList(venueId: string, limit = 20): Promise<RecipeListSummary> {
    const where = {
      product: {
        venueId,
        active: true,
        deletedAt: null,
      },
    }

    const [totalRecipes, recipes] = await Promise.all([
      prisma.recipe.count({ where }),
      prisma.recipe.findMany({
        where,
        take: limit,
        orderBy: [{ product: { name: 'asc' } }],
        select: {
          id: true,
          portionYield: true,
          totalCost: true,
          product: {
            select: {
              name: true,
            },
          },
        },
      }),
    ])

    return {
      totalRecipes,
      limit,
      hasMore: totalRecipes > recipes.length,
      recipes: recipes.map(recipe => ({
        id: recipe.id,
        name: recipe.product.name,
        productName: recipe.product.name,
        portionYield: Number(recipe.portionYield ?? 0),
        totalCost: Number(recipe.totalCost ?? 0),
      })),
    }
  }

  /**
   * Get recipe usage ranked by order item quantity.
   *
   * Used by:
   * - AI Chatbot for "¿qué receta se usa más?" queries
   *
   * @param venueId - Venue ID (multi-tenant isolation)
   * @param limit - Max recipes to return in chat response
   * @returns Total active recipes plus top recipes by usage
   */
  static async getRecipeUsage(venueId: string, limit = 5): Promise<RecipeUsageSummary> {
    const totalRecipes = await prisma.recipe.count({
      where: {
        product: {
          venueId,
          active: true,
          deletedAt: null,
        },
      },
    })

    const topRecipes = await prisma.$queryRaw<
      Array<{
        recipeId: string
        productId: string
        productName: string
        quantityUsed: bigint
        orderCount: bigint
        revenue: Prisma.Decimal
      }>
    >`
      SELECT
        r."id" as "recipeId",
        p."id" as "productId",
        p."name" as "productName",
        COALESCE(SUM(oi."quantity"), 0)::bigint as "quantityUsed",
        COUNT(DISTINCT o."id")::bigint as "orderCount",
        COALESCE(SUM(oi."total"), 0) as "revenue"
      FROM "Recipe" r
      INNER JOIN "Product" p ON r."productId" = p."id"
      INNER JOIN "OrderItem" oi ON oi."productId" = p."id"
      INNER JOIN "Order" o ON oi."orderId" = o."id"
      WHERE p."venueId"::text = ${venueId}
        AND p."active" = true
        AND p."deletedAt" IS NULL
        AND o."venueId"::text = ${venueId}
        AND o."status" NOT IN ('CANCELLED', 'DELETED')
      GROUP BY r."id", p."id", p."name"
      ORDER BY "quantityUsed" DESC, "revenue" DESC, p."name" ASC
      LIMIT ${limit}
    `

    return {
      totalRecipes,
      limit,
      topRecipes: topRecipes.map(recipe => ({
        recipeId: recipe.recipeId,
        productId: recipe.productId,
        recipeName: recipe.productName,
        productName: recipe.productName,
        quantityUsed: Number(recipe.quantityUsed),
        orderCount: Number(recipe.orderCount),
        revenue: recipe.revenue?.toNumber() || 0,
      })),
    }
  }

  /**
   * Get pending orders statistics
   *
   * Used by:
   * - Dashboard /api/v1/dashboard/orders/pending endpoint
   * - AI Chatbot for "¿cuántas órdenes pendientes hay?" queries
   *
   * @param venueId - Venue ID
   * @returns Pending orders statistics by status
   *
   * @example
   * const pending = await SharedQueryService.getPendingOrders(venueId)
   * console.log(`${pending.total} órdenes pendientes`) // "15 órdenes pendientes"
   */
  static async getPendingOrders(venueId: string): Promise<PendingOrdersStats> {
    // Use typed enum values for Prisma query
    const openStatuses: Prisma.Enumerable<'PENDING' | 'CONFIRMED' | 'PREPARING' | 'READY'> = ['PENDING', 'CONFIRMED', 'PREPARING', 'READY']
    const now = new Date()
    const activeOrderCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000)

    // Get recently-created orders with open status. Historical seed/demo orders
    // can remain open forever, but they should not appear as "active right now".
    const orders = await prisma.order.findMany({
      where: {
        venueId,
        status: { in: openStatuses },
        createdAt: { gte: activeOrderCutoff },
      },
      select: {
        id: true,
        status: true,
        createdAt: true,
      },
    })

    // Calculate wait times
    const waitTimes = orders.map(o => Math.floor((now.getTime() - o.createdAt.getTime()) / (1000 * 60)))
    const oldestOrderMinutes = waitTimes.length > 0 ? Math.max(...waitTimes) : null
    const averageWaitMinutes = waitTimes.length > 0 ? waitTimes.reduce((a, b) => a + b, 0) / waitTimes.length : 0

    return {
      total: orders.length,
      byStatus: {
        pending: orders.filter(o => o.status === 'PENDING').length,
        confirmed: orders.filter(o => o.status === 'CONFIRMED').length,
        preparing: orders.filter(o => o.status === 'PREPARING').length,
        ready: orders.filter(o => o.status === 'READY').length,
      },
      oldestOrderMinutes,
      averageWaitMinutes: Math.round(averageWaitMinutes),
    }
  }

  /**
   * Get active (open) shifts
   *
   * Used by:
   * - Dashboard /api/v1/dashboard/shifts/active endpoint
   * - AI Chatbot for "¿quién está trabajando?" or "¿turnos abiertos?" queries
   *
   * @param venueId - Venue ID
   * @returns Array of active shifts with staff and sales info
   *
   * @example
   * const shifts = await SharedQueryService.getActiveShifts(venueId)
   * console.log(`${shifts.length} turnos abiertos`) // "3 turnos abiertos"
   */
  static async getActiveShifts(venueId: string): Promise<ActiveShiftInfo[]> {
    const now = new Date()

    // Get open shifts with staff info
    const shifts = await prisma.shift.findMany({
      where: {
        venueId,
        status: 'OPEN',
      },
      select: {
        id: true,
        staffId: true,
        startTime: true,
        totalCashPayments: true,
        totalCardPayments: true,
        totalTips: true,
        staff: {
          select: {
            firstName: true,
            lastName: true,
            venues: {
              where: { venueId },
              select: { role: true },
            },
          },
        },
      },
    })

    // Fetch all relevant orders in one query, then count per-shift in memory
    // Each shift has its own startTime, so we fetch since the earliest and filter per shift
    if (shifts.length === 0) return []

    const earliestStart = shifts.reduce((min, s) => (s.startTime < min ? s.startTime : min), shifts[0].startTime)
    const staffIds = shifts.map(s => s.staffId)

    const allOrders = await prisma.order.findMany({
      where: {
        venueId,
        createdById: { in: staffIds },
        createdAt: { gte: earliestStart },
      },
      select: { createdById: true, createdAt: true },
    })

    // Index orders by staffId for O(1) lookup instead of O(n*m) full scan
    const ordersByStaff = new Map<string, Array<{ createdAt: Date }>>()
    for (const order of allOrders) {
      if (!order.createdById) continue
      const arr = ordersByStaff.get(order.createdById)
      if (arr) arr.push(order)
      else ordersByStaff.set(order.createdById, [order])
    }

    const shiftInfos: ActiveShiftInfo[] = shifts.map(shift => {
      // Count only orders created after THIS shift's startTime
      const staffOrders = ordersByStaff.get(shift.staffId) || []
      const ordersCount = staffOrders.filter(o => o.createdAt >= shift.startTime).length

      const salesTotal = (shift.totalCashPayments?.toNumber() || 0) + (shift.totalCardPayments?.toNumber() || 0)
      const durationMinutes = Math.floor((now.getTime() - shift.startTime.getTime()) / (1000 * 60))

      return {
        shiftId: shift.id,
        staffId: shift.staffId,
        staffName: `${shift.staff.firstName} ${shift.staff.lastName}`.trim(),
        role: shift.staff.venues[0]?.role || 'STAFF',
        startTime: shift.startTime,
        durationMinutes,
        salesTotal,
        ordersCount,
        tipsTotal: shift.totalTips?.toNumber() || 0,
      }
    })

    return shiftInfos.sort((a, b) => b.salesTotal - a.salesTotal)
  }

  /**
   * Get profit analysis for a period
   *
   * Used by:
   * - Dashboard /api/v1/dashboard/analytics/profit endpoint
   * - AI Chatbot for "¿cuál es mi margen?" or "¿productos más rentables?" queries
   *
   * @param venueId - Venue ID
   * @param period - Date range (RelativeDateRange OR custom { from, to } object)
   * @param limit - Maximum number of top products to return (default: 5)
   * @param timezone - Venue timezone
   * @returns Profit analysis with margins and top profitable products
   *
   * @example
   * const profit = await SharedQueryService.getProfitAnalysis(venueId, 'last30days')
   * console.log(`Margen bruto: ${profit.grossMarginPercent.toFixed(1)}%`) // "Margen bruto: 35.2%"
   */
  static async getProfitAnalysis(venueId: string, period: DateRangeSpec, limit: number = 5, timezone?: string): Promise<ProfitAnalysis> {
    const venue = await prisma.venue.findUnique({
      where: { id: venueId },
      select: { timezone: true, currency: true },
    })

    if (!venue) {
      throw new Error(`Venue not found: ${venueId}`)
    }

    const venueTimezone = timezone || venue.timezone
    const { from, to } = this.getDateRange(period, venueTimezone)

    // Get revenue from payments
    const paymentsAgg = await prisma.payment.aggregate({
      where: {
        venueId,
        createdAt: { gte: from, lte: to },
        status: 'COMPLETED',
      },
      _sum: { amount: true },
    })

    const totalRevenue = paymentsAgg._sum.amount?.toNumber() || 0

    // Get products with their costs (via recipes)
    const productProfits = await prisma.$queryRaw<
      Array<{
        productId: string
        productName: string
        revenue: Prisma.Decimal
        cost: Prisma.Decimal
        quantitySold: bigint
      }>
    >`
      SELECT
        p."id" as "productId",
        p."name" as "productName",
        SUM(oi."quantity" * oi."unitPrice") as "revenue",
        COALESCE(SUM(oi."quantity" * r."totalCost"), 0) as "cost",
        SUM(oi."quantity")::bigint as "quantitySold"
      FROM "OrderItem" oi
      INNER JOIN "Product" p ON oi."productId" = p."id"
      INNER JOIN "Order" o ON oi."orderId" = o."id"
      LEFT JOIN "Recipe" r ON r."productId" = p."id"
      WHERE o."venueId"::text = ${venueId}
        AND o."createdAt" >= ${from}::timestamp
        AND o."createdAt" <= ${to}::timestamp
      GROUP BY p."id", p."name"
      ORDER BY (SUM(oi."quantity" * oi."unitPrice") - COALESCE(SUM(oi."quantity" * r."totalCost"), 0)) DESC
      LIMIT ${limit}
    `

    // Calculate totals
    const totalCost = productProfits.reduce((sum, p) => sum + (p.cost?.toNumber() || 0), 0)
    const grossProfit = totalRevenue - totalCost
    const grossMarginPercent = totalRevenue > 0 ? (grossProfit / totalRevenue) * 100 : 0

    const topProfitableProducts = productProfits.map(p => {
      const revenue = p.revenue?.toNumber() || 0
      const cost = p.cost?.toNumber() || 0
      const profit = revenue - cost
      const marginPercent = revenue > 0 ? (profit / revenue) * 100 : 0

      return {
        productId: p.productId,
        productName: p.productName,
        revenue,
        cost,
        profit,
        marginPercent,
        quantitySold: Number(p.quantitySold),
      }
    })

    return {
      totalRevenue,
      totalCost,
      grossProfit,
      grossMarginPercent,
      currency: venue.currency,
      topProfitableProducts,
    }
  }

  /**
   * Get payment method breakdown
   *
   * Used by:
   * - Dashboard /api/v1/dashboard/payments/breakdown endpoint
   * - AI Chatbot for "¿cuántos pagos en efectivo vs tarjeta?" queries
   *
   * @param venueId - Venue ID
   * @param period - Date range (RelativeDateRange OR custom { from, to } object)
   * @param timezone - Venue timezone
   * @returns Payment breakdown by method with percentages
   *
   * @example
   * const breakdown = await SharedQueryService.getPaymentMethodBreakdown(venueId, 'today')
   * console.log(`Efectivo: ${breakdown.methods[0].percentage}%`) // "Efectivo: 45.2%"
   */
  static async getPaymentMethodBreakdown(venueId: string, period: DateRangeSpec, timezone?: string): Promise<PaymentMethodBreakdown> {
    const venue = await prisma.venue.findUnique({
      where: { id: venueId },
      select: { timezone: true, currency: true },
    })

    if (!venue) {
      throw new Error(`Venue not found: ${venueId}`)
    }

    const venueTimezone = timezone || venue.timezone
    const { from, to } = this.getDateRange(period, venueTimezone)

    // Get payments grouped by method
    const payments = await prisma.payment.groupBy({
      by: ['method'],
      where: {
        venueId,
        createdAt: { gte: from, lte: to },
        status: 'COMPLETED',
      },
      _sum: {
        amount: true,
        tipAmount: true,
      },
      _count: true,
    })

    const total = payments.reduce((sum, p) => sum + (p._sum.amount?.toNumber() || 0), 0)

    const methods = payments.map(p => ({
      method: p.method,
      amount: p._sum.amount?.toNumber() || 0,
      count: p._count,
      percentage: total > 0 ? ((p._sum.amount?.toNumber() || 0) / total) * 100 : 0,
      tipAmount: p._sum.tipAmount?.toNumber() || 0,
    }))

    // Sort by amount descending
    methods.sort((a, b) => b.amount - a.amount)

    return {
      total,
      methods,
      currency: venue.currency,
    }
  }

  /**
   * Get settlement calendar totals for a venue and period.
   *
   * Used by:
   * - Dashboard available-balance settlement calendar
   * - AI Chatbot for "¿cuánto me liquidan/dispersan hoy?" queries
   */
  static async getSettlementCalendarForPeriod(
    venueId: string,
    period: DateRangeSpec,
    timezone?: string,
  ): Promise<SettlementCalendarSummary> {
    const venue = await prisma.venue.findUnique({
      where: { id: venueId },
      select: { timezone: true, currency: true },
    })

    if (!venue) {
      throw new Error(`Venue not found: ${venueId}`)
    }

    const venueTimezone = timezone || venue.timezone
    const { from, to, periodName } = this.getDateRange(period, venueTimezone)
    const entries = await availableBalanceService.getSettlementCalendar(venueId, { from, to })

    return {
      totalNetAmount: entries.reduce((sum, entry) => sum + entry.totalNetAmount, 0),
      transactionCount: entries.reduce((sum, entry) => sum + entry.transactionCount, 0),
      currency: venue.currency,
      period: periodName,
      dateRange: { from, to },
      entries: entries.map(entry => ({
        settlementDate: entry.settlementDate,
        totalNetAmount: entry.totalNetAmount,
        transactionCount: entry.transactionCount,
        status: entry.status,
        byCardType: entry.byCardType.map(card => ({
          cardType: card.cardType,
          netAmount: card.netAmount,
          transactionCount: card.transactionCount,
        })),
      })),
    }
  }

  /**
   * List payment links for the current venue.
   *
   * Used by:
   * - Dashboard payment-links list endpoint
   * - AI Chatbot for "¿qué links de pago tengo?" queries
   */
  static async getPaymentLinks(
    venueId: string,
    filters: { status?: string; search?: string; limit?: number; offset?: number } = {},
  ): Promise<PaymentLinksSummary> {
    const result = await paymentLinkService.getPaymentLinks(venueId, {
      status: filters.status,
      search: filters.search,
      limit: filters.limit,
      offset: filters.offset,
    })

    return {
      total: result.total,
      limit: result.limit,
      offset: result.offset,
      hasMore: result.hasMore,
      links: result.paymentLinks.map(link => ({
        id: link.id,
        title: link.title,
        shortCode: link.shortCode,
        status: link.status,
        purpose: link.purpose,
        amountType: link.amountType,
        amount: link.amount == null ? null : Number(link.amount),
        currency: link.currency,
        isReusable: link.isReusable,
        totalCollected: Number(link.totalCollected),
        paymentCount: link.paymentCount,
        checkoutSessionCount: link._count?.checkoutSessions ?? 0,
        createdAt: link.createdAt,
        expiresAt: link.expiresAt,
        createdByName: link.createdBy ? `${link.createdBy.firstName || ''} ${link.createdBy.lastName || ''}`.trim() || null : null,
      })),
    }
  }

  /**
   * Summarize payment links for the current venue.
   *
   * Used by:
   * - AI Chatbot for "resumen de links de pago" queries
   */
  static async getPaymentLinksSummary(venueId: string): Promise<PaymentLinksAggregateSummary> {
    const result = await paymentLinkService.getPaymentLinks(venueId, { limit: 100, offset: 0 })
    const links = result.paymentLinks
    const currency = links[0]?.currency || 'MXN'

    return {
      totalLinks: result.total,
      activeLinks: links.filter(link => link.status === 'ACTIVE').length,
      pausedLinks: links.filter(link => link.status === 'PAUSED').length,
      fixedAmountLinks: links.filter(link => link.amountType === 'FIXED').length,
      openAmountLinks: links.filter(link => link.amountType === 'OPEN').length,
      totalCollected: links.reduce((sum, link) => sum + this.numberValue(link.totalCollected), 0),
      paymentCount: links.reduce((sum, link) => sum + Number(link.paymentCount || 0), 0),
      checkoutSessionCount: links.reduce((sum, link) => sum + Number(link._count?.checkoutSessions || 0), 0),
      currency,
    }
  }

  /**
   * Summarize customers for the current venue without exposing PII.
   *
   * Used by:
   * - Dashboard customer stats endpoint
   * - AI Chatbot for "resumen de clientes" queries
   */
  static async getCustomerSummary(venueId: string): Promise<CustomerSummary> {
    const stats = await customerDashboardService.getCustomerStats(venueId)

    return {
      totalCustomers: stats.totalCustomers,
      activeCustomers: stats.activeCustomers,
      newCustomersThisMonth: stats.newCustomersThisMonth,
      vipCustomers: stats.vipCustomers,
      averageLifetimeValue: stats.averageLifetimeValue,
      averageVisitsPerCustomer: stats.averageVisitsPerCustomer,
      topSpenders: stats.topSpenders.map(customer => ({
        name: customer.name,
        totalSpent: customer.totalSpent,
        totalVisits: customer.totalVisits,
      })),
    }
  }

  /**
   * List team members for the current venue with credential/contact fields removed.
   *
   * Used by:
   * - Dashboard team list endpoint
   * - AI Chatbot for "quién está en mi equipo" queries
   */
  static async getTeamMembers(
    venueId: string,
    filters: { search?: string; limit?: number; page?: number } = {},
  ): Promise<TeamMembersSummary> {
    const pageSize = Math.min(Math.max(Math.trunc(Number(filters.limit) || 10), 1), 25)
    const page = Math.min(Math.max(Math.trunc(Number(filters.page) || 1), 1), 1000)
    const result = await teamDashboardService.getTeamMembers(venueId, page, pageSize, filters.search)

    return {
      total: result.meta.totalCount,
      limit: result.meta.pageSize,
      members: result.data.map(member => ({
        staffVenueId: member.id,
        staffId: member.staffId,
        name: `${member.firstName || ''} ${member.lastName || ''}`.trim() || 'Sin nombre',
        role: member.role,
        active: member.active,
        totalSales: this.numberValue(member.totalSales),
        totalTips: this.numberValue(member.totalTips),
        totalOrders: Number(member.totalOrders || 0),
        permissionSetName: member.permissionSetName,
      })),
    }
  }

  /**
   * Summarize commissions for the current venue.
   *
   * Used by:
   * - Dashboard commission stats endpoint
   * - AI Chatbot for "cómo van mis comisiones" queries
   */
  static async getCommissionsSummary(venueId: string): Promise<CommissionsSummary> {
    const stats = await commissionCalculationService.getVenueCommissionStats(venueId)

    return {
      totalPaid: stats.totalPaid,
      totalPending: stats.totalPending,
      totalApproved: stats.totalApproved,
      staffWithCommissions: stats.staffWithCommissions,
      averageCommission: stats.averageCommission,
      topEarners: stats.topEarners.map(earner => ({
        staffName: earner.staffName,
        totalEarned: earner.totalEarned,
        calculationCount: earner.calculationCount,
      })),
    }
  }

  /**
   * List payments for the current venue and period with card/processor details minimized.
   *
   * Used by:
   * - Dashboard payments list endpoint
   * - AI Chatbot for "muéstrame los pagos de hoy" queries
   */
  static async getPayments(
    venueId: string,
    period: DateRangeSpec,
    filters: { method?: string; source?: string; search?: string; limit?: number; page?: number } = {},
    timezone?: string,
  ): Promise<PaymentsListSummary> {
    const venue = await prisma.venue.findUnique({
      where: { id: venueId },
      select: { timezone: true, currency: true },
    })

    if (!venue) {
      throw new Error(`Venue not found: ${venueId}`)
    }

    const { from, to, periodName } = this.getDateRange(period, timezone || venue.timezone)
    const pageSize = Math.min(Math.max(Math.trunc(Number(filters.limit) || 10), 1), 25)
    const page = Math.min(Math.max(Math.trunc(Number(filters.page) || 1), 1), 1000)
    const result = await paymentDashboardService.getPaymentsData(venueId, page, pageSize, {
      startDate: from.toISOString(),
      endDate: to.toISOString(),
      method: this.normalizePaymentMethod(filters.method),
      source: filters.source,
      search: filters.search,
    })

    return {
      total: result.meta.total,
      page: result.meta.page,
      pageSize: result.meta.pageSize,
      pageCount: result.meta.pageCount,
      period: periodName,
      dateRange: { from, to },
      payments: result.data.map(payment => ({
        id: payment.id,
        amount: this.numberValue(payment.amount),
        tipAmount: this.numberValue(payment.tipAmount),
        currency: (payment as any).currency || venue.currency || 'MXN',
        status: payment.status,
        method: payment.method,
        source: payment.source,
        cardBrand: payment.cardBrand,
        last4: (payment as any).last4 || null,
        createdAt: payment.createdAt,
        processedByName: payment.processedBy
          ? `${payment.processedBy.firstName || ''} ${payment.processedBy.lastName || ''}`.trim() || null
          : null,
        orderNumber: payment.order?.orderNumber || null,
        tableNumber: (payment.order as any)?.table?.number || null,
        merchantName: payment.merchantAccount?.displayName || payment.merchantAccount?.alias || null,
      })),
    }
  }

  /**
   * Summarize payments for the current venue and period.
   *
   * Uses the same dashboard payment service as the list endpoint. The summary is
   * capped to the first 100 dashboard rows until a dedicated dashboard aggregate
   * endpoint exists.
   */
  static async getPaymentsSummary(venueId: string, period: DateRangeSpec, timezone?: string): Promise<PaymentsSummary> {
    const venue = await prisma.venue.findUnique({
      where: { id: venueId },
      select: { timezone: true, currency: true },
    })

    if (!venue) {
      throw new Error(`Venue not found: ${venueId}`)
    }

    const { from, to, periodName } = this.getDateRange(period, timezone || venue.timezone)
    const result = await paymentDashboardService.getPaymentsData(venueId, 1, 100, {
      startDate: from.toISOString(),
      endDate: to.toISOString(),
    })

    const payments = result.data
    const currency = (payments[0] as any)?.currency || venue.currency || 'MXN'

    return {
      totalPayments: result.meta.total,
      completedPayments: payments.filter(payment => payment.status === 'COMPLETED').length,
      refundedPayments: payments.filter(payment => payment.status === 'REFUNDED').length,
      totalAmount: payments.reduce((sum, payment) => sum + this.numberValue(payment.amount), 0),
      totalTips: payments.reduce((sum, payment) => sum + this.numberValue(payment.tipAmount), 0),
      currency,
      period: periodName,
      dateRange: { from, to },
    }
  }

  /**
   * Summarize reservations for the current venue and period.
   *
   * Used by:
   * - Dashboard reservations stats endpoint
   * - AI Chatbot for "¿cuántas reservaciones tengo hoy?" queries
   */
  static async getReservationSummary(venueId: string, period: DateRangeSpec, timezone?: string): Promise<ReservationSummary> {
    const venue = await prisma.venue.findUnique({
      where: { id: venueId },
      select: { timezone: true },
    })

    if (!venue) {
      throw new Error(`Venue not found: ${venueId}`)
    }

    const { from, to, periodName } = this.getDateRange(period, timezone || venue.timezone)
    const stats = await reservationService.getReservationStats(venueId, from, to)

    return {
      ...stats,
      period: periodName,
      dateRange: { from, to },
    }
  }

  /**
   * List reservations for the current venue and period with PII-minimized fields.
   *
   * Used by:
   * - Dashboard reservations list endpoint
   * - AI Chatbot for "muéstrame mis reservas de hoy" queries
   */
  static async getReservations(
    venueId: string,
    period: DateRangeSpec,
    filters: { status?: string; search?: string; limit?: number; page?: number } = {},
    timezone?: string,
  ): Promise<ReservationListSummary> {
    const venue = await prisma.venue.findUnique({
      where: { id: venueId },
      select: { timezone: true },
    })

    if (!venue) {
      throw new Error(`Venue not found: ${venueId}`)
    }

    const { from, to, periodName } = this.getDateRange(period, timezone || venue.timezone)
    const pageSize = Math.min(Math.max(Math.trunc(Number(filters.limit) || 10), 1), 25)
    const page = Math.min(Math.max(Math.trunc(Number(filters.page) || 1), 1), 1000)
    const result = await reservationService.getReservations(
      venueId,
      {
        dateFrom: from,
        dateTo: to,
        status: this.normalizeReservationStatus(filters.status),
        search: filters.search,
      },
      page,
      pageSize,
    )

    return {
      total: result.meta.total,
      page: result.meta.page,
      pageSize: result.meta.pageSize,
      totalPages: result.meta.totalPages,
      period: periodName,
      dateRange: { from, to },
      reservations: result.data.map(reservation => ({
        confirmationCode: reservation.confirmationCode,
        status: reservation.status,
        channel: reservation.channel,
        startsAt: reservation.startsAt,
        endsAt: reservation.endsAt,
        partySize: reservation.partySize,
        guestName: reservation.guestName || null,
        customerName: reservation.customer
          ? `${reservation.customer.firstName || ''} ${reservation.customer.lastName || ''}`.trim() || null
          : null,
        tableNumber: reservation.table?.number || null,
        productName: reservation.product?.name || null,
        assignedStaffName: reservation.assignedStaff
          ? `${reservation.assignedStaff.firstName || ''} ${reservation.assignedStaff.lastName || ''}`.trim() || null
          : null,
      })),
    }
  }

  private static normalizeReservationStatus(status?: string): ReservationStatus | undefined {
    if (!status) return undefined
    const normalized = status.toUpperCase()
    const allowed: ReservationStatus[] = ['PENDING', 'CONFIRMED', 'CHECKED_IN', 'COMPLETED', 'CANCELLED', 'NO_SHOW']
    return allowed.includes(normalized as ReservationStatus) ? (normalized as ReservationStatus) : undefined
  }

  private static normalizePaymentMethod(method?: string): PaymentMethod | undefined {
    if (!method) return undefined
    const normalized = method.toUpperCase()
    const allowed = Object.values(PaymentMethod)
    return allowed.includes(normalized as PaymentMethod) ? (normalized as PaymentMethod) : undefined
  }

  private static numberValue(value: unknown): number {
    if (value == null) return 0
    if (typeof value === 'number') return value
    if (typeof value === 'object' && 'toNumber' in value && typeof value.toNumber === 'function') return value.toNumber()
    return Number(value) || 0
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

  // ============================================
  // CUSTOMER ANALYTICS
  // ============================================

  /**
   * Get top customers by spending (VIP customers)
   *
   * Returns customers ranked by total spending with visit stats.
   * Used for "mejor cliente", "clientes VIP", "top cliente" queries.
   *
   * @param venueId - Venue ID
   * @param limit - Number of customers to return (default: 10)
   * @returns Array of top customers with spending and visit data
   */
  static async getTopCustomers(
    venueId: string,
    limit: number = 10,
  ): Promise<{
    customers: Array<{
      id: string
      firstName: string | null
      lastName: string | null
      email: string | null
      totalSpent: number
      totalVisits: number
      lastVisitAt: Date | null
      averageOrderValue: number
    }>
    totalCustomers: number
  }> {
    const customers = await prisma.customer.findMany({
      where: {
        venueId,
        active: true,
        totalSpent: { gt: 0 },
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        totalSpent: true,
        totalVisits: true,
        lastVisitAt: true,
        averageOrderValue: true,
      },
      orderBy: {
        totalSpent: 'desc',
      },
      take: limit,
    })

    const totalCustomers = await prisma.customer.count({
      where: { venueId, active: true },
    })

    return {
      customers: customers.map(c => ({
        id: c.id,
        firstName: c.firstName,
        lastName: c.lastName,
        email: c.email,
        totalSpent: c.totalSpent?.toNumber() || 0,
        totalVisits: c.totalVisits,
        lastVisitAt: c.lastVisitAt,
        averageOrderValue: c.averageOrderValue?.toNumber() || 0,
      })),
      totalCustomers,
    }
  }

  /**
   * Get churning/lost customers (customers who stopped visiting)
   *
   * Returns customers who haven't visited in X days but had multiple visits.
   * Used for "dejó de venir", "cliente perdido", "clientes inactivos" queries.
   *
   * @param venueId - Venue ID
   * @param inactiveDays - Days since last visit to consider churned (default: 30)
   * @param minVisits - Minimum visits to be considered a churned customer (default: 2)
   * @param limit - Number of customers to return (default: 20)
   * @returns Array of churning customers with last visit and spending data
   */
  static async getChurningCustomers(
    venueId: string,
    inactiveDays: number = 30,
    minVisits: number = 2,
    limit: number = 20,
  ): Promise<{
    customers: Array<{
      id: string
      firstName: string | null
      lastName: string | null
      email: string | null
      totalSpent: number
      totalVisits: number
      lastVisitAt: Date | null
      daysSinceLastVisit: number
    }>
    totalChurning: number
    cutoffDate: Date
  }> {
    const cutoffDate = new Date()
    cutoffDate.setDate(cutoffDate.getDate() - inactiveDays)

    const customers = await prisma.customer.findMany({
      where: {
        venueId,
        active: true,
        totalVisits: { gte: minVisits },
        lastVisitAt: { lt: cutoffDate },
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        totalSpent: true,
        totalVisits: true,
        lastVisitAt: true,
      },
      orderBy: {
        totalSpent: 'desc', // Show highest value lost customers first
      },
      take: limit,
    })

    const totalChurning = await prisma.customer.count({
      where: {
        venueId,
        active: true,
        totalVisits: { gte: minVisits },
        lastVisitAt: { lt: cutoffDate },
      },
    })

    return {
      customers: customers.map(c => {
        const daysSince = c.lastVisitAt ? Math.floor((Date.now() - c.lastVisitAt.getTime()) / (1000 * 60 * 60 * 24)) : 999
        return {
          id: c.id,
          firstName: c.firstName,
          lastName: c.lastName,
          email: c.email,
          totalSpent: c.totalSpent?.toNumber() || 0,
          totalVisits: c.totalVisits,
          lastVisitAt: c.lastVisitAt,
          daysSinceLastVisit: daysSince,
        }
      }),
      totalChurning,
      cutoffDate,
    }
  }

  /**
   * Get new customer registrations
   *
   * Returns count and list of new customers for a period.
   * Used for "clientes nuevos", "nuevos registros" queries.
   *
   * @param venueId - Venue ID
   * @param period - Date range specification
   * @param timezone - Venue timezone
   * @returns New customer stats with list
   */
  static async getNewCustomers(
    venueId: string,
    period: DateRangeSpec,
    timezone?: string,
  ): Promise<{
    count: number
    customers: Array<{
      id: string
      firstName: string | null
      lastName: string | null
      createdAt: Date
    }>
    periodLabel: string
  }> {
    const venue = await prisma.venue.findUnique({
      where: { id: venueId },
      select: { timezone: true },
    })

    const venueTimezone = timezone || venue?.timezone || 'America/Mexico_City'
    const { from, to, periodName } = this.getDateRange(period, venueTimezone)

    const customers = await prisma.customer.findMany({
      where: {
        venueId,
        createdAt: { gte: from, lte: to },
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        createdAt: true,
      },
      orderBy: {
        createdAt: 'desc',
      },
      take: 50,
    })

    const count = await prisma.customer.count({
      where: {
        venueId,
        createdAt: { gte: from, lte: to },
      },
    })

    return {
      count,
      customers,
      periodLabel: periodName,
    }
  }

  /**
   * Get timing patterns for new customers.
   *
   * Uses firstVisitAt when available, then falls back to createdAt. This keeps the
   * metric aligned with loyalty/customer behavior while still working for older
   * records that do not have firstVisitAt populated.
   */
  static async getNewCustomerTimingPattern(venueId: string, period: DateRangeSpec, timezone?: string): Promise<NewCustomerTimingPattern> {
    const venue = await prisma.venue.findUnique({
      where: { id: venueId },
      select: { timezone: true },
    })

    const venueTimezone = timezone || venue?.timezone || 'America/Mexico_City'
    const { from, to, periodName } = this.getDateRange(period, venueTimezone)

    const customers = await prisma.customer.findMany({
      where: {
        venueId,
        active: true,
        OR: [
          { firstVisitAt: { gte: from, lte: to } },
          {
            firstVisitAt: null,
            createdAt: { gte: from, lte: to },
          },
        ],
      },
      select: {
        firstVisitAt: true,
        createdAt: true,
      },
    })

    const dayLabels = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado']
    const dayCounts = new Map(dayLabels.map(day => [day, 0]))
    const hourCounts = new Map(Array.from({ length: 24 }, (_, hour) => [`${hour.toString().padStart(2, '0')}:00`, 0]))

    const datePartsFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: venueTimezone,
      weekday: 'short',
      hour: '2-digit',
      hourCycle: 'h23',
    })

    const weekdayIndexByShortName: Record<string, number> = {
      Sun: 0,
      Mon: 1,
      Tue: 2,
      Wed: 3,
      Thu: 4,
      Fri: 5,
      Sat: 6,
    }

    for (const customer of customers) {
      const visitDate = customer.firstVisitAt || customer.createdAt
      const parts = datePartsFormatter.formatToParts(visitDate)
      const weekdayShort = parts.find(part => part.type === 'weekday')?.value || 'Sun'
      const hour = parts.find(part => part.type === 'hour')?.value || '00'
      const day = dayLabels[weekdayIndexByShortName[weekdayShort] ?? 0]
      const hourLabel = `${hour.padStart(2, '0')}:00`

      dayCounts.set(day, (dayCounts.get(day) || 0) + 1)
      hourCounts.set(hourLabel, (hourCounts.get(hourLabel) || 0) + 1)
    }

    const byDayOfWeek = Array.from(dayCounts.entries()).map(([day, count]) => ({ day, count }))
    const byHour = Array.from(hourCounts.entries()).map(([hour, count]) => ({ hour, count }))

    const peakDay = byDayOfWeek.reduce<{ day: string; count: number } | null>(
      (peak, current) => (!peak || current.count > peak.count ? current : peak),
      null,
    )
    const peakHour = byHour.reduce<{ hour: string; count: number } | null>(
      (peak, current) => (!peak || current.count > peak.count ? current : peak),
      null,
    )

    return {
      count: customers.length,
      periodLabel: periodName,
      peakDay: peakDay && peakDay.count > 0 ? peakDay : null,
      peakHour: peakHour && peakHour.count > 0 ? peakHour : null,
      byDayOfWeek,
      byHour,
    }
  }
}
