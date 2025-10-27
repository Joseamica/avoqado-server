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

/**
 * Preview proration for subscription change
 * POST /api/v1/dashboard/venues/:venueId/features/:featureId/proration-preview
 * Body: { newFeatureCode: string }
 */
export async function previewSubscriptionChange(
  req: Request<{ venueId: string; featureId: string }, any, { newFeatureCode: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId, featureId } = req.params
    const { newFeatureCode } = req.body

    logger.info('Previewing subscription change', { venueId, featureId, newFeatureCode })

    // Get current VenueFeature with subscription ID
    const venueFeature = await prisma.venueFeature.findUnique({
      where: { id: featureId },
      include: { feature: true },
    })

    if (!venueFeature) {
      res.status(404).json({
        success: false,
        error: 'Feature subscription not found',
      })
      return
    }

    if (!venueFeature.stripeSubscriptionId) {
      res.status(400).json({
        success: false,
        error: 'No active subscription found for this feature',
      })
      return
    }

    // Get new feature to get its Stripe price ID
    const newFeature = await prisma.feature.findUnique({
      where: { code: newFeatureCode },
    })

    if (!newFeature || !newFeature.stripePriceId) {
      res.status(404).json({
        success: false,
        error: 'Target feature not found or has no price',
      })
      return
    }

    // Get proration preview from Stripe
    const prorationDetails = await stripeService.previewSubscriptionProration(
      venueFeature.stripeSubscriptionId,
      newFeature.stripePriceId,
    )

    res.status(200).json({
      success: true,
      data: {
        currentFeature: {
          id: venueFeature.feature.id,
          code: venueFeature.feature.code,
          name: venueFeature.feature.name,
          price: venueFeature.monthlyPrice,
        },
        newFeature: {
          id: newFeature.id,
          code: newFeature.code,
          name: newFeature.name,
          price: newFeature.monthlyPrice,
        },
        proration: prorationDetails,
      },
    })
  } catch (error) {
    logger.error('Error previewing subscription change', {
      error: error instanceof Error ? error.message : 'Unknown error',
      venueId: req.params?.venueId,
      featureId: req.params?.featureId,
    })
    next(error)
  }
}

/**
 * Update subscription to new feature/price
 * PUT /api/v1/dashboard/venues/:venueId/features/:featureId/subscription
 * Body: { newFeatureCode: string }
 */
export async function updateSubscription(
  req: Request<{ venueId: string; featureId: string }, any, { newFeatureCode: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId, featureId } = req.params
    const { newFeatureCode } = req.body

    logger.info('Updating subscription', { venueId, featureId, newFeatureCode })

    // Get current VenueFeature
    const venueFeature = await prisma.venueFeature.findUnique({
      where: { id: featureId },
      include: { feature: true },
    })

    if (!venueFeature) {
      res.status(404).json({
        success: false,
        error: 'Feature subscription not found',
      })
      return
    }

    if (!venueFeature.stripeSubscriptionId) {
      res.status(400).json({
        success: false,
        error: 'No active subscription found',
      })
      return
    }

    // Get new feature
    const newFeature = await prisma.feature.findUnique({
      where: { code: newFeatureCode },
    })

    if (!newFeature || !newFeature.stripePriceId) {
      res.status(404).json({
        success: false,
        error: 'Target feature not found or has no price',
      })
      return
    }

    // Update subscription in Stripe
    const updatedSubscription = await stripeService.updateSubscriptionPrice(
      venueFeature.stripeSubscriptionId,
      newFeature.stripePriceId,
    )

    // Update VenueFeature record
    const updatedVenueFeature = await prisma.venueFeature.update({
      where: { id: featureId },
      data: {
        featureId: newFeature.id,
        monthlyPrice: newFeature.monthlyPrice,
      },
      include: { feature: true },
    })

    logger.info('✅ Subscription updated successfully', {
      venueId,
      oldFeature: venueFeature.feature.code,
      newFeature: newFeature.code,
      subscriptionId: updatedSubscription.id,
    })

    res.status(200).json({
      success: true,
      data: updatedVenueFeature,
      message: 'Subscription updated successfully',
    })
  } catch (error) {
    logger.error('Error updating subscription', {
      error: error instanceof Error ? error.message : 'Unknown error',
      venueId: req.params?.venueId,
      featureId: req.params?.featureId,
    })
    next(error)
  }
}

/**
 * Retry failed invoice payment
 * POST /api/v1/dashboard/venues/:venueId/invoices/:invoiceId/retry
 */
export async function retryInvoicePayment(
  req: Request<{ venueId: string; invoiceId: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId, invoiceId } = req.params

    logger.info('Retrying invoice payment', { venueId, invoiceId })

    // Get venue's organization to verify customer
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
      res.status(400).json({
        success: false,
        error: 'No Stripe customer associated with this venue',
      })
      return
    }

    // Retry payment using Stripe
    const paidInvoice = await stripeService.retryInvoicePayment(invoiceId)

    logger.info('✅ Invoice payment retry successful', {
      venueId,
      invoiceId,
      amount: paidInvoice.amount_due,
      status: paidInvoice.status,
    })

    res.status(200).json({
      success: true,
      data: {
        invoice: paidInvoice,
      },
      message: 'Payment retry successful',
    })
  } catch (error) {
    logger.error('Error retrying invoice payment', {
      error: error instanceof Error ? error.message : 'Unknown error',
      venueId: req.params?.venueId,
      invoiceId: req.params?.invoiceId,
    })
    next(error)
  }
}
