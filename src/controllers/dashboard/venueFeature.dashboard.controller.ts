/**
 * Venue Feature Management Controller
 */

import { Request, Response, NextFunction } from 'express'
import * as venueFeatureService from '../../services/dashboard/venueFeature.dashboard.service'
import logger from '../../config/logger'

/**
 * Get venue feature status (active and available features)
 * GET /api/v1/dashboard/venues/:venueId/features
 */
export async function getVenueFeatures(req: Request<{ venueId: string }>, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId } = req.params

    logger.info('Getting venue feature status', { venueId })

    const featureStatus = await venueFeatureService.getVenueFeatureStatus(venueId)

    res.status(200).json({
      success: true,
      data: featureStatus,
    })
  } catch (error) {
    logger.error('Error getting venue features', {
      error: error instanceof Error ? error.message : 'Unknown error',
      venueId: req.params?.venueId,
    })
    next(error)
  }
}

/**
 * Add features to venue with trial subscriptions
 * POST /api/v1/dashboard/venues/:venueId/features
 *
 * Body: {
 *   featureCodes: string[],
 *   trialPeriodDays?: number
 * }
 */
export async function addVenueFeatures(
  req: Request<{ venueId: string }, any, { featureCodes: string[]; trialPeriodDays?: number }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId } = req.params
    const { featureCodes, trialPeriodDays = 5 } = req.body

    logger.info('Adding features to venue', {
      venueId,
      featureCodes,
      trialPeriodDays,
    })

    const createdFeatures = await venueFeatureService.addFeaturesToVenue(venueId, featureCodes, trialPeriodDays)

    res.status(201).json({
      success: true,
      data: createdFeatures,
      message: `${createdFeatures.length} feature(s) added successfully with ${trialPeriodDays}-day trial`,
    })
  } catch (error) {
    logger.error('Error adding features to venue', {
      error: error instanceof Error ? error.message : 'Unknown error',
      venueId: req.params?.venueId,
      featureCodes: req.body?.featureCodes,
    })
    next(error)
  }
}

/**
 * Remove feature from venue and cancel subscription
 * DELETE /api/v1/dashboard/venues/:venueId/features/:featureId
 */
export async function removeVenueFeature(
  req: Request<{ venueId: string; featureId: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId, featureId } = req.params

    logger.info('Removing feature from venue', {
      venueId,
      featureId,
    })

    const removedFeature = await venueFeatureService.removeFeatureFromVenue(venueId, featureId)

    res.status(200).json({
      success: true,
      data: removedFeature,
      message: 'Feature removed and subscription canceled successfully',
    })
  } catch (error) {
    logger.error('Error removing feature from venue', {
      error: error instanceof Error ? error.message : 'Unknown error',
      venueId: req.params?.venueId,
      featureId: req.params?.featureId,
    })
    next(error)
  }
}
