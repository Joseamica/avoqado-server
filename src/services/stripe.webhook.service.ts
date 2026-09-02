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
import { resolvePlanNotificationTarget } from './access/planNotification.service'
import { createNotification } from './dashboard/notification.dashboard.service'
import { NotificationType, NotificationChannel, NotificationPriority, StaffRole } from '@prisma/client'
import { handlePaymentFailure, generateBillingPortalUrl, fulfillPlanCheckout } from './stripe.service'
import { PAID_PLAN_TIER_CODES } from './access/basePlan.service'
import socketManager from '../communication/sockets'
import { tokenBudgetService } from './dashboard/token-budget.service'
import { OPERATIONAL_VENUE_STATUSES } from '@/lib/venueStatus.constants'
import { fulfillPurchase as fulfillCreditPackPurchase } from './dashboard/creditPack.public.service'
import { executeSeatReconciliation, reactivateSeatCapDeactivated } from './dashboard/seatReconciliation.service'
import { commercialStripeWebhookAdapter } from './commercial/commercialStripeWebhookAdapter.service'
import {
  createCurrentStripeWebhookDispatcher,
  type CurrentHandlerEffectResult,
  type InvoiceEffectResult,
  type PaymentIntentEffectResult,
} from './stripe-webhooks/platformWebhookCurrentDispatcher.service'

/**
 * Run the pending Pro→Free seat reconciliation for a venue AFTER its paid plan has been
 * downgraded (VenueFeature deactivated). If the owner scheduled a downgrade-to-Free with a
 * "who stays" selection, this deactivates the non-selected StaffVenue rows now that the venue
 * has actually dropped to Free. Idempotent and a no-op when nothing is pending. NEVER throws —
 * a reconciliation failure must not fail the webhook (the venue is already on Free); it's
 * logged and can be re-run (the next webhook delivery, or a manual call, is safe).
 */
async function runSeatReconciliationSafely(venueId: string): Promise<void> {
  try {
    const deactivated = await executeSeatReconciliation(venueId)
    if (deactivated > 0) {
      logger.info('🪑 Webhook: executed pending seat reconciliation on paid→Free transition', {
        venueId,
        deactivated,
      })
    }
  } catch (error) {
    logger.error('🪑 Webhook: failed to execute seat reconciliation (non-fatal)', {
      venueId,
      error: error instanceof Error ? error.message : 'Unknown error',
    })
  }
}

/**
 * Re-activate the StaffVenue rows the Free-tier seat cap previously deactivated, AFTER a venue
 * RE-UPGRADES to a paid base plan (PLAN_PRO / PLAN_PREMIUM → unlimited seats). Mirrors
 * {@link runSeatReconciliationSafely}: idempotent, a no-op when nothing was cap-deactivated, and
 * NEVER throws — a reactivation failure must not fail the webhook (the plan activation already
 * succeeded); it's logged and the operation is re-runnable on the next delivery or manually.
 * Call ONLY for base-plan (paid tier) activations, never add-ons.
 */
async function runSeatReactivationSafely(venueId: string): Promise<void> {
  try {
    const reactivated = await reactivateSeatCapDeactivated(venueId)
    if (reactivated > 0) {
      logger.info('🪑 Webhook: reactivated seat-cap-deactivated seats on re-upgrade to paid plan', {
        venueId,
        reactivated,
      })
    }
  } catch (error) {
    logger.error('🪑 Webhook: failed to reactivate seat-cap-deactivated seats (non-fatal)', {
      venueId,
      error: error instanceof Error ? error.message : 'Unknown error',
    })
  }
}

/**
 * Handle subscription updated event
 * Triggered when subscription status changes (trial → active, active → canceled, etc.)
 *
 * @param subscription - Stripe Subscription object
 */
