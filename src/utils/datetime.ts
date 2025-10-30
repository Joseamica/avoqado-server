/**
 * Centralized Date/Time Utility for Avoqado Backend
 *
 * **CRITICAL: This file MUST stay in sync with frontend's datetime.ts**
 *
 * **Best Practices (Stripe, AWS, Shopify standard):**
 * - STORE: Always UTC in PostgreSQL (Prisma handles this automatically) ✅
 * - TRANSMIT: Always ISO 8601 with Z suffix (e.g., "2025-10-29T12:30:00.000Z") ✅
 * - COMPUTE: Convert to venue timezone for date range calculations ✅
 * - ISOLATE: Each venue operates in its own timezone ✅
 *
 * **Architecture:**
 *
 * Frontend (Luxon) ──[ISO 8601 UTC]──> Backend (date-fns-tz) ──> Database (UTC)
 *                      ^                                ^
 *                      |                                |
 *              "2025-10-29T12:30:00.000Z"    new Date() / Prisma
 *
 * **Key Principle:**
 * When filtering data by date ranges, we must consider the venue's timezone.
 * Example: "Today" in Mexico City (CST) is different from "Today" in UTC.
 *
 * **Usage Examples:**
 *
 * ```typescript
 * // In controllers:
 * import { parseDateRange, getVenueDateRange } from '@/utils/datetime'
 *
 * // Parse ISO strings from frontend:
 * const { from, to } = parseDateRange(req.query.fromDate, req.query.toDate)
 *
 * // Get relative date ranges in venue timezone:
 * const range = getVenueDateRange('last7days', venue.timezone)
 *
 * // In Prisma queries:
 * const orders = await prisma.order.findMany({
 *   where: {
 *     venueId,
 *     createdAt: { gte: from, lte: to }  // Prisma converts to UTC automatically
 *   }
 * })
 * ```
 */

import {
  startOfDay,
  endOfDay,
  subDays,
  subMonths,
  startOfWeek,
  endOfWeek,
  startOfMonth,
  endOfMonth,
  parseISO,
  isValid,
  formatISO,
} from 'date-fns'
import { fromZonedTime, toZonedTime, format as formatTz } from 'date-fns-tz'

/**
 * Default timezone for Mexico (most common for Avoqado venues)
 */
export const DEFAULT_TIMEZONE = 'America/Mexico_City'

/**
 * Date range type returned by all date range functions
 */
export interface DateRange {
  from: Date
  to: Date
}

/**
 * Supported relative date range types (matches frontend filters)
 */
export type RelativeDateRange =
  | 'today'
  | 'yesterday'
  | 'last7days'
  | 'last30days'
  | 'thisWeek' // Últimos 7 días (NOT calendar week)
  | 'thisMonth' // Últimos 30 días (NOT calendar month)
  | 'lastWeek' // Previous 7 days
  | 'lastMonth' // Previous 30 days

/**
 * Parse ISO 8601 date strings from frontend to Date objects
 *
 * **CRITICAL:** Frontend always sends ISO strings with 'Z' suffix (UTC)
 * Example: "2025-10-29T12:30:00.000Z"
 *
 * @param fromDate - ISO string from frontend query parameter
 * @param toDate - ISO string from frontend query parameter
 * @param defaultDays - Number of days to look back if dates not provided (default: 7)
 * @returns DateRange with from/to as Date objects in UTC
 *
 * @example
 * // In controller:
 * const { fromDate, toDate } = req.query
 * const { from, to } = parseDateRange(fromDate, toDate)
 *
 * // Result: { from: Date(UTC), to: Date(UTC) }
 */
