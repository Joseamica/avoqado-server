/**
 * Refunds Report Dashboard Controller
 *
 * Thin controller layer for the refunds report.
 * Business logic lives in refunds.dashboard.service.ts
 */

import type { Request, Response, NextFunction } from 'express'

import logger from '@/config/logger'
import { getRefundsReport, RefundsReportFilters } from '@/services/dashboard/refunds.dashboard.service'
import { BadRequestError } from '@/errors/AppError'
import { resolveRequestVenueId } from '@/middlewares/checkPermission.middleware'

/**
 * GET /api/v1/dashboard/reports/refunds
 *
 * Refunds Report — every refund issued for a venue over a date range.
 *
 * Query params:
 * - startDate: ISO date string (required)
 * - endDate: ISO date string (required)
 *
 * @permission reports:read
 */
export async function refundsReport(req: Request, res: Response, next: NextFunction) {
  try {
    // Resolve the DATA venue the same way checkPermission('reports:read') did
    // (`:venueId` param -> `x-venue-id` header -> JWT venue), so the report follows
    // the user's active/URL venue instead of the stale JWT venue from login.
    const venueId = resolveRequestVenueId(req, req.authContext!)
    if (!venueId) {
      throw new BadRequestError('No venue context for the request')
    }

    const { startDate, endDate } = req.query

    if (!startDate || typeof startDate !== 'string') {
      throw new BadRequestError('startDate is required (ISO date string)')
    }
    if (!endDate || typeof endDate !== 'string') {
      throw new BadRequestError('endDate is required (ISO date string)')
    }

    const filters: RefundsReportFilters = { startDate, endDate }

    const report = await getRefundsReport(venueId, filters)

    res.json({
      success: true,
      data: report,
    })
  } catch (error) {
    logger.error('Refunds report error:', error)
    next(error)
  }
}
