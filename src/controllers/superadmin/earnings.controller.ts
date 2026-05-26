import { Request, Response, NextFunction } from 'express'
import * as earningsService from '../../services/superadmin/earnings.service'

function parseRange(req: Request) {
  const { startDate, endDate } = req.query
  return {
    startDate: startDate ? new Date(startDate as string) : undefined,
    endDate: endDate ? new Date(endDate as string) : undefined,
  }
}

function parseFilter(req: Request) {
  const { venueId, merchantAccountId } = req.query
  return {
    venueId: typeof venueId === 'string' ? venueId : undefined,
    merchantAccountId: typeof merchantAccountId === 'string' ? merchantAccountId : undefined,
  }
}

/** GET /api/v1/superadmin/earnings/summary */
export async function getEarningsSummary(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await earningsService.getEarningsSummary(parseRange(req), parseFilter(req))
    res.json({ success: true, data })
  } catch (error) {
    next(error)
  }
}

/** GET /api/v1/superadmin/earnings/time-series */
export async function getEarningsTimeSeries(req: Request, res: Response, next: NextFunction) {
  try {
    const granularity = (req.query.granularity as 'daily' | 'weekly' | 'monthly') || 'daily'
    const data = await earningsService.getEarningsTimeSeries(parseRange(req), granularity, parseFilter(req))
    res.json({ success: true, data, meta: { granularity } })
  } catch (error) {
    next(error)
  }
}
