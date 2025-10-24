/**
 * Stripe Webhook Event Handlers
 *
 * Handles Stripe webhook events to keep database in sync with subscription status
 */

import Stripe from 'stripe'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { FRONTEND_URL } from '@/config/env'
import emailService from './email.service'
import { createNotification } from './dashboard/notification.dashboard.service'
import { NotificationType, NotificationChannel, NotificationPriority, StaffRole } from '@prisma/client'

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
 * Send trial ending notifications (email + in-app) to venue owners and admins
 * Called by handleSubscriptionTrialWillEnd
 *
 * @param venueId - Venue ID
 * @param venueName - Venue name
 * @param featureName - Feature name
 * @param trialEndDate - Trial end date
 */
async function sendTrialEndingNotifications(venueId: string, venueName: string, featureName: string, trialEndDate: Date): Promise<void> {
  try {
    // 1. Query venue staff with OWNER and ADMIN roles
    const staffMembers = await prisma.staffVenue.findMany({
      where: {
        venueId,
        role: { in: [StaffRole.OWNER, StaffRole.ADMIN] },
      },
      include: {
        staff: {
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
          },
        },
      },
    })

    if (staffMembers.length === 0) {
      logger.warn('⚠️ No OWNER/ADMIN staff found for venue', { venueId })
      return
    }

    logger.info(`📧 Sending trial ending notifications to ${staffMembers.length} staff members`, { venueId })

    // 2. Generate billing portal URL
    const billingPortalUrl = `${FRONTEND_URL}/dashboard/venues/${venueId}/billing`

    // 3. Send notifications to each staff member
    for (const staffVenue of staffMembers) {
      const { staff } = staffVenue

      try {
        // 3a. Create in-app notification
        await createNotification({
          recipientId: staff.id,
          venueId,
          type: NotificationType.SUBSCRIPTION_TRIAL_ENDING,
          title: `⏰ Prueba gratuita terminando pronto`,
          message: `Tu prueba gratuita de ${featureName} termina el ${trialEndDate.toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric' })}. Actualiza tu método de pago para continuar usando esta función.`,
          metadata: {
            featureName,
            trialEndDate: trialEndDate.toISOString(),
            billingPortalUrl,
          },
          channels: [NotificationChannel.IN_APP, NotificationChannel.EMAIL],
          priority: NotificationPriority.HIGH,
        })

        logger.info('✅ In-app notification created', { userId: staff.id, venueId })

        // 3b. Send email notification
        const emailSent = await emailService.sendTrialEndingEmail(staff.email, {
          venueName,
          featureName,
          trialEndDate,
          billingPortalUrl,
        })

        if (emailSent) {
          logger.info('✅ Email sent successfully', { email: staff.email, venueId })
        } else {
          logger.warn('⚠️ Email failed to send', { email: staff.email, venueId })
        }
      } catch (notificationError) {
        // Log but don't throw - notifications should not block webhook success
        logger.error('❌ Failed to send notification to staff member', {
          staffId: staff.id,
          email: staff.email,
          error: notificationError instanceof Error ? notificationError.message : 'Unknown error',
        })
      }
    }

    logger.info('✅ Trial ending notifications sent successfully', { venueId, staffCount: staffMembers.length })
  } catch (error) {
    // Log but don't throw - notifications should not block webhook success
    logger.error('❌ Failed to send trial ending notifications', {
      venueId,
      error: error instanceof Error ? error.message : 'Unknown error',
    })
  }
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

  // Send notifications to venue owners and admins
  if (trialEnd) {
    await sendTrialEndingNotifications(venueFeature.venueId, venueFeature.venue.name, venueFeature.feature.name, trialEnd)
  }
}

/**
 * Handle customer deleted event
 * Triggered when a customer is permanently deleted from Stripe
 *
 * @param customer - Stripe Customer object
 */
