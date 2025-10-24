/**
 * Stripe Service
 *
 * Handles all Stripe-related operations:
 * - Customer management
 * - Product/Price synchronization
 * - Subscription management with trials
 * - Payment method updates
 */

import Stripe from 'stripe'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { Feature } from '@prisma/client'

// Initialize Stripe
// Note: Using 'as any' because Stripe SDK v19.1.0 has incorrect type definition ('2025-09-30.clover')
// The correct API version is '2024-10-28' (latest stable as of Oct 2024)
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
  apiVersion: '2024-10-28' as any,
})

/**
 * Get or create Stripe customer for an organization
 *
 * @param organizationId - Organization ID
 * @param email - Customer email
 * @param name - Customer name
 * @returns Stripe customer ID
 */
export async function getOrCreateStripeCustomer(organizationId: string, email: string, name: string): Promise<string> {
  // Check if organization already has a Stripe customer
  const organization = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { stripeCustomerId: true },
  })

  if (organization?.stripeCustomerId) {
    logger.info(`✅ Organization ${organizationId} already has Stripe customer: ${organization.stripeCustomerId}`)
    return organization.stripeCustomerId
  }

  // Create new Stripe customer
  const customer = await stripe.customers.create({
    email,
    name,
    metadata: {
      organizationId,
    },
  })

  // Save customer ID to database
  await prisma.organization.update({
    where: { id: organizationId },
    data: { stripeCustomerId: customer.id },
  })

  logger.info(`✅ Created Stripe customer ${customer.id} for organization ${organizationId}`)
  return customer.id
}

/**
 * Sync features to Stripe products and prices
 * Creates or updates Stripe products/prices for each feature
 *
 * @returns Array of synced features with Stripe IDs
 */
export async function syncFeaturesToStripe(): Promise<Feature[]> {
  const features = await prisma.feature.findMany({
    where: { active: true },
  })

  logger.info(`🔄 Syncing ${features.length} features to Stripe...`)

  for (const feature of features) {
    try {
      let productId = feature.stripeProductId
      let priceId = feature.stripePriceId

      // Create or update Stripe product
      if (!productId) {
        const product = await stripe.products.create({
          name: feature.name,
          description: feature.description || undefined,
          metadata: {
            featureId: feature.id,
            featureCode: feature.code,
          },
        })
        productId = product.id
        logger.info(`  ✅ Created Stripe product ${productId} for feature ${feature.code}`)
      } else {
        await stripe.products.update(productId, {
          name: feature.name,
          description: feature.description || undefined,
        })
        logger.info(`  ✅ Updated Stripe product ${productId} for feature ${feature.code}`)
      }

      // Create or update Stripe price
      if (!priceId) {
        const price = await stripe.prices.create({
          product: productId,
          unit_amount: Math.round(feature.monthlyPrice.toNumber() * 100), // Convert to cents
          currency: 'mxn',
          recurring: {
            interval: 'month',
          },
          metadata: {
            featureId: feature.id,
            featureCode: feature.code,
          },
        })
        priceId = price.id
        logger.info(`  ✅ Created Stripe price ${priceId} for feature ${feature.code}`)
      }

      // Update feature with Stripe IDs
      await prisma.feature.update({
        where: { id: feature.id },
        data: {
          stripeProductId: productId,
          stripePriceId: priceId,
        },
      })
    } catch (error) {
      logger.error(`❌ Error syncing feature ${feature.code} to Stripe:`, error)
    }
  }

  // Return updated features
  return prisma.feature.findMany({
    where: { active: true },
  })
}

/**
 * Create trial subscriptions for selected features
 *
 * @param customerId - Stripe customer ID
 * @param venueId - Venue ID
 * @param featureCodes - Array of feature codes to subscribe to
 * @param trialPeriodDays - Number of trial days (default: 5)
 * @returns Created subscription IDs
 */