export async function handleSubscriptionUpdated(subscription: Stripe.Subscription): Promise<CurrentHandlerEffectResult> {
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
    return 'NOOP_SUBJECT_NOT_FOUND'
  }

  // Security Enhancement: Skip activation for non-operational venues
  // Venues that are SUSPENDED, ADMIN_SUSPENDED, or CLOSED should not receive feature activations
  if (!OPERATIONAL_VENUE_STATUSES.includes(venueFeature.venue.status)) {
    logger.warn('⚠️ Webhook: Ignoring subscription update for non-operational venue', {
      subscriptionId,
      venueId: venueFeature.venueId,
      venueStatus: venueFeature.venue.status,
      status,
    })
    return 'NOOP_VENUE_NOT_OPERATIONAL'
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

      // 🔔 Emit socket event for real-time UI update
      if (socketManager.getServer()) {
        socketManager.broadcastToVenue(venueFeature.venueId, 'subscription.activated' as any, {
          featureId: venueFeature.featureId,
          featureCode: venueFeature.feature.code,
          subscriptionId,
          status: 'active',
          endDate: null,
          timestamp: new Date(),
        })
        logger.info('📡 Socket event emitted: subscription.activated', {
          venueId: venueFeature.venueId,
          featureCode: venueFeature.feature.code,
        })
      }

      // 🪑 Free→Paid RE-UPGRADE: a base plan just became active again. Reactivate every seat the
      // Free-tier cap previously deactivated (paid = unlimited). Base-plan only (never add-ons);
      // no-op when nothing was cap-deactivated.
      if ((PAID_PLAN_TIER_CODES as readonly string[]).includes(venueFeature.feature.code)) {
        await runSeatReactivationSafely(venueFeature.venueId)
      }
      return 'APPLIED'

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
      return 'APPLIED'

    case 'past_due':
      // Payment failed, but subscription still active
      logger.warn('⚠️ Webhook: Payment past due', {
        venueId: venueFeature.venueId,
        featureCode: venueFeature.feature.code,
        subscriptionId,
      })
      // Don't deactivate yet - Stripe will retry payment
      return 'MATCHED_NO_CHANGE'

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

      // 🔔 Emit socket event for real-time UI update
      if (socketManager.getServer()) {
        socketManager.broadcastToVenue(venueFeature.venueId, 'subscription.deactivated' as any, {
          featureId: venueFeature.featureId,
          featureCode: venueFeature.feature.code,
          subscriptionId,
          status,
          timestamp: new Date(),
        })
        logger.info('📡 Socket event emitted: subscription.deactivated', {
          venueId: venueFeature.venueId,
          featureCode: venueFeature.feature.code,
        })
      }

      // 🪑 Paid→Free transition: the base plan just ended (cancel-at-period-end reached, or
      // unpaid). If the owner scheduled a downgrade-to-Free with a "who stays" selection,
      // execute it now (deactivate the non-kept seats). No-op when nothing is pending.
      if ((PAID_PLAN_TIER_CODES as readonly string[]).includes(venueFeature.feature.code)) {
        await runSeatReconciliationSafely(venueFeature.venueId)
      }
      return 'APPLIED'

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
      return 'APPLIED'

    default:
      logger.info('ℹ️ Webhook: Unhandled subscription status', { status, subscriptionId })
      return 'MATCHED_NO_CHANGE'
  }
}

/**
 * Handle subscription deleted event
 * Triggered when subscription is permanently deleted
 *
 * @param subscription - Stripe Subscription object
 */
export async function handleSubscriptionDeleted(subscription: Stripe.Subscription): Promise<CurrentHandlerEffectResult> {
  const subscriptionId = subscription.id

  logger.info('📥 Webhook: Subscription deleted', { subscriptionId })

  // Resolve the affected VenueFeature(s) up front so we know which venue dropped to Free and
  // whether it was a base-plan tier (so we only run seat reconciliation for the base plan).
  const affected = await prisma.venueFeature.findMany({
    where: { stripeSubscriptionId: subscriptionId },
    select: { venueId: true, feature: { select: { code: true } } },
  })

  // Deactivate VenueFeature
  const result = await prisma.venueFeature.updateMany({
    where: { stripeSubscriptionId: subscriptionId },
    data: { active: false },
  })

  logger.info('❌ Webhook: Feature deactivated (subscription deleted)', {
    subscriptionId,
    affectedRecords: result.count,
  })

  // 🪑 Paid→Free transition: if a deleted base-plan subscription leaves the venue on Free and
  // a downgrade "who stays" selection is pending, execute it now. No-op when nothing is pending.
  const baseplanVenueIds = new Set(
    affected.filter(a => (PAID_PLAN_TIER_CODES as readonly string[]).includes(a.feature.code)).map(a => a.venueId),
  )
  for (const venueId of baseplanVenueIds) {
    await runSeatReconciliationSafely(venueId)
  }
  return result.count > 0 ? 'APPLIED' : 'NOOP_SUBJECT_NOT_FOUND'
}

/**
 * Handle invoice payment succeeded event
 * Triggered when subscription payment OR token purchase payment is successful
 *
 * @param invoice - Stripe Invoice object
 */
