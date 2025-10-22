/**
 * Feature Controller
 *
 * Handles HTTP requests for feature management
 */

import { Request, Response, NextFunction } from 'express'
import * as featureService from '@/services/dashboard/feature.service'

/**
 * Get all available features
 *
 * @route GET /api/v1/dashboard/features
 */
export async function getAvailableFeatures(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const features = await featureService.getAvailableFeatures()

    res.status(200).json({
      success: true,
      data: features,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Get features enabled for a specific venue
 *
 * @route GET /api/v1/dashboard/venues/:venueId/features
 */
export async function getVenueFeatures(req: Request<{ venueId: string }>, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId } = req.params

    const features = await featureService.getVenueFeatures(venueId)

    res.status(200).json({
      success: true,
      data: features,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Save selected features for a venue
 *
 * @route POST /api/v1/dashboard/venues/:venueId/features
 */
export async function saveVenueFeatures(
  req: Request<{ venueId: string }, any, { featureIds: string[] }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId } = req.params
    const { featureIds } = req.body

    if (!Array.isArray(featureIds)) {
      res.status(400).json({
        success: false,
        error: 'featureIds must be an array',
      })
      return
    }

    const features = await featureService.saveVenueFeatures(venueId, featureIds)

    res.status(200).json({
      success: true,
      data: features,
    })
  } catch (error) {
    next(error)
  }
}
