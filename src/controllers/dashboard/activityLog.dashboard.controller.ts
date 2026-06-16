import { NextFunction, Request, Response } from 'express'
import { queryVenueActivityLogs, getVenueDistinctActions, getVenueDistinctEntities } from '../../services/dashboard/activity-log.service'

export async function getActivityLog(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = (req as any).authContext
    const result = await queryVenueActivityLogs({
      venueId,
      page: req.query.page ? Number(req.query.page) : undefined,
      pageSize: req.query.pageSize ? Number(req.query.pageSize) : undefined,
      staffId: req.query.staffId as string | undefined,
      action: req.query.action as string | undefined,
      entity: req.query.entity as string | undefined,
      search: req.query.search as string | undefined,
      startDate: req.query.startDate as string | undefined,
      endDate: req.query.endDate as string | undefined,
    })
    res.json({ success: true, data: result })
  } catch (err) {
    next(err)
  }
}

export async function getActivityLogActions(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = (req as any).authContext
    res.json({ success: true, data: await getVenueDistinctActions(venueId) })
  } catch (err) {
    next(err)
  }
}

export async function getActivityLogEntities(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = (req as any).authContext
    res.json({ success: true, data: await getVenueDistinctEntities(venueId) })
  } catch (err) {
    next(err)
  }
}
