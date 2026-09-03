/**
 * Historical Reports Service
 *
 * Provides aggregated sales data grouped by time periods (day/week/month/quarter/year)
 * with period-over-period comparisons for trend analysis.
 *
 * **World-Class Pattern (Toast POS + Square + Stripe)**:
 * - Efficient SQL aggregation with DATE_TRUNC
 * - Automatic previous period calculation
 * - Timezone-aware grouping
 * - Cursor-based pagination
 *
 * @see /docs/DATETIME_SYNC.md - Date synchronization architecture
 */

import prisma from '@/utils/prismaClient'
import { localInstantRaw, localWallClockRaw, utcTs } from '@/utils/sqlDates'
import { sanitizeTimezone } from '@/utils/sanitizeTimezone'
import { BadRequestError } from '@/errors/AppError'
import { Prisma } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'

/**
 * Time grouping options for historical data
 */
export enum HistoricalGrouping {
  DAILY = 'DAILY',
  WEEKLY = 'WEEKLY',
  MONTHLY = 'MONTHLY',
  QUARTERLY = 'QUARTERLY',
  YEARLY = 'YEARLY',
}

/**
 * Single historical period with metrics and comparison
 */
export interface HistoricalPeriod {
  periodStart: Date
  periodEnd: Date
  grouping: HistoricalGrouping
  label: string // "15 Enero 2025"
  subtitle: string // "Martes" or "Semana 3"
  totalSales: number
  totalOrders: number
  totalProducts: number
  averageOrderValue: number
  // Comparison vs previous period
  salesChange: number | null // +12.5 (percentage)
  ordersChange: number | null // -3.2 (percentage)
}

/**
 * Paginated historical data response
 */
export interface PaginatedHistoricalData {
  periods: HistoricalPeriod[]
  pagination: {
    nextCursor: string | null
    hasMore: boolean
  }
}

/**
 * Get DATE_TRUNC expression based on grouping type
 */
function getTruncateExpression(grouping: HistoricalGrouping, timezone: string): string {
  // SECURITY: Sanitize timezone to prevent SQL injection
  const safeTz = sanitizeTimezone(timezone)

  // Venue wall clock of the UTC column. A single `AT TIME ZONE tz` read the stored UTC value
  // as if it were local time and put a 20:00 sale on the next day. The period is returned as
  // the INSTANT it starts (midnight on the venue clock): the TPV formats `periodStart` itself.
  const wall = localWallClockRaw(safeTz, 'o."createdAt"')

  switch (grouping) {
    case HistoricalGrouping.DAILY:
      return localInstantRaw(safeTz, `DATE_TRUNC('day', ${wall})`)
    case HistoricalGrouping.WEEKLY:
      return localInstantRaw(safeTz, `DATE_TRUNC('week', ${wall})`)
    case HistoricalGrouping.MONTHLY:
      return localInstantRaw(safeTz, `DATE_TRUNC('month', ${wall})`)
    case HistoricalGrouping.QUARTERLY:
      return localInstantRaw(safeTz, `DATE_TRUNC('quarter', ${wall})`)
    case HistoricalGrouping.YEARLY:
      return localInstantRaw(safeTz, `DATE_TRUNC('year', ${wall})`)
  }
}

/**
 * Calculate period end based on period start and grouping
 */
function getPeriodEnd(periodStart: Date, grouping: HistoricalGrouping): Date {
  const end = new Date(periodStart)

  switch (grouping) {
    case HistoricalGrouping.DAILY:
      end.setDate(end.getDate() + 1)
      break
    case HistoricalGrouping.WEEKLY:
      end.setDate(end.getDate() + 7)
      break
    case HistoricalGrouping.MONTHLY:
      end.setMonth(end.getMonth() + 1)
      break
    case HistoricalGrouping.QUARTERLY:
      end.setMonth(end.getMonth() + 3)
      break
    case HistoricalGrouping.YEARLY:
      end.setFullYear(end.getFullYear() + 1)
      break
  }

  end.setMilliseconds(-1) // End of period
  return end
}

/**
 * Format period label based on grouping (Spanish)
 */
function formatPeriodLabel(periodStart: Date, grouping: HistoricalGrouping, locale: string = 'es-ES'): string {
  const options: Intl.DateTimeFormatOptions = { timeZone: 'UTC' }

  switch (grouping) {
    case HistoricalGrouping.DAILY:
      return periodStart.toLocaleDateString(locale, { ...options, day: 'numeric', month: 'long', year: 'numeric' })
    case HistoricalGrouping.WEEKLY:
      const weekNumber = getWeekNumber(periodStart)
      const monthName = periodStart.toLocaleDateString(locale, { ...options, month: 'long' })
      return `Semana ${weekNumber}, ${monthName} ${periodStart.getFullYear()}`
    case HistoricalGrouping.MONTHLY:
      return periodStart.toLocaleDateString(locale, { ...options, month: 'long', year: 'numeric' })
    case HistoricalGrouping.QUARTERLY:
      const quarter = Math.floor(periodStart.getMonth() / 3) + 1
      return `Q${quarter} ${periodStart.getFullYear()}`
    case HistoricalGrouping.YEARLY:
      return `${periodStart.getFullYear()}`
  }
}

