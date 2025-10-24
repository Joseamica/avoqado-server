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
import { retry, shouldRetryStripeError } from '@/utils/retry'

// Initialize Stripe
// Using default API version from SDK (automatically uses the latest compatible version)
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '')

/**
 * Get or create Stripe customer for an organization
 *
 * @param organizationId - Organization ID
 * @param email - Customer email
 * @param name - Customer name
 * @param venueName - Optional venue name for customer description
 * @param venueSlug - Optional venue slug for identification
 * @returns Stripe customer ID
 */
export async function getOrCreateStripeCustomer(
  organizationId: string,
  email: string,
  name: string,
  venueName?: string,
  venueSlug?: string,
): Promise<string> {
  // Check if organization already has a Stripe customer
  const organization = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { stripeCustomerId: true },
  })

  if (organization?.stripeCustomerId) {
    logger.info(`✅ Organization ${organizationId} already has Stripe customer: ${organization.stripeCustomerId}`)

    // Update customer description with venue info if provided
    if (venueName || venueSlug) {
      try {
        await retry(
          () =>
            stripe.customers.update(organization.stripeCustomerId!, {
              description: venueName ? `Venue: ${venueName}${venueSlug ? ` (${venueSlug})` : ''}` : undefined,
              metadata: {
                organizationId,
                ...(venueSlug && { venueSlug }),
              },
            }),
          {
            retries: 3,
            shouldRetry: shouldRetryStripeError,
            context: 'stripe.updateCustomer',
          },
        )
        logger.info(`✅ Updated Stripe customer description with venue info: ${venueName}`)
      } catch (error) {
        logger.warn('⚠️ Failed to update Stripe customer description after retries', { error })
      }
    }

    return organization.stripeCustomerId
  }

  // Create new Stripe customer with venue info (with retry)
  const customer = await retry(
    () =>
      stripe.customers.create({
        email,
        name,
        description: venueName ? `Venue: ${venueName}${venueSlug ? ` (${venueSlug})` : ''}` : undefined,
        metadata: {
          organizationId,
          ...(venueSlug && { venueSlug }),
        },
      }),
    {
      retries: 3,
      shouldRetry: shouldRetryStripeError,
      context: 'stripe.createCustomer',
    },
  )

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

      // Create or update Stripe product (with retry)
      if (!productId) {
        const product = await retry(
          () =>
            stripe.products.create({
              name: feature.name,
              description: feature.description || undefined,
              metadata: {
                featureId: feature.id,
                featureCode: feature.code,
              },
            }),
          {
            retries: 3,
            shouldRetry: shouldRetryStripeError,
            context: 'stripe.createProduct',
          },
        )
        productId = product.id
        logger.info(`  ✅ Created Stripe product ${productId} for feature ${feature.code}`)
      } else {
        await retry(
          () =>
            stripe.products.update(productId!, {
              name: feature.name,
              description: feature.description || undefined,
            }),
          {
            retries: 3,
            shouldRetry: shouldRetryStripeError,
            context: 'stripe.updateProduct',
          },
        )
        logger.info(`  ✅ Updated Stripe product ${productId} for feature ${feature.code}`)
      }

      // Create or update Stripe price (with retry)
      if (!priceId) {
        const price = await retry(
          () =>
            stripe.prices.create({
              product: productId!,
              unit_amount: Math.round(feature.monthlyPrice.toNumber() * 100), // Convert to cents
              currency: 'mxn',
              recurring: {
                interval: 'month',
              },
              metadata: {
                featureId: feature.id,
                featureCode: feature.code,
              },
            }),
          {
            retries: 3,
            shouldRetry: shouldRetryStripeError,
            context: 'stripe.createPrice',
          },
        )
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
 * @param venueName - Optional venue name for identification
 * @param venueSlug - Optional venue slug for identification
 * @returns Created subscription IDs
 */
export async function createTrialSubscriptions(
  customerId: string,
  venueId: string,
  featureCodes: string[],
  trialPeriodDays: number = 5,
  venueName?: string,
  venueSlug?: string,
): Promise<string[]> {
  logger.info(`🎯 Creating trial subscriptions for venue ${venueId}, features: ${featureCodes.join(', ')}`)

  // Get venue info if not provided
  let venueNameToUse = venueName
  let venueSlugToUse = venueSlug
  if (!venueName || !venueSlug) {
    const venue = await prisma.venue.findUnique({
      where: { id: venueId },
      select: { name: true, slug: true },
    })
    if (venue) {
      venueNameToUse = venueNameToUse || venue.name
      venueSlugToUse = venueSlugToUse || venue.slug
    }
  }

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
      const subscription = await retry(
        () =>
          stripe.subscriptions.create({
            customer: customerId,
            items: [
              {
                price: feature.stripePriceId!,
              },
            ],
            trial_period_days: trialPeriodDays,
            description: venueNameToUse ? `${feature.name} - ${venueNameToUse}` : undefined,
            metadata: {
              venueId,
              featureId: feature.id,
              featureCode: feature.code,
              ...(venueNameToUse && { venueName: venueNameToUse }),
              ...(venueSlugToUse && { venueSlug: venueSlugToUse }),
            },
          }),
        {
          retries: 3,
          shouldRetry: shouldRetryStripeError,
          context: 'stripe.createSubscription',
        },
      )

      // Create or update VenueFeature record (upsert for renewals)
      // endDate logic:
      // - If trialPeriodDays > 0: set endDate to trial end (trial subscription)
      // - If trialPeriodDays = 0: set endDate to null (paid subscription, no trial)
      const endDate =
        trialPeriodDays > 0
          ? (() => {
              const date = new Date()
              date.setDate(date.getDate() + trialPeriodDays)
              return date
            })()
          : null

      await prisma.venueFeature.upsert({
        where: {
          venueId_featureId: {
            venueId,
            featureId: feature.id,
          },
        },
        update: {
          // Reactivate existing subscription (renewal after cancellation)
          active: true,
          monthlyPrice: feature.monthlyPrice,
          startDate: new Date(),
          endDate,
          stripeSubscriptionId: subscription.id,
          stripePriceId: feature.stripePriceId,
        },
        create: {
          // First-time subscription
          venueId,
          featureId: feature.id,
          active: true,
          monthlyPrice: feature.monthlyPrice,
          startDate: new Date(),
          endDate,
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
 * Cancel subscription (with retry)
 *
 * @param subscriptionId - Stripe subscription ID
 */
export async function cancelSubscription(subscriptionId: string): Promise<void> {
  await retry(() => stripe.subscriptions.cancel(subscriptionId), {
    retries: 3,
    shouldRetry: shouldRetryStripeError,
    context: 'stripe.cancelSubscription',
  })

  // Deactivate VenueFeature
  await prisma.venueFeature.updateMany({
    where: { stripeSubscriptionId: subscriptionId },
    data: { active: false },
  })

  logger.info(`✅ Canceled subscription ${subscriptionId}`)
}

/**
 * Update payment method for customer (with retry)
 *
 * @param customerId - Stripe customer ID
 * @param paymentMethodId - New payment method ID
 */
export async function updatePaymentMethod(customerId: string, paymentMethodId: string): Promise<void> {
  // Attach payment method to customer
  await retry(() => stripe.paymentMethods.attach(paymentMethodId, { customer: customerId }), {
    retries: 3,
    shouldRetry: shouldRetryStripeError,
    context: 'stripe.attachPaymentMethod',
  })

  // Set as default payment method
  await retry(
    () =>
      stripe.customers.update(customerId, {
        invoice_settings: {
          default_payment_method: paymentMethodId,
        },
      }),
    {
      retries: 3,
      shouldRetry: shouldRetryStripeError,
      context: 'stripe.setDefaultPaymentMethod',
    },
  )

  logger.info(`✅ Updated payment method for customer ${customerId}`)
}

/**
 * Create Stripe Customer Portal session
 * Generates a secure URL to Stripe's hosted billing portal where customers can:
 * - View subscription details
 * - Update payment methods
 * - View invoice history
 * - Cancel subscriptions
 *
 * @param customerId - Stripe customer ID
 * @param returnUrl - URL to redirect user after they're done
 * @returns Session URL for the customer portal
 */
export async function createCustomerPortalSession(customerId: string, returnUrl: string): Promise<string> {
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  })

  logger.info(`✅ Created customer portal session for customer ${customerId}`)
  return session.url
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

/**
 * Get Stripe invoices for a customer
 * Fetches all invoices (paid, open, draft, etc.) for billing history
 *
 * @param customerId - Stripe customer ID
 * @param limit - Maximum number of invoices to return (default: 100)
 * @returns Array of Stripe invoices
 */
export async function getCustomerInvoices(customerId: string, limit: number = 100): Promise<Stripe.Invoice[]> {
  const invoices = await stripe.invoices.list({
    customer: customerId,
    limit,
  })

  logger.info(`✅ Retrieved ${invoices.data.length} invoices for customer ${customerId}`)
  return invoices.data
}

/**
 * Get invoice PDF download URL
 * Retrieves the invoice_pdf URL from Stripe for downloading
 *
 * @param invoiceId - Stripe invoice ID
 * @returns Invoice PDF URL
 */
export async function getInvoicePdfUrl(invoiceId: string): Promise<string> {
  const invoice = await stripe.invoices.retrieve(invoiceId)

  if (!invoice.invoice_pdf) {
    throw new Error(`Invoice ${invoiceId} does not have a PDF available`)
  }

  logger.info(`✅ Retrieved PDF URL for invoice ${invoiceId}`)
  return invoice.invoice_pdf
}

export default {
  getOrCreateStripeCustomer,
  syncFeaturesToStripe,
  createTrialSubscriptions,
  convertTrialToPaid,
  cancelSubscription,
  updatePaymentMethod,
  createTrialSetupIntent,
  getCustomerInvoices,
  getInvoicePdfUrl,
}
