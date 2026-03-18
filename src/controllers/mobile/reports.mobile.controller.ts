/**
 * Reports Mobile Controller
 *
 * Thin wrapper around dashboard report services for mobile apps.
 * Key difference: mobile takes venueId from req.params (not req.authContext).
 */

import type { Request, Response, NextFunction } from 'express'

import logger from '@/config/logger'
import { getSalesSummary, SalesSummaryFilters, ReportType } from '@/services/dashboard/sales-summary.dashboard.service'
import { getSalesByItem, SalesByItemFilters, GroupByOption } from '@/services/dashboard/sales-by-item.dashboard.service'
import { BadRequestError } from '@/errors/AppError'
import prisma from '@/utils/prismaClient'

/**
 * GET /api/v1/mobile/venues/:venueId/reports/sales-summary
 *
 * Sales Summary Report - comprehensive sales metrics for a venue
 *
 * Query params:
 * - startDate: ISO date string (required)
 * - endDate: ISO date string (required)
 * - groupBy: 'none' | 'paymentMethod' (optional, default: 'paymentMethod')
 * - reportType: 'summary' | 'hours' | 'days' | 'weeks' | 'months' | 'hourlySum' | 'dailySum' (optional, default: 'hourlySum')
 *
 * @permission reports:read
 */
export async function salesSummary(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
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
      groupBy: (groupBy as 'none' | 'paymentMethod') || 'paymentMethod',
      reportType: (reportType as ReportType) || 'hourlySum',
      timezone: venue?.timezone || 'America/Mexico_City',
    }

    const report = await getSalesSummary(venueId, filters)

    res.json({
      success: true,
      data: report,
    })
  } catch (error) {
    logger.error('Mobile sales summary report error:', error)
    next(error)
  }
}

/**
 * GET /api/v1/mobile/venues/:venueId/reports/sales-by-item
 *
 * Sales by Item Report - item-level sales metrics for a venue
 *
 * Query params:
 * - startDate: ISO date string (required)
 * - endDate: ISO date string (required)
 * - groupBy: 'none' | 'category' (optional, default: 'none')
 *
 * @permission reports:read
 */
export async function salesByItem(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const { startDate, endDate, groupBy } = req.query

    // Validate required params
    if (!startDate || typeof startDate !== 'string') {
      throw new BadRequestError('startDate is required (ISO date string)')
    }
    if (!endDate || typeof endDate !== 'string') {
      throw new BadRequestError('endDate is required (ISO date string)')
    }

    // Validate groupBy param
    const validGroupBy: GroupByOption[] = ['none', 'category']
    if (groupBy && !validGroupBy.includes(groupBy as GroupByOption)) {
      throw new BadRequestError(`Invalid groupBy value. Must be one of: ${validGroupBy.join(', ')}`)
    }

    // Fetch venue timezone
    const venue = await prisma.venue.findUnique({
      where: { id: venueId },
      select: { timezone: true },
    })

    const filters: SalesByItemFilters = {
      startDate,
      endDate,
      reportType: 'summary',
      groupBy: (groupBy as GroupByOption) || 'none',
      timezone: venue?.timezone || 'America/Mexico_City',
    }

    const report = await getSalesByItem(venueId, filters)

    res.json({
      success: true,
      data: report,
    })
  } catch (error) {
    logger.error('Mobile sales by item report error:', error)
    next(error)
  }
}
