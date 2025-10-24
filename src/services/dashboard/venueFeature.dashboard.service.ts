/**
 * Venue Feature Management Service
 *
 * Handles adding and removing features to venues with Stripe subscription management
 */

import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { BadRequestError, NotFoundError } from '../../errors/AppError'
import { createTrialSubscriptions, cancelSubscription } from '../stripe.service'
import Stripe from 'stripe'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '')

/**
 * Add features to a venue with Stripe trial subscriptions
 *
 * @param venueId - Venue ID
 * @param featureCodes - Array of feature codes to add
 * @param trialPeriodDays - Number of trial days (default: 5)
 * @returns Array of created VenueFeature records
 */
export async function addFeaturesToVenue(venueId: string, featureCodes: string[], trialPeriodDays: number = 5) {
  logger.info('Adding features to venue', { venueId, featureCodes, trialPeriodDays })

  // Get venue with Stripe customer ID
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    select: {
      id: true,
      name: true,
      slug: true,
      stripeCustomerId: true,
      stripePaymentMethodId: true,
      features: {
        where: {
          active: true,
        },
        include: {
          feature: true,
        },
      },
    },
  })

  if (!venue) {
    throw new NotFoundError(`Venue with ID ${venueId} not found`)
  }

  // Verify venue has Stripe customer configured
  if (!venue.stripeCustomerId) {
    throw new BadRequestError('Venue does not have Stripe customer configured. Please add a payment method first.')
  }

  // Check if venue already has payment method
  if (!venue.stripePaymentMethodId) {
    logger.warn('Venue has Stripe customer but no payment method', { venueId })
    throw new BadRequestError('Venue does not have a payment method configured. Please add a payment method first.')
  }

  // Check which features are already active
  const activeFeatureCodes = venue.features.map(vf => vf.feature.code)
  const newFeatureCodes = featureCodes.filter(code => !activeFeatureCodes.includes(code))

  if (newFeatureCodes.length === 0) {
    logger.info('All requested features are already active', { venueId, featureCodes })
    return []
  }

  // Check if venue has ever had these features before (even if canceled)
  // If they had a trial before, don't give them another one
  const previousFeatures = await prisma.venueFeature.findMany({
    where: {
      venueId,
      feature: {
        code: {
          in: newFeatureCodes,
        },
      },
    },
    include: {
      feature: true,
    },
  })

  const previousFeatureCodes = previousFeatures.map(vf => vf.feature.code)

  // Only give trial to features they've NEVER had before
  const firstTimeFeatures = newFeatureCodes.filter(code => !previousFeatureCodes.includes(code))
  const returningFeatures = newFeatureCodes.filter(code => previousFeatureCodes.includes(code))

  logger.info('Creating subscriptions for new features', {
    venueId,
    newFeatureCodes,
    alreadyActive: activeFeatureCodes,
    firstTimeFeatures,
    returningFeatures,
  })

  // Create trial subscriptions for new features
  try {
    // First-time features get trial period
    const firstTimeTrialDays = firstTimeFeatures.length > 0 ? trialPeriodDays : 0
    // Returning features get NO trial (immediate payment)
    const returningTrialDays = 0

    const subscriptionIds: string[] = []

    // Create trial subscriptions for first-time features
    if (firstTimeFeatures.length > 0) {
      const firstTimeIds = await createTrialSubscriptions(
        venue.stripeCustomerId,
        venueId,
        firstTimeFeatures,
        firstTimeTrialDays,
        venue.name,
        venue.slug,
      )
      subscriptionIds.push(...firstTimeIds)
      logger.info('✅ Trial subscriptions created for first-time features', {
        features: firstTimeFeatures,
        trialDays: firstTimeTrialDays,
      })
    }

    // Create immediate (no trial) subscriptions for returning features
    if (returningFeatures.length > 0) {
      const returningIds = await createTrialSubscriptions(
        venue.stripeCustomerId,
        venueId,
        returningFeatures,
        returningTrialDays,
        venue.name,
        venue.slug,
      )
      subscriptionIds.push(...returningIds)
      logger.info('✅ Paid subscriptions created for returning features (no trial)', {
        features: returningFeatures,
      })
    }

    logger.info('✅ Features added successfully', {
      venueId,
      featureCount: newFeatureCodes.length,
      subscriptionIds,
    })

    // Return created VenueFeature records
    const createdFeatures = await prisma.venueFeature.findMany({
      where: {
        venueId,
        stripeSubscriptionId: {
          in: subscriptionIds,
        },
      },
      include: {
        feature: true,
      },
    })

    return createdFeatures
  } catch (error) {
    logger.error('❌ Error adding features to venue', {
      error,
      venueId,
      featureCodes: newFeatureCodes,
    })
    throw error
  }
}