/**
 * Format period subtitle (day of week or week number)
 */
function formatPeriodSubtitle(periodStart: Date, grouping: HistoricalGrouping, locale: string = 'es-ES'): string {
  if (grouping === HistoricalGrouping.DAILY) {
    return periodStart.toLocaleDateString(locale, { weekday: 'long', timeZone: 'UTC' })
  }
  return ''
}

/**
 * Get ISO week number (1-53)
 */
function getWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const dayNum = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
}

/**
 * Calculate percentage change between current and previous values
 */
function calculatePercentageChange(current: number, previous: number): number | null {
  if (previous === 0) return null
  return ((current - previous) / previous) * 100
}

/**
 * Calculate the start date of the previous period (pure function, no DB call)
 */
function calculatePreviousStart(periodStart: Date, grouping: HistoricalGrouping): Date {
  const previousStart = new Date(periodStart)

  switch (grouping) {
    case HistoricalGrouping.DAILY:
      previousStart.setDate(previousStart.getDate() - 1)
      break
    case HistoricalGrouping.WEEKLY:
      previousStart.setDate(previousStart.getDate() - 7)
      break
    case HistoricalGrouping.MONTHLY:
      previousStart.setMonth(previousStart.getMonth() - 1)
      break
    case HistoricalGrouping.QUARTERLY:
      previousStart.setMonth(previousStart.getMonth() - 3)
      break
    case HistoricalGrouping.YEARLY:
      previousStart.setFullYear(previousStart.getFullYear() - 1)
      break
  }

  return previousStart
}

/**
 * Bulk-calculate previous period metrics for all periods in a single query.
 * Replaces N individual queries with 1 aggregated query using DATE_TRUNC grouping.
 */
async function calculatePreviousPeriodsBulk(
  venueId: string,
  periods: Array<{ period_start: Date }>,
  grouping: HistoricalGrouping,
  timezone: string,
): Promise<Map<string, { total_sales: number; total_orders: number }>> {
  if (periods.length === 0) {
    return new Map()
  }

  // Calculate the date range covering all previous periods
  let earliestPrevStart: Date | null = null
  let latestPrevEnd: Date | null = null

  for (const period of periods) {
    const prevStart = calculatePreviousStart(period.period_start, grouping)
    const prevEnd = getPeriodEnd(prevStart, grouping)

    if (!earliestPrevStart || prevStart < earliestPrevStart) {
      earliestPrevStart = prevStart
    }
    if (!latestPrevEnd || prevEnd > latestPrevEnd) {
      latestPrevEnd = prevEnd
    }
  }

  if (!earliestPrevStart || !latestPrevEnd) {
    return new Map()
  }

  // Single query: aggregate all previous periods grouped by DATE_TRUNC
  const truncateExpr = getTruncateExpression(grouping, timezone)

  const rows = await prisma.$queryRaw<Array<{ period_start: Date; total_sales: Decimal; total_orders: bigint }>>`
    SELECT
      ${Prisma.raw(truncateExpr)} as period_start,
      COALESCE(SUM(o.total), 0) as total_sales,
      COALESCE(COUNT(DISTINCT o.id), 0) as total_orders
    FROM "Order" o
    WHERE o."venueId" = ${venueId}
      AND o."createdAt" >= ${utcTs(earliestPrevStart)}
      AND o."createdAt" < ${utcTs(latestPrevEnd)}
      AND o.status = 'COMPLETED'
    GROUP BY period_start
  `

  // Build lookup map keyed by period_start date string (YYYY-MM-DD)
  const map = new Map<string, { total_sales: number; total_orders: number }>()
  for (const row of rows) {
    const key = row.period_start.toISOString().split('T')[0]
    map.set(key, {
      total_sales: new Decimal(row.total_sales).toNumber(),
      total_orders: Number(row.total_orders),
    })
  }

  return map
}

/**
 * Get historical sales summaries grouped by time period
 *
 * @param venueId - Venue ID (tenant isolation)
 * @param grouping - Time grouping (DAILY, WEEKLY, MONTHLY, QUARTERLY, YEARLY)
 * @param startDate - Start of historical range
 * @param endDate - End of historical range
 * @param cursor - Pagination cursor (timestamp-based)
 * @param limit - Number of periods to fetch (default 20)
 * @returns Paginated list of historical summaries with comparisons
 */