export async function handleInvoicePaymentSucceeded(invoice: Stripe.Invoice): Promise<InvoiceEffectResult> {
  const metadata = invoice.metadata
  const amountPaid = invoice.amount_paid / 100 // Convert cents to dollars
  const currency = invoice.currency.toUpperCase()

  logger.info('📥 Webhook: Invoice payment succeeded', {
    invoiceId: invoice.id,
    amountPaid,
    currency,
    metadataType: metadata?.type,
  })

  // Check if this is a token purchase invoice
  if (metadata?.type === 'chatbot_tokens_purchase') {
    logger.info('📥 Webhook: Token purchase invoice payment succeeded', {
      invoiceId: invoice.id,
      venueId: metadata.venueId,
      tokenAmount: metadata.tokenAmount,
    })

    try {
      await tokenBudgetService.completeInvoicePurchase(invoice.id, {
        invoicePdfUrl: invoice.invoice_pdf || undefined,
        hostedInvoiceUrl: invoice.hosted_invoice_url || undefined,
      })

      logger.info('✅ Webhook: Token purchase completed via invoice', {
        invoiceId: invoice.id,
        venueId: metadata.venueId,
        tokenAmount: metadata.tokenAmount,
        hasInvoicePdf: !!invoice.invoice_pdf,
      })

      // Emit socket event for real-time UI update
      if (metadata.venueId && socketManager.getServer()) {
        socketManager.broadcastToVenue(metadata.venueId, 'tokens.purchased' as any, {
          invoiceId: invoice.id,
          tokenAmount: parseInt(metadata.tokenAmount || '0'),
          invoicePdfUrl: invoice.invoice_pdf,
          timestamp: new Date(),
        })
      }
    } catch (error) {
      logger.error('❌ Webhook: Failed to complete token purchase via invoice', {
        invoiceId: invoice.id,
        error: error instanceof Error ? error.message : 'Unknown error',
      })
      throw error
    }
    return 'TOKEN_INVOICE_APPLIED'
  }

  // Handle subscription invoices (original logic)
  // Type assertion: subscription exists in Stripe API (can be string | Subscription | null)
  const subscriptionId = (invoice as any).subscription as string | Stripe.Subscription | null
  const subscriptionIdStr = typeof subscriptionId === 'string' ? subscriptionId : subscriptionId?.id || null

  if (!subscriptionIdStr) {
    logger.info('ℹ️ Webhook: Invoice has no subscription and is not a token purchase, skipping', { invoiceId: invoice.id })
    return 'INVOICE_NOOP_NO_SUBSCRIPTION'
  }

  // ✅ FIX BUG #7: Retry with backoff if VenueFeature not yet created
  // Race condition: Webhook can fire before sync code creates VenueFeature
  let venueFeature = await prisma.venueFeature.findFirst({
    where: { stripeSubscriptionId: subscriptionIdStr },
    include: { feature: true, venue: { select: { status: true } } },
  })

  if (!venueFeature) {
    // Wait 2 seconds and retry once - VenueFeature might be being created
    logger.info('⏳ Webhook: VenueFeature not found, retrying in 2s...', { subscriptionId: subscriptionIdStr, invoiceId: invoice.id })
    await new Promise(resolve => setTimeout(resolve, 2000))

    venueFeature = await prisma.venueFeature.findFirst({
      where: { stripeSubscriptionId: subscriptionIdStr },
      include: { feature: true, venue: { select: { status: true } } },
    })

    if (!venueFeature) {
      // Still not found after retry - log warning and return
      // The sync code's immediate activation should handle this
      logger.warn('⚠️ Webhook: VenueFeature still not found after retry', { subscriptionId: subscriptionIdStr, invoiceId: invoice.id })
      return 'INVOICE_NOOP_SUBJECT_NOT_FOUND'
    }

    logger.info('✅ Webhook: VenueFeature found on retry', { subscriptionId: subscriptionIdStr, venueId: venueFeature.venueId })
  }

  // Security Enhancement: Skip activation for non-operational venues
  if (!OPERATIONAL_VENUE_STATUSES.includes(venueFeature.venue.status)) {
    logger.warn('⚠️ Webhook: Ignoring invoice payment for non-operational venue', {
      invoiceId: invoice.id,
      venueId: venueFeature.venueId,
      venueStatus: venueFeature.venue.status,
    })
    return 'INVOICE_NOOP_VENUE_NOT_OPERATIONAL'
  }

  // Ensure feature is active
  // This handles two cases:
  // 1. First-time activation (trialPeriodDays=0, created with active=false)
  // 2. Reactivation after payment failure suspension
  if (!venueFeature.active) {
    await prisma.venueFeature.update({
      where: { id: venueFeature.id },
      data: { active: true, endDate: null },
    })
    logger.info('✅ Webhook: Feature activated after successful payment', {
      venueId: venueFeature.venueId,
      featureCode: venueFeature.feature.code,
      amountPaid,
    })
    return 'SUBSCRIPTION_INVOICE_APPLIED'
  } else {
    // Feature already active - this is expected when immediate payment activation
    // happened in createTrialSubscriptions() before webhook arrived
    logger.info('ℹ️ Webhook: Invoice paid but feature already active (immediate activation worked)', {
      venueId: venueFeature.venueId,
      featureCode: venueFeature.feature.code,
      subscriptionId: subscriptionIdStr,
    })
    return 'SUBSCRIPTION_INVOICE_MATCHED_NO_CHANGE'
  }
}

/**
 * Send payment failed in-app notifications to venue owners and admins
 * Called by handleInvoicePaymentFailed
 *
 * NOTE: Email notifications are sent by handlePaymentFailure() in stripe.service.ts
 * to avoid duplicate emails and ensure consistent Stripe billing portal URLs
 *
 * @param venueId - Venue ID
 * @param venueName - Venue name
 * @param featureName - Feature name
 * @param attemptCount - Payment attempt count (1-3)
 * @param amountDue - Amount due in cents
 * @param currency - Currency code (usd, mxn, etc.)
 * @param last4 - Last 4 digits of card (optional)
 */