/**
 * Remove a feature from a venue and cancel Stripe subscription
 *
 * @param venueId - Venue ID
 * @param featureId - Feature ID to remove
 */
export async function removeFeatureFromVenue(venueId: string, featureId: string) {
  logger.info('Removing feature from venue', { venueId, featureId })

  // Get VenueFeature record
  const venueFeature = await prisma.venueFeature.findFirst({
    where: {
      venueId,
      featureId,
      active: true,
    },
    include: {
      feature: true,
    },
  })

  if (!venueFeature) {
    throw new NotFoundError(`Active feature ${featureId} not found for venue ${venueId}`)
  }

  // Cancel Stripe subscription if exists
  if (venueFeature.stripeSubscriptionId) {
    try {
      await cancelSubscription(venueFeature.stripeSubscriptionId)
      logger.info('✅ Stripe subscription canceled', {
        venueId,
        featureId,
        subscriptionId: venueFeature.stripeSubscriptionId,
      })
    } catch (error) {
      logger.error('❌ Error canceling Stripe subscription', {
        error,
        venueId,
        featureId,
        subscriptionId: venueFeature.stripeSubscriptionId,
      })
      // Continue with deactivation even if Stripe cancellation fails
      // Admin can manually cancel in Stripe dashboard
    }
  }

  // Deactivate VenueFeature record
  await prisma.venueFeature.update({
    where: { id: venueFeature.id },
    data: { active: false },
  })

  logger.info('✅ Feature removed from venue', {
    venueId,
    featureId,
    featureCode: venueFeature.feature.code,
  })

  return venueFeature
}

/**
 * Get all features available for a venue
 * Shows which features are active and which are available to add
 *
 * @param venueId - Venue ID
 */
export async function getVenueFeatureStatus(venueId: string) {
  logger.info('Getting venue feature status', { venueId })

  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    select: {
      id: true,
      name: true,
      stripeCustomerId: true,
      stripePaymentMethodId: true,
      features: {
        where: { active: true },
        include: {
          feature: true,
        },
      },
    },
  })

  if (!venue) {
    throw new NotFoundError(`Venue with ID ${venueId} not found`)
  }

  // Get all available features
  const allFeatures = await prisma.feature.findMany({
    where: { active: true },
  })

  const activeFeatureIds = venue.features.map(vf => vf.featureId)
  const availableFeatures = allFeatures.filter(f => !activeFeatureIds.includes(f.id))

  // Get historical feature usage (including canceled) to determine if features were previously used
  const previousFeatures = await prisma.venueFeature.findMany({
    where: {
      venueId,
      featureId: {
        in: availableFeatures.map(f => f.id),
      },
    },
    select: {
      featureId: true,
    },
  })

  const previousFeatureIds = new Set(previousFeatures.map(vf => vf.featureId))

  // Get payment method details from Stripe if available
  let paymentMethod: {
    brand: string
    last4: string
    expMonth: number
    expYear: number
  } | null = null

  if (venue.stripePaymentMethodId) {
    try {
      const pm = await stripe.paymentMethods.retrieve(venue.stripePaymentMethodId)
      if (pm.card) {
        paymentMethod = {
          brand: pm.card.brand,
          last4: pm.card.last4,
          expMonth: pm.card.exp_month,
          expYear: pm.card.exp_year,
        }
      }
    } catch (error) {
      logger.warn('Failed to retrieve payment method from Stripe', {
        venueId,
        paymentMethodId: venue.stripePaymentMethodId,
        error,
      })
    }
  }

  const result = {
    venueId: venue.id,
    venueName: venue.name,
    hasStripeCustomer: !!venue.stripeCustomerId,
    hasPaymentMethod: !!venue.stripePaymentMethodId,
    paymentMethod,
    activeFeatures: venue.features.map(vf => ({
      id: vf.id,
      venueId: vf.venueId,
      featureId: vf.feature.id,
      feature: {
        id: vf.feature.id,
        code: vf.feature.code,
        name: vf.feature.name,
        description: vf.feature.description,
      },
      active: vf.active,
      monthlyPrice: vf.monthlyPrice,
      startDate: vf.startDate,
      endDate: vf.endDate,
      stripeSubscriptionId: vf.stripeSubscriptionId,
      stripePriceId: vf.stripePriceId,
    })),
    availableFeatures: availableFeatures.map(f => ({
      id: f.id,
      code: f.code,
      name: f.name,
      description: f.description,
      monthlyPrice: f.monthlyPrice,
      stripeProductId: f.stripeProductId,
      stripePriceId: f.stripePriceId,
      hadPreviously: previousFeatureIds.has(f.id), // NEW: Indicates if feature was previously used
    })),
  }

  return result
}

export default {
  addFeaturesToVenue,
  removeFeatureFromVenue,
  getVenueFeatureStatus,
}
