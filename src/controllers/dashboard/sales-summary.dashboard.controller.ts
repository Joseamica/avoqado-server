/**
 * Sales Summary Dashboard Controller
 *
 * Thin controller layer for sales summary reports.
 * Business logic lives in sales-summary.dashboard.service.ts
 */

import type { Request, Response, NextFunction } from 'express'

import logger from '@/config/logger'
import { getSalesSummary, SalesSummaryFilters, ReportType } from '@/services/dashboard/sales-summary.dashboard.service'
import { BadRequestError } from '@/errors/AppError'
import prisma from '@/utils/prismaClient'

/**
 * GET /api/v1/dashboard/reports/sales-summary
 *
 * Sales Summary Report - comprehensive sales metrics for a venue
 *
 * Query params:
 * - startDate: ISO date string (required)
 * - endDate: ISO date string (required)
 * - groupBy: 'none' | 'paymentMethod' (optional, default: 'none')
 * - reportType: 'summary' | 'hours' | 'days' | 'weeks' | 'months' | 'hourlySum' | 'dailySum' (optional, default: 'summary')
 *
 * @permission reports:read
 */
export async function salesSummaryReport(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.authContext!
    const { startDate, endDate, groupBy, reportType } = req.query

    // Validate required params
    if (!startDate || typeof startDate !== 'string') {
      throw new BadRequestError('startDate is required (ISO date string)')
    }
    if (!endDate || typeof endDate !== 'string') {
      throw new BadRequestError('endDate is required (ISO date string)')
    }

    // Validate groupBy param
    const validGroupBy = ['none', 'paymentMethod']
    if (groupBy && !validGroupBy.includes(groupBy as string)) {
      throw new BadRequestError(`Invalid groupBy value. Must be one of: ${validGroupBy.join(', ')}`)
    }

    // Validate reportType param
    const validReportTypes: ReportType[] = ['summary', 'hours', 'days', 'weeks', 'months', 'hourlySum', 'dailySum']
    if (reportType && !validReportTypes.includes(reportType as ReportType)) {
      throw new BadRequestError(`Invalid reportType value. Must be one of: ${validReportTypes.join(', ')}`)
    }

    // Fetch venue timezone
    const venue = await prisma.venue.findUnique({
      where: { id: venueId },
      select: { timezone: true },
    })

    const filters: SalesSummaryFilters = {
      startDate,
      endDate,
      groupBy: (groupBy as 'none' | 'paymentMethod') || 'none',
      reportType: (reportType as ReportType) || 'summary',
      timezone: venue?.timezone || 'America/Mexico_City',
    }

    const report = await getSalesSummary(venueId, filters)

    res.json({
      success: true,
      data: report,
    })
  } catch (error) {
    logger.error('Sales summary report error:', error)
    next(error)
  }
}