async function sendPaymentFailedNotifications(
  venueId: string,
  venueName: string,
  featureName: string,
  attemptCount: number,
  amountDue: number,
  currency: string,
  last4?: string,
): Promise<void> {
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

    logger.info(`🔔 Creating in-app notifications for ${staffMembers.length} staff members`, { venueId, attemptCount })

    // 2. Get venue slug for billing URL
    const venue = await prisma.venue.findUnique({
      where: { id: venueId },
      select: { slug: true },
    })

    // 3. Generate billing portal URL for in-app notification (using venue-slug)
    const billingPortalUrl = venue?.slug
      ? `${FRONTEND_URL}/dashboard/venues/${venue.slug}/billing`
      : `${FRONTEND_URL}/dashboard/venues/${venueId}/billing`

    // 3. Send in-app notifications to each staff member
    for (const staffVenue of staffMembers) {
      const { staff } = staffVenue

      try {
        // Determine notification priority based on attempt count
        const priority =
          attemptCount >= 3 ? NotificationPriority.URGENT : attemptCount >= 2 ? NotificationPriority.HIGH : NotificationPriority.NORMAL

        // Build message with card details if available
        const cardInfo = last4 ? ` terminada en ${last4}` : ''
        const urgencyMessage =
          attemptCount >= 3
            ? '\n\n⚠️ ÚLTIMO INTENTO: Tu suscripción será cancelada si no actualizas tu método de pago.'
            : attemptCount >= 2
              ? '\n\nSi no actualizas, perderás acceso a esta función.'
              : ''

        // Create in-app notification with actionUrl and actionLabel
        await createNotification({
          recipientId: staff.id,
          venueId,
          type: NotificationType.PAYMENT_FAILED,
          title: `🚨 Pago rechazado - ${featureName}`,
          message: `Tu tarjeta${cardInfo} fue rechazada.\n\nPor favor usa un método de pago diferente para mantener tu suscripción activa.\n\n(Intento ${attemptCount} de 3)${urgencyMessage}`,
          actionUrl: billingPortalUrl, // ✅ Frontend will redirect here on click
          actionLabel: 'Actualizar método de pago', // ✅ Button text
          metadata: {
            featureName,
            attemptCount,
            amountDue,
            currency,
            last4,
            billingPortalUrl,
          },
          channels: [NotificationChannel.IN_APP],
          priority,
        })

        logger.info('✅ In-app notification created', { userId: staff.id, venueId, attemptCount })
      } catch (notificationError) {
        // Log but don't throw - notifications should not block webhook success
        logger.error('❌ Failed to create in-app notification for staff member', {
          staffId: staff.id,
          email: staff.email,
          error: notificationError instanceof Error ? notificationError.message : 'Unknown error',
        })
      }
    }

    logger.info('✅ In-app notifications created successfully', { venueId, staffCount: staffMembers.length, attemptCount })
  } catch (error) {
    // Log but don't throw - notifications should not block webhook success
    logger.error('❌ Failed to send in-app notifications', {
      venueId,
      attemptCount,
      error: error instanceof Error ? error.message : 'Unknown error',
    })
  }
}

/**
 * Handle invoice payment failed event
 * Triggered when subscription payment OR token purchase payment fails
 *
 * @param invoice - Stripe Invoice object
 */
