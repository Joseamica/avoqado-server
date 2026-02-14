/**
 * Sales Summary Dashboard Service
 *
 * Calculates comprehensive sales metrics for venues.
 * Used by the Sales Summary report in the dashboard.
 *
 * Accounting Structure:
 * - grossSales = items + serviceCosts (Order.subtotal + service fees)
 *   Does NOT include taxes or tips (pass-through items)
 * - items: Sum of Order.subtotal (item prices without taxes/tips)
 * - serviceCosts: Service fees, delivery fees (future)
 * - discounts: Total discounts applied
 * - refunds: Total refunded payments
 * - netSales: grossSales - discounts - refunds
 * - deferredSales: Unpaid/partial orders total
 * - taxes: Total taxes collected (pass-through)
 * - tips: Total tips
 *
 * Costs breakdown:
 * - platformFees: Avoqado platform fees (from VenueTransaction.feeAmount)
 * - staffCommissions: Commissions paid to staff (from CommissionCalculation.netCommission)
 *
 * Calculated totals:
 * - totalCollected: netSales + tips - platformFees (actual cash flow)
 * - netProfit: netSales - platformFees - staffCommissions (true venue profit)
 */

import logger from '@/config/logger'
import { BadRequestError } from '@/errors/AppError'
import prisma from '@/utils/prismaClient'
import { sanitizeTimezone } from '@/utils/sanitizeTimezone'

// ============================================================
// Types
// ============================================================

export interface SalesSummaryMetrics {
  grossSales: number
  items: number
  serviceCosts: number
  discounts: number
  refunds: number
  netSales: number
  deferredSales: number
  taxes: number
  tips: number
  // Costs breakdown (for clarity)
  platformFees: number // Avoqado platform fees (from VenueTransaction)
  staffCommissions: number // Commissions paid to staff (from CommissionCalculation)
  // Legacy field for backwards compatibility (= platformFees)
  commissions: number
  totalCollected: number
  // True profit after all costs
  netProfit: number // netSales - platformFees - staffCommissions
  transactionCount: number
}

export interface PaymentMethodBreakdown {
  method: string
  amount: number
  count: number
  percentage: number
}

export interface TimePeriodMetrics {
  period: string // ISO date string or label (e.g., "Monday", "09:00")
  periodLabel?: string // Human-readable label
  metrics: SalesSummaryMetrics
}

export interface SalesSummaryResponse {
  dateRange: {
    startDate: Date
    endDate: Date
  }
  reportType: ReportType
  summary: SalesSummaryMetrics
  byPaymentMethod?: PaymentMethodBreakdown[]
  byPeriod?: TimePeriodMetrics[] // Time-based breakdown
}

export type ReportType = 'summary' | 'hours' | 'days' | 'weeks' | 'months' | 'hourlySum' | 'dailySum'

export interface SalesSummaryFilters {
  startDate: string
  endDate: string
  groupBy?: 'none' | 'paymentMethod'
  reportType?: ReportType
  timezone?: string
}

// ============================================================
// Main Service Function
// ============================================================

/**
 * Get sales summary for a venue within a date range
 */
