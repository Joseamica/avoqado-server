/**
 * Venue Feature Management Controller
 */

import { Request, Response, NextFunction } from 'express'
import * as venueFeatureService from '../../services/dashboard/venueFeature.dashboard.service'
import * as stripeService from '../../services/stripe.service'
import prisma from '../../utils/prismaClient'
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

/**
 * Get Stripe invoices for a venue
 * GET /api/v1/dashboard/venues/:venueId/invoices
 */
export async function getVenueInvoices(req: Request<{ venueId: string }>, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId } = req.params

    logger.info('Getting invoices for venue', { venueId })

    // Get venue's organization to find Stripe customer ID
    const venue = await prisma.venue.findUnique({
      where: { id: venueId },
      include: { organization: true },
    })

    if (!venue) {
      res.status(404).json({
        success: false,
        error: 'Venue not found',
      })
      return
    }

    if (!venue.organization.stripeCustomerId) {
      // No Stripe customer = no invoices
      res.status(200).json({
        success: true,
        data: {
          invoices: [],
        },
      })
      return
    }

    // Fetch invoices from Stripe
    const invoices = await stripeService.getCustomerInvoices(venue.organization.stripeCustomerId)

    res.status(200).json({
      success: true,
      data: {
        invoices,
      },
    })
  } catch (error) {
    logger.error('Error getting venue invoices', {
      error: error instanceof Error ? error.message : 'Unknown error',
      venueId: req.params?.venueId,
    })
    next(error)
  }
}

/**
 * Download invoice PDF
 * GET /api/v1/dashboard/venues/:venueId/invoices/:invoiceId/download
 */
export async function downloadInvoice(
  req: Request<{ venueId: string; invoiceId: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId, invoiceId } = req.params

    logger.info('Downloading invoice', { venueId, invoiceId })

    // Get invoice PDF URL from Stripe
    const pdfUrl = await stripeService.getInvoicePdfUrl(invoiceId)

    // Redirect to Stripe's hosted PDF
    res.redirect(pdfUrl)
  } catch (error) {
    logger.error('Error downloading invoice', {
      error: error instanceof Error ? error.message : 'Unknown error',
      venueId: req.params?.venueId,
      invoiceId: req.params?.invoiceId,
    })
    next(error)
  }
}
