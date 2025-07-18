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