export async function getSalesSummary(venueId: string, filters: SalesSummaryFilters): Promise<SalesSummaryResponse> {
  const { startDate, endDate, groupBy = 'none', reportType = 'summary', timezone = 'America/Mexico_City' } = filters

  // Validate dates
  const parsedStartDate = new Date(startDate)
  const parsedEndDate = new Date(endDate)

  if (isNaN(parsedStartDate.getTime())) {
    throw new BadRequestError(`Invalid startDate: ${startDate}`)
  }
  if (isNaN(parsedEndDate.getTime())) {
    throw new BadRequestError(`Invalid endDate: ${endDate}`)
  }

  logger.info('Calculating sales summary', { venueId, startDate, endDate, groupBy })

  // Base date filter for orders
  const dateFilter = {
    createdAt: {
      gte: parsedStartDate,
      lte: parsedEndDate,
    },
  }

  // ============================================================
  // Calculate Core Metrics
  // ============================================================

  // 1. Gross Sales - Total from valid orders (exclude drafts, cancelled, deleted, refunded)
  const grossSalesResult = await prisma.order.aggregate({
    where: {
      venueId,
      ...dateFilter,
      status: { notIn: ['PENDING', 'CANCELLED', 'DELETED'] },
      paymentStatus: { notIn: ['REFUNDED'] },
    },
    _sum: {
      total: true,
      subtotal: true,
      taxAmount: true,
      tipAmount: true,
      discountAmount: true,
    },
    _count: true,
  })

  // 2. Items - Using Order.subtotal (more reliable than OrderItem aggregation
  // because some orders synced from POS don't have OrderItem records)
  // NOTE: items = grossSalesResult._sum.subtotal (already queried above)

  // 3. Refunds - Sum of refunded payment amounts
  const refundsResult = await prisma.payment.aggregate({
    where: {
      venueId,
      ...dateFilter,
      status: 'REFUNDED',
    },
    _sum: {
      amount: true,
    },
    _count: true,
  })

  // 4. Deferred Sales - Orders with PENDING or PARTIAL payment status
  const deferredResult = await prisma.order.aggregate({
    where: {
      venueId,
      ...dateFilter,
      status: { notIn: ['PENDING', 'CANCELLED', 'DELETED'] },
      paymentStatus: { in: ['PENDING', 'PARTIAL'] },
    },
    _sum: {
      remainingBalance: true,
    },
    _count: true,
  })

  // 5. Tips - From completed payments (more accurate than order tips)
  const tipsResult = await prisma.payment.aggregate({
    where: {
      venueId,
      ...dateFilter,
      status: 'COMPLETED',
    },
    _sum: {
      tipAmount: true,
    },
  })

  // 6. Platform Fees (Avoqado fees) - From VenueTransaction
  const platformFeesResult = await prisma.venueTransaction.aggregate({
    where: {
      venueId,
      ...dateFilter,
    },
    _sum: {
      feeAmount: true,
    },
  })

  // 7. Staff Commissions (paid to employees) - From CommissionCalculation
  const staffCommissionsResult = await prisma.commissionCalculation.aggregate({
    where: {
      venueId,
      createdAt: dateFilter.createdAt,
      status: { not: 'VOIDED' }, // Exclude voided commissions
    },
    _sum: {
      netCommission: true,
    },
  })

  // 8. Transaction Count - Completed payments
  const transactionCountResult = await prisma.payment.count({
    where: {
      venueId,
      ...dateFilter,
      status: 'COMPLETED',
    },
  })

  // ============================================================
  // Calculate Derived Metrics
  // ============================================================

  // Gross Sales = Item subtotals (Order.subtotal) + service costs
  // Does NOT include taxes or tips (those are shown separately)
  // This follows standard accounting where taxes are pass-through, not revenue
  const grossSales = Number(grossSalesResult._sum.subtotal || 0)
  const items = Number(grossSalesResult._sum.subtotal || 0)
  const discounts = Number(grossSalesResult._sum.discountAmount || 0)
  const refunds = Number(refundsResult._sum.amount || 0)
  const taxes = Number(grossSalesResult._sum.taxAmount || 0)
  const tips = Number(tipsResult._sum.tipAmount || 0)
  const platformFees = Number(platformFeesResult._sum.feeAmount || 0)
  const staffCommissions = Number(staffCommissionsResult._sum.netCommission || 0)
  const deferredSales = Number(deferredResult._sum.remainingBalance || 0)
  const serviceCosts = 0 // Not tracked separately in current schema

  // Net Sales = Gross Sales - Discounts - Refunds
  const netSales = grossSales - discounts - refunds

  // Total Collected = Net Sales + Tips - Platform Fees
  // Mexico model: taxes are already included in prices, NOT added on top
  // This represents the actual cash flow (money in account after platform fees)
  const totalCollected = netSales + tips - platformFees

  // Net Profit = Net Sales - Platform Fees - Staff Commissions
  // This is the true profit after all costs to the venue
  // Note: Tips are NOT subtracted here because they are pass-through to employees
  const netProfit = netSales - platformFees - staffCommissions

  const summary: SalesSummaryMetrics = {
    grossSales,
    items,
    serviceCosts,
    discounts,
    refunds,
    netSales,
    deferredSales,
    taxes,
    tips,
    platformFees,
    staffCommissions,
    commissions: platformFees, // Legacy field for backwards compatibility
    totalCollected,
    netProfit,
    transactionCount: transactionCountResult,
  }

  // ============================================================
  // Payment Method Breakdown (if requested)
  // ============================================================

  let byPaymentMethod: PaymentMethodBreakdown[] | undefined

  if (groupBy === 'paymentMethod') {
    const paymentsByMethod = await prisma.payment.groupBy({
      by: ['method'],
      where: {
        venueId,
        ...dateFilter,
        status: 'COMPLETED',
      },
      _sum: {
        amount: true,
        tipAmount: true,
      },
      _count: true,
    })

    const totalPaymentAmount = paymentsByMethod.reduce((sum, p) => sum + Number(p._sum.amount || 0), 0)

    byPaymentMethod = paymentsByMethod.map(p => ({
      method: p.method,
      amount: Number(p._sum.amount || 0) + Number(p._sum.tipAmount || 0),
      count: p._count,
      percentage: totalPaymentAmount > 0 ? Number(((Number(p._sum.amount || 0) / totalPaymentAmount) * 100).toFixed(1)) : 0,
    }))

    // Sort by amount descending
    byPaymentMethod.sort((a, b) => b.amount - a.amount)
  }

  // ============================================================
  // Time-Period Breakdown (if reportType is not 'summary')
  // ============================================================

  let byPeriod: TimePeriodMetrics[] | undefined

  if (reportType !== 'summary') {
    byPeriod = await calculateTimePeriodMetrics(venueId, parsedStartDate, parsedEndDate, reportType, timezone)
  }

  logger.info('Sales summary calculated', {
    venueId,
    grossSales,
    netSales,
    transactionCount: transactionCountResult,
    reportType,
    periodsCount: byPeriod?.length,
  })

  return {
    dateRange: {
      startDate: parsedStartDate,
      endDate: parsedEndDate,
    },
    reportType,
    summary,
    byPaymentMethod,
    byPeriod,
  }
}

