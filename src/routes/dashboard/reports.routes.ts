/**
 * Dashboard Reports Routes
 *
 * Financial and operational reports for venue management.
 */

import express from 'express'

import { payLaterAgingReport } from '@/controllers/dashboard/reports.dashboard.controller'
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

export default router
