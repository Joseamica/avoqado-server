/**
 * TPV Reports Controller
 *
 * **THIN CONTROLLER PATTERN**: This controller only orchestrates HTTP concerns.
 * All business logic lives in services (HTTP-agnostic).
 *
 * Responsibilities:
 * - Extract and validate request data
 * - Call service methods
 * - Send HTTP responses
 *
 * Does NOT contain:
 * - Business logic
 * - Database queries
 * - Calculations
 */

import { Request, Response, NextFunction } from 'express'
import * as HistoricalReportsService from '@/services/tpv/historical-reports.service'
import AppError from '@/errors/AppError'

/**
 * GET /api/v1/tpv/venues/:venueId/reports/historical
 *
 * Get historical sales summaries grouped by time period
 *
 * Query params:
 * - grouping: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'YEARLY'
 * - startDate: ISO 8601 (UTC)
 * - endDate: ISO 8601 (UTC)
 * - cursor?: string (timestamp for pagination)
 * - limit?: number (default 20)
 */
export async function getHistoricalReports(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const { grouping, startDate, endDate, cursor, limit } = req.query

    // Validate required parameters
    if (!grouping || !startDate || !endDate) {
      throw new AppError('grouping, startDate, and endDate are required', 400)
    }

    // Validate grouping enum
    const validGroupings = ['DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY']
    if (!validGroupings.includes(grouping as string)) {
      throw new AppError(`Invalid grouping. Must be one of: ${validGroupings.join(', ')}`, 400)
    }

    // Parse dates
    const start = new Date(startDate as string)
    const end = new Date(endDate as string)

    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      throw new AppError('Invalid date format. Use ISO 8601 format.', 400)
    }

    // Call service
    const result = await HistoricalReportsService.getHistoricalSummaries(
      venueId,
      grouping as HistoricalReportsService.HistoricalGrouping,
      start,
      end,
      cursor as string | undefined,
      limit ? parseInt(limit as string) : 20,
    )

    res.json({
      success: true,
      data: result,
    })
  } catch (error) {
    next(error)
  }
}