export function parseDateRange(fromDate?: string, toDate?: string, defaultDays: number = 7): DateRange {
  let from: Date
  let to: Date

  // Parse fromDate
  if (fromDate) {
    const parsedFrom = parseISO(fromDate)
    if (!isValid(parsedFrom)) {
      throw new Error(`Invalid fromDate: ${fromDate}. Expected ISO 8601 format.`)
    }
    from = parsedFrom
  } else {
    // Default: N days ago
    from = subDays(new Date(), defaultDays)
  }

  // Parse toDate
  if (toDate) {
    const parsedTo = parseISO(toDate)
    if (!isValid(parsedTo)) {
      throw new Error(`Invalid toDate: ${toDate}. Expected ISO 8601 format.`)
    }
    to = parsedTo
  } else {
    // Default: now
    to = new Date()
  }

  return { from, to }
}

/**
 * Get date range for relative period in venue's timezone
 *
 * **CRITICAL:** This function ensures date ranges match the dashboard frontend exactly.
 *
 * **Key Difference from Naive Approach:**
 * - "Today" means start/end of day in VENUE timezone, not UTC
 * - "Last 7 days" means exactly 7 days from now, not calendar week
 *
 * @param period - Relative date period (e.g., 'today', 'last7days')
 * @param timezone - Venue timezone (IANA format, e.g., 'America/Mexico_City')
 * @returns DateRange with from/to in UTC (for Prisma queries)
 *
 * @example
 * // Get "today" in Mexico City timezone:
 * const range = getVenueDateRange('today', 'America/Mexico_City')
 * // If current time in Mexico is Oct 29 2025 14:30 CST
 * // Returns: {
 * //   from: Oct 29 2025 00:00:00 CST → Oct 29 2025 06:00:00 UTC
 * //   to:   Oct 29 2025 23:59:59 CST → Oct 30 2025 05:59:59 UTC
 * // }
 *
 * @example
 * // Get "last 7 days" (matches dashboard filter):
 * const range = getVenueDateRange('last7days', 'America/Mexico_City')
 * // Returns: from = 7 days ago, to = now (both in UTC)
 */
export function getVenueDateRange(period: RelativeDateRange, timezone: string = DEFAULT_TIMEZONE): DateRange {
  // Get current time in venue timezone
  const nowUtc = new Date()
  const nowVenue = toZonedTime(nowUtc, timezone)

  let from: Date
  let to: Date

  switch (period) {
    case 'today':
      // Start and end of today in venue timezone
      from = fromZonedTime(startOfDay(nowVenue), timezone)
      to = fromZonedTime(endOfDay(nowVenue), timezone)
      break

    case 'yesterday':
      // Start and end of yesterday in venue timezone
      const yesterdayVenue = subDays(nowVenue, 1)
      from = fromZonedTime(startOfDay(yesterdayVenue), timezone)
      to = fromZonedTime(endOfDay(yesterdayVenue), timezone)
      break

    case 'last7days':
    case 'thisWeek':
      // Last 7 days from now (NOT calendar week)
      // This matches dashboard "Últimos 7 días" filter
      from = subDays(nowUtc, 7)
      to = nowUtc
      break

    case 'last30days':
    case 'thisMonth':
      // Last 30 days from now (NOT calendar month)
      // This matches dashboard "Últimos 30 días" filter
      from = subDays(nowUtc, 30)
      to = nowUtc
      break

    case 'lastWeek':
      // Previous 7-day period
      from = subDays(nowUtc, 14)
      to = subDays(nowUtc, 7)
      break

    case 'lastMonth':
      // Previous 30-day period
      from = subDays(nowUtc, 60)
      to = subDays(nowUtc, 30)
      break

    default:
      throw new Error(`Unsupported period: ${period}`)
  }

  return { from, to }
}

/**
 * Get date range for calendar week in venue timezone
 *
 * **USE WITH CAUTION:** This returns the calendar week (Monday-Sunday),
 * which is different from "last 7 days". Most dashboard filters use
 * "last 7 days", not calendar weeks.
 *
 * @param timezone - Venue timezone
 * @returns DateRange for current calendar week in venue timezone
 */
