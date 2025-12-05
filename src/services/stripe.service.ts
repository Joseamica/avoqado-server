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
import { addDays } from 'date-fns'
import emailService from './email.service'

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
  venueId: string,
  email: string,
  name: string,
  venueName?: string,
  venueSlug?: string,
): Promise<string> {
  // Check if venue already has a Stripe customer
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    select: { stripeCustomerId: true },
  })

  // Venue must exist
  if (!venue) {
    throw new Error(`Venue ${venueId} not found`)
  }

  if (venue.stripeCustomerId) {
    logger.info(`✅ Venue ${venueId} already has Stripe customer: ${venue.stripeCustomerId}`)

    // Update customer description with venue info if provided
    if (venueName || venueSlug) {
      try {
        await retry(
          () =>
            stripe.customers.update(venue.stripeCustomerId!, {
              description: venueName ? `Venue: ${venueName}${venueSlug ? ` (${venueSlug})` : ''}` : undefined,
              metadata: {
                venueId,
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

    return venue.stripeCustomerId
  }

  // Create new Stripe customer with venue info (with retry)
  // Include venue slug in name for easy identification in Stripe dashboard
  const customerName = venueSlug ? `${name} (${venueSlug})` : name

  const customer = await retry(
    () =>
      stripe.customers.create({
        email,
        name: customerName,
        description: venueName ? `Venue: ${venueName}${venueSlug ? ` (${venueSlug})` : ''}` : undefined,
        metadata: {
          venueId,
          ...(venueSlug && { venueSlug }),
        },
      }),
    {
      retries: 3,
      shouldRetry: shouldRetryStripeError,
      context: 'stripe.createCustomer',
    },
  )

  // Save customer ID to venue database
  await prisma.venue.update({
    where: { id: venueId },
    data: { stripeCustomerId: customer.id },
  })

  logger.info(`✅ Created Stripe customer ${customer.id} for venue ${venueId}`)
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
 * @param paymentMethodId - Optional Stripe payment method ID to use for subscription
 * @returns Created subscription IDs
 */
export async function createTrialSubscriptions(
  customerId: string,
  venueId: string,
  featureCodes: string[],
  trialPeriodDays: number = 5,
  venueName?: string,
  venueSlug?: string,
  paymentMethodId?: string,
): Promise<string[]> {
  logger.info(`🎯 Creating trial subscriptions for venue ${venueId}, features: ${featureCodes.join(', ')}`, {
    paymentMethodId: paymentMethodId || 'default',
  })

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
  const errors: { featureCode: string; error: Error }[] = []

  // Create individual subscription for each feature
  for (const feature of features) {
    try {
      // ✅ FIX: Check if VenueFeature already exists with a subscription
      // If it does, reuse the existing subscription instead of creating a new one
      const existingVenueFeature = await prisma.venueFeature.findUnique({
        where: {
          venueId_featureId: {
            venueId,
            featureId: feature.id,
          },
        },
        select: {
          id: true,
          stripeSubscriptionId: true,
        },
      })

      let subscription: Stripe.Subscription

      if (existingVenueFeature?.stripeSubscriptionId) {
        // VenueFeature exists with a subscription - check if it's still valid
        logger.info(`  🔍 Found existing subscription ${existingVenueFeature.stripeSubscriptionId} for feature ${feature.code}`)

        try {
          // Retrieve the existing subscription from Stripe
          const existingSubscription = await stripe.subscriptions.retrieve(existingVenueFeature.stripeSubscriptionId)

          // If subscription is incomplete or past_due, reuse it and attempt payment
          if (existingSubscription.status === 'incomplete' || existingSubscription.status === 'past_due') {
            logger.info(`  ♻️ Reusing existing ${existingSubscription.status} subscription ${existingSubscription.id}`)
            subscription = existingSubscription

            // ✅ FIX: Attempt to charge the latest invoice immediately
            // This triggers webhooks and provides immediate feedback
            try {
              const latestInvoice = existingSubscription.latest_invoice
              if (latestInvoice) {
                const invoiceId = typeof latestInvoice === 'string' ? latestInvoice : latestInvoice.id
                logger.info(`  💳 Attempting to charge invoice ${invoiceId}...`)

                // Attempt payment - this will trigger webhooks (success or failure)
                const paidInvoice = await stripe.invoices.pay(invoiceId)

                if (paidInvoice.status === 'paid') {
                  logger.info(`  ✅ Payment successful! Invoice ${invoiceId} paid`)
                } else {
                  logger.warn(`  ⚠️ Payment incomplete. Invoice ${invoiceId} status: ${paidInvoice.status}`)
                }
              }
            } catch (paymentError: any) {
              // Payment failed - this is expected, webhook will handle it
              logger.warn(`  ❌ Payment failed: ${paymentError.message}`)
              logger.warn(`  📧 User will receive email notification to update payment method`)
              // Don't throw - feature should show as inactive, but record should be created
            }
          } else if (existingSubscription.status === 'canceled') {
            // If canceled, create a new one
            logger.info(`  🆕 Existing subscription canceled, creating new one`)
            subscription = await retry(
              () =>
                stripe.subscriptions.create({
                  customer: customerId,
                  items: [{ price: feature.stripePriceId! }],
                  trial_period_days: trialPeriodDays,
                  description: venueNameToUse ? `${feature.name} - ${venueNameToUse}` : undefined,
                  ...(paymentMethodId && { default_payment_method: paymentMethodId }),
                  metadata: {
                    venueId,
                    featureId: feature.id,
                    featureCode: feature.code,
                    ...(venueNameToUse && { venueName: venueNameToUse }),
                    ...(venueSlugToUse && { venueSlug: venueSlugToUse }),
                  },
                  collection_method: 'charge_automatically',
                  payment_behavior: 'default_incomplete',
                  payment_settings: {
                    save_default_payment_method: 'on_subscription',
                    payment_method_types: ['card'],
                  },
                }),
              {
                retries: 3,
                shouldRetry: shouldRetryStripeError,
                context: 'stripe.createSubscription',
              },
            )
          } else {
            // Active subscription - reuse it
            logger.info(`  ✅ Reusing existing active subscription ${existingSubscription.id}`)
            subscription = existingSubscription
          }
        } catch {
          // Subscription not found in Stripe - create new one
          logger.warn(`  ⚠️ Subscription ${existingVenueFeature.stripeSubscriptionId} not found in Stripe, creating new one`)
          subscription = await retry(
            () =>
              stripe.subscriptions.create({
                customer: customerId,
                items: [{ price: feature.stripePriceId! }],
                trial_period_days: trialPeriodDays,
                description: venueNameToUse ? `${feature.name} - ${venueNameToUse}` : undefined,
                ...(paymentMethodId && { default_payment_method: paymentMethodId }),
                metadata: {
                  venueId,
                  featureId: feature.id,
                  featureCode: feature.code,
                  ...(venueNameToUse && { venueName: venueNameToUse }),
                  ...(venueSlugToUse && { venueSlug: venueSlugToUse }),
                },
                collection_method: 'charge_automatically',
                payment_behavior: 'default_incomplete',
                payment_settings: {
                  save_default_payment_method: 'on_subscription',
                  payment_method_types: ['card'],
                },
              }),
            {
              retries: 3,
              shouldRetry: shouldRetryStripeError,
              context: 'stripe.createSubscription',
            },
          )
        }
      } else {
        // No existing VenueFeature or no subscription - create new subscription
        logger.info(`  🆕 Creating new subscription for feature ${feature.code}`)
        subscription = await retry(
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
              ...(paymentMethodId && { default_payment_method: paymentMethodId }),
              metadata: {
                venueId,
                featureId: feature.id,
                featureCode: feature.code,
                ...(venueNameToUse && { venueName: venueNameToUse }),
                ...(venueSlugToUse && { venueSlug: venueSlugToUse }),
              },
              // ✅ FIX: Configuración para evitar múltiples invoices en fallos de pago
              // Stripe debe REINTENTAR la misma invoice en lugar de crear nuevas
              collection_method: 'charge_automatically',
              payment_behavior: 'default_incomplete',
              payment_settings: {
                save_default_payment_method: 'on_subscription',
                payment_method_types: ['card'],
              },
            }),
          {
            retries: 3,
            shouldRetry: shouldRetryStripeError,
            context: 'stripe.createSubscription',
          },
        )
      }

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

      // Active logic:
      // - If trialPeriodDays > 0: active=true (trial, no payment required yet)
      // - If subscription.status is 'active' or 'trialing': active=true (already paid/valid in Stripe)
      // - Otherwise: active=false (wait for payment confirmation via webhook)
      const isActive = trialPeriodDays > 0 || subscription.status === 'active' || subscription.status === 'trialing'

      await prisma.venueFeature.upsert({
        where: {
          venueId_featureId: {
            venueId,
            featureId: feature.id,
          },
        },
        update: {
          // Reactivate existing subscription (renewal after cancellation)
          active: isActive,
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
          active: isActive,
          monthlyPrice: feature.monthlyPrice,
          startDate: new Date(),
          endDate,
          stripeSubscriptionId: subscription.id,
          stripePriceId: feature.stripePriceId,
        },
      })

      subscriptionIds.push(subscription.id)
      if (isActive) {
        const reason = trialPeriodDays > 0 ? 'trial' : subscription.status === 'active' ? 'already paid' : subscription.status
        logger.info(`  ✅ Subscription ${subscription.id} for feature ${feature.code} is ACTIVE (reason: ${reason})`)
      } else {
        logger.info(
          `  ⏳ Created subscription ${subscription.id} for feature ${feature.code} (active=false, waiting for payment confirmation)`,
        )

        // ✅ FIX: For non-trial subscriptions (trialPeriodDays=0), immediately attempt to charge the invoice
        // This prevents the "two-click" issue where users had to subscribe twice to complete payment
        if (trialPeriodDays === 0 && subscription.status === 'incomplete') {
          try {
            const latestInvoice = subscription.latest_invoice
            if (latestInvoice) {
              const invoiceId = typeof latestInvoice === 'string' ? latestInvoice : latestInvoice.id
              logger.info(`  💳 Attempting to charge invoice ${invoiceId} immediately...`)

              // Attempt payment - this triggers webhooks and provides immediate feedback
              const paidInvoice = await stripe.invoices.pay(invoiceId)

              if (paidInvoice.status === 'paid') {
                // ✅ FIX BUG #2: Immediately activate feature instead of waiting for webhook
                // Webhook can have 1-10 second latency, causing "pending" state after successful payment
                await prisma.venueFeature.update({
                  where: {
                    venueId_featureId: {
                      venueId,
                      featureId: feature.id,
                    },
                  },
                  data: {
                    active: true,
                    endDate: null,
                    startDate: new Date(),
                  },
                })
                logger.info(`  ✅ Payment successful! Invoice ${invoiceId} paid, feature IMMEDIATELY activated`)
              } else {
                logger.warn(`  ⚠️ Payment incomplete. Invoice ${invoiceId} status: ${paidInvoice.status}`)
              }
            }
          } catch (paymentError: any) {
            // Payment failed - this is expected for card errors
            // Webhook will handle the failure notification, don't block subscription creation
            logger.warn(`  ❌ Payment failed: ${paymentError.message}`)
            logger.warn(`  📧 User will receive email notification about payment failure`)
            // Don't throw - subscription record should exist even if payment fails
          }
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      logger.error(`  ❌ Error creating subscription for feature ${feature.code}: ${errorMessage}`)
      errors.push({
        featureCode: feature.code,
        error: error instanceof Error ? error : new Error(errorMessage),
      })
    }
  }

  // If any subscriptions failed, throw error with details
  if (errors.length > 0) {
    const errorDetails = errors.map(e => `${e.featureCode}: ${e.error.message}`).join('; ')
    throw new Error(
      `Failed to create ${errors.length} subscription(s): ${errorDetails}. Please ensure you have a valid payment method attached.`,
    )
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
export async function getCustomerInvoices(
  customerId: string,
  options?: {
    limit?: number
    starting_after?: string
  },
): Promise<{ invoices: Stripe.Invoice[]; hasMore: boolean; lastInvoiceId?: string }> {
  const limit = options?.limit || 10 // Default to 10 for better UX
  const invoices = await stripe.invoices.list({
    customer: customerId,
    limit: limit + 1, // Fetch one extra to check if there are more
    ...(options?.starting_after && { starting_after: options.starting_after }),
  })

  // Check if there are more invoices
  const hasMore = invoices.data.length > limit
  const resultInvoices = hasMore ? invoices.data.slice(0, limit) : invoices.data
  const lastInvoiceId = resultInvoices.length > 0 ? resultInvoices[resultInvoices.length - 1].id : undefined

  logger.info(`✅ Retrieved ${resultInvoices.length} invoices for customer ${customerId}`, {
    hasMore,
    requestedLimit: limit,
  })

  return {
    invoices: resultInvoices,
    hasMore,
    lastInvoiceId,
  }
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

/**
 * Preview proration for subscription change
 * Shows how much the customer will be charged/credited when changing subscription
 *
 * @param subscriptionId - Stripe subscription ID
 * @param newPriceId - New Stripe price ID to change to
 * @returns Proration details with amount and description
 */
export async function previewSubscriptionProration(
  subscriptionId: string,
  newPriceId: string,
): Promise<{
  prorationAmount: number
  currency: string
  nextInvoiceAmount: number
  immediateCharge: boolean
  description: string
}> {
  // Get current subscription
  const subscription = await stripe.subscriptions.retrieve(subscriptionId)

  if (!subscription.items.data[0]) {
    throw new Error('Subscription has no items')
  }

  const currentItem = subscription.items.data[0]
  const currentPrice = await stripe.prices.retrieve(currentItem.price.id)
  const newPrice = await stripe.prices.retrieve(newPriceId)

  // Calculate time remaining in current period
  const now = Math.floor(Date.now() / 1000)
  const periodEnd = (subscription as any).current_period_end
  const periodStart = (subscription as any).current_period_start
  const totalPeriodSeconds = periodEnd - periodStart
  const remainingSeconds = periodEnd - now
  const percentageRemaining = remainingSeconds / totalPeriodSeconds

  // Calculate amounts (Stripe prices are in cents)
  const currentAmount = currentPrice.unit_amount || 0
  const newAmount = newPrice.unit_amount || 0
  const priceDiff = newAmount - currentAmount

  // Calculate prorated amount
  // For upgrade: charge the difference prorated for remaining time
  // For downgrade: credit the difference prorated for remaining time
  const prorationAmount = Math.round(priceDiff * percentageRemaining)
  const immediateCharge = prorationAmount > 0

  const currency = currentPrice.currency
  let description = ''

  if (immediateCharge) {
    description = `You'll be charged ${(prorationAmount / 100).toFixed(2)} ${currency.toUpperCase()} today (prorated)`
  } else if (prorationAmount < 0) {
    description = `You'll receive a ${(Math.abs(prorationAmount) / 100).toFixed(2)} ${currency.toUpperCase()} credit (prorated)`
  } else {
    description = 'No immediate charge - change takes effect on next billing cycle'
  }

  logger.info(`💰 Proration preview calculated`, {
    subscriptionId,
    currentAmount,
    newAmount,
    prorationAmount,
    percentageRemaining,
    immediateCharge,
  })

  return {
    prorationAmount,
    currency,
    nextInvoiceAmount: newAmount,
    immediateCharge,
    description,
  }
}

/**
 * Update subscription to a new price with proration
 *
 * @param subscriptionId - Stripe subscription ID
 * @param newPriceId - New Stripe price ID
 * @returns Updated subscription
 */
export async function updateSubscriptionPrice(subscriptionId: string, newPriceId: string): Promise<Stripe.Subscription> {
  const subscription = await stripe.subscriptions.retrieve(subscriptionId)

  if (!subscription.items.data[0]) {
    throw new Error('Subscription has no items')
  }

  const currentItem = subscription.items.data[0]

  logger.info(`🔄 Updating subscription ${subscriptionId} to new price ${newPriceId}`)

  const updatedSubscription = await stripe.subscriptions.update(subscriptionId, {
    items: [
      {
        id: currentItem.id,
        price: newPriceId,
      },
    ],
    proration_behavior: 'always_invoice',
    proration_date: Math.floor(Date.now() / 1000),
  })

  logger.info(`✅ Subscription updated successfully`, {
    subscriptionId,
    newPriceId,
    status: updatedSubscription.status,
  })

  return updatedSubscription
}

/**
 * Retry payment for a failed invoice
 * Uses Stripe's invoice.pay() API to manually retry payment with the customer's default payment method
 *
 * @param invoiceId - Stripe invoice ID
 * @returns Paid invoice object
 * @throws Error if invoice is already paid or cannot be paid
 */
export async function retryInvoicePayment(invoiceId: string): Promise<Stripe.Invoice> {
  // First retrieve the invoice to check its status
  const invoice = await stripe.invoices.retrieve(invoiceId)

  // Validate invoice can be paid
  if (invoice.status === 'paid') {
    throw new Error(`Invoice ${invoiceId} is already paid`)
  }

  if (invoice.status !== 'open' && invoice.status !== 'uncollectible') {
    throw new Error(`Invoice ${invoiceId} cannot be paid (status: ${invoice.status})`)
  }

  logger.info(`🔄 Retrying payment for invoice ${invoiceId}`, {
    amount: invoice.amount_due,
    currency: invoice.currency,
    attemptCount: invoice.attempt_count,
  })

  // Attempt to pay the invoice
  const paidInvoice = await stripe.invoices.pay(invoiceId)

  logger.info(`✅ Invoice payment successful`, {
    invoiceId,
    status: paidInvoice.status,
    amountPaid: paidInvoice.amount_paid,
  })

  return paidInvoice
}

/**
 * List all payment methods for a Stripe customer
 * Returns formatted payment method data with default indicator
 *
 * @param customerId - Stripe customer ID
 * @returns Array of payment method objects with isDefault flag
 */
export async function listPaymentMethods(customerId: string): Promise<
  Array<{
    id: string
    card: {
      brand: string
      last4: string
      exp_month: number
      exp_year: number
    }
    isDefault: boolean
  }>
> {
  // Retrieve customer to get default payment method
  const customer = await stripe.customers.retrieve(customerId)

  // Get default payment method ID from customer
  // Stripe.Customer | Stripe.DeletedCustomer - check if customer is not deleted
  const defaultPaymentMethodId =
    !customer.deleted && customer.invoice_settings?.default_payment_method
      ? typeof customer.invoice_settings.default_payment_method === 'string'
        ? customer.invoice_settings.default_payment_method
        : customer.invoice_settings.default_payment_method.id
      : null

  // List all card payment methods
  const paymentMethods = await stripe.paymentMethods.list({
    customer: customerId,
    type: 'card',
  })

  logger.info(`✅ Listed ${paymentMethods.data.length} payment methods for customer ${customerId}`, {
    defaultPaymentMethodId,
  })

  // Format and return payment methods with default indicator
  return paymentMethods.data.map(pm => ({
    id: pm.id,
    card: {
      brand: pm.card?.brand || 'unknown',
      last4: pm.card?.last4 || '0000',
      exp_month: pm.card?.exp_month || 0,
      exp_year: pm.card?.exp_year || 0,
    },
    isDefault: pm.id === defaultPaymentMethodId,
  }))
}

/**
 * Detach (delete) a payment method from a customer
 *
 * @param paymentMethodId - Stripe payment method ID
 */
export async function detachPaymentMethod(paymentMethodId: string) {
  await stripe.paymentMethods.detach(paymentMethodId)
  logger.info(`✅ Payment method ${paymentMethodId} detached`)
}

/**
 * Set a payment method as the default for a customer
 *
 * @param customerId - Stripe customer ID
 * @param paymentMethodId - Stripe payment method ID
 */
export async function setDefaultPaymentMethod(customerId: string, paymentMethodId: string) {
  await stripe.customers.update(customerId, {
    invoice_settings: {
      default_payment_method: paymentMethodId,
    },
  })
  logger.info(`✅ Set default payment method ${paymentMethodId} for customer ${customerId}`)
}

/**
 * Generate billing portal URL for customer to update payment method
 * @param customerId - Stripe customer ID
 * @param returnUrl - Optional return URL after leaving Stripe portal (should include venue slug)
 * @returns Billing portal URL
 */
export async function generateBillingPortalUrl(customerId: string, returnUrl?: string): Promise<string> {
  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl || `${process.env.FRONTEND_URL || 'https://dashboardv2.avoqado.io'}/dashboard`,
    })
    return session.url
  } catch (error) {
    logger.error('❌ Failed to generate billing portal URL', {
      customerId,
      error: error instanceof Error ? error.message : 'Unknown error',
    })
    // Fallback: Return the provided URL or dashboard
    return returnUrl || `${process.env.FRONTEND_URL || 'https://dashboardv2.avoqado.io'}/dashboard`
  }
}

/**
 * Check if this is the first payment attempt for a subscription
 * Used to determine grace period eligibility (only for returning customers)
 *
 * @param subscriptionId - Stripe subscription ID
 * @returns true if this is the first payment attempt (no previous successful payments)
 */
async function isFirstSubscriptionPayment(subscriptionId: string): Promise<boolean> {
  try {
    // Query Stripe for invoices with successful payments for this subscription
    const invoices = await stripe.invoices.list({
      subscription: subscriptionId,
      status: 'paid',
      limit: 1,
    })

    // If there are no paid invoices, this is the first payment attempt
    const isFirstPayment = invoices.data.length === 0

    logger.info(`🔍 Checked payment history for subscription ${subscriptionId}`, {
      isFirstPayment,
      paidInvoiceCount: invoices.data.length,
    })

    return isFirstPayment
  } catch (error) {
    logger.error('❌ Error checking subscription payment history', {
      subscriptionId,
      error: error instanceof Error ? error.message : 'Unknown error',
    })
    // On error, assume it's NOT the first payment (safer to give grace period)
    return false
  }
}

/**
 * Handle payment failure with dunning management
 * Implements grace period logic and progressive warnings
 *
 * Dunning Strategy (Returning Customers):
 * - Day 0 (attempt 1): Email "Payment failed, please update" + 7-day grace period
 * - Day 3 (attempt 2): Email "Reminder: Update payment method"
 * - Day 5 (attempt 3): Email "Final warning before suspension"
 * - Day 7 (attempt 4): SOFT SUSPENSION - Block access, keep data
 * - Day 14 (attempt 5+): HARD CANCEL - Handled by cron job
 *
 * First-Time Customers:
 * - Day 0 (attempt 1): Immediate suspension, no grace period
 * - Must update payment method to activate feature
 *
 * @param subscriptionId - Stripe subscription ID
 * @param attemptCount - Number of payment attempts (from invoice.attempt_count)
 * @param invoiceData - Invoice details for email (invoiceId, amountDue, currency, last4)
 */
export async function handlePaymentFailure(
  subscriptionId: string,
  attemptCount: number,
  invoiceData?: {
    invoiceId: string
    amountDue: number
    currency: string
    last4?: string
  },
): Promise<void> {
  logger.info(`🚨 Handling payment failure for subscription ${subscriptionId}, attempt ${attemptCount}`)

  // Find VenueFeature by subscription ID
  const venueFeature = await prisma.venueFeature.findFirst({
    where: { stripeSubscriptionId: subscriptionId },
    include: {
      venue: {
        select: {
          id: true,
          name: true,
          slug: true,
          stripeCustomerId: true,
          organization: true,
        },
      },
      feature: true,
    },
  })

  if (!venueFeature) {
    logger.warn(`⚠️ VenueFeature not found for subscription ${subscriptionId}`)
    return
  }

  const now = new Date()

  // Update failure tracking
  const updateData: any = {
    lastPaymentAttempt: now,
    paymentFailureCount: attemptCount,
  }

  // Check if this is the first payment attempt for this subscription
  let isFirstPayment = false
  if (attemptCount === 1) {
    isFirstPayment = await isFirstSubscriptionPayment(subscriptionId)
  }

  // Set grace period on first failure (7 days) - ONLY for returning customers
  if (attemptCount === 1) {
    if (isFirstPayment) {
      // First-time customer: Immediate suspension, NO grace period
      updateData.gracePeriodEndsAt = null
      updateData.suspendedAt = now
      updateData.active = false
      logger.warn(`🚫 FIRST PAYMENT FAILED: Immediate suspension for ${venueFeature.feature.name} (Venue: ${venueFeature.venue.name})`, {
        subscriptionId,
        reason: 'First payment attempt failed - no grace period for new customers',
      })
    } else {
      // Returning customer: 7-day grace period
      updateData.gracePeriodEndsAt = addDays(now, 7)
      // active stays TRUE during grace period
      logger.info(`⏰ RETURNING CUSTOMER: Grace period granted for ${venueFeature.feature.name} (Venue: ${venueFeature.venue.name})`, {
        subscriptionId,
        gracePeriodEndsAt: updateData.gracePeriodEndsAt,
      })
    }
  }

  await prisma.venueFeature.update({
    where: { id: venueFeature.id },
    data: updateData,
  })

  logger.info(`📊 Updated failure tracking for ${venueFeature.feature.name} (Venue: ${venueFeature.venue.name})`, {
    attemptCount,
    isFirstPayment,
    gracePeriodEndsAt: updateData.gracePeriodEndsAt,
    suspended: updateData.suspendedAt !== undefined,
  })

  // Generate billing portal URL for customer to update payment method
  // Build venue-aware return URL
  const FRONTEND_URL = process.env.FRONTEND_URL || 'https://dashboard.avoqado.io'
  const returnUrl = venueFeature.venue.slug
    ? `${FRONTEND_URL}/dashboard/venues/${venueFeature.venue.slug}/billing`
    : `${FRONTEND_URL}/dashboard/venues/${venueFeature.venue.id}/billing`

  const billingPortalUrl = venueFeature.venue.stripeCustomerId
    ? await generateBillingPortalUrl(venueFeature.venue.stripeCustomerId, returnUrl)
    : returnUrl

  // Send appropriate notification based on attempt count
  switch (attemptCount) {
    case 1:
    case 2:
    case 3:
      // Day 0, 3, 5: Payment failed emails
      try {
        if (!invoiceData) {
          logger.warn('⚠️ Invoice data not provided, skipping payment failed email', {
            subscriptionId,
            attemptCount,
          })
          break
        }

        const emailSent = await emailService.sendPaymentFailedEmail(venueFeature.venue.organization.email, {
          venueName: venueFeature.venue.name,
          featureName: venueFeature.feature.name,
          attemptCount,
          amountDue: invoiceData.amountDue,
          currency: invoiceData.currency,
          billingPortalUrl,
          last4: invoiceData.last4,
        })

        if (emailSent) {
          logger.info(`✅ Payment failed email sent (attempt ${attemptCount})`, {
            email: venueFeature.venue.organization.email,
            venueId: venueFeature.venueId,
            featureName: venueFeature.feature.name,
          })
        } else {
          logger.warn(`⚠️ Payment failed email failed to send (attempt ${attemptCount})`, {
            email: venueFeature.venue.organization.email,
            venueId: venueFeature.venueId,
          })
        }
      } catch (emailError) {
        // Non-blocking: Log error but continue dunning process
        logger.error('❌ Error sending payment failed email', {
          attemptCount,
          subscriptionId,
          error: emailError instanceof Error ? emailError.message : 'Unknown error',
        })
      }
      break

    case 4:
      // Day 7: Soft suspension
      await prisma.venueFeature.update({
        where: { id: venueFeature.id },
        data: {
          suspendedAt: now,
          active: false, // Block access but keep data
        },
      })

      logger.warn(`⛔ SUSPENDED: Feature ${venueFeature.feature.name} for venue ${venueFeature.venue.name}`)

      try {
        const emailSent = await emailService.sendSubscriptionSuspendedEmail(venueFeature.venue.organization.email, {
          venueName: venueFeature.venue.name,
          featureName: venueFeature.feature.name,
          suspendedAt: now,
          gracePeriodEndsAt: updateData.gracePeriodEndsAt || addDays(now, 7),
          billingPortalUrl,
        })

        if (emailSent) {
          logger.info('✅ Subscription suspended email sent', {
            email: venueFeature.venue.organization.email,
            venueId: venueFeature.venueId,
            featureName: venueFeature.feature.name,
          })
        } else {
          logger.warn('⚠️ Subscription suspended email failed to send', {
            email: venueFeature.venue.organization.email,
            venueId: venueFeature.venueId,
          })
        }
      } catch (emailError) {
        // Non-blocking: Log error but continue dunning process
        logger.error('❌ Error sending subscription suspended email', {
          subscriptionId,
          error: emailError instanceof Error ? emailError.message : 'Unknown error',
        })
      }
      break

    default:
      // Attempt 5+: Grace period expired, awaiting hard cancel by cron job
      logger.warn(`⚠️ Payment failure attempt ${attemptCount} for subscription ${subscriptionId}. Awaiting hard cancellation by cron job.`)
      break
  }

  logger.info(`✅ Payment failure handling complete for subscription ${subscriptionId}`)
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
  listPaymentMethods,
  detachPaymentMethod,
  setDefaultPaymentMethod,
  handlePaymentFailure,
}
