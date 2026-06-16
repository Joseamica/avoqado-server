/**
 * Dashboard Reports Routes
 *
 * Financial and operational reports for venue management.
 *
 * Plan-tier gating (Pro feature ADVANCED_REPORTS — grandfathered/demo venues bypass):
 *   - sales-by-item & refunds: fully gated with checkFeatureAccess('ADVANCED_REPORTS').
 *   - sales-summary: NOT 403'd — the Free plan includes a basic TODAY-only summary, so a
 *     non-entitled venue is range-clamped to "today" in the venue's timezone instead
 *     (403 code PLAN_LIMIT_RANGE for any other range).
 *   - pay-later-aging: own permission, NOT part of ADVANCED_REPORTS — left ungated.
 */

import express, { Request, Response, NextFunction } from 'express'
import { formatInTimeZone } from 'date-fns-tz'

import { payLaterAgingReport } from '@/controllers/dashboard/reports.dashboard.controller'
import { salesSummaryReport, salesSummaryExport } from '@/controllers/dashboard/sales-summary.dashboard.controller'
import { salesByItemReport } from '@/controllers/dashboard/sales-by-item.dashboard.controller'
import { refundsReport } from '@/controllers/dashboard/refunds.dashboard.controller'
import { checkPermission, resolveRequestVenueId } from '@/middlewares/checkPermission.middleware'
import { checkFeatureAccess } from '@/middlewares/checkFeatureAccess.middleware'
import { venueHasFeatureAccess } from '@/services/access/basePlan.service'
import prisma from '@/utils/prismaClient'

const router = express.Router()

/** Stable error code when a Free venue requests a sales-summary range beyond "today". */
export const PLAN_LIMIT_RANGE_CODE = 'PLAN_LIMIT_RANGE'

/**
 * Range clamp for the Free-tier basic sales summary.
 *
 * Entitled venues (ADVANCED_REPORTS via tier blanket / own grant / grandfathered / demo —
 * resolved by venueHasFeatureAccess) pass through untouched, any range allowed.
 * Non-entitled venues may ONLY query "today" in the venue's timezone: both startDate and
 * endDate must fall on today's calendar date there (the dashboard sends start/end-of-day
 * instants for that same date). Anything else → 403 with stable code PLAN_LIMIT_RANGE
 * (SEAT_CAP_REACHED-style) and a user-facing Spanish message.
 *
 * Missing/invalid dates fall through to the controller/service, which already 400 on them.
 */
export async function clampSalesSummaryRangeToToday(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const authContext = (req as any).authContext
    const venueId = resolveRequestVenueId(req, authContext || {})
    if (!venueId) return next() // controller surfaces its own missing-venue error

    if (await venueHasFeatureAccess(venueId, 'ADVANCED_REPORTS')) return next()

    const { startDate, endDate } = req.query
    if (typeof startDate !== 'string' || typeof endDate !== 'string') return next() // controller 400s
    const start = new Date(startDate)
    const end = new Date(endDate)
    if (isNaN(start.getTime()) || isNaN(end.getTime())) return next() // service 400s

    const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } })
    const timezone = venue?.timezone || 'America/Mexico_City'
    const todayKey = formatInTimeZone(new Date(), timezone, 'yyyy-MM-dd')
    const startKey = formatInTimeZone(start, timezone, 'yyyy-MM-dd')
    const endKey = formatInTimeZone(end, timezone, 'yyyy-MM-dd')
    if (startKey === todayKey && endKey === todayKey) return next()

    res.status(403).json({
      error: 'Plan limit',
      message: 'El histórico de ventas requiere el plan Pro. El plan Gratis incluye el resumen de ventas de hoy.',
      code: PLAN_LIMIT_RANGE_CODE,
      featureCode: 'ADVANCED_REPORTS',
      subscriptionRequired: true,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * GET /api/v1/dashboard/reports/pay-later-aging
 *
 * Pay-Later Aging Report
 * Shows all pay-later orders grouped by age (0-30, 31-60, 61-90, 90+ days)
 *
 * @permission tpv-reports:pay-later-aging
 */
router.get('/pay-later-aging', checkPermission('tpv-reports:pay-later-aging'), payLaterAgingReport)
router.get('/venues/:venueId/pay-later-aging', checkPermission('tpv-reports:pay-later-aging'), payLaterAgingReport)

/**
 * GET /api/v1/dashboard/reports/sales-summary
 *
 * Sales Summary Report
 * Comprehensive sales metrics including gross/net sales, discounts, refunds, taxes, tips
 *
 * Query params:
 * - startDate: ISO date string (required)
 * - endDate: ISO date string (required)
 * - groupBy: 'none' | 'paymentMethod' (optional)
 *
 * Free venues are clamped to a today-only range (see clampSalesSummaryRangeToToday);
 * ADVANCED_REPORTS-entitled venues query any range.
 *
 * @permission reports:read
 */
router.get('/sales-summary', checkPermission('reports:read'), clampSalesSummaryRangeToToday, salesSummaryReport)

/**
 * GET /api/v1/dashboard/reports/sales-summary/export
 * Streams CSV/XLSX/PDF. mode=summary (Free=today via clamp) | mode=detailed (PREMIUM TRANSACTION_EXPORT).
 * @permission reports:read
 */
router.get('/sales-summary/export', checkPermission('reports:read'), clampSalesSummaryRangeToToday, salesSummaryExport)
router.get('/venues/:venueId/sales-summary/export', checkPermission('reports:read'), clampSalesSummaryRangeToToday, salesSummaryExport)

/**
 * GET /api/v1/dashboard/reports/sales-by-item
 *
 * Sales by Item Report
 * Item-level sales metrics including quantity sold, gross sales, discounts
 *
 * Query params:
 * - startDate: ISO date string (required)
 * - endDate: ISO date string (required)
 * - reportType: 'summary' | 'hours' | 'days' | 'weeks' | 'months' | 'hourlySum' | 'dailySum' (optional)
 * - groupBy: 'none' | 'category' | 'channel' | ... (optional)
 *
 * @permission reports:read
 * @feature ADVANCED_REPORTS (Pro) — also serves the Sales-by-Category report (groupBy=category)
 */
router.get('/sales-by-item', checkFeatureAccess('ADVANCED_REPORTS'), checkPermission('reports:read'), salesByItemReport)

/**
 * GET /api/v1/dashboard/reports/refunds
 *
 * Refunds Report
 * Every refund issued for a venue over a date range (amount, tip, method, reason,
 * note, original order, who processed it) plus totals and a breakdown by reason.
 *
 * Query params:
 * - startDate: ISO date string (required)
 * - endDate: ISO date string (required)
 *
 * @permission reports:read
 * @feature ADVANCED_REPORTS (Pro)
 */
router.get('/refunds', checkFeatureAccess('ADVANCED_REPORTS'), checkPermission('reports:read'), refundsReport)

export default router
