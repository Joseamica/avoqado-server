/**
 * Stripe Webhook Event Handlers
 *
 * Handles Stripe webhook events to keep database in sync with subscription status
 */

import Stripe from 'stripe'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'

/**
 * Handle subscription updated event
 * Triggered when subscription status changes (trial → active, active → canceled, etc.)
 *
 * @param subscription - Stripe Subscription object
 */
export async function handleSubscriptionUpdated(subscription: Stripe.Subscription) {
  const subscriptionId = subscription.id
  const status = subscription.status
  const trialEnd = subscription.trial_end ? new Date(subscription.trial_end * 1000) : null
  // Type assertion: current_period_end exists in Stripe API but not in type definitions
  const currentPeriodEnd = (subscription as any).current_period_end ? new Date((subscription as any).current_period_end * 1000) : null

  logger.info('📥 Webhook: Subscription updated', {
    subscriptionId,
    status,
    trialEnd,
    currentPeriodEnd,
  })

  // Find VenueFeature by subscription ID
  const venueFeature = await prisma.venueFeature.findFirst({
    where: { stripeSubscriptionId: subscriptionId },
    include: { feature: true, venue: true },
  })

  if (!venueFeature) {
    logger.warn('⚠️ Webhook: Subscription not found in database', { subscriptionId })
    return
  }

  // Update VenueFeature based on subscription status
  switch (status) {
    case 'active':
      // Trial ended, subscription is now active (paid)
      await prisma.venueFeature.update({
        where: { id: venueFeature.id },
        data: {
          active: true,
          endDate: null, // null = paid subscription (no expiration)
        },
      })
      logger.info('✅ Webhook: Feature activated (trial → paid)', {
        venueId: venueFeature.venueId,
        featureCode: venueFeature.feature.code,
        subscriptionId,
      })
      break

    case 'trialing':
      // Still in trial period
      await prisma.venueFeature.update({
        where: { id: venueFeature.id },
        data: {
          active: true,
          endDate: trialEnd,
        },
      })
      logger.info('✅ Webhook: Feature in trial', {
        venueId: venueFeature.venueId,
        featureCode: venueFeature.feature.code,
        trialEnd,
      })
      break

    case 'past_due':
      // Payment failed, but subscription still active
      logger.warn('⚠️ Webhook: Payment past due', {
        venueId: venueFeature.venueId,
        featureCode: venueFeature.feature.code,
        subscriptionId,
      })
      // Don't deactivate yet - Stripe will retry payment
      break

    case 'canceled':
    case 'unpaid':
      // Subscription canceled or payment failed multiple times
      await prisma.venueFeature.update({
        where: { id: venueFeature.id },
        data: {
          active: false,
        },
      })
      logger.info('❌ Webhook: Feature deactivated (subscription canceled/unpaid)', {
        venueId: venueFeature.venueId,
        featureCode: venueFeature.feature.code,
        subscriptionId,
        status,
      })
      break

    case 'incomplete':
    case 'incomplete_expired':
      // Subscription creation failed
      await prisma.venueFeature.update({
        where: { id: venueFeature.id },
        data: {
          active: false,
        },
      })
      logger.warn('⚠️ Webhook: Subscription incomplete/expired', {
        venueId: venueFeature.venueId,
        featureCode: venueFeature.feature.code,
        subscriptionId,
        status,
      })
      break

    default:
      logger.info('ℹ️ Webhook: Unhandled subscription status', { status, subscriptionId })
  }
}

/**
 * Handle subscription deleted event
 * Triggered when subscription is permanently deleted
 *
 * @param subscription - Stripe Subscription object
 */
export async function handleSubscriptionDeleted(subscription: Stripe.Subscription) {
  const subscriptionId = subscription.id

  logger.info('📥 Webhook: Subscription deleted', { subscriptionId })

  // Deactivate VenueFeature
  const result = await prisma.venueFeature.updateMany({
    where: { stripeSubscriptionId: subscriptionId },
    data: { active: false },
  })

  logger.info('❌ Webhook: Feature deactivated (subscription deleted)', {
    subscriptionId,
    affectedRecords: result.count,
  })
}

/**
 * Handle invoice payment succeeded event
 * Triggered when subscription payment is successful
 *
 * @param invoice - Stripe Invoice object
 */
