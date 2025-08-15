import { NextFunction, Request, Response } from 'express'
import * as generalStatsService from '../../services/dashboard/generalStats.dashboard.service'
import { GeneralStatsQuery } from '../../schemas/dashboard/generalStats.schema'

/**
 * Controller para obtener estadísticas generales del dashboard
 * Ruta: GET /api/v1/dashboard/venues/:venueId/general-stats
 */
export async function getGeneralStats(
  req: Request<{ venueId: string }, {}, {}, GeneralStatsQuery>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId } = req.params
    const filters = req.query

    const generalStats = await generalStatsService.getGeneralStatsData(venueId, filters)

    res.status(200).json(generalStats)
  } catch (error) {
    next(error)
  }
}

/**
 * Controller para obtener métricas básicas del dashboard (carga prioritaria)
 * Ruta: GET /api/v1/dashboard/venues/:venueId/basic-metrics
 */
export async function getBasicMetrics(
  req: Request<{ venueId: string }, {}, {}, GeneralStatsQuery>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId } = req.params
    const filters = req.query

    const basicMetrics = await generalStatsService.getBasicMetricsData(venueId, filters)

    res.status(200).json(basicMetrics)
  } catch (error) {
    next(error)
  }
}

/**
 * Controller para obtener datos de charts específicos
 * Ruta: GET /api/v1/dashboard/venues/:venueId/charts/:chartType
 */
export async function getChartData(
  req: Request<{ venueId: string; chartType: string }, {}, {}, GeneralStatsQuery>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId, chartType } = req.params
    const filters = req.query

    const chartData = await generalStatsService.getChartData(venueId, chartType, filters)

    res.status(200).json(chartData)
  } catch (error) {
    next(error)
  }
}

/**
 * Controller para obtener métricas extendidas específicas
 * Ruta: GET /api/v1/dashboard/venues/:venueId/metrics/:metricType
 */
export async function getExtendedMetrics(
  req: Request<{ venueId: string; metricType: string }, {}, {}, GeneralStatsQuery>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId, metricType } = req.params
    const filters = req.query

    const metricsData = await generalStatsService.getExtendedMetrics(venueId, metricType, filters)

    res.status(200).json(metricsData)
  } catch (error) {
    next(error)
  }
}
