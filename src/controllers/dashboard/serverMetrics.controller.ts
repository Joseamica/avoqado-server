import { Request, Response, NextFunction } from 'express'
import { getCurrentMetrics, getMetricsHistory, getActiveAlerts } from '../../services/superadmin/serverMetrics.service'

/**
 * Get server metrics (current + history + alerts)
 *
 * @route GET /api/v1/dashboard/superadmin/server-metrics
 */
export const getServerMetrics = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const current = getCurrentMetrics()
    const history = getMetricsHistory()
    const alerts = getActiveAlerts()

    return res.status(200).json({
      current,
      history,
      alerts,
    })
  } catch (error) {
    next(error)
  }
}