export async function handleCustomerDeleted(customer: Stripe.Customer) {
  const customerId = customer.id

  logger.warn('📥 Webhook: Customer deleted from Stripe', {
    customerId,
    email: customer.email,
    name: customer.name,
  })

  // Find organization with this Stripe customer
  const organization = await prisma.organization.findFirst({
    where: { stripeCustomerId: customerId },
    include: {
      venues: {
        select: {
          id: true,
          name: true,
        },
      },
    },
  })

  if (!organization) {
    logger.warn('⚠️ Webhook: No organization found for deleted customer', { customerId })
    return
  }

  logger.warn('⚠️ Webhook: Removing Stripe customer ID from organization', {
    organizationId: organization.id,
    organizationName: organization.name,
    venueCount: organization.venues.length,
    customerId,
  })

  // Clear Stripe customer ID from organization
  await prisma.organization.update({
    where: { id: organization.id },
    data: {
      stripeCustomerId: null,
    },
  })

  // Deactivate all venue features (since payment method is gone)
  const deactivatedCount = await prisma.venueFeature.updateMany({
    where: {
      venue: {
        organizationId: organization.id,
      },
      active: true,
    },
    data: {
      active: false,
    },
  })

  logger.warn('⚠️ Webhook: Deactivated all features due to customer deletion', {
    organizationId: organization.id,
    deactivatedFeatures: deactivatedCount.count,
  })
}

/**
 * Main webhook event dispatcher
 * Routes events to appropriate handlers
 *
 * Implements idempotency to prevent duplicate event processing
 * by tracking events in the StripeWebhookEvent table
 *
 * @param event - Stripe Event object
 */
export async function handleStripeWebhookEvent(event: Stripe.Event) {
  logger.info('📥 Webhook received', { type: event.type, id: event.id })

  try {
    // 🔒 ATOMIC IDEMPOTENCY: Create event record to claim this event
    // If another process already claimed it, Prisma will throw unique constraint error
    try {
      await prisma.stripeWebhookEvent.create({
        data: {
          eventId: event.id,
          type: event.type,
          processed: false,
        },
      })
    } catch (error: any) {
      // P2002 = Unique constraint violation (eventId already exists)
      if (error.code === 'P2002') {
        logger.info('⏭️ Webhook event already being processed by another instance, skipping', {
          eventId: event.id,
          type: event.type,
        })
        return
      }
      // Re-throw other errors
      throw error
    }

    logger.info('🎯 Processing webhook event', { type: event.type, id: event.id })

    // Process event based on type
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

      case 'customer.deleted':
        await handleCustomerDeleted(event.data.object as Stripe.Customer)
        break

      default:
        logger.info('ℹ️ Webhook: Unhandled event type', { type: event.type })
    }

    // 🔒 IDEMPOTENCY: Mark event as processed after successful completion
    await prisma.stripeWebhookEvent.update({
      where: { eventId: event.id },
      data: { processed: true },
    })

    logger.info('✅ Webhook processed successfully', { type: event.type, id: event.id })
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'

    logger.error('❌ Webhook processing failed', {
      type: event.type,
      id: event.id,
      error: errorMessage,
    })

    // Track failure in database for observability
    try {
      await prisma.stripeWebhookEvent.update({
        where: { eventId: event.id },
        data: {
          processed: false,
          failureReason: errorMessage,
          failedAt: new Date(),
          retryCount: { increment: 1 },
        },
      })

      // If failed 3+ times, log critical alert (in production, send to PagerDuty/Slack)
      const failedEvent = await prisma.stripeWebhookEvent.findUnique({
        where: { eventId: event.id },
        select: { retryCount: true },
      })

      if (failedEvent && failedEvent.retryCount >= 3) {
        logger.error('🚨 CRITICAL: Webhook failed 3+ times', {
          eventId: event.id,
          type: event.type,
          retryCount: failedEvent.retryCount,
          error: errorMessage,
        })
        // TODO: Send alert to ops team (Slack/PagerDuty)
        // await alertOps(`Webhook ${event.id} failed ${failedEvent.retryCount} times`)
      }
    } catch (dbError) {
      // Don't throw if DB update fails - webhook failure is more important
      logger.warn('⚠️ Failed to update webhook failure tracking', {
        eventId: event.id,
        error: dbError instanceof Error ? dbError.message : 'Unknown error',
      })
    }

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
  handleCustomerDeleted,
}