export async function createTrialSubscriptions(
  customerId: string,
  venueId: string,
  featureCodes: string[],
  trialPeriodDays: number = 5,
): Promise<string[]> {
  logger.info(`🎯 Creating trial subscriptions for venue ${venueId}, features: ${featureCodes.join(', ')}`)

  const features = await prisma.feature.findMany({
    where: {
      code: { in: featureCodes },
      active: true,
      stripePriceId: { not: null },
    },
  })

  if (features.length === 0) {
    throw new Error('No valid features found to subscribe')
  }

  const subscriptionIds: string[] = []

  // Create individual subscription for each feature
  for (const feature of features) {
    try {
      const subscription = await stripe.subscriptions.create({
        customer: customerId,
        items: [
          {
            price: feature.stripePriceId!,
          },
        ],
        trial_period_days: trialPeriodDays,
        metadata: {
          venueId,
          featureId: feature.id,
          featureCode: feature.code,
        },
      })

      // Create VenueFeature record
      const trialEndDate = new Date()
      trialEndDate.setDate(trialEndDate.getDate() + trialPeriodDays)

      await prisma.venueFeature.create({
        data: {
          venueId,
          featureId: feature.id,
          active: true,
          monthlyPrice: feature.monthlyPrice,
          startDate: new Date(),
          endDate: trialEndDate,
          stripeSubscriptionId: subscription.id,
          stripePriceId: feature.stripePriceId,
        },
      })

      subscriptionIds.push(subscription.id)
      logger.info(`  ✅ Created trial subscription ${subscription.id} for feature ${feature.code}`)
    } catch (error) {
      logger.error(`  ❌ Error creating subscription for feature ${feature.code}:`, error)
    }
  }

  return subscriptionIds
}

/**
 * Convert trial to paid subscription
 * Called when trial period ends successfully
 *
 * @param venueFeatureId - VenueFeature ID
 */
export async function convertTrialToPaid(venueFeatureId: string): Promise<void> {
  const venueFeature = await prisma.venueFeature.findUnique({
    where: { id: venueFeatureId },
    include: { feature: true },
  })

  if (!venueFeature) {
    throw new Error(`VenueFeature ${venueFeatureId} not found`)
  }

  // Set endDate to null (paid subscription)
  await prisma.venueFeature.update({
    where: { id: venueFeatureId },
    data: {
      endDate: null, // null = paid subscription
      active: true,
    },
  })

  logger.info(`✅ Converted trial to paid subscription for VenueFeature ${venueFeatureId}`)
}

/**
 * Cancel subscription
 *
 * @param subscriptionId - Stripe subscription ID
 */
export async function cancelSubscription(subscriptionId: string): Promise<void> {
  await stripe.subscriptions.cancel(subscriptionId)

  // Deactivate VenueFeature
  await prisma.venueFeature.updateMany({
    where: { stripeSubscriptionId: subscriptionId },
    data: { active: false },
  })

  logger.info(`✅ Canceled subscription ${subscriptionId}`)
}

/**
 * Update payment method for customer
 *
 * @param customerId - Stripe customer ID
 * @param paymentMethodId - New payment method ID
 */
export async function updatePaymentMethod(customerId: string, paymentMethodId: string): Promise<void> {
  // Attach payment method to customer
  await stripe.paymentMethods.attach(paymentMethodId, {
    customer: customerId,
  })

  // Set as default payment method
  await stripe.customers.update(customerId, {
    invoice_settings: {
      default_payment_method: paymentMethodId,
    },
  })

  logger.info(`✅ Updated payment method for customer ${customerId}`)
}

/**
 * Create payment intent for trial setup
 * Used to collect payment method upfront before trial
 *
 * @param customerId - Stripe customer ID
 * @param amount - Amount in cents (usually $0 or $1 for verification)
 * @returns Payment intent client secret
 */
export async function createTrialSetupIntent(customerId: string): Promise<string> {
  const setupIntent = await stripe.setupIntents.create({
    customer: customerId,
    payment_method_types: ['card'],
  })

  logger.info(`✅ Created setup intent ${setupIntent.id} for customer ${customerId}`)
  return setupIntent.client_secret!
}

export default {
  getOrCreateStripeCustomer,
  syncFeaturesToStripe,
  createTrialSubscriptions,
  convertTrialToPaid,
  cancelSubscription,
  updatePaymentMethod,
  createTrialSetupIntent,
}
