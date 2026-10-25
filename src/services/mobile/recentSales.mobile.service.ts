import { startOfDay, subDays } from 'date-fns'
import { fromZonedTime, toZonedTime } from 'date-fns-tz'

export const RECENT_SALES_DAYS = 30
export const RECENT_SALE_MAX_LINES = 200
export const RECENT_SALES_OVERLAP_MS = 120_000
export const RECENT_SALES_MAX_DELTA_AGE_MS = 7 * 86_400_000
export const RECENT_SALES_FUTURE_SKEW_MS = 300_000

export function recentSalesWindowStart(now: Date, timezone: string): Date {
  return fromZonedTime(startOfDay(subDays(toZonedTime(now, timezone), RECENT_SALES_DAYS - 1)), timezone)
}
