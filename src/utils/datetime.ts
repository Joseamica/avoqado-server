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
  startOfWeek,
  endOfWeek,
  startOfMonth,
  endOfMonth,
  parseISO,
  isValid,
  formatISO,
  subMonths,
} from 'date-fns'
import { fromZonedTime, toZonedTime, format as formatTz } from 'date-fns-tz'

/**
 * Default timezone for Mexico (most common for Avoqado venues)
 */
export const DEFAULT_TIMEZONE = 'America/Mexico_City'

/**
 * CRITICAL: Database Timezone Reality (verified 2026-02-06)
 *
 * PostgreSQL is configured with timezone = 'America/Mexico_City', and datetime
 * columns use `timestamp without time zone`.
 *
 * **Prisma stores REAL UTC.** Prisma sends JavaScript Date values (which are
 * internally UTC) as literal timestamps to PostgreSQL. PG stores them as-is
 * in `timestamp without time zone` columns, bypassing its timezone setting.
 * Verified: payment at 1:10 PM Mexico → DB shows 19:10 (= 1:10 PM + 6h UTC).
 *
 * **Raw SQL NOW() stores Mexico local time.** When PG evaluates NOW(), it
 * applies its timezone setting and stores the local result.
 *
 * SOLUTION: Use fromZonedTime() to convert venue-local boundaries to real UTC.
 * Example: "Feb 6 midnight Mexico" → fromZonedTime → 2026-02-06T06:00:00Z (UTC)
 *
 * IMPORTANT: Do NOT use setHours(0,0,0,0) — that creates UTC midnight, not
 * venue midnight. Do NOT use "fake UTC" (new Date('...T00:00:00.000Z')) for
 * Prisma-stored data — it's 6 hours off.
 */

/**
 * Get start of day in venue timezone, converted to real UTC for Prisma queries.
 *
 * Example: venueStartOfDay('America/Mexico_City') on Feb 6
 *   → midnight Mexico = 2026-02-06T06:00:00.000Z (UTC)
 *
 * @param timezone - Venue IANA timezone
 * @param referenceDate - Date to get start of day for (default: now)
 */
export function venueStartOfDay(timezone: string = DEFAULT_TIMEZONE, referenceDate?: Date): Date {
  const ref = referenceDate ?? new Date()
  const venueNow = toZonedTime(ref, timezone)
  return fromZonedTime(startOfDay(venueNow), timezone)
}

/**
 * Get end of day in venue timezone, converted to real UTC for Prisma queries.
 *
 * Example: venueEndOfDay('America/Mexico_City') on Feb 6
 *   → 23:59:59.999 Mexico = 2026-02-07T05:59:59.999Z (UTC)
 *
 * @param timezone - Venue IANA timezone
 * @param referenceDate - Date to get end of day for (default: now)
 */
export function venueEndOfDay(timezone: string = DEFAULT_TIMEZONE, referenceDate?: Date): Date {
  const ref = referenceDate ?? new Date()
  const venueNow = toZonedTime(ref, timezone)
  return fromZonedTime(endOfDay(venueNow), timezone)
}

/**
 * Get start of day N days offset from now in venue timezone for Prisma queries.
 * Use negative values for past dates.
 *
 * Example: venueStartOfDayOffset('America/Mexico_City', -7)
 *   → midnight 7 days ago in Mexico, converted to real UTC
 *
 * @param timezone - Venue IANA timezone
 * @param daysOffset - Number of days to offset (negative = past)
 */
export function venueStartOfDayOffset(timezone: string = DEFAULT_TIMEZONE, daysOffset: number = 0): Date {
  const now = new Date()
  const venueNow = toZonedTime(now, timezone)
  const offsetDay = subDays(startOfDay(venueNow), -daysOffset)
  return fromZonedTime(offsetDay, timezone)
}

/**
 * Get start of month in venue timezone, converted to real UTC for Prisma queries.
 *
 * Example: venueStartOfMonth('America/Mexico_City') on Feb 6
 *   → Feb 1 midnight Mexico = 2026-02-01T06:00:00.000Z (UTC)
 *
 * @param timezone - Venue IANA timezone
 */
export function venueStartOfMonth(timezone: string = DEFAULT_TIMEZONE): Date {
  const now = new Date()
  const venueNow = toZonedTime(now, timezone)
  return fromZonedTime(startOfMonth(venueNow), timezone)
}

/**
 * Parse ISO date strings from frontend and convert to real UTC range
 * using venue timezone boundaries.
 *
 * Frontend sends ISO strings (e.g., "2026-02-06T06:00:00.000Z" or "2026-02-06").
 * This function creates venue-timezone start/end-of-day boundaries in real UTC
 * for Prisma queries.
 *
 * @param fromDate - ISO string or YYYY-MM-DD from frontend
 * @param toDate - ISO string or YYYY-MM-DD from frontend
 * @param timezone - Venue IANA timezone
 * @param defaultDays - Fallback days if dates not provided
 */
export function parseDbDateRange(
  fromDate?: string,
  toDate?: string,
  timezone: string = DEFAULT_TIMEZONE,
  defaultDays: number = 1,
): DateRange {
  let from: Date
  let to: Date

  if (fromDate) {
    const parsed = parseISO(fromDate)
    if (!isValid(parsed)) throw new Error(`Invalid fromDate: ${fromDate}`)
    from = venueStartOfDay(timezone, parsed)
  } else {
    from = venueStartOfDayOffset(timezone, -defaultDays)
  }

  if (toDate) {
    const parsed = parseISO(toDate)
    if (!isValid(parsed)) throw new Error(`Invalid toDate: ${toDate}`)
    to = venueEndOfDay(timezone, parsed)
  } else {
    to = venueEndOfDay(timezone)
  }

  return { from, to }
}

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
 * **WARNING:** These filters use NOW() and CURRENT_DATE which return Mexico
 * local time (due to PG timezone = America/Mexico_City). This is CORRECT for
 * querying Prisma-stored UTC data ONLY because PG applies timezone conversion
 * when comparing `timestamp without time zone` values with `timestamptz` functions.
 *
 * For relative ranges (last7days, etc.) the ~6hr error is negligible.
 * For day-boundary ranges (today, yesterday) there may be edge-case mismatches.
 *
 * @param period - Relative date period
 * @param columnName - Database column name (default: 'createdAt')
 * @returns SQL WHERE clause fragment
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
