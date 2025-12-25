/**
 * Dashboard Reports Controller
 *
 * Thin controller layer for dashboard reports.
 * Business logic lives in reports.dashboard.service.ts
 */

import type { Request, Response, NextFunction } from 'express'

import logger from '@/config/logger'
import { getPayLaterAgingReport } from '@/services/dashboard/reports.dashboard.service'

/**
 * GET /api/v1/dashboard/reports/pay-later-aging
 *
 * Pay-Later Aging Report - shows all pay-later orders grouped by age brackets
 */
export async function payLaterAgingReport(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.authContext!

    const report = await getPayLaterAgingReport(venueId)

    res.json({
      success: true,
      data: report,
    })
  } catch (error) {
    logger.error('Pay-later aging report error:', error)
    next(error)
  }
}
