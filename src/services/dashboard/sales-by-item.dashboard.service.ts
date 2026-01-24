/**
 * Sales by Item Dashboard Service
 *
 * Calculates item-level sales metrics for venues.
 * Used by the Sales by Item report in the dashboard.
 *
 * Metrics per item:
 * - itemsSold: Count of OrderItem records (transactions)
 * - unitsSold: Sum of OrderItem.quantity
 * - grossSales: Sum of (unitPrice * quantity)
 * - discounts: Sum of discountAmount
 * - netSales: grossSales - discounts
 * - refunds: From refunded orders (tracked separately)
 */

import logger from '@/config/logger'
import { BadRequestError } from '@/errors/AppError'
import prisma from '@/utils/prismaClient'

// ============================================================
// Types
// ============================================================

export type ReportType = 'summary' | 'hours' | 'days' | 'weeks' | 'months' | 'hourlySum' | 'dailySum'

export type GroupByOption = 'none' | 'category' | 'channel' | 'paymentMethod' | 'device' | 'source' | 'serviceOption' | 'itemType'

export interface SalesByItemFilters {
  startDate: string
  endDate: string
  reportType?: ReportType
  groupBy?: GroupByOption
  timezone?: string
  // Hour range filter (optional) - Format: "HH:mm"
  startHour?: string // e.g. "09:00"
  endHour?: string // e.g. "17:00"
  // Optional filters
  categoryId?: string
  productId?: string
  channel?: string
  paymentMethod?: string
}

export interface ItemSalesMetrics {
  productId: string | null
  productName: string
  productSku: string | null
  categoryName: string | null
  unit: string // 'c/u' (cada uno) or 'ea' (each)
  itemsSold: number // COUNT of OrderItems
  unitsSold: number // SUM of quantity
  grossSales: number // SUM of (unitPrice * quantity)
  discounts: number // SUM of discountAmount
  netSales: number // grossSales - discounts
}

export interface TimePeriodItemMetrics {
  period: string
  periodLabel?: string
  grossSales: number
  itemsSold: number
}

export interface SalesByItemResponse {
  dateRange: {
    startDate: Date
    endDate: Date
  }
  reportType: ReportType
  items: ItemSalesMetrics[]
  byPeriod?: TimePeriodItemMetrics[]
  totals: {
    itemsSold: number
    unitsSold: number
    grossSales: number
    discounts: number
    netSales: number
  }
}

// ============================================================
// Main Service Function
// ============================================================

/**
 * Get sales by item for a venue within a date range
 */
