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

import { Prisma } from '@prisma/client'

import logger from '@/config/logger'
import { BadRequestError } from '@/errors/AppError'
import prisma from '@/utils/prismaClient'
import { sanitizeTimezone } from '@/utils/sanitizeTimezone'

// ============================================================
// Types
// ============================================================

export interface SalesSummaryMetrics {
  // Order-derived metrics — null when filtering by paymentMethod/cardType
  // because Order rows can't be reliably split across payment buckets
  // (a single Order may be paid by multiple Payments with different methods).
  grossSales: number | null
  items: number | null
  serviceCosts: number | null
  discounts: number | null
  refunds: number
  netSales: number | null
  deferredSales: number | null
  taxes: number | null
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

export interface PaymentMethodDetailedBreakdown {
  bucket: 'CARD' | 'CASH' | 'OTHER' | 'QR_LEGACY'
  amount: number
  count: number
  percentage: number
  tips: number
  refunds: number
  platformFees: number
  subBuckets?: Array<{
    type: 'CREDIT' | 'DEBIT' | 'AMEX' | 'INTERNATIONAL'
    amount: number
    count: number
    percentage: number
    platformFees: number
  }>
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
  byPaymentMethodDetailed?: PaymentMethodDetailedBreakdown[]
  byPeriod?: TimePeriodMetrics[] // Time-based breakdown
  filtered: boolean
}

export type ReportType = 'summary' | 'hours' | 'days' | 'weeks' | 'months' | 'hourlySum' | 'dailySum'

export type PaymentMethodFilter = 'CASH' | 'CARD' | 'QR_LEGACY' | 'OTHER'
export type CardTypeFilter = 'CREDIT' | 'DEBIT' | 'AMEX' | 'INTERNATIONAL'

export interface SalesSummaryFilters {
  startDate: string
  endDate: string
  groupBy?: 'none' | 'paymentMethod'
  reportType?: ReportType
  timezone?: string
  merchantAccountId?: string
  paymentMethod?: PaymentMethodFilter
  cardType?: CardTypeFilter
}

// ============================================================
// Payment Filter Helpers
// ============================================================

/**
 * Build a Prisma where fragment narrowing payments to a single method/card-type
 * bucket. Mirrors the canonical mapping in `transactionCost.service.ts`
 * (`determineTransactionCardType`) so a payment that counts as AMEX here
 * counts as AMEX everywhere else.
 *
 * QR_LEGACY is handled outside Prisma — see the short-circuit in
 * getSalesSummary. We throw here as defense-in-depth so any direct caller
 * (e.g. a test) gets a clear failure instead of silent zero rows.
 */
export function buildPaymentWhereFilter(
  paymentMethod?: PaymentMethodFilter,
  cardType?: CardTypeFilter,
): Prisma.PaymentWhereInput {
  if (!paymentMethod) return {}

  if (paymentMethod === 'CASH') return { method: 'CASH' }

  if (paymentMethod === 'OTHER') {
    return { method: { in: ['DIGITAL_WALLET', 'BANK_TRANSFER', 'CRYPTOCURRENCY', 'OTHER'] } }
  }

  if (paymentMethod === 'QR_LEGACY') {
    throw new Error('QR_LEGACY should be short-circuited by getSalesSummary, not reach the filter builders')
  }

  // paymentMethod === 'CARD'
  if (!cardType) {
    return { method: { in: ['CREDIT_CARD', 'DEBIT_CARD'] } }
  }

  if (cardType === 'INTERNATIONAL') {
    return {
      method: { in: ['CREDIT_CARD', 'DEBIT_CARD'] },
      processorData: { path: ['isInternational'], equals: true },
    }
  }

  if (cardType === 'AMEX') {
    return {
      method: { in: ['CREDIT_CARD', 'DEBIT_CARD'] },
      cardBrand: 'AMERICAN_EXPRESS',
      NOT: { processorData: { path: ['isInternational'], equals: true } },
    }
  }

  // CREDIT or DEBIT — exclude AMEX brand and exclude international flag
  return {
    method: cardType === 'CREDIT' ? 'CREDIT_CARD' : 'DEBIT_CARD',
    cardBrand: { not: 'AMERICAN_EXPRESS' },
    NOT: { processorData: { path: ['isInternational'], equals: true } },
  }
}

/**
 * SQL twin for raw-SQL queries. Returns " AND <clause>" or "" if no filter.
 * `columnPrefix` is the table alias (e.g. 'p' for "p.method").
 */
export function buildPaymentSqlClause(
  paymentMethod: PaymentMethodFilter | undefined,
  cardType: CardTypeFilter | undefined,
  columnPrefix = '',
): string {
  if (!paymentMethod) return ''

  const c = columnPrefix ? `${columnPrefix}.` : ''
  const pdJson = `${c}"processorData"`
  const pdIsIntl = `(${pdJson}->>'isInternational')::boolean = true`
  const pdNotIntl = `(${pdJson} IS NULL OR (${pdJson}->>'isInternational') IS NULL OR (${pdJson}->>'isInternational')::boolean = false)`

  if (paymentMethod === 'CASH') return ` AND ${c}method = 'CASH'`
  if (paymentMethod === 'OTHER') return ` AND ${c}method IN ('DIGITAL_WALLET','BANK_TRANSFER','CRYPTOCURRENCY','OTHER')`
  if (paymentMethod === 'QR_LEGACY') {
    throw new Error('QR_LEGACY should be short-circuited by getSalesSummary, not reach the filter builders')
  }

  // CARD
  if (!cardType) return ` AND ${c}method IN ('CREDIT_CARD','DEBIT_CARD')`
  if (cardType === 'INTERNATIONAL') return ` AND ${c}method IN ('CREDIT_CARD','DEBIT_CARD') AND ${pdIsIntl}`
  if (cardType === 'AMEX') return ` AND ${c}method IN ('CREDIT_CARD','DEBIT_CARD') AND ${c}"cardBrand" = 'AMERICAN_EXPRESS' AND ${pdNotIntl}`

  const method = cardType === 'CREDIT' ? 'CREDIT_CARD' : 'DEBIT_CARD'
  return ` AND ${c}method = '${method}' AND (${c}"cardBrand" IS NULL OR ${c}"cardBrand" <> 'AMERICAN_EXPRESS') AND ${pdNotIntl}`
}

// ============================================================
// Main Service Function
// ============================================================

/**
 * Get sales summary for a venue within a date range
 */
export async function getSalesSummary(venueId: string, filters: SalesSummaryFilters): Promise<SalesSummaryResponse> {
  const {
    startDate,
    endDate,
    groupBy = 'none',
    reportType = 'summary',
    timezone = 'America/Mexico_City',
    merchantAccountId,
    paymentMethod,
    cardType,
  } = filters

  // Validate dates
  const parsedStartDate = new Date(startDate)
  const parsedEndDate = new Date(endDate)

  if (isNaN(parsedStartDate.getTime())) {
    throw new BadRequestError(`Invalid startDate: ${startDate}`)
  }
  if (isNaN(parsedEndDate.getTime())) {
    throw new BadRequestError(`Invalid endDate: ${endDate}`)
  }

  // When a payment-method filter is active, order-derived metrics become
  // misleading (a single order can be paid by mixed methods). We compute only
  // payment-derived metrics and return null for grossSales/items/discounts/
  // taxes/deferred — frontend hides those rows.
  const isFiltered = !!paymentMethod

  // QR_LEGACY short-circuit. Phase 3 will replace this with the actual
  // legacy QR merge for MindForm; until then, return a zeroed shell so we
  // don't issue 8 native queries that the buildPaymentWhereFilter sentinel
  // would force to return zero rows.
  if (paymentMethod === 'QR_LEGACY') {
    const zeroSummary: SalesSummaryMetrics = {
      grossSales: null,
      items: null,
      serviceCosts: null,
      discounts: null,
      refunds: 0,
      netSales: null,
      deferredSales: null,
      taxes: null,
      tips: 0,
      platformFees: 0,
      staffCommissions: 0,
      commissions: 0,
      totalCollected: 0,
      netProfit: 0,
      transactionCount: 0,
    }
    return {
      dateRange: { startDate: parsedStartDate, endDate: parsedEndDate },
      reportType,
      summary: zeroSummary,
      filtered: true,
    }
  }

  const paymentWhereFilter = buildPaymentWhereFilter(paymentMethod, cardType)
  const paymentLevelFilter = { ...(merchantAccountId ? { merchantAccountId } : {}), ...paymentWhereFilter }

  logger.info('Calculating sales summary', { venueId, startDate, endDate, groupBy, merchantAccountId, paymentMethod, cardType })

  // Base date filter for orders
  const dateFilter = {
    createdAt: {
      gte: parsedStartDate,
      lte: parsedEndDate,
    },
  }

  // When filtering by merchant, we scope orders to only those that have at
  // least one Payment linked to the target merchantAccountId.
  const merchantOrderFilter = merchantAccountId ? { payments: { some: { merchantAccountId } } } : {}

  // Payment-level merchant filter
  const merchantPaymentFilter = merchantAccountId ? { merchantAccountId } : {}

  // Kick off the filtered payment-volume query in parallel with the rest of
  // the core-metric awaits below. We need this number only when deriving
  // totalCollected/netProfit under a filter; awaiting at the derived-metrics
  // block lets the other 8 queries run concurrently with this one.
  const paymentVolumeForFilteredPromise: Promise<number> = isFiltered
    ? prisma.payment
        .aggregate({
          where: { venueId, ...dateFilter, status: 'COMPLETED', ...paymentLevelFilter },
          _sum: { amount: true },
        })
        .then(r => Number(r._sum.amount || 0))
    : Promise.resolve(0)

  // ============================================================
  // Calculate Core Metrics
  // ============================================================

  // 1. Gross Sales - Total from valid orders (exclude drafts, cancelled, deleted, refunded)
  // Skipped under a payment-method filter — orders can't be honestly split per bucket.
  const grossSalesResult = !isFiltered
    ? await prisma.order.aggregate({
        where: {
          venueId,
          ...dateFilter,
          status: { notIn: ['PENDING', 'CANCELLED', 'DELETED'] },
          paymentStatus: { notIn: ['REFUNDED'] },
          ...merchantOrderFilter,
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
    : null

  // 2. Items - Using Order.subtotal (more reliable than OrderItem aggregation
  // because some orders synced from POS don't have OrderItem records)
  // NOTE: items = grossSalesResult._sum.subtotal (already queried above)

  // 3. Refunds — sum of refund Payments (type=REFUND, status=COMPLETED).
  // The legacy query filtered `status='REFUNDED'` which matched a handful of
  // pre-sprint hack records (original Payments flipped to status=REFUNDED with
  // a negative amount) and missed every real refund since the 2026-04 refund
  // sprint, which creates Payments with type=REFUND, status=COMPLETED, negative
  // amount and negative tipAmount (post-2026-04-19 tip split fix).
  const refundsResult = await prisma.payment.aggregate({
    where: {
      venueId,
      ...dateFilter,
      type: 'REFUND',
      ...paymentLevelFilter,
    },
    _sum: {
      amount: true,
      tipAmount: true,
    },
    _count: true,
  })

  // 4. Deferred Sales - Orders with PENDING or PARTIAL payment status
  // Skipped under a payment-method filter (order-derived).
  const deferredResult = !isFiltered
    ? await prisma.order.aggregate({
        where: {
          venueId,
          ...dateFilter,
          status: { notIn: ['PENDING', 'CANCELLED', 'DELETED'] },
          paymentStatus: { in: ['PENDING', 'PARTIAL'] },
          ...merchantOrderFilter,
        },
        _sum: {
          remainingBalance: true,
        },
        _count: true,
      })
    : null

  // 5. Tips - From completed payments (more accurate than order tips)
  const tipsResult = await prisma.payment.aggregate({
    where: {
      venueId,
      ...dateFilter,
      status: 'COMPLETED',
      ...paymentLevelFilter,
    },
    _sum: {
      tipAmount: true,
    },
  })

  // 6. Platform Fees (Avoqado fees) - From TransactionCost.venueChargeAmount
  // (joined via Payment because TransactionCost has no venueId column).
  // VenueTransaction.feeAmount is currently not synced from TransactionCost,
  // so reading the canonical value from TransactionCost avoids reporting $0.
  // The payment-method clause is appended as a SQL fragment from
  // buildPaymentSqlClause — only enum-derived literals (CASH/CREDIT_CARD/etc),
  // never user-supplied strings, so it is safe to concatenate.
  const platformFeesSqlClause = buildPaymentSqlClause(paymentMethod, cardType, 'p')
  const platformFeesMerchantClause = merchantAccountId ? ' AND p."merchantAccountId" = $4' : ''
  const platformFeesQuery = `
    SELECT COALESCE(SUM(tc."venueChargeAmount"), 0)::float AS sum_fee
    FROM "TransactionCost" tc
    JOIN "Payment" p ON p.id = tc."paymentId"
    WHERE p."venueId" = $1
      AND p."createdAt" >= $2
      AND p."createdAt" <= $3
      ${platformFeesMerchantClause}
      ${platformFeesSqlClause}
  `
  const platformFeesParams: Array<string | Date> = merchantAccountId
    ? [venueId, parsedStartDate, parsedEndDate, merchantAccountId]
    : [venueId, parsedStartDate, parsedEndDate]
  const platformFeesRows = await prisma.$queryRawUnsafe<Array<{ sum_fee: number }>>(platformFeesQuery, ...platformFeesParams)

  // 7. Staff Commissions (paid to employees) - From CommissionCalculation
  // CommissionCalculation has paymentId → Payment.merchantAccountId for filtering
  const hasPaymentFilter = !!merchantAccountId || isFiltered
  const staffCommissionsResult = await prisma.commissionCalculation.aggregate({
    where: {
      venueId,
      createdAt: dateFilter.createdAt,
      status: { not: 'VOIDED' },
      ...(hasPaymentFilter ? { payment: paymentLevelFilter } : {}),
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
      ...paymentLevelFilter,
    },
  })

  // ============================================================
  // Calculate Derived Metrics
  // ============================================================

  // Order-derived metrics — null when filtering by paymentMethod/cardType so
  // the frontend hides the rows rather than showing meaningless values.
  // Gross Sales = Item subtotals (Order.subtotal) + service costs
  // Does NOT include taxes or tips (those are shown separately)
  // This follows standard accounting where taxes are pass-through, not revenue
  const grossSales = grossSalesResult ? Number(grossSalesResult._sum.subtotal || 0) : null
  const items = grossSalesResult ? Number(grossSalesResult._sum.subtotal || 0) : null
  const discounts = grossSalesResult ? Number(grossSalesResult._sum.discountAmount || 0) : null
  const taxes = grossSalesResult ? Number(grossSalesResult._sum.taxAmount || 0) : null
  const deferredSales = deferredResult ? Number(deferredResult._sum.remainingBalance || 0) : null
  // Service costs = any revenue beyond item sales (delivery fees, service charges, etc.)
  // Currently no separate serviceCharge field in Order schema, so this is derived
  const serviceCosts = grossSalesResult ? 0 : null

  // Payment-derived metrics — always computed (filter or not).
  // Refund amounts are stored negative on Payment.amount/tipAmount. Sum both so
  // the total includes the tip portion (tip split fix 2026-04-19), take abs so
  // downstream consumers treat "refunds" as a positive magnitude.
  const refunds = Math.abs(Number(refundsResult._sum.amount || 0) + Number(refundsResult._sum.tipAmount || 0))
  const tips = Number(tipsResult._sum.tipAmount || 0)
  const platformFees = Number(platformFeesRows[0]?.sum_fee || 0)
  const staffCommissions = Number(staffCommissionsResult._sum.netCommission || 0)

  // Net Sales = Gross Sales - Discounts - Refunds (null when filtered)
  const netSales = grossSales !== null && discounts !== null ? grossSales - discounts - refunds : null

  // Under filter, derive totalCollected and netProfit from filtered payment
  // volume directly (Payment.amount sum) rather than from netSales. The
  // promise was kicked off near the top of the function so it runs in
  // parallel with the other core-metric queries.
  const paymentVolumeForFiltered = await paymentVolumeForFilteredPromise

  // Total Collected = Net Sales + Tips - Platform Fees
  // Mexico model: taxes are already included in prices, NOT added on top
  // This represents the actual cash flow (money in account after platform fees)
  const totalCollected = isFiltered
    ? paymentVolumeForFiltered + tips - platformFees
    : netSales !== null
      ? netSales + tips - platformFees
      : 0

  // Net Profit = Net Sales - Platform Fees - Staff Commissions
  // This is the true profit after all costs to the venue
  // Note: Tips are NOT subtracted here because they are pass-through to employees
  const netProfit = isFiltered
    ? paymentVolumeForFiltered - platformFees - staffCommissions
    : netSales !== null
      ? netSales - platformFees - staffCommissions
      : 0

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

  // Skip breakdown under filter — the user already drilled in to one bucket,
  // a single-row breakdown adds no information.
  if (groupBy === 'paymentMethod' && !isFiltered) {
    const paymentsByMethod = await prisma.payment.groupBy({
      by: ['method'],
      where: {
        venueId,
        ...dateFilter,
        status: 'COMPLETED',
        ...merchantPaymentFilter,
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
    byPeriod = await calculateTimePeriodMetrics(
      venueId,
      parsedStartDate,
      parsedEndDate,
      reportType,
      timezone,
      merchantAccountId,
      paymentMethod,
      cardType,
    )
  }

  logger.info('Sales summary calculated', {
    venueId,
    grossSales,
    netSales,
    transactionCount: transactionCountResult,
    reportType,
    periodsCount: byPeriod?.length,
    filtered: isFiltered,
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
    filtered: isFiltered,
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
  merchantAccountId?: string,
  paymentMethod?: PaymentMethodFilter,
  cardType?: CardTypeFilter,
): Promise<TimePeriodMetrics[]> {
  // When a payment-method filter is active, order-derived metrics (gross/items/
  // discounts/taxes/deferred) become null and the corresponding raw queries are
  // skipped. Payment-derived queries get the SQL clause appended.
  const isFiltered = !!paymentMethod
  const paymentSqlClause = buildPaymentSqlClause(paymentMethod, cardType)
  const paymentSqlClauseWithPrefix = buildPaymentSqlClause(paymentMethod, cardType, 'p')

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

  // Optional merchant filter clause for raw SQL queries
  const merchantPaymentClause = merchantAccountId ? `AND "merchantAccountId" = $4` : ''
  const merchantOrderClause = merchantAccountId ? `AND id IN (SELECT "orderId" FROM "Payment" WHERE "merchantAccountId" = $4)` : ''
  const merchantPlatformClause = merchantAccountId ? `AND p."merchantAccountId" = $4` : ''
  const merchantCommissionClause = merchantAccountId ? `AND "paymentId" IN (SELECT id FROM "Payment" WHERE "merchantAccountId" = $4)` : ''

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
      ${merchantOrderClause}
    GROUP BY ${groupByExpression}
    ORDER BY ${orderByExpression}
  `

  // Query payment metrics grouped by period — payment-method clause appended
  // before GROUP BY so the filter narrows rows, not groups.
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
      ${merchantPaymentClause}
      ${paymentSqlClause}
    GROUP BY ${groupByExpression}
    ORDER BY ${orderByExpression}
  `

  // Query refunds grouped by period — REFUND Payments have negative amount and
  // (since 2026-04-19) negative tipAmount. Use ABS so "refunds" is a positive
  // magnitude matching the consumer contract of the non-raw aggregate above.
  const refundsQuery = `
    SELECT
      ${groupByExpression} as period,
      COALESCE(SUM(ABS(amount) + ABS("tipAmount")), 0) as refunds
    FROM "Payment"
    WHERE "venueId" = $1
      AND "createdAt" >= $2
      AND "createdAt" <= $3
      AND type = 'REFUND'
      ${merchantPaymentClause}
      ${paymentSqlClause}
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
      ${merchantOrderClause}
    GROUP BY ${groupByExpression}
    ORDER BY ${orderByExpression}
  `

  // Query platform fees (Avoqado fees) grouped by period.
  // Source: TransactionCost.venueChargeAmount joined to Payment for venueId/date.
  // VenueTransaction.feeAmount is not currently synced from TransactionCost.
  const platformFeesGroupBy = groupByExpression.replace(/"createdAt"/g, 'p."createdAt"')
  const platformFeesOrderBy = orderByExpression.replace(/"createdAt"/g, 'p."createdAt"')
  const platformFeesQuery = `
    SELECT
      ${platformFeesGroupBy} as period,
      COALESCE(SUM(tc."venueChargeAmount"), 0) as platform_fees
    FROM "TransactionCost" tc
    JOIN "Payment" p ON p.id = tc."paymentId"
    WHERE p."venueId" = $1
      AND p."createdAt" >= $2
      AND p."createdAt" <= $3
      ${merchantPlatformClause}
      ${paymentSqlClauseWithPrefix}
    GROUP BY ${platformFeesGroupBy}
    ORDER BY ${platformFeesOrderBy}
  `

  // Query staff commissions grouped by period
  // When a payment-method filter is active, also constrain the inner Payment
  // subquery so only commissions for matching payments are aggregated.
  const staffCommissionsPaymentInnerClause = isFiltered ? buildPaymentSqlClause(paymentMethod, cardType) : ''
  const staffCommissionsPaymentSubquery = isFiltered
    ? `AND "paymentId" IN (SELECT id FROM "Payment" WHERE "venueId" = $1 ${staffCommissionsPaymentInnerClause})`
    : ''
  const staffCommissionsQuery = `
    SELECT
      ${groupByExpression} as period,
      COALESCE(SUM("netCommission"), 0) as staff_commissions
    FROM "CommissionCalculation"
    WHERE "venueId" = $1
      AND "createdAt" >= $2
      AND "createdAt" <= $3
      AND status != 'VOIDED'
      ${merchantCommissionClause}
      ${staffCommissionsPaymentSubquery}
    GROUP BY ${groupByExpression}
    ORDER BY ${orderByExpression}
  `

  // Execute all queries in parallel
  // When merchantAccountId is provided, it becomes the 4th parameter ($4) for all queries
  const queryParams: [string, Date, Date, ...string[]] = merchantAccountId
    ? [venueId, startDate, endDate, merchantAccountId]
    : [venueId, startDate, endDate]

  // Under a payment-method filter, skip order-derived queries entirely — their
  // results would be misleading because a single order can't be split per method.
  const [orderMetrics, paymentMetrics, refundsMetrics, deferredMetrics, platformFeesMetrics, staffCommissionsMetrics] = await Promise.all([
    isFiltered
      ? Promise.resolve(
          [] as Array<{ period: Date | number; gross_sales: number; taxes: number; discounts: number; order_count: bigint }>,
        )
      : prisma.$queryRawUnsafe<
          Array<{ period: Date | number; gross_sales: number; taxes: number; discounts: number; order_count: bigint }>
        >(orderMetricsQuery, ...queryParams),
    prisma.$queryRawUnsafe<Array<{ period: Date | number; payment_amount: number; tips: number; transaction_count: bigint }>>(
      paymentMetricsQuery,
      ...queryParams,
    ),
    prisma.$queryRawUnsafe<Array<{ period: Date | number; refunds: number }>>(refundsQuery, ...queryParams),
    isFiltered
      ? Promise.resolve([] as Array<{ period: Date | number; deferred_sales: number }>)
      : prisma.$queryRawUnsafe<Array<{ period: Date | number; deferred_sales: number }>>(deferredQuery, ...queryParams),
    prisma.$queryRawUnsafe<Array<{ period: Date | number; platform_fees: number }>>(platformFeesQuery, ...queryParams),
    prisma.$queryRawUnsafe<Array<{ period: Date | number; staff_commissions: number }>>(staffCommissionsQuery, ...queryParams),
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

  // Combine metrics by period — use allPeriods for summary types, otherwise
  // drive from whichever metric source has rows (payment under filter; order
  // metrics in the default path).
  const periodsToProcess =
    allPeriods.length > 0 ? allPeriods : isFiltered ? paymentMetrics.map(p => p.period) : orderMetrics.map(o => o.period)

  const result: TimePeriodMetrics[] = periodsToProcess.map(periodValue => {
    const periodKey = String(Number(periodValue))
    const order = orderMetricsMap.get(periodKey)
    const payment = paymentMap.get(periodKey)
    const refund = refundsMap.get(periodKey)
    const deferred = deferredMap.get(periodKey)
    const platformFee = platformFeesMap.get(periodKey)
    const staffCommission = staffCommissionsMap.get(periodKey)

    // Order-derived metrics are null when filtered (order rows can't be honestly
    // split per payment bucket).
    const grossSales = isFiltered ? null : Number(order?.gross_sales || 0)
    const discounts = isFiltered ? null : Number(order?.discounts || 0)
    const taxes = isFiltered ? null : Number(order?.taxes || 0)
    const deferredSales = isFiltered ? null : Number(deferred?.deferred_sales || 0)

    // Payment-derived metrics are always present.
    const refunds = Number(refund?.refunds || 0)
    const tips = Number(payment?.tips || 0)
    const platformFees = Number(platformFee?.platform_fees || 0)
    const staffCommissions = Number(staffCommission?.staff_commissions || 0)
    const paymentAmount = Number(payment?.payment_amount || 0)

    const netSales = grossSales !== null && discounts !== null ? grossSales - discounts - refunds : null

    // Mexico model: taxes are already included in prices, NOT added on top
    // Total Collected = Net Sales + Tips - Platform Fees (actual cash flow)
    // Under filter, derive from filtered payment volume directly.
    const totalCollected = isFiltered
      ? paymentAmount + tips - platformFees
      : netSales !== null
        ? netSales + tips - platformFees
        : 0
    // Net Profit = Net Sales - Platform Fees - Staff Commissions (true profit)
    const netProfit = isFiltered
      ? paymentAmount - platformFees - staffCommissions
      : netSales !== null
        ? netSales - platformFees - staffCommissions
        : 0

    return {
      period: formatPeriod(periodValue, reportType, timezone),
      periodLabel: formatPeriodLabel(periodValue, reportType, timezone),
      metrics: {
        grossSales,
        items: grossSales, // Simplified - using grossSales as items proxy
        // serviceCosts: schema has no service-charge column yet; surface 0 when an
        // order exists, null when order metrics are skipped under filter.
        serviceCosts: grossSales !== null ? 0 : null,
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