export async function handleInvoicePaymentFailed(invoice: Stripe.Invoice): Promise<InvoiceEffectResult> {
  const metadata = invoice.metadata
  const attemptCount = invoice.attempt_count || 1
  const amountDue = invoice.amount_due
  const currency = invoice.currency

  logger.warn('📥 Webhook: Invoice payment failed', {
    invoiceId: invoice.id,
    attemptCount,
    amountDue,
    currency,
    metadataType: metadata?.type,
  })

  // Check if this is a token purchase invoice
  if (metadata?.type === 'chatbot_tokens_purchase') {
    logger.warn('⚠️ Webhook: Token purchase invoice payment failed', {
      invoiceId: invoice.id,
      venueId: metadata.venueId,
      tokenAmount: metadata.tokenAmount,
    })

    try {
      await tokenBudgetService.failInvoicePurchase(invoice.id)

      // Notify venue about failed payment
      if (metadata.venueId && socketManager.getServer()) {
        socketManager.broadcastToVenue(metadata.venueId, 'tokens.purchase_failed' as any, {
          invoiceId: invoice.id,
          tokenAmount: parseInt(metadata.tokenAmount || '0'),
          failureMessage: 'Payment failed',
          timestamp: new Date(),
        })
      }
    } catch (error) {
      logger.error('❌ Webhook: Failed to mark token purchase invoice as failed', {
        invoiceId: invoice.id,
        error: error instanceof Error ? error.message : 'Unknown error',
      })
      throw error
    }
    return 'TOKEN_INVOICE_APPLIED'
  }

  // Handle subscription invoices (original logic)
  // Type assertion: subscription exists in Stripe API (can be string | Subscription | null)
  const subscriptionId = (invoice as any).subscription as string | Stripe.Subscription | null
  const subscriptionIdStr = typeof subscriptionId === 'string' ? subscriptionId : subscriptionId?.id || null

  if (!subscriptionIdStr) {
    logger.info('ℹ️ Webhook: Invoice has no subscription and is not a token purchase, skipping', { invoiceId: invoice.id })
    return 'INVOICE_NOOP_NO_SUBSCRIPTION'
  }

  const venueFeature = await prisma.venueFeature.findFirst({
    where: { stripeSubscriptionId: subscriptionIdStr },
    include: { feature: true, venue: true },
  })

  if (!venueFeature) {
    logger.warn('⚠️ Webhook: Subscription not found for failed invoice', { subscriptionId: subscriptionIdStr })
    return 'INVOICE_NOOP_SUBJECT_NOT_FOUND'
  }

  logger.warn('⚠️ Webhook: Payment failed for feature', {
    venueId: venueFeature.venueId,
    featureCode: venueFeature.feature.code,
    attemptCount,
    maxAttempts: 3,
  })

  // Get payment method details from Stripe (if available)
  let last4: string | undefined
  try {
    if (invoice.default_payment_method) {
      const paymentMethodId =
        typeof invoice.default_payment_method === 'string' ? invoice.default_payment_method : invoice.default_payment_method.id
      const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY)
      const paymentMethod = await stripe.paymentMethods.retrieve(paymentMethodId)
      last4 = paymentMethod.card?.last4
    }
  } catch {
    logger.warn('⚠️ Could not retrieve payment method details', { invoiceId: invoice.id })
  }

  // Send notifications to venue owners and admins
  await sendPaymentFailedNotifications(
    venueFeature.venueId,
    venueFeature.venue.name,
    venueFeature.feature.name,
    attemptCount,
    amountDue,
    currency,
    last4,
  )

  // Handle payment failure with dunning management
  // This will update failure tracking, set grace periods, and handle suspension
  await handlePaymentFailure(subscriptionIdStr, attemptCount, {
    invoiceId: invoice.id,
    amountDue,
    currency,
    last4,
  })
  return 'SUBSCRIPTION_INVOICE_APPLIED'
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

    // 2. Get venue organization to generate Stripe billing portal URL
    const venue = await prisma.venue.findUnique({
      where: { id: venueId },
      select: {
        slug: true,
        stripeCustomerId: true,
      },
    })

    // 3. Generate Stripe billing portal URL (or fallback to dashboard with venue-slug)
    const returnUrl = venue?.slug
      ? `${FRONTEND_URL}/dashboard/venues/${venue.slug}/billing`
      : `${FRONTEND_URL}/dashboard/venues/${venueId}/billing`

    const billingPortalUrl = venue?.stripeCustomerId ? await generateBillingPortalUrl(venue.stripeCustomerId, returnUrl) : returnUrl

    // Resolve the preferred email recipient + locale once for this venue.
    // In-app notifications still go to each OWNER/ADMIN; the email itself prefers the
    // resolved recipient (venue.email → owner → org), falling back to the staff email.
    const target = await resolvePlanNotificationTarget(venueId)

    // 4. Send notifications to each staff member
    for (const staffVenue of staffMembers) {
      const { staff } = staffVenue

      try {
        // 4a. Create in-app notification
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

        // 4b. Send email notification with Stripe billing portal URL.
        // Prefer the resolved recipient; fall back to this staff member's email.
        const recipient = target.email ?? staff.email
        const emailSent = await emailService.sendTrialEndingEmail(recipient, {
          venueName,
          featureName,
          trialEndDate,
          billingPortalUrl,
          locale: target.locale,
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
export async function handleSubscriptionTrialWillEnd(subscription: Stripe.Subscription): Promise<CurrentHandlerEffectResult> {
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
    return 'NOOP_SUBJECT_NOT_FOUND'
  }

  // Security Enhancement: Skip notifications for non-operational venues
  if (!OPERATIONAL_VENUE_STATUSES.includes(venueFeature.venue.status)) {
    logger.warn('⚠️ Webhook: Ignoring trial ending notification for non-operational venue', {
      subscriptionId,
      venueId: venueFeature.venueId,
      venueStatus: venueFeature.venue.status,
    })
    return 'NOOP_VENUE_NOT_OPERATIONAL'
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
    return 'APPLIED'
  }
  return 'MATCHED_NO_CHANGE'
}

/**
 * Handle customer deleted event
 * Triggered when a customer is permanently deleted from Stripe
 *
 * @param customer - Stripe Customer object
 */
export async function handleCustomerDeleted(customer: Stripe.Customer): Promise<CurrentHandlerEffectResult> {
  const customerId = customer.id

  logger.warn('📥 Webhook: Customer deleted from Stripe', {
    customerId,
    email: customer.email,
    name: customer.name,
  })

  // Find venue with this Stripe customer
  const venue = await prisma.venue.findFirst({
    where: { stripeCustomerId: customerId },
    select: {
      id: true,
      name: true,
      slug: true,
    },
  })

  if (!venue) {
    logger.warn('⚠️ Webhook: No venue found for deleted customer', { customerId })
    return 'NOOP_SUBJECT_NOT_FOUND'
  }

  logger.warn('⚠️ Webhook: Removing Stripe customer ID from venue', {
    venueId: venue.id,
    venueName: venue.name,
    customerId,
  })

  // Clear Stripe customer ID from venue
  await prisma.venue.update({
    where: { id: venue.id },
    data: {
      stripeCustomerId: null,
    },
  })

  // Deactivate only this venue's features (since payment method is gone)
  const deactivatedCount = await prisma.venueFeature.updateMany({
    where: {
      venueId: venue.id,
      active: true,
    },
    data: {
      active: false,
    },
  })

  logger.warn('⚠️ Webhook: Deactivated venue features due to customer deletion', {
    venueId: venue.id,
    deactivatedFeatures: deactivatedCount.count,
  })
  return 'APPLIED'
}

/**
 * Handle payment method attached event
 * Triggered when a payment method is attached to a customer
 * Detects and removes duplicate cards based on fingerprint
 *
 * @param paymentMethod - Stripe PaymentMethod object
 */
export async function handlePaymentMethodAttached(paymentMethod: Stripe.PaymentMethod): Promise<CurrentHandlerEffectResult> {
  const paymentMethodId = paymentMethod.id
  const customerId = paymentMethod.customer as string
  const fingerprint = paymentMethod.card?.fingerprint

  logger.info('📥 Webhook: Payment method attached', {
    paymentMethodId,
    customerId,
    fingerprint,
    last4: paymentMethod.card?.last4,
    brand: paymentMethod.card?.brand,
  })

  if (!customerId) {
    logger.warn('⚠️ Webhook: Payment method has no customer', { paymentMethodId })
    return 'NOOP_INVALID_INPUT'
  }

  if (!fingerprint) {
    logger.warn('⚠️ Webhook: Payment method has no fingerprint (not a card)', { paymentMethodId })
    return 'NOOP_INVALID_INPUT'
  }

  try {
    // Get all payment methods for this customer
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY)
    const paymentMethods = await stripe.paymentMethods.list({
      customer: customerId,
      type: 'card',
    })

    // Find duplicates (same fingerprint, different ID)
    const duplicates = paymentMethods.data.filter(
      (pm: Stripe.PaymentMethod) => pm.card?.fingerprint === fingerprint && pm.id !== paymentMethodId,
    )

    if (duplicates.length > 0) {
      logger.warn('⚠️ Webhook: Duplicate payment method detected', {
        newPaymentMethodId: paymentMethodId,
        existingPaymentMethodIds: duplicates.map((pm: Stripe.PaymentMethod) => pm.id),
        fingerprint,
        last4: paymentMethod.card?.last4,
      })

      // Detach the newly added payment method (keep the older one)
      await stripe.paymentMethods.detach(paymentMethodId)

      logger.info('✅ Webhook: Duplicate payment method removed', {
        removedPaymentMethodId: paymentMethodId,
        keptPaymentMethodId: duplicates[0].id,
      })
      return 'APPLIED'

      // Note: This won't send an error to the user immediately since the webhook
      // happens asynchronously. The frontend will simply not see the new payment method
      // appear in the list when it refreshes.
    } else {
      logger.info('✅ Webhook: Payment method is unique, no duplicates found', {
        paymentMethodId,
        fingerprint,
      })

      // Set this payment method as default for the customer
      try {
        await stripe.customers.update(customerId, {
          invoice_settings: {
            default_payment_method: paymentMethodId,
          },
        })

        logger.info('✅ Webhook: Payment method set as default in Stripe', {
          paymentMethodId,
          customerId,
          last4: paymentMethod.card?.last4,
          brand: paymentMethod.card?.brand,
        })

        // Update Venue record in database with payment method ID
        try {
          // Find venue by Stripe customer ID
          const venue = await prisma.venue.findUnique({
            where: { stripeCustomerId: customerId },
            select: { id: true },
          })

          if (venue) {
            // Update venue's payment method
            await prisma.venue.update({
              where: { id: venue.id },
              data: { stripePaymentMethodId: paymentMethodId },
            })

            logger.info('✅ Webhook: Payment method saved to venue database', {
              paymentMethodId,
              customerId,
              venueId: venue.id,
            })
          } else {
            logger.warn('⚠️ Webhook: No venue found with stripeCustomerId', {
              customerId,
              paymentMethodId,
            })
          }
        } catch (dbUpdateError) {
          logger.error('❌ Webhook: Failed to update venue payment method in database', {
            paymentMethodId,
            customerId,
            error: dbUpdateError instanceof Error ? dbUpdateError.message : 'Unknown error',
          })
          // Don't throw - Stripe is already updated, database sync can be retried
        }
      } catch (setDefaultError) {
        logger.error('❌ Webhook: Failed to set payment method as default', {
          paymentMethodId,
          customerId,
          error: setDefaultError instanceof Error ? setDefaultError.message : 'Unknown error',
        })
        // Don't throw - setting as default is important but not critical for the webhook
        return 'NOOP_PROCESSING_FAILED'
      }
      return 'APPLIED'
    }
  } catch (error) {
    // Don't throw - this is informational and shouldn't block the webhook
    logger.error('❌ Webhook: Failed to check for duplicate payment methods', {
      paymentMethodId,
      error: error instanceof Error ? error.message : 'Unknown error',
    })
    return 'NOOP_PROCESSING_FAILED'
  }
}

/**
 * Handle successful payment intent for token purchases
 *
 * @param paymentIntent - Stripe PaymentIntent object
 */
export async function handlePaymentIntentSucceeded(paymentIntent: Stripe.PaymentIntent): Promise<PaymentIntentEffectResult> {
  const paymentIntentId = paymentIntent.id
  const metadata = paymentIntent.metadata

  // Only process chatbot token purchases
  if (metadata?.type !== 'chatbot_tokens') {
    logger.info('ℹ️ Webhook: PaymentIntent not for chatbot tokens, skipping', {
      paymentIntentId,
      type: metadata?.type,
    })
    return 'PAYMENT_INTENT_NOOP_NOT_TOKEN'
  }

  logger.info('📥 Webhook: Token purchase payment succeeded', {
    paymentIntentId,
    amount: paymentIntent.amount,
    venueId: metadata?.venueId,
    tokenAmount: metadata?.tokenAmount,
  })

  try {
    await tokenBudgetService.completePurchase(paymentIntentId)

    logger.info('✅ Webhook: Token purchase completed', {
      paymentIntentId,
      venueId: metadata?.venueId,
      tokenAmount: metadata?.tokenAmount,
    })

    // Emit socket event for real-time UI update
    if (metadata?.venueId && socketManager.getServer()) {
      socketManager.broadcastToVenue(metadata.venueId, 'tokens.purchased' as any, {
        paymentIntentId,
        tokenAmount: parseInt(metadata?.tokenAmount || '0'),
        timestamp: new Date(),
      })
    }
  } catch (error) {
    logger.error('❌ Webhook: Failed to complete token purchase', {
      paymentIntentId,
      error: error instanceof Error ? error.message : 'Unknown error',
    })
    throw error
  }
  return 'TOKEN_PAYMENT_INTENT_APPLIED'
}

/**
 * Handle failed payment intent for token purchases
 *
 * @param paymentIntent - Stripe PaymentIntent object
 */
export async function handlePaymentIntentFailed(paymentIntent: Stripe.PaymentIntent): Promise<PaymentIntentEffectResult> {
  const paymentIntentId = paymentIntent.id
  const metadata = paymentIntent.metadata

  // Only process chatbot token purchases
  if (metadata?.type !== 'chatbot_tokens') {
    logger.info('ℹ️ Webhook: PaymentIntent not for chatbot tokens, skipping', {
      paymentIntentId,
      type: metadata?.type,
    })
    return 'PAYMENT_INTENT_NOOP_NOT_TOKEN'
  }

  logger.warn('⚠️ Webhook: Token purchase payment failed', {
    paymentIntentId,
    venueId: metadata?.venueId,
    tokenAmount: metadata?.tokenAmount,
    failureCode: paymentIntent.last_payment_error?.code,
    failureMessage: paymentIntent.last_payment_error?.message,
  })

  try {
    await tokenBudgetService.failPurchase(paymentIntentId)

    logger.info('✅ Webhook: Token purchase marked as failed', {
      paymentIntentId,
    })

    // Notify venue about failed payment
    if (metadata?.venueId && socketManager.getServer()) {
      socketManager.broadcastToVenue(metadata.venueId, 'tokens.purchase_failed' as any, {
        paymentIntentId,
        tokenAmount: parseInt(metadata?.tokenAmount || '0'),
        failureMessage: paymentIntent.last_payment_error?.message || 'Payment failed',
        timestamp: new Date(),
      })
    }
  } catch (error) {
    logger.error('❌ Webhook: Failed to mark token purchase as failed', {
      paymentIntentId,
      error: error instanceof Error ? error.message : 'Unknown error',
    })
    throw error
  }
  return 'TOKEN_PAYMENT_INTENT_APPLIED'
}

/**
 * Kept as a compatibility export for existing Superadmin consumers. The durable
 * inbox owns the actual effect budget.
 */
export const STRIPE_WEBHOOK_MAX_RETRIES = 5

async function enrichCurrentWebhookVenue(
  event: Stripe.Event,
  localWebhookEventId: string,
): Promise<'APPLIED' | 'NOT_APPLICABLE' | 'SKIPPED_INVALID' | 'FAILED_NON_FATAL'> {
  const eventData = event.data.object as any
  let venueId: string | null = typeof eventData.metadata?.venueId === 'string' ? eventData.metadata.venueId : null
  if (!venueId && eventData.subscription) {
    const subscriptionId = typeof eventData.subscription === 'string' ? eventData.subscription : eventData.subscription.id
    const venueFeature = await prisma.venueFeature.findFirst({
      where: { stripeSubscriptionId: subscriptionId },
      select: { venueId: true },
    })
    venueId = venueFeature?.venueId ?? null
  }
  if (!venueId) return 'NOT_APPLICABLE'

  try {
    const { platformWebhookRuntime } = await import('./stripe-webhooks/platformWebhookRuntime.service')
    const applied = await platformWebhookRuntime.inbox.enrichVenueId(localWebhookEventId, venueId)
    if (!applied) {
      logger.warn('⚠️ Webhook: venueId from event metadata is invalid or conflicts with durable enrichment', {
        eventId: event.id,
        type: event.type,
        venueId,
      })
      return 'SKIPPED_INVALID'
    }
    return 'APPLIED'
  } catch (error) {
    logger.warn('⚠️ Webhook: failed to enrich event with venueId (non-fatal)', {
      eventId: event.id,
      type: event.type,
      venueId,
      error: error instanceof Error ? error.message : 'Unknown error',
    })
    return 'FAILED_NON_FATAL'
  }
}

async function fulfillLegacyPlanCheckout(session: Stripe.Checkout.Session): Promise<CurrentHandlerEffectResult> {
  logger.info('📥 Webhook: base-plan checkout completed', {
    sessionId: session.id,
    venueId: session.metadata?.venueId,
    tierCode: session.metadata?.tierCode,
    interval: session.metadata?.interval,
  })
  const result = await fulfillPlanCheckout(session)
  await runSeatReactivationSafely(result?.venueId ?? session.metadata!.venueId)
  if (result && socketManager.getServer()) {
    socketManager.broadcastToVenue(result.venueId, 'subscription.activated' as any, {
      featureId: result.featureId,
      featureCode: result.featureCode,
      subscriptionId: result.subscriptionId,
      status: 'active',
      endDate: result.endDate,
      timestamp: new Date(),
    })
    logger.info('📡 Socket event emitted: subscription.activated', {
      venueId: result.venueId,
      featureCode: result.featureCode,
    })
  }
  return result ? 'APPLIED' : 'NOOP_NOT_APPLICABLE'
}

const currentStripeWebhookDispatcher = createCurrentStripeWebhookDispatcher({
  commercialAdapter: event => commercialStripeWebhookAdapter.reconcile(event),
  enrichVenue: enrichCurrentWebhookVenue,
  handlers: {
    subscriptionUpdated: handleSubscriptionUpdated,
    subscriptionDeleted: handleSubscriptionDeleted,
    invoicePaymentSucceeded: handleInvoicePaymentSucceeded,
    invoicePaymentFailed: handleInvoicePaymentFailed,
    subscriptionTrialWillEnd: handleSubscriptionTrialWillEnd,
    customerDeleted: handleCustomerDeleted,
    paymentMethodAttached: handlePaymentMethodAttached,
    paymentIntentSucceeded: handlePaymentIntentSucceeded,
    paymentIntentFailed: handlePaymentIntentFailed,
    async creditPackCheckout(session) {
      logger.info('📥 Webhook (platform, LEGACY): Credit pack checkout completed', {
        sessionId: session.id,
        venueId: session.metadata?.venueId,
        packId: session.metadata?.packId,
      })
      const result = await fulfillCreditPackPurchase(session.id)
      // The existing helper exposes only subject found/not-found, not whether
      // this invocation inserted or hit its idempotent existing purchase.
      return result ? 'MATCHED' : 'NOOP_NOT_APPLICABLE'
    },
    async terminalOrderCheckout(session) {
      const { handleTerminalOrderCheckoutCompleted } = await import('./stripe-webhooks/terminalOrderCheckoutCompleted.handler')
      return handleTerminalOrderCheckoutCompleted(session)
    },
    legacyPlanCheckout: fulfillLegacyPlanCheckout,
  },
  isLegacyPaidPlanTier: tierCode => (PAID_PLAN_TIER_CODES as readonly string[]).includes(tierCode),
  logUnhandled: type => logger.info('ℹ️ Webhook: Unhandled event type', { type }),
})

/**
 * Exact current platform fan-out. It never owns WebhookEvent persistence or
 * phase state; callers must hold an EFFECT lease.
 */
export function dispatchCurrentStripeWebhookEffects(event: Stripe.Event, localWebhookEventId: string) {
  return currentStripeWebhookDispatcher(event, localWebhookEventId)
}

/**
 * Compatibility adapter for legacy in-process callers. New HTTP ingress calls
 * the runtime directly so persistence failures can map to HTTP 503.
 */
export async function handleStripeWebhookEvent(event: Stripe.Event): Promise<void> {
  const { platformWebhookRuntime } = await import('./stripe-webhooks/platformWebhookRuntime.service')
  const observed = await platformWebhookRuntime.inbox.observe({
    stripeEventId: event.id,
    eventType: event.type,
    payload: event,
  })
  await platformWebhookRuntime.processor.processIngress(observed.event.id, {
    mode: platformWebhookRuntime.mode,
    created: observed.created,
  })
}

/**
 * Compatibility adapter consumed by Superadmin until A1c-c adds typed manual
 * retry responses. It acquires a manual EFFECT lease and never writes
 * WebhookEvent directly.
 */
export async function replayStripeWebhookEvent(webhookEventId: string): Promise<{ replayed: boolean; reason?: string }> {
  const { platformWebhookRuntime } = await import('./stripe-webhooks/platformWebhookRuntime.service')
  await platformWebhookRuntime.inbox.load(webhookEventId)
  const lease = await platformWebhookRuntime.inbox.acquire(webhookEventId, 'EFFECT', { manual: true })
  if (!lease) return { replayed: false, reason: 'NOT_ELIGIBLE' }
  await platformWebhookRuntime.processor.processEffect(webhookEventId, lease)
  return { replayed: true }
}

export default {
  handleStripeWebhookEvent,
  replayStripeWebhookEvent,
  handleSubscriptionUpdated,
  handleSubscriptionDeleted,
  handleInvoicePaymentSucceeded,
  handleInvoicePaymentFailed,
  handleSubscriptionTrialWillEnd,
  handleCustomerDeleted,
  handlePaymentMethodAttached,
}