export async function getSalesByItem(venueId: string, filters: SalesByItemFilters): Promise<SalesByItemResponse> {
  const { startDate, endDate, reportType = 'summary', groupBy = 'none', timezone = 'America/Mexico_City', startHour, endHour } = filters

  // Validate dates
  const parsedStartDate = new Date(startDate)
  const parsedEndDate = new Date(endDate)

  if (isNaN(parsedStartDate.getTime())) {
    throw new BadRequestError(`Invalid startDate: ${startDate}`)
  }
  if (isNaN(parsedEndDate.getTime())) {
    throw new BadRequestError(`Invalid endDate: ${endDate}`)
  }

  logger.info('Calculating sales by item', { venueId, startDate, endDate, reportType, groupBy, startHour, endHour })

  // ============================================================
  // Query Item Sales Aggregation
  // ============================================================

  // Build query based on groupBy option
  const { selectFields, groupByFields, orderByField } = buildGroupByClause(groupBy)

  // Add Payment JOIN only when grouping by paymentMethod
  const paymentJoin = groupBy === 'paymentMethod' ? 'LEFT JOIN "Payment" pay ON pay."orderId" = o.id' : ''

  // Add Terminal JOIN only when grouping by device
  const terminalJoin = groupBy === 'device' ? 'LEFT JOIN "Terminal" t ON t.id = o."terminalId"' : ''

  // Build hour filter clause if custom hours are provided
  // Filter by hour of day in the venue's timezone
  let hourFilterClause = ''
  if (startHour && endHour) {
    // Parse hours from "HH:mm" format
    const [startH] = startHour.split(':').map(Number)
    const [endH] = endHour.split(':').map(Number)

    if (!isNaN(startH) && !isNaN(endH)) {
      // Filter by hour of day (0-23)
      hourFilterClause = `
        AND EXTRACT(HOUR FROM o."createdAt" AT TIME ZONE '${timezone}') >= ${startH}
        AND EXTRACT(HOUR FROM o."createdAt" AT TIME ZONE '${timezone}') <= ${endH}
      `
    }
  }

  // Main query: aggregate sales by product or grouped dimension
  // Uses denormalized fields (productName, productSku, categoryName) for reliability
  // Some POS-synced orders may not have Product records linked
  const itemSalesQuery = `
    SELECT
      ${selectFields}
      COUNT(oi.id)::integer as items_sold,
      SUM(oi.quantity)::integer as units_sold,
      COALESCE(SUM(oi."unitPrice" * oi.quantity), 0) as gross_sales,
      COALESCE(SUM(oi."discountAmount"), 0) as discounts
    FROM "OrderItem" oi
    INNER JOIN "Order" o ON o.id = oi."orderId"
    LEFT JOIN "Product" p ON p.id = oi."productId"
    LEFT JOIN "MenuCategory" mc ON mc.id = p."categoryId"
    ${paymentJoin}
    ${terminalJoin}
    WHERE o."venueId" = $1
      AND o."createdAt" >= $2
      AND o."createdAt" <= $3
      AND o.status NOT IN ('CANCELLED')
      AND o."paymentStatus" NOT IN ('REFUNDED')
      ${hourFilterClause}
    GROUP BY ${groupByFields}
    ORDER BY ${orderByField} DESC
  `

  const itemSalesResults = await prisma.$queryRawUnsafe<
    Array<{
      productId: string | null
      product_name: string
      product_sku: string | null
      category_name: string | null
      channel: string | null
      payment_method: string | null
      source: string | null
      terminal_id: string | null
      items_sold: number
      units_sold: number
      gross_sales: number
      discounts: number
    }>
  >(itemSalesQuery, venueId, parsedStartDate, parsedEndDate)

  // Transform results based on groupBy
  const items: ItemSalesMetrics[] = itemSalesResults.map(row => {
    const grossSales = Number(row.gross_sales)
    const discounts = Number(row.discounts)

    // Determine display name based on groupBy
    let displayName = row.product_name
    if (groupBy === 'category') {
      displayName = row.category_name || 'Sin categorizar'
    } else if (groupBy === 'channel') {
      displayName = formatChannelName(row.channel)
    } else if (groupBy === 'paymentMethod') {
      displayName = formatPaymentMethodName(row.payment_method)
    } else if (groupBy === 'source') {
      displayName = formatSourceName(row.source)
    } else if (groupBy === 'device') {
      // Device uses Terminal name directly from the query result
      displayName = row.product_name // Already set to t.name or 'Sin terminal asignado'
    }

    return {
      productId: groupBy === 'none' ? row.productId : null,
      productName: displayName,
      productSku: groupBy === 'none' ? row.product_sku : null,
      categoryName: groupBy === 'none' ? row.category_name : null,
      unit: 'c/u',
      itemsSold: Number(row.items_sold),
      unitsSold: Number(row.units_sold),
      grossSales,
      discounts,
      netSales: grossSales - discounts,
    }
  })

  // ============================================================
  // Calculate Totals
  // ============================================================

  const totals = items.reduce(
    (acc, item) => ({
      itemsSold: acc.itemsSold + item.itemsSold,
      unitsSold: acc.unitsSold + item.unitsSold,
      grossSales: acc.grossSales + item.grossSales,
      discounts: acc.discounts + item.discounts,
      netSales: acc.netSales + item.netSales,
    }),
    { itemsSold: 0, unitsSold: 0, grossSales: 0, discounts: 0, netSales: 0 },
  )

  // ============================================================
  // Time-Period Breakdown (for charts)
  // ============================================================

  let byPeriod: TimePeriodItemMetrics[] | undefined

  if (reportType !== 'summary') {
    byPeriod = await calculateTimePeriodItemMetrics(venueId, parsedStartDate, parsedEndDate, reportType, timezone, startHour, endHour)
  }

  logger.info('Sales by item calculated', {
    venueId,
    itemCount: items.length,
    totalGrossSales: totals.grossSales,
    reportType,
    periodsCount: byPeriod?.length,
  })

  return {
    dateRange: {
      startDate: parsedStartDate,
      endDate: parsedEndDate,
    },
    reportType,
    items,
    byPeriod,
    totals,
  }
}

// ============================================================
// Helper: Calculate Time-Period Item Metrics
// ============================================================

/**
 * Calculate item sales metrics grouped by time period (for chart display)
 */
