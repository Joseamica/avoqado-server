/**
 * Promotions Sales Report Dashboard Controller
 *
 * Capa delgada: resuelve venue + valida query. La lógica vive en
 * promotion-sales.dashboard.service.ts
 */

import type { Request, Response, NextFunction } from 'express'

import logger from '@/config/logger'
import { BadRequestError } from '@/errors/AppError'
import { resolveRequestVenueId } from '@/middlewares/checkPermission.middleware'
import {
  getPromotionSales,
  type PromotionReportType,
  type PromotionSalesFilters,
} from '@/services/dashboard/promotion-sales.dashboard.service'
import prisma from '@/utils/prismaClient'

/**
 * GET /api/v1/dashboard/reports/promotions
 *
 * Reporte de promociones — el combo como renglón, con su nombre.
 *
 * Query params:
 * - startDate: ISO date string o YYYY-MM-DD (requerido)
 * - endDate:   ISO date string o YYYY-MM-DD (requerido)
 * - reportType: 'summary' | 'hours' | 'days' | 'weeks' | 'months' (opcional, default 'summary')
 *
 * @permission reports:read
 * @feature PROMOTIONS (Pro)
 */
export async function promotionSalesReport(req: Request, res: Response, next: NextFunction) {
  try {
    // Mismo criterio que los demás reportes: `:venueId` -> header `x-venue-id` -> venue del JWT,
    // para que el reporte siga al venue activo y no al que traía el token del login.
    const venueId = resolveRequestVenueId(req, req.authContext!)
    if (!venueId) {
      throw new BadRequestError('No venue context for the request')
    }

    const { startDate, endDate, reportType } = req.query

    if (!startDate || typeof startDate !== 'string') {
      throw new BadRequestError('startDate is required (ISO date string)')
    }
    if (!endDate || typeof endDate !== 'string') {
      throw new BadRequestError('endDate is required (ISO date string)')
    }

    const validReportTypes: PromotionReportType[] = ['summary', 'hours', 'days', 'weeks', 'months']
    if (reportType && !validReportTypes.includes(reportType as PromotionReportType)) {
      throw new BadRequestError(`Invalid reportType value. Must be one of: ${validReportTypes.join(', ')}`)
    }

    const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } })

    const filters: PromotionSalesFilters = {
      startDate,
      endDate,
      reportType: (reportType as PromotionReportType) || 'summary',
      timezone: venue?.timezone || 'America/Mexico_City',
    }

    const report = await getPromotionSales(venueId, filters)

    res.json({ success: true, data: report })
  } catch (error) {
    logger.error('Promotion sales report error:', error)
    next(error)
  }
}