export async function getHistoricalSummaries(
  venueId: string,
  grouping: HistoricalGrouping,
  startDate: Date,
  endDate: Date,
  cursor?: string,
  limit: number = 20,
): Promise<PaginatedHistoricalData> {
  // 1. Get venue timezone
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    select: { timezone: true },
  })

  if (!venue) {
    throw new Error('Venue not found')
  }

  const timezone = venue.timezone || 'America/Mexico_City'

  // 2. Build SQL query with DATE_TRUNC grouping
  const truncateExpr = getTruncateExpression(grouping, timezone)

  // Cursor condition (pagination) — validate cursor as ISO timestamp to prevent SQL injection
  let cursorCondition = ''
  if (cursor) {
    const cursorDate = new Date(cursor)
    if (isNaN(cursorDate.getTime())) {
      throw new BadRequestError('Invalid cursor format. Must be a valid ISO 8601 timestamp.')
    }
    // Use validated ISO string to prevent injection. `::timestamptz` keeps the literal's Z:
    // cast to a bare `::timestamp` it was re-read in the session zone, six hours later than
    // the period it names, and the next page repeated the last period of the previous one.
    cursorCondition = `AND ${truncateExpr} < '${cursorDate.toISOString()}'::timestamptz`
  }

  // 3. Query aggregated data by period
  //
  // `total_products` is the ONLY thing that needs the order's lines. It used to
  // be fetched with `LEFT JOIN "OrderItem"`, which fans the result out to one
  // row per line and therefore multiplied `SUM(o.total)` by each order's line
  // count — a real $931 day was reported as $2,809. The correlated subquery
  // keeps `total_products` identical while leaving `SUM(o.total)` per ORDER,
  // which is also the basis `calculatePreviousPeriodsBulk` compares against
  // (it never had the join, so `salesChange` was comparing inflated vs clean).
  const periodsRaw = await prisma.$queryRaw<
    Array<{
      period_start: Date
      total_sales: Decimal
      total_orders: bigint
      // SUM over a subquery returns `numeric`, which Prisma hands back as a
      // Decimal — not the bigint that `SUM(oi.quantity)` used to produce.
      // `Number(...)` handles both, but the annotation has to say what actually
      // arrives or the next reader trusts it.
      total_products: Decimal
    }>
  >`
    SELECT
      ${Prisma.raw(truncateExpr)} as period_start,
      COALESCE(SUM(o.total), 0) as total_sales,
      COALESCE(COUNT(DISTINCT o.id), 0) as total_orders,
      COALESCE(SUM((SELECT COALESCE(SUM(oi.quantity), 0) FROM "OrderItem" oi WHERE oi."orderId" = o.id)), 0) as total_products
    FROM "Order" o
    WHERE o."venueId" = ${venueId}
      AND o."createdAt" >= ${utcTs(startDate)}
      AND o."createdAt" <= ${utcTs(endDate)}
      AND o.status = 'COMPLETED'
      ${Prisma.raw(cursorCondition)}
    GROUP BY period_start
    ORDER BY period_start DESC
    LIMIT ${limit + 1}
  `

  // Determine if there are more results
  const hasMore = periodsRaw.length > limit
  const periods = hasMore ? periodsRaw.slice(0, limit) : periodsRaw

  // 4. Bulk-fetch all previous period metrics in ONE query (instead of N)
  const prevMap = await calculatePreviousPeriodsBulk(venueId, periods, grouping, timezone)

  const periodsWithComparison = periods.map(period => {
    const prevKey = calculatePreviousStart(period.period_start, grouping).toISOString().split('T')[0]
    const previousPeriod = prevMap.get(prevKey) || { total_sales: 0, total_orders: 0 }

    const totalSales = new Decimal(period.total_sales).toNumber()
    const totalOrders = Number(period.total_orders)
    const totalProducts = Number(period.total_products)
    const averageOrderValue = totalOrders > 0 ? totalSales / totalOrders : 0

    return {
      periodStart: period.period_start,
      periodEnd: getPeriodEnd(period.period_start, grouping),
      grouping,
      label: formatPeriodLabel(period.period_start, grouping),
      subtitle: formatPeriodSubtitle(period.period_start, grouping),
      totalSales,
      totalOrders,
      totalProducts,
      averageOrderValue,
      salesChange: calculatePercentageChange(totalSales, previousPeriod.total_sales),
      ordersChange: calculatePercentageChange(totalOrders, previousPeriod.total_orders),
    }
  })

  // 5. Build pagination cursor (last period start timestamp)
  const nextCursor = hasMore && periods.length > 0 ? periods[periods.length - 1].period_start.toISOString() : null

  return {
    periods: periodsWithComparison,
    pagination: {
      nextCursor,
      hasMore,
    },
  }
}
