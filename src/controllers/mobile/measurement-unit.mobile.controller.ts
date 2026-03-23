/**
 * Mobile Measurement Unit Controller
 *
 * CRUD endpoints for custom measurement units per venue.
 * Used by mobile apps (iOS, Android).
 */

import { NextFunction, Request, Response } from 'express'
import logger from '../../config/logger'
import * as measurementUnitService from '../../services/mobile/measurement-unit.mobile.service'

/**
 * List measurement units for a venue
 * @route GET /api/v1/mobile/venues/:venueId/measurement-units
 */
export const listMeasurementUnits = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = req.params

    const units = await measurementUnitService.listMeasurementUnits(venueId)

    res.status(200).json({
      success: true,
      units,
    })
  } catch (error) {
    logger.error('Error in listMeasurementUnits controller:', error)
    next(error)
  }
}

/**
 * Create a measurement unit
 * @route POST /api/v1/mobile/venues/:venueId/measurement-units
 */
export const createMeasurementUnit = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = req.params
    const { name, abbreviation } = req.body

    const unit = await measurementUnitService.createMeasurementUnit(venueId, name, abbreviation)

    res.status(201).json({
      success: true,
      unit,
    })
  } catch (error) {
    logger.error('Error in createMeasurementUnit controller:', error)
    next(error)
  }
}

/**
 * Delete a measurement unit
 * @route DELETE /api/v1/mobile/venues/:venueId/measurement-units/:id
 */
export const deleteMeasurementUnit = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, id } = req.params

    await measurementUnitService.deleteMeasurementUnit(venueId, id)

    res.status(200).json({
      success: true,
      message: 'Unidad de medida eliminada',
    })
  } catch (error) {
    logger.error('Error in deleteMeasurementUnit controller:', error)
    next(error)
  }
}
