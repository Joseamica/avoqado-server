import { NextFunction, Request, Response } from 'express'

import * as shiftTpvService from '../../services/tpv/shift.tpv.service'

/**
 * Open a new shift for a venue
 * Can work with both integrated POS and standalone mode
 */
export async function openShift(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const orgId = req.authContext?.orgId
    const venueId: string = req.params.venueId

    // Extract data from request body
    const { staffId, startingCash, stationId } = req.body

    // Validate required fields
    if (!staffId) {
      res.status(400).json({
        success: false,
        message: 'staffId is required',
      })
      return
    }

    // Call service to handle the shift opening
    const shift = await shiftTpvService.openShiftForVenue(venueId, staffId, startingCash || 0, stationId, orgId)

    res.status(201).json({
      success: true,
      data: shift,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Close an existing shift for a venue
 * Can work with both integrated POS and standalone mode
 */
export async function closeShift(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const orgId = req.authContext?.orgId
    const venueId: string = req.params.venueId
    const shiftId: string = req.params.shiftId

    // Forward the body without inventing zero declarations. The service owns the additive
    // reconciliation contract and keeps legacy Desktop/TPV shapes separate.
    const result = await shiftTpvService.closeShiftForVenueWithResult(venueId, shiftId, req.body ?? {}, {
      orgId,
      actorStaffId: req.authContext?.userId,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    })

    res.status(200).json({
      success: true,
      data: result.shift,
      reconciliation: result.reconciliation,
    })
  } catch (error) {
    next(error)
  }
}

export async function getCurrentShift(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const orgId = req.authContext?.orgId // 1. Extract from req (Controller)

    const venueId: string = req.params.venueId // 3. Extract from req (Controller, already validated)
    const posName: string | undefined = req.query.pos_name as string // 4. Extract optional pos_name

    // 5. Call service with clean data (Controller delegates)
    const shift = await shiftTpvService.getCurrentShift(venueId, orgId, posName)

    // 6. Send HTTP response (Controller)
    // Always wrap in {shift: ...} for consistency
    res.status(200).json({ shift: shift })
  } catch (error) {
    next(error) // 7. HTTP error handling (Controller)
  }
}

export async function getShifts(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const orgId = req.authContext?.orgId // 1. Extract from req (Controller)

    const venueId: string = req.params.venueId // 3. Extract from req (Controller, already validated)

    // 4. Extract query parameters with defaults
    const pageSize = Number(req.query.pageSize || '10')
    const pageNumber = Number(req.query.pageNumber || '1')

    // 5. Validate pagination parameters
    if (isNaN(pageSize) || isNaN(pageNumber) || pageSize <= 0 || pageNumber <= 0) {
      res.status(400).json({
        success: false,
        message: 'Invalid pagination parameters. pageSize and pageNumber must be positive numbers',
      })
      return
    }

    // 6. Extract filter parameters
    const filters = {
      staffId: req.query.staffId as string,
      startTime: req.query.startTime as string,
      endTime: req.query.endTime as string,
    }

    // 7. Call service with clean data (Controller delegates)
    const result = await shiftTpvService.getShifts(venueId, pageSize, pageNumber, filters, orgId)

    // 8. Send HTTP response (Controller)
    res.status(200).json({
      success: true,
      data: result.data,
      meta: result.meta,
    })
  } catch (error) {
    next(error) // 9. HTTP error handling (Controller)
  }
}

export async function getShiftsSummary(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const orgId = req.authContext?.orgId // 1. Extract from req (Controller)

    const venueId: string = req.params.venueId // 3. Extract from req (Controller, already validated)

    // 4. Extract filter parameters
    const filters = {
      staffId: req.query.staffId as string,
      startTime: req.query.startTime as string,
      endTime: req.query.endTime as string,
    }

    // 5. Call service with clean data (Controller delegates)
    const result = await shiftTpvService.getShiftsSummary(venueId, filters, orgId)

    // 6. Send HTTP response (Controller)
    res.status(200).json({
      success: true,
      data: result,
    })
  } catch (error) {
    next(error) // 7. HTTP error handling (Controller)
  }
}
