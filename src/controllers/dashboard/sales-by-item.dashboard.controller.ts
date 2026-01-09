/**
 * Sales by Item Dashboard Controller
 *
 * Thin controller layer for sales by item reports.
 * Business logic lives in sales-by-item.dashboard.service.ts
 */

import type { Request, Response, NextFunction } from 'express'

import logger from '@/config/logger'
import { getSalesByItem, SalesByItemFilters, ReportType, GroupByOption } from '@/services/dashboard/sales-by-item.dashboard.service'
import { BadRequestError } from '@/errors/AppError'
import prisma from '@/utils/prismaClient'

/**
 * GET /api/v1/dashboard/reports/sales-by-item
 *
 * Sales by Item Report - item-level sales metrics for a venue
 *
 * Query params:
 * - startDate: ISO date string (required)
 * - endDate: ISO date string (required)
 * - reportType: 'summary' | 'hours' | 'days' | 'weeks' | 'months' | 'hourlySum' | 'dailySum' (optional, default: 'summary')
 * - groupBy: 'none' | 'category' | 'channel' | ... (optional, default: 'none')
 * - startHour: 'HH:mm' format (optional, e.g. '09:00')
 * - endHour: 'HH:mm' format (optional, e.g. '17:00')
 *
 * @permission reports:read
 */
export async function salesByItemReport(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.authContext!
    const {
      startDate,
      endDate,
      reportType,
      groupBy,
      startHour,
      endHour,
      categoryId,
      productId,
      channel,
      paymentMethod,
    } = req.query

    // Validate required params
    if (!startDate || typeof startDate !== 'string') {
      throw new BadRequestError('startDate is required (ISO date string)')
    }
    if (!endDate || typeof endDate !== 'string') {
      throw new BadRequestError('endDate is required (ISO date string)')
    }

    // Validate reportType param
    const validReportTypes: ReportType[] = ['summary', 'hours', 'days', 'weeks', 'months', 'hourlySum', 'dailySum']
    if (reportType && !validReportTypes.includes(reportType as ReportType)) {
      throw new BadRequestError(`Invalid reportType value. Must be one of: ${validReportTypes.join(', ')}`)
    }

    // Validate groupBy param
    const validGroupBy: GroupByOption[] = ['none', 'category', 'channel', 'paymentMethod', 'device', 'source', 'serviceOption', 'itemType']
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
      reportType: (reportType as ReportType) || 'summary',
      groupBy: (groupBy as GroupByOption) || 'none',
      timezone: venue?.timezone || 'America/Mexico_City',
      startHour: startHour as string | undefined,
      endHour: endHour as string | undefined,
      categoryId: categoryId as string | undefined,
      productId: productId as string | undefined,
      channel: channel as string | undefined,
      paymentMethod: paymentMethod as string | undefined,
    }

    const report = await getSalesByItem(venueId, filters)

    res.json({
      success: true,
      data: report,
    })
  } catch (error) {
    logger.error('Sales by item report error:', error)
    next(error)
  }
}