export function getCalendarWeek(timezone: string = DEFAULT_TIMEZONE): DateRange {
  const nowUtc = new Date()
  const nowVenue = toZonedTime(nowUtc, timezone)

  const weekStart = startOfWeek(nowVenue, { weekStartsOn: 1 }) // Monday
  const weekEnd = endOfWeek(nowVenue, { weekStartsOn: 1 })

  return {
    from: fromZonedTime(weekStart, timezone),
    to: fromZonedTime(weekEnd, timezone),
  }
}

/**
 * Get date range for calendar month in venue timezone
 *
 * **USE WITH CAUTION:** This returns the calendar month (1st-31st),
 * which is different from "last 30 days". Most dashboard filters use
 * "last 30 days", not calendar months.
 *
 * @param timezone - Venue timezone
 * @returns DateRange for current calendar month in venue timezone
 */
export function getCalendarMonth(timezone: string = DEFAULT_TIMEZONE): DateRange {
  const nowUtc = new Date()
  const nowVenue = toZonedTime(nowUtc, timezone)

  const monthStart = startOfMonth(nowVenue)
  const monthEnd = endOfMonth(nowVenue)

  return {
    from: fromZonedTime(monthStart, timezone),
    to: fromZonedTime(monthEnd, timezone),
  }
}

/**
 * Format a Date object to ISO 8601 string with Z suffix
 *
 * Use this when sending dates back to frontend in API responses.
 *
 * @param date - Date object (assumed to be in UTC)
 * @returns ISO string like "2025-10-29T12:30:00.000Z"
 *
 * @example
 * const order = await prisma.order.findUnique({ where: { id } })
 * res.json({
 *   order: {
 *     ...order,
 *     createdAt: toISOString(order.createdAt)
 *   }
 * })
 */
export function toISOString(date: Date): string {
  return formatISO(date, { format: 'extended' })
}

/**
 * Convert UTC date to venue timezone for display/logging
 *
 * **IMPORTANT:** Use this ONLY for logging or admin displays.
 * Always store and transmit dates in UTC.
 *
 * @param date - UTC Date object
 * @param timezone - Venue timezone
 * @returns Date object adjusted to venue timezone
 *
 * @example
 * const orderCreatedAt = new Date('2025-10-29T18:30:00.000Z') // UTC
 * const venueTime = toVenueTime(orderCreatedAt, 'America/Mexico_City')
 * // Result: Oct 29 2025 12:30:00 (CST, UTC-6)
 */
export function toVenueTime(date: Date, timezone: string = DEFAULT_TIMEZONE): Date {
  return toZonedTime(date, timezone)
}

/**
 * Format date in venue timezone for human-readable display
 *
 * @param date - UTC Date object
 * @param timezone - Venue timezone
 * @param formatString - date-fns format string (default: 'yyyy-MM-dd HH:mm:ss')
 * @returns Formatted string in venue timezone
 *
 * @example
 * const orderTime = new Date('2025-10-29T18:30:00.000Z')
 * formatInVenueTimezone(orderTime, 'America/Mexico_City')
 * // Returns: "2025-10-29 12:30:00" (CST)
 */
export function formatInVenueTimezone(
  date: Date,
  timezone: string = DEFAULT_TIMEZONE,
  formatString: string = 'yyyy-MM-dd HH:mm:ss',
): string {
  return formatTz(date, formatString, { timeZone: timezone })
}

/**
 * Validate if a string is a valid IANA timezone
 *
 * @param timezone - Timezone string to validate
 * @returns true if valid, false otherwise
 *
 * @example
 * isValidTimezone('America/Mexico_City') // true
 * isValidTimezone('Invalid/Timezone') // false
 */
export function isValidTimezone(timezone: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone })
    return true
  } catch {
    return false
  }
}

/**
 * Get timezone offset in hours for a given timezone
 *
 * @param timezone - IANA timezone
 * @returns Offset in hours (e.g., -6 for CST)
 *
 * @example
 * getTimezoneOffset('America/Mexico_City') // -6 (CST)
 * getTimezoneOffset('America/New_York') // -5 (EST)
 */
