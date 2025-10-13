import { Request, Response, NextFunction } from 'express'
import * as paymentAnalyticsService from '../../services/superadmin/paymentAnalytics.service'
import logger from '../../config/logger'

/**
 * PaymentAnalytics Controller
 *
 * REST API endpoints for payment analytics and profit reporting.
 * All endpoints require SUPERADMIN role (enforced by parent router middleware).
 */

/**
 * GET /api/v1/superadmin/payment-analytics/profit-metrics
 * Get comprehensive profit metrics for a date range
 * Query params: ?startDate=2024-01-01&endDate=2024-12-31
 */
export async function getProfitMetrics(req: Request, res: Response, next: NextFunction) {
  try {
    const { startDate, endDate } = req.query

    const dateRange = {
      startDate: startDate ? new Date(startDate as string) : undefined,
      endDate: endDate ? new Date(endDate as string) : undefined,
    }

    const metrics = await paymentAnalyticsService.getProfitMetrics(dateRange)

    res.json({
      success: true,
      data: metrics,
      dateRange: {
        startDate: dateRange.startDate?.toISOString(),
        endDate: dateRange.endDate?.toISOString(),
      },
    })
  } catch (error) {
    next(error)
  }
}

/**
 * GET /api/v1/superadmin/payment-analytics/venue/:venueId
 * Get venue-specific profit metrics
 * Query params: ?startDate=2024-01-01&endDate=2024-12-31
 */
export async function getVenueProfitMetrics(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const { startDate, endDate } = req.query

    const dateRange = {
      startDate: startDate ? new Date(startDate as string) : undefined,
      endDate: endDate ? new Date(endDate as string) : undefined,
    }

    const metrics = await paymentAnalyticsService.getVenueProfitMetrics(venueId, dateRange)

    res.json({
      success: true,
      data: metrics,
      dateRange: {
        startDate: dateRange.startDate?.toISOString(),
        endDate: dateRange.endDate?.toISOString(),
      },
    })
  } catch (error) {
    next(error)
  }
}

/**
 * GET /api/v1/superadmin/payment-analytics/time-series
 * Get time-series profit data
 * Query params: ?startDate=2024-01-01&endDate=2024-12-31&granularity=daily
 */
export async function getProfitTimeSeries(req: Request, res: Response, next: NextFunction) {
  try {
    const { startDate, endDate, granularity } = req.query

    const dateRange = {
      startDate: startDate ? new Date(startDate as string) : undefined,
      endDate: endDate ? new Date(endDate as string) : undefined,
    }

    const validGranularity = granularity as 'daily' | 'weekly' | 'monthly' | undefined

    const timeSeries = await paymentAnalyticsService.getProfitTimeSeries(dateRange, validGranularity || 'daily')

    res.json({
      success: true,
      data: timeSeries,
      granularity: validGranularity || 'daily',
      dateRange: {
        startDate: dateRange.startDate?.toISOString(),
        endDate: dateRange.endDate?.toISOString(),
      },
    })
  } catch (error) {
    next(error)
  }
}

/**
 * GET /api/v1/superadmin/payment-analytics/provider-comparison
 * Get provider cost comparison
 * Query params: ?startDate=2024-01-01&endDate=2024-12-31
 */
export async function getProviderComparison(req: Request, res: Response, next: NextFunction) {
  try {
    const { startDate, endDate } = req.query

    const dateRange = {
      startDate: startDate ? new Date(startDate as string) : undefined,
      endDate: endDate ? new Date(endDate as string) : undefined,
    }

    const comparison = await paymentAnalyticsService.getProviderComparison(dateRange)

    res.json({
      success: true,
      data: comparison,
      dateRange: {
        startDate: dateRange.startDate?.toISOString(),
        endDate: dateRange.endDate?.toISOString(),
      },
    })
  } catch (error) {
    next(error)
  }
}

/**
 * GET /api/v1/superadmin/payment-analytics/export
 * Export profit data for a date range
 * Query params: ?startDate=2024-01-01&endDate=2024-12-31&format=json
 */
export async function exportProfitData(req: Request, res: Response, next: NextFunction) {
  try {
    const { startDate, endDate, format } = req.query

    const dateRange = {
      startDate: startDate ? new Date(startDate as string) : undefined,
      endDate: endDate ? new Date(endDate as string) : undefined,
    }

    const exportData = await paymentAnalyticsService.exportProfitData(dateRange)

    logger.info('Profit data export requested', {
      requestedBy: (req as any).user?.uid,
      rows: exportData.length,
      format: format || 'json',
    })

    // Return JSON format (future: support CSV)
    if (format === 'csv') {
      // TODO: Convert to CSV format
      res.setHeader('Content-Type', 'text/csv')
      res.setHeader('Content-Disposition', `attachment; filename=profit-export-${Date.now()}.csv`)
      // For now, return JSON
      res.json({
        success: true,
        message: 'CSV export not yet implemented. Returning JSON format.',
        data: exportData,
      })
    } else {
      res.json({
        success: true,
        data: exportData,
        count: exportData.length,
        dateRange: {
          startDate: dateRange.startDate?.toISOString(),
          endDate: dateRange.endDate?.toISOString(),
        },
      })
    }
  } catch (error) {
    next(error)
  }
}
