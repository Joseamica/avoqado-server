import prisma from '@/utils/prismaClient'
import { getChartData } from '@/services/dashboard/generalStats.dashboard.service'
import { venueStartOfDay, venueEndOfDay } from '@/utils/datetime'

/**
 * MCP wrapper for getChartData that fixes the venue-local date window.
 *
 * getChartData → parseDateRange parses a bare `YYYY-MM-DD` as UTC midnight and
 * uses it as the START of `to` (not end-of-day), with NO timezone conversion. So
 * a bare `toDate: "2026-06-15"` silently (a) drops the whole last day and (b)
 * shifts the window ~6h early for a UTC-6 venue — the operator's "today" vanishes
 * and totals undercount. (The dashboard avoids this by sending precise
 * timestamps, which is why the two disagreed.)
 *
 * Here we convert the operator's venue-LOCAL dates to real UTC instants:
 * fromDate → venue start-of-day, toDate → venue end-of-day. The noon anchor keeps
 * the intended calendar day regardless of server timezone (same pattern as
 * list_payments). Omitted dates fall through to getChartData's own default
 * (last 7 days .. now), which is instant-based and already correct.
 */
export async function getVenueChartData(
  venueId: string,
  chartType: string,
  range: { fromDate?: string; toDate?: string },
): Promise<unknown> {
  const tz = (await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } }))?.timezone || 'America/Mexico_City'
  const fromDate = range.fromDate ? venueStartOfDay(tz, new Date(`${range.fromDate}T12:00:00`)).toISOString() : undefined
  const toDate = range.toDate ? venueEndOfDay(tz, new Date(`${range.toDate}T12:00:00`)).toISOString() : undefined
  return getChartData(venueId, chartType, { fromDate, toDate })
}