export async function handleInvoicePaymentSucceeded(invoice: Stripe.Invoice) {
  // Type assertion: subscription exists in Stripe API (can be string | Subscription | null)
  const subscriptionId = (invoice as any).subscription as string | Stripe.Subscription | null
  const subscriptionIdStr = typeof subscriptionId === 'string' ? subscriptionId : subscriptionId?.id || null
  const amountPaid = invoice.amount_paid / 100 // Convert cents to dollars
  const currency = invoice.currency.toUpperCase()

  logger.info('📥 Webhook: Invoice payment succeeded', {
    invoiceId: invoice.id,
    subscriptionId: subscriptionIdStr,
    amountPaid,
    currency,
  })

  if (!subscriptionIdStr) {
    logger.warn('⚠️ Webhook: Invoice has no subscription', { invoiceId: invoice.id })
    return
  }

  // Verify VenueFeature is active
  const venueFeature = await prisma.venueFeature.findFirst({
    where: { stripeSubscriptionId: subscriptionIdStr },
    include: { feature: true },
  })

  if (!venueFeature) {
    logger.warn('⚠️ Webhook: Subscription not found for invoice', { subscriptionId: subscriptionIdStr, invoiceId: invoice.id })
    return
  }

  // Ensure feature is active (should already be, but double-check)
  if (!venueFeature.active) {
    await prisma.venueFeature.update({
      where: { id: venueFeature.id },
      data: { active: true, endDate: null },
    })
    logger.info('✅ Webhook: Feature reactivated after payment', {
      venueId: venueFeature.venueId,
      featureCode: venueFeature.feature.code,
      amountPaid,
    })
  }
}

/**
 * Handle invoice payment failed event
 * Triggered when subscription payment fails
 *
 * @param invoice - Stripe Invoice object
 */
export async function handleInvoicePaymentFailed(invoice: Stripe.Invoice) {
  // Type assertion: subscription exists in Stripe API (can be string | Subscription | null)
  const subscriptionId = (invoice as any).subscription as string | Stripe.Subscription | null
  const subscriptionIdStr = typeof subscriptionId === 'string' ? subscriptionId : subscriptionId?.id || null
  const attemptCount = invoice.attempt_count

  logger.warn('📥 Webhook: Invoice payment failed', {
    invoiceId: invoice.id,
    subscriptionId: subscriptionIdStr,
    attemptCount,
  })

  if (!subscriptionIdStr) {
    logger.warn('⚠️ Webhook: Invoice has no subscription', { invoiceId: invoice.id })
    return
  }

  const venueFeature = await prisma.venueFeature.findFirst({
    where: { stripeSubscriptionId: subscriptionIdStr },
    include: { feature: true, venue: true },
  })

  if (!venueFeature) {
    logger.warn('⚠️ Webhook: Subscription not found for failed invoice', { subscriptionId: subscriptionIdStr })
    return
  }

  // After 3 failed attempts, Stripe will cancel the subscription
  // We'll wait for subscription.deleted event to deactivate feature
  // For now, just log the warning
  logger.warn('⚠️ Webhook: Payment failed for feature', {
    venueId: venueFeature.venueId,
    featureCode: venueFeature.feature.code,
    attemptCount,
    maxAttempts: 3,
  })

  // TODO: Send notification to venue owner about payment failure
}

/**
 * Handle subscription trial will end event
 * Triggered 3 days before trial ends (configurable in Stripe)
 *
 * @param subscription - Stripe Subscription object
 */
export async function handleSubscriptionTrialWillEnd(subscription: Stripe.Subscription) {
  const subscriptionId = subscription.id
  const trialEnd = subscription.trial_end ? new Date(subscription.trial_end * 1000) : null

  logger.info('📥 Webhook: Subscription trial will end', {
    subscriptionId,
    trialEnd,
  })

  const venueFeature = await prisma.venueFeature.findFirst({
    where: { stripeSubscriptionId: subscriptionId },
    include: { feature: true, venue: true },
  })

  if (!venueFeature) {
    logger.warn('⚠️ Webhook: Subscription not found', { subscriptionId })
    return
  }

  logger.info('ℹ️ Webhook: Trial ending soon', {
    venueId: venueFeature.venueId,
    venueName: venueFeature.venue.name,
    featureCode: venueFeature.feature.code,
    trialEnd,
  })

  // TODO: Send notification to venue owner about trial ending
  // TODO: Create in-app notification
}

/**
 * Main webhook event dispatcher
 * Routes events to appropriate handlers
 *
 * @param event - Stripe Event object
 */
export async function handleStripeWebhookEvent(event: Stripe.Event) {
  logger.info('📥 Webhook received', { type: event.type, id: event.id })

  try {
    switch (event.type) {
      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(event.data.object as Stripe.Subscription)
        break

      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object as Stripe.Subscription)
        break

      case 'invoice.payment_succeeded':
        await handleInvoicePaymentSucceeded(event.data.object as Stripe.Invoice)
        break

      case 'invoice.payment_failed':
        await handleInvoicePaymentFailed(event.data.object as Stripe.Invoice)
        break

      case 'customer.subscription.trial_will_end':
        await handleSubscriptionTrialWillEnd(event.data.object as Stripe.Subscription)
        break

      default:
        logger.info('ℹ️ Webhook: Unhandled event type', { type: event.type })
    }

    logger.info('✅ Webhook processed successfully', { type: event.type, id: event.id })
  } catch (error) {
    logger.error('❌ Webhook processing failed', {
      type: event.type,
      id: event.id,
      error: error instanceof Error ? error.message : 'Unknown error',
    })
    throw error
  }
}

export default {
  handleStripeWebhookEvent,
  handleSubscriptionUpdated,
  handleSubscriptionDeleted,
  handleInvoicePaymentSucceeded,
  handleInvoicePaymentFailed,
  handleSubscriptionTrialWillEnd,
}
