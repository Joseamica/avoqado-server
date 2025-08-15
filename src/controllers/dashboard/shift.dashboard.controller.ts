import { NextFunction, Request, Response } from 'express'
import * as shiftDashboardService from '../../services/dashboard/shift.dashboard.service'

export async function getShifts(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const venueId: string = req.params.venueId

    const page = Number(req.query.page || '1')
    const pageSize = Number(req.query.pageSize || '10')

    if (isNaN(page) || isNaN(pageSize) || page <= 0 || pageSize <= 0) {
      res.status(400).json({
        error: 'Invalid pagination parameters. page and pageSize must be positive numbers',
      })
      return
    }

    const filters = {
      staffId: req.query.staffId as string,
      startTime: req.query.startTime as string,
      endTime: req.query.endTime as string,
    }

    const result = await shiftDashboardService.getShifts(venueId, page, pageSize, filters)

    res.status(200).json(result)
  } catch (error) {
    next(error)
  }
}

export async function getShift(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const venueId: string = req.params.venueId
    const shiftId: string = req.params.shiftId

    const result = await shiftDashboardService.getShiftById(venueId, shiftId)

    if (!result) {
      res.status(404).json({
        error: 'Shift not found',
      })
      return
    }

    res.status(200).json(result)
  } catch (error) {
    next(error)
  }
}

export async function getShiftsSummary(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const venueId: string = req.params.venueId

    const filters = {
      staffId: req.query.staffId as string,
      startTime: req.query.startTime as string,
      endTime: req.query.endTime as string,
    }

    const result = await shiftDashboardService.getShiftsSummary(venueId, filters)

    res.status(200).json(result)
  } catch (error) {
    next(error)
  }
}