// ============================================================
// Helper: Calculate Time-Period Metrics
// ============================================================

/**
 * Calculate metrics grouped by time period
 */
async function calculateTimePeriodMetrics(
  venueId: string,
  startDate: Date,
  endDate: Date,
  reportType: ReportType,
  timezone: string,
): Promise<TimePeriodMetrics[]> {
  // SECURITY: Sanitize timezone to prevent SQL injection
  const safeTz = sanitizeTimezone(timezone)

  // Determine SQL grouping based on reportType
  let groupByExpression: string
  let orderByExpression: string

  switch (reportType) {
    case 'hours':
      groupByExpression = `DATE_TRUNC('hour', "createdAt" AT TIME ZONE '${safeTz}')`
      orderByExpression = 'period'
      break
    case 'days':
      groupByExpression = `DATE_TRUNC('day', "createdAt" AT TIME ZONE '${safeTz}')`
      orderByExpression = 'period'
      break
    case 'weeks':
      groupByExpression = `DATE_TRUNC('week', "createdAt" AT TIME ZONE '${safeTz}')`
      orderByExpression = 'period'
      break
    case 'months':
      groupByExpression = `DATE_TRUNC('month', "createdAt" AT TIME ZONE '${safeTz}')`
      orderByExpression = 'period'
      break
    case 'hourlySum':
      // Group by hour of day (0-23)
      groupByExpression = `EXTRACT(HOUR FROM "createdAt" AT TIME ZONE '${safeTz}')`
      orderByExpression = 'period'
      break
    case 'dailySum':
      // Group by day of week (0=Sunday, 6=Saturday)
      groupByExpression = `EXTRACT(DOW FROM "createdAt" AT TIME ZONE '${safeTz}')`
      orderByExpression = 'period'
      break
    default:
      return []
  }

  // Query order metrics grouped by period
  // Using subtotal for gross_sales (not total) to match accounting standards
  const orderMetricsQuery = `
    SELECT
      ${groupByExpression} as period,
      COALESCE(SUM(subtotal), 0) as gross_sales,
      COALESCE(SUM("taxAmount"), 0) as taxes,
      COALESCE(SUM("discountAmount"), 0) as discounts,
      COUNT(*) as order_count
    FROM "Order"
    WHERE "venueId" = $1
      AND "createdAt" >= $2
      AND "createdAt" <= $3
      AND status NOT IN ('CANCELLED')
      AND "paymentStatus" NOT IN ('REFUNDED')
    GROUP BY ${groupByExpression}
    ORDER BY ${orderByExpression}
  `

  // Query payment metrics grouped by period
  const paymentMetricsQuery = `
    SELECT
      ${groupByExpression} as period,
      COALESCE(SUM(amount), 0) as payment_amount,
      COALESCE(SUM("tipAmount"), 0) as tips,
      COUNT(*) as transaction_count
    FROM "Payment"
    WHERE "venueId" = $1
      AND "createdAt" >= $2
      AND "createdAt" <= $3
      AND status = 'COMPLETED'
    GROUP BY ${groupByExpression}
    ORDER BY ${orderByExpression}
  `

  // Query refunds grouped by period
  const refundsQuery = `
    SELECT
      ${groupByExpression} as period,
      COALESCE(SUM(amount), 0) as refunds
    FROM "Payment"
    WHERE "venueId" = $1
      AND "createdAt" >= $2
      AND "createdAt" <= $3
      AND status = 'REFUNDED'
    GROUP BY ${groupByExpression}
    ORDER BY ${orderByExpression}
  `

  // Query deferred sales grouped by period
  const deferredQuery = `
    SELECT
      ${groupByExpression} as period,
      COALESCE(SUM("remainingBalance"), 0) as deferred_sales
    FROM "Order"
    WHERE "venueId" = $1
      AND "createdAt" >= $2
      AND "createdAt" <= $3
      AND status NOT IN ('CANCELLED')
      AND "paymentStatus" IN ('PENDING', 'PARTIAL')
    GROUP BY ${groupByExpression}
    ORDER BY ${orderByExpression}
  `

  // Query platform fees (Avoqado fees) grouped by period
  const platformFeesQuery = `
    SELECT
      ${groupByExpression} as period,
      COALESCE(SUM("feeAmount"), 0) as platform_fees
    FROM "VenueTransaction"
    WHERE "venueId" = $1
      AND "createdAt" >= $2
      AND "createdAt" <= $3
    GROUP BY ${groupByExpression}
    ORDER BY ${orderByExpression}
  `

  // Query staff commissions grouped by period
  const staffCommissionsQuery = `
    SELECT
      ${groupByExpression} as period,
      COALESCE(SUM("netCommission"), 0) as staff_commissions
    FROM "CommissionCalculation"
    WHERE "venueId" = $1
      AND "createdAt" >= $2
      AND "createdAt" <= $3
      AND status != 'VOIDED'
    GROUP BY ${groupByExpression}
    ORDER BY ${orderByExpression}
  `

  // Execute all queries in parallel
  const [orderMetrics, paymentMetrics, refundsMetrics, deferredMetrics, platformFeesMetrics, staffCommissionsMetrics] = await Promise.all([
    prisma.$queryRawUnsafe<Array<{ period: Date | number; gross_sales: number; taxes: number; discounts: number; order_count: bigint }>>(
      orderMetricsQuery,
      venueId,
      startDate,
      endDate,
    ),
    prisma.$queryRawUnsafe<Array<{ period: Date | number; payment_amount: number; tips: number; transaction_count: bigint }>>(
      paymentMetricsQuery,
      venueId,
      startDate,
      endDate,
    ),
    prisma.$queryRawUnsafe<Array<{ period: Date | number; refunds: number }>>(refundsQuery, venueId, startDate, endDate),
    prisma.$queryRawUnsafe<Array<{ period: Date | number; deferred_sales: number }>>(deferredQuery, venueId, startDate, endDate),
    prisma.$queryRawUnsafe<Array<{ period: Date | number; platform_fees: number }>>(platformFeesQuery, venueId, startDate, endDate),
    prisma.$queryRawUnsafe<Array<{ period: Date | number; staff_commissions: number }>>(staffCommissionsQuery, venueId, startDate, endDate),
  ])

  // Create maps for quick lookup
  // Use String(Number()) to normalize Decimal/BigInt types from PostgreSQL
  const paymentMap = new Map(paymentMetrics.map(p => [String(Number(p.period)), p]))
  const refundsMap = new Map(refundsMetrics.map(r => [String(Number(r.period)), r]))
  const deferredMap = new Map(deferredMetrics.map(d => [String(Number(d.period)), d]))
  const platformFeesMap = new Map(platformFeesMetrics.map(c => [String(Number(c.period)), c]))
  const staffCommissionsMap = new Map(staffCommissionsMetrics.map(c => [String(Number(c.period)), c]))
  const orderMetricsMap = new Map(orderMetrics.map(o => [String(Number(o.period)), o]))

  // Debug logging for dailySum/hourlySum
  if (reportType === 'dailySum' || reportType === 'hourlySum') {
    logger.info(`[SalesSummary] ${reportType} orderMetrics keys:`, Array.from(orderMetricsMap.keys()))
    logger.info(
      `[SalesSummary] ${reportType} orderMetrics values:`,
      orderMetrics.map(o => ({ period: o.period, gross_sales: o.gross_sales })),
    )
  }

  // Generate all periods for summary report types (fill zeros for missing periods)
  const allPeriods = generateAllPeriods(reportType)

  // Combine metrics by period - use allPeriods for summary types, orderMetrics for others
  const periodsToProcess = allPeriods.length > 0 ? allPeriods : orderMetrics.map(o => o.period)

  const result: TimePeriodMetrics[] = periodsToProcess.map(periodValue => {
    const periodKey = String(Number(periodValue))
    const order = orderMetricsMap.get(periodKey)
    const payment = paymentMap.get(periodKey)
    const refund = refundsMap.get(periodKey)
    const deferred = deferredMap.get(periodKey)
    const platformFee = platformFeesMap.get(periodKey)
    const staffCommission = staffCommissionsMap.get(periodKey)

    const grossSales = Number(order?.gross_sales || 0)
    const discounts = Number(order?.discounts || 0)
    const refunds = Number(refund?.refunds || 0)
    const taxes = Number(order?.taxes || 0)
    const tips = Number(payment?.tips || 0)
    const platformFees = Number(platformFee?.platform_fees || 0)
    const staffCommissions = Number(staffCommission?.staff_commissions || 0)
    const deferredSales = Number(deferred?.deferred_sales || 0)
    const netSales = grossSales - discounts - refunds
    // Mexico model: taxes are already included in prices, NOT added on top
    // Total Collected = Net Sales + Tips - Platform Fees (actual cash flow)
    const totalCollected = netSales + tips - platformFees
    // Net Profit = Net Sales - Platform Fees - Staff Commissions (true profit)
    const netProfit = netSales - platformFees - staffCommissions

    return {
      period: formatPeriod(periodValue, reportType, timezone),
      periodLabel: formatPeriodLabel(periodValue, reportType, timezone),
      metrics: {
        grossSales,
        items: grossSales, // Simplified - using grossSales as items proxy
        serviceCosts: 0,
        discounts,
        refunds,
        netSales,
        deferredSales,
        taxes,
        tips,
        platformFees,
        staffCommissions,
        commissions: platformFees, // Legacy field for backwards compatibility
        totalCollected,
        netProfit,
        transactionCount: Number(payment?.transaction_count || 0),
      },
    }
  })

  return result
}