async function calculateTimePeriodItemMetrics(
  venueId: string,
  startDate: Date,
  endDate: Date,
  reportType: ReportType,
  timezone: string,
  startHour?: string,
  endHour?: string,
): Promise<TimePeriodItemMetrics[]> {
  // Determine SQL grouping based on reportType
  let groupByExpression: string
  let orderByExpression: string

  switch (reportType) {
    case 'hours':
      groupByExpression = `DATE_TRUNC('hour', o."createdAt" AT TIME ZONE '${timezone}')`
      orderByExpression = 'period'
      break
    case 'days':
      groupByExpression = `DATE_TRUNC('day', o."createdAt" AT TIME ZONE '${timezone}')`
      orderByExpression = 'period'
      break
    case 'weeks':
      groupByExpression = `DATE_TRUNC('week', o."createdAt" AT TIME ZONE '${timezone}')`
      orderByExpression = 'period'
      break
    case 'months':
      groupByExpression = `DATE_TRUNC('month', o."createdAt" AT TIME ZONE '${timezone}')`
      orderByExpression = 'period'
      break
    case 'hourlySum':
      // Group by hour of day (0-23)
      groupByExpression = `EXTRACT(HOUR FROM o."createdAt" AT TIME ZONE '${timezone}')`
      orderByExpression = 'period'
      break
    case 'dailySum':
      // Group by day of week (0=Sunday, 6=Saturday)
      groupByExpression = `EXTRACT(DOW FROM o."createdAt" AT TIME ZONE '${timezone}')`
      orderByExpression = 'period'
      break
    default:
      return []
  }

  // Build hour filter clause if custom hours are provided
  let hourFilterClause = ''
  if (startHour && endHour) {
    const [startH] = startHour.split(':').map(Number)
    const [endH] = endHour.split(':').map(Number)
    if (!isNaN(startH) && !isNaN(endH)) {
      hourFilterClause = `
        AND EXTRACT(HOUR FROM o."createdAt" AT TIME ZONE '${timezone}') >= ${startH}
        AND EXTRACT(HOUR FROM o."createdAt" AT TIME ZONE '${timezone}') <= ${endH}
      `
    }
  }

  // Query item sales grouped by period
  const periodMetricsQuery = `
    SELECT
      ${groupByExpression} as period,
      COALESCE(SUM(oi."unitPrice" * oi.quantity), 0) as gross_sales,
      COUNT(oi.id)::integer as items_sold
    FROM "OrderItem" oi
    INNER JOIN "Order" o ON o.id = oi."orderId"
    WHERE o."venueId" = $1
      AND o."createdAt" >= $2
      AND o."createdAt" <= $3
      AND o.status NOT IN ('CANCELLED')
      AND o."paymentStatus" NOT IN ('REFUNDED')
      ${hourFilterClause}
    GROUP BY ${groupByExpression}
    ORDER BY ${orderByExpression}
  `

  const periodMetrics = await prisma.$queryRawUnsafe<
    Array<{
      period: Date | number
      gross_sales: number | bigint | { toNumber?: () => number }
      items_sold: number
    }>
  >(periodMetricsQuery, venueId, startDate, endDate)

  // Helper to convert gross_sales to number (handles Decimal/BigInt from Prisma)
  const toNumber = (value: number | bigint | { toNumber?: () => number } | null | undefined): number => {
    if (value === null || value === undefined) return 0
    if (typeof value === 'object' && value.toNumber) return value.toNumber()
    if (typeof value === 'bigint') return Number(value)
    return Number(value)
  }

  // For summary report types (hourlySum, dailySum), fill in missing periods with zeros
  const allPeriods = generateAllPeriods(reportType)

  if (allPeriods.length > 0) {
    // Create map for quick lookup
    const metricsMap = new Map(periodMetrics.map(p => [Number(p.period), p]))

    // Generate result with all periods (filling zeros for missing)
    const result: TimePeriodItemMetrics[] = allPeriods.map(periodValue => {
      const metrics = metricsMap.get(periodValue)
      return {
        period: formatPeriod(periodValue, reportType, timezone),
        periodLabel: formatPeriodLabel(periodValue, reportType, timezone),
        grossSales: toNumber(metrics?.gross_sales),
        itemsSold: Number(metrics?.items_sold || 0),
      }
    })

    logger.info('Period metrics (summary mode)', {
      count: result.length,
      totalGrossSales: result.reduce((acc, r) => acc + r.grossSales, 0),
    })

    return result
  }

  // For regular report types (hours, days, weeks, months), return data directly from query
  const result: TimePeriodItemMetrics[] = periodMetrics.map(p => ({
    period: formatPeriod(p.period, reportType, timezone),
    periodLabel: formatPeriodLabel(p.period, reportType, timezone),
    grossSales: toNumber(p.gross_sales),
    itemsSold: Number(p.items_sold),
  }))

  logger.info('Period metrics (regular mode)', {
    count: result.length,
    sample: result.slice(0, 3),
    totalGrossSales: result.reduce((acc, r) => acc + r.grossSales, 0),
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

// ============================================================
// Helper: Build GroupBy SQL Clause
// ============================================================

interface GroupByClause {
  selectFields: string
  groupByFields: string
  orderByField: string
}

/**
 * Build SQL SELECT, GROUP BY, and ORDER BY clauses based on groupBy option
 */
function buildGroupByClause(groupBy: GroupByOption): GroupByClause {
  switch (groupBy) {
    case 'category':
      return {
        selectFields: `
          NULL as "productId",
          COALESCE(oi."categoryName", mc.name, 'Sin categorizar') as product_name,
          NULL as product_sku,
          COALESCE(oi."categoryName", mc.name, 'Sin categorizar') as category_name,
          NULL as channel,
          NULL as payment_method,
          NULL as source,
          NULL as terminal_id,
        `,
        groupByFields: 'COALESCE(oi."categoryName", mc.name, \'Sin categorizar\')',
        orderByField: 'gross_sales',
      }

    case 'channel':
      return {
        selectFields: `
          NULL as "productId",
          COALESCE(o.channel, 'POS') as product_name,
          NULL as product_sku,
          NULL as category_name,
          COALESCE(o.channel, 'POS') as channel,
          NULL as payment_method,
          NULL as source,
          NULL as terminal_id,
        `,
        groupByFields: "COALESCE(o.channel, 'POS')",
        orderByField: 'gross_sales',
      }

    case 'paymentMethod':
      // Payment method is in the Payment table, not Order
      // We need to join with Payment and group by payment method
      return {
        selectFields: `
          NULL as "productId",
          COALESCE(pay.method::text, 'OTHER') as product_name,
          NULL as product_sku,
          NULL as category_name,
          NULL as channel,
          COALESCE(pay.method::text, 'OTHER') as payment_method,
          NULL as source,
          NULL as terminal_id,
        `,
        groupByFields: "COALESCE(pay.method::text, 'OTHER')",
        orderByField: 'gross_sales',
      }

    case 'source':
      // source is an OrderSource enum (TPV, QR, WEB, APP, PHONE, POS)
      // Cast to text to allow grouping
      return {
        selectFields: `
          NULL as "productId",
          COALESCE(o.source::text, 'TPV') as product_name,
          NULL as product_sku,
          NULL as category_name,
          NULL as channel,
          NULL as payment_method,
          COALESCE(o.source::text, 'TPV') as source,
          NULL as terminal_id,
        `,
        groupByFields: "COALESCE(o.source::text, 'TPV')",
        orderByField: 'gross_sales',
      }

    case 'device':
      // Device groupBy uses the actual Terminal table
      // Groups by terminal ID and shows terminal name for each device
      // Orders without terminalId are grouped as "Sin terminal asignado"
      return {
        selectFields: `
          NULL as "productId",
          COALESCE(t.name, 'Sin terminal asignado') as product_name,
          NULL as product_sku,
          NULL as category_name,
          NULL as channel,
          NULL as payment_method,
          NULL as source,
          o."terminalId" as terminal_id,
        `,
        groupByFields: 'o."terminalId", t.name',
        orderByField: 'gross_sales',
      }

    case 'none':
    default:
      // Default: group by product (original behavior)
      return {
        selectFields: `
          oi."productId",
          COALESCE(oi."productName", p.name, 'Sin descripción') as product_name,
          oi."productSku" as product_sku,
          COALESCE(oi."categoryName", mc.name, 'Sin categorizar') as category_name,
          NULL as channel,
          NULL as payment_method,
          NULL as source,
          NULL as terminal_id,
        `,
        groupByFields: 'oi."productId", oi."productName", oi."productSku", oi."categoryName", p.name, mc.name',
        orderByField: 'gross_sales',
      }
  }
}

// ============================================================
// Helper: Format Display Names
// ============================================================

/**
 * Format channel name for display
 */
function formatChannelName(channel: string | null): string {
  const channelMap: Record<string, string> = {
    POS: 'Punto de Venta (TPV)',
    QR: 'QR',
    WEB: 'Web',
    APP: 'App',
    DELIVERY: 'Delivery',
    KIOSK: 'Kiosko',
  }
  return channelMap[channel || 'POS'] || channel || 'Punto de Venta (TPV)'
}

/**
 * Format payment method name for display
 */
function formatPaymentMethodName(paymentMethod: string | null): string {
  const methodMap: Record<string, string> = {
    CASH: 'Efectivo',
    CARD: 'Tarjeta',
    TRANSFER: 'Transferencia',
    WALLET: 'Monedero',
    OTHER: 'Otro',
    CREDIT_CARD: 'Tarjeta de Crédito',
    DEBIT_CARD: 'Tarjeta de Débito',
  }
  return methodMap[paymentMethod || 'OTHER'] || paymentMethod || 'Otro'
}

/**
 * Format source/device name for display
 * OrderSource enum: TPV, QR, WEB, APP, PHONE, POS
 */
function formatSourceName(source: string | null): string {
  const sourceMap: Record<string, string> = {
    TPV: 'Terminal (TPV)',
    QR: 'Código QR',
    WEB: 'Sitio Web',
    APP: 'Aplicación Móvil',
    PHONE: 'Pedido Telefónico',
    POS: 'Punto de Venta (POS)',
  }
  return sourceMap[source || 'TPV'] || source || 'Terminal (TPV)'
}