export function getTimezoneOffset(timezone: string = DEFAULT_TIMEZONE): number {
  const now = new Date()
  const utcDate = new Date(now.toLocaleString('en-US', { timeZone: 'UTC' }))
  const tzDate = new Date(now.toLocaleString('en-US', { timeZone: timezone }))
  return (utcDate.getTime() - tzDate.getTime()) / (1000 * 60 * 60)
}

/**
 * Generate SQL date filter string for text-to-SQL assistant
 *
 * **CRITICAL:** This function is used by the AI chatbot to generate
 * SQL WHERE clauses that match the dashboard date filters EXACTLY.
 *
 * @param period - Relative date period
 * @param columnName - Database column name (default: 'createdAt')
 * @returns SQL WHERE clause fragment
 *
 * @example
 * getSqlDateFilter('last7days')
 * // Returns: '"createdAt" >= NOW() - INTERVAL \'7 days\''
 *
 * getSqlDateFilter('today', '"startTime"')
 * // Returns: '"startTime" >= CURRENT_DATE AND "startTime" < CURRENT_DATE + INTERVAL \'1 day\''
 */
export function getSqlDateFilter(period: RelativeDateRange, columnName: string = '"createdAt"'): string {
  switch (period) {
    case 'today':
      return `${columnName} >= CURRENT_DATE AND ${columnName} < CURRENT_DATE + INTERVAL '1 day'`

    case 'yesterday':
      return `${columnName} >= CURRENT_DATE - INTERVAL '1 day' AND ${columnName} < CURRENT_DATE`

    case 'last7days':
    case 'thisWeek':
      return `${columnName} >= NOW() - INTERVAL '7 days'`

    case 'last30days':
    case 'thisMonth':
      return `${columnName} >= NOW() - INTERVAL '30 days'`

    case 'lastWeek':
      return `${columnName} >= NOW() - INTERVAL '14 days' AND ${columnName} < NOW() - INTERVAL '7 days'`

    case 'lastMonth':
      return `${columnName} >= NOW() - INTERVAL '60 days' AND ${columnName} < NOW() - INTERVAL '30 days'`

    default:
      throw new Error(`Unsupported period: ${period}`)
  }
}

/**
 * EXAMPLES OF COMMON USE CASES
 * ============================
 *
 * 1. Controller receiving dates from frontend:
 *
 * ```typescript
 * export async function getDashboardData(req: Request, res: Response) {
 *   const { fromDate, toDate } = req.query
 *   const { venueId } = req.params
 *
 *   // Parse ISO strings from frontend
 *   const { from, to } = parseDateRange(fromDate, toDate)
 *
 *   // Query database (Prisma converts to UTC automatically)
 *   const orders = await prisma.order.findMany({
 *     where: {
 *       venueId,
 *       createdAt: { gte: from, lte: to }
 *     }
 *   })
 *
 *   res.json({ orders })
 * }
 * ```
 *
 * 2. Chatbot interpreting relative dates:
 *
 * ```typescript
 * // User asks: "¿cuánto vendí esta semana?"
 * const venue = await prisma.venue.findUnique({ where: { id: venueId } })
 * const range = getVenueDateRange('thisWeek', venue.timezone)
 *
 * // Generate SQL for OpenAI
 * const sqlFilter = getSqlDateFilter('thisWeek')
 * // Result: '"createdAt" >= NOW() - INTERVAL \'7 days\''
 * ```
 *
 * 3. Comparing with previous period:
 *
 * ```typescript
 * const currentPeriod = getVenueDateRange('last7days', venue.timezone)
 * const previousPeriod = getVenueDateRange('lastWeek', venue.timezone)
 *
 * const currentSales = await getSales(venueId, currentPeriod)
 * const previousSales = await getSales(venueId, previousPeriod)
 *
 * const percentageChange = ((currentSales - previousSales) / previousSales) * 100
 * ```
 */