/**
 * Generate all periods for summary report types (to show $0 for missing periods)
 */
function generateAllPeriods(reportType: ReportType): number[] {
  switch (reportType) {
    case 'hourlySum':
      // All 24 hours: 0-23
      return Array.from({ length: 24 }, (_, i) => i)
    case 'dailySum':
      // All 7 days: 0=Sunday to 6=Saturday
      return Array.from({ length: 7 }, (_, i) => i)
    default:
      // For other report types, return empty (use actual data)
      return []
  }
}

/**
 * Format period value for API response
 */
function formatPeriod(period: Date | number, reportType: ReportType, _timezone: string): string {
  if (reportType === 'hourlySum') {
    // Hour of day (0-23)
    return String(period).padStart(2, '0') + ':00'
  }
  if (reportType === 'dailySum') {
    // Day of week (0=Sunday)
    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
    return days[Number(period)] || String(period)
  }
  // ISO date string for time-based periods
  if (period instanceof Date) {
    return period.toISOString()
  }
  return String(period)
}

/**
 * Format human-readable period label
 */
function formatPeriodLabel(period: Date | number, reportType: ReportType, timezone: string): string {
  if (reportType === 'hourlySum') {
    const hour = Number(period)
    const suffix = hour >= 12 ? 'PM' : 'AM'
    const displayHour = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour
    return `${displayHour}:00 ${suffix}`
  }
  if (reportType === 'dailySum') {
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
    return days[Number(period)] || String(period)
  }
  if (period instanceof Date) {
    // Format based on report type
    const options: Intl.DateTimeFormatOptions = { timeZone: timezone }
    switch (reportType) {
      case 'hours':
        options.hour = '2-digit'
        options.minute = '2-digit'
        options.day = 'numeric'
        options.month = 'short'
        break
      case 'days':
        options.weekday = 'short'
        options.day = 'numeric'
        options.month = 'short'
        break
      case 'weeks':
        options.day = 'numeric'
        options.month = 'short'
        break
      case 'months':
        options.month = 'long'
        options.year = 'numeric'
        break
    }
    return period.toLocaleDateString('es-MX', options)
  }
  return String(period)
}
