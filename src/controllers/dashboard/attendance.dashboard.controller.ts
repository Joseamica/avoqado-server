import { NextFunction, Request, Response } from 'express'
import * as attendanceService from '../../services/dashboard/attendance.dashboard.service'
import type { TimeEntryStatus } from '@prisma/client'

export async function getTimeEntries(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const venueId: string = req.params.venueId
    const result = await attendanceService.getVenueTimeEntries(venueId, {
      staffId: req.query.staffId as string | undefined,
      startDate: req.query.startDate as string | undefined,
      endDate: req.query.endDate as string | undefined,
      status: req.query.status as TimeEntryStatus | undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      offset: req.query.offset ? Number(req.query.offset) : undefined,
    })
    res.status(200).json(result)
  } catch (error) {
    next(error)
  }
}

export async function getActiveStaff(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await attendanceService.getVenueActiveStaff(req.params.venueId)
    res.status(200).json(result)
  } catch (error) {
    next(error)
  }
}

export async function getStaffTimeSummary(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId, staffId } = req.params
    const result = await attendanceService.getVenueStaffTimeSummary(
      venueId,
      staffId,
      req.query.startDate as string,
      req.query.endDate as string,
    )
    res.status(200).json(result)
  } catch (error) {
    next(error)
  }
}

export async function validateTimeEntry(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId, timeEntryId } = req.params
    const validatedById = req.authContext?.userId

    if (!validatedById) {
      res.status(401).json({ error: 'Authentication required' })
      return
    }

    const { status, note } = req.body
    const result = await attendanceService.validateVenueTimeEntry(venueId, timeEntryId, validatedById, status, note)
    res.status(200).json(result)
  } catch (error) {
    next(error)
  }
}
