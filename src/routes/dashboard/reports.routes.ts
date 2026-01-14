/**
 * Dashboard Reports Routes
 *
 * Financial and operational reports for venue management.
 */

import express from 'express'

import { payLaterAgingReport } from '@/controllers/dashboard/reports.dashboard.controller'
import { salesSummaryReport } from '@/controllers/dashboard/sales-summary.dashboard.controller'
import { salesByItemReport } from '@/controllers/dashboard/sales-by-item.dashboard.controller'
import { checkPermission } from '@/middlewares/checkPermission.middleware'

const router = express.Router()

/**
 * GET /api/v1/dashboard/reports/pay-later-aging
 *
 * Pay-Later Aging Report
 * Shows all pay-later orders grouped by age (0-30, 31-60, 61-90, 90+ days)
 *
 * @permission tpv-reports:pay-later-aging
 */
router.get('/pay-later-aging', checkPermission('tpv-reports:pay-later-aging'), payLaterAgingReport)

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
 * @permission reports:read
 */
router.get('/sales-summary', checkPermission('reports:read'), salesSummaryReport)

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
 */
router.get('/sales-by-item', checkPermission('reports:read'), salesByItemReport)

export default router
