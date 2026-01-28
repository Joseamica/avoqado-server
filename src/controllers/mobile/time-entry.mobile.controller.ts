/**
 * Mobile Time Entry Controller
 *
 * Time clock endpoints for mobile apps (iOS, Android).
 * PIN-based identification - no JWT required for time clock operations.
 */

import { NextFunction, Request, Response } from 'express'
import logger from '../../config/logger'
import * as timeEntryService from '../../services/mobile/time-entry.mobile.service'

/**
 * Identify staff by PIN and return their current status
 * @route POST /api/v1/mobile/venues/:venueId/time-clock/identify
 */
export const identifyByPin = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = req.params
    const { pin } = req.body

    if (!pin) {
      return res.status(400).json({
        success: false,
        message: 'PIN es requerido',
      })
    }

    const result = await timeEntryService.identifyByPin(venueId, pin)

    res.status(200).json({
      success: true,
      ...result,
    })
  } catch (error) {
    logger.error('Error in identifyByPin controller:', error)
    next(error)
  }
}

/**
 * Clock in (identified by PIN)
 * @route POST /api/v1/mobile/venues/:venueId/time-clock/clock-in
 */
export const clockIn = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = req.params
    const { pin, jobRole, checkInPhotoUrl, latitude, longitude, accuracy } = req.body

    if (!pin) {
      return res.status(400).json({
        success: false,
        message: 'PIN es requerido',
      })
    }

    const timeEntry = await timeEntryService.clockIn({
      venueId,
      pin,
      jobRole,
      checkInPhotoUrl,
      latitude,
      longitude,
      accuracy,
    })

    res.status(201).json({
      success: true,
      timeEntry,
    })
  } catch (error) {
    logger.error('Error in clockIn controller:', error)
    next(error)
  }
}

/**
 * Clock out (identified by PIN)
 * @route POST /api/v1/mobile/venues/:venueId/time-clock/clock-out
 */
export const clockOut = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = req.params
    const { pin, checkOutPhotoUrl, latitude, longitude, accuracy } = req.body

    if (!pin) {
      return res.status(400).json({
        success: false,
        message: 'PIN es requerido',
      })
    }

    const timeEntry = await timeEntryService.clockOut({
      venueId,
      pin,
      checkOutPhotoUrl,
      latitude,
      longitude,
      accuracy,
    })

    res.status(200).json({
      success: true,
      timeEntry,
    })
  } catch (error) {
    logger.error('Error in clockOut controller:', error)
    next(error)
  }
}

/**
 * Start break (identified by PIN)
 * @route POST /api/v1/mobile/venues/:venueId/time-clock/break/start
 */
export const startBreak = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = req.params
    const { pin, breakType } = req.body

    if (!pin) {
      return res.status(400).json({
        success: false,
        message: 'PIN es requerido',
      })
    }

    const result = await timeEntryService.startBreak(venueId, pin, breakType)

    res.status(200).json({
      success: true,
      timeEntry: result,
    })
  } catch (error) {
    logger.error('Error in startBreak controller:', error)
    next(error)
  }
}

/**
 * End break (identified by PIN)
 * @route POST /api/v1/mobile/venues/:venueId/time-clock/break/end
 */
export const endBreak = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = req.params
    const { pin } = req.body

    if (!pin) {
      return res.status(400).json({
        success: false,
        message: 'PIN es requerido',
      })
    }

    const result = await timeEntryService.endBreak(venueId, pin)

    res.status(200).json({
      success: true,
      timeEntry: result,
    })
  } catch (error) {
    logger.error('Error in endBreak controller:', error)
    next(error)
  }
}
