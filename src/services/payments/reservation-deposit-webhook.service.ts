import { Prisma, ReservationStatus } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { VerifiedWebhookEvent } from './providers/provider.interface'
import { finalizePaymentLinkCheckout } from '@/services/dashboard/paymentLink.service'

type CheckoutSessionLike = {
  id: string
  payment_status?: string | null
  payment_intent?: string | { id?: string } | null
  amount_total?: number | null
  metadata?: Record<string, string> | null
}

function getPaymentIntentId(session: CheckoutSessionLike): string | null {
  if (!session.payment_intent) return null
  return typeof session.payment_intent === 'string' ? session.payment_intent : (session.payment_intent.id ?? null)
}

async function recordMoneyAnomaly(args: {
  tx: Prisma.TransactionClient
  category: string
  reservationId?: string | null
  stripeEventId: string
  expectedState: Prisma.InputJsonValue
  observedState: Prisma.InputJsonValue
}) {
  await args.tx.moneyAnomaly.create({
    data: {
      category: args.category,
      reservationId: args.reservationId ?? null,
      stripeEventId: args.stripeEventId,
      expectedState: args.expectedState,
      observedState: args.observedState,
    },
  })

  logger.error('🚨 [STRIPE CONNECT] Money anomaly detected', {
    category: args.category,
    reservationId: args.reservationId,
    stripeEventId: args.stripeEventId,
  })
}

async function processCheckoutCompleted(event: VerifiedWebhookEvent) {
  const session = event.data as CheckoutSessionLike
  if (!session.id) {
    logger.warn('⚠️ [STRIPE CONNECT] checkout.session.completed without session id', { eventId: event.id })
    return
  }

  if (session.payment_status !== 'paid') {
    logger.warn('⚠️ [STRIPE CONNECT] Checkout completed but payment_status is not paid', {
      eventId: event.id,
      sessionId: session.id,
      paymentStatus: session.payment_status,
    })
    return
  }

  const paymentIntentId = getPaymentIntentId(session)

  // Branch on session.metadata.type — set by whichever upstream created the
  // Checkout Session. 'payment_link' came from our public payment-link flow,
  // anything else (or missing) falls through to reservation-deposit handling.
  if (session.metadata?.type === 'payment_link') {
    try {
      // Idempotency: record the event first so duplicate deliveries no-op
      // via the unique constraint on `stripeEventId`.
      await prisma.processedStripeEvent.create({
        data: {
          stripeEventId: event.id,
          endpoint: 'connect',
          eventType: event.type,
          account: event.account,
          payload: event.data as Prisma.InputJsonValue,
        },
      })
      await finalizePaymentLinkCheckout({
        stripeSessionId: session.id,
        paymentIntentId,
        amountPaidCents: session.amount_total ?? null,
      })
    } catch (error: any) {
      if (error?.code === 'P2002') {
        logger.info('ℹ️ [STRIPE CONNECT] Duplicate payment-link webhook ignored', { eventId: event.id })
        return
      }
      throw error
    }
    return
  }

  try {
    await prisma.$transaction(async tx => {
      await tx.processedStripeEvent.create({
        data: {
          stripeEventId: event.id,
          endpoint: 'connect',
          eventType: event.type,
          account: event.account,
          payload: event.data as Prisma.InputJsonValue,
        },
      })

      const updated = await tx.reservation.updateMany({
        where: {
          checkoutSessionId: session.id,
          depositStatus: 'PENDING',
        },
        data: {
          status: ReservationStatus.CONFIRMED,
          confirmedAt: new Date(),
          depositStatus: 'PAID',
          depositPaidAt: new Date(),
          depositProcessorRef: paymentIntentId,
        },
      })

      if (updated.count === 1) return

      const current = await tx.reservation.findFirst({
        where: { checkoutSessionId: session.id },
        select: { id: true, status: true, depositStatus: true },
      })

      if (!current) {
        logger.warn('⚠️ [STRIPE CONNECT] Checkout completed for unknown reservation session', {
          eventId: event.id,
          sessionId: session.id,
        })
        return
      }

      if (current.depositStatus === 'PAID') return

      await recordMoneyAnomaly({
        tx,
        category: 'PAID_AFTER_DIVERGENT_STATE',
        reservationId: current.id,
        stripeEventId: event.id,
        expectedState: { depositStatus: 'PENDING' },
        observedState: { status: current.status, depositStatus: current.depositStatus },
      })
    })
  } catch (error: any) {
    if (error?.code === 'P2002') {
      logger.info('ℹ️ [STRIPE CONNECT] Duplicate webhook event ignored', { eventId: event.id, type: event.type })
      return
    }
    throw error
  }
}

async function processCheckoutExpired(event: VerifiedWebhookEvent) {
  const session = event.data as CheckoutSessionLike
  if (!session.id) {
    logger.warn('⚠️ [STRIPE CONNECT] checkout.session.expired without session id', { eventId: event.id })
    return
  }

  try {
    await prisma.$transaction(async tx => {
      await tx.processedStripeEvent.create({
        data: {
          stripeEventId: event.id,
          endpoint: 'connect',
          eventType: event.type,
          account: event.account,
          payload: event.data as Prisma.InputJsonValue,
        },
      })

      const updated = await tx.reservation.updateMany({
        where: {
          checkoutSessionId: session.id,
          depositStatus: 'PENDING',
        },
        data: {
          status: ReservationStatus.CANCELLED,
          cancelledAt: new Date(),
          cancelledBy: 'SYSTEM',
          cancellationReason: 'Stripe Checkout session expired',
          depositStatus: 'EXPIRED',
        },
      })

      if (updated.count === 1) return

      const current = await tx.reservation.findFirst({
        where: { checkoutSessionId: session.id },
        select: { id: true, status: true, depositStatus: true },
      })

      if (!current || current.depositStatus === 'EXPIRED' || current.depositStatus === 'PAID') return

      await recordMoneyAnomaly({
        tx,
        category: 'EXPIRED_AFTER_DIVERGENT_STATE',
        reservationId: current.id,
        stripeEventId: event.id,
        expectedState: { depositStatus: 'PENDING' },
        observedState: { status: current.status, depositStatus: current.depositStatus },
      })
    })
  } catch (error: any) {
    if (error?.code === 'P2002') {
      logger.info('ℹ️ [STRIPE CONNECT] Duplicate webhook event ignored', { eventId: event.id, type: event.type })
      return
    }
    throw error
  }
}

async function processAccountUpdated(event: VerifiedWebhookEvent) {
  const account = event.data as any
  const connectAccountId = event.account || account?.id
  if (!connectAccountId) return

  const requirementsDue = [...(account?.requirements?.currently_due ?? []), ...(account?.requirements?.past_due ?? [])]
  const chargesEnabled = Boolean(
    account?.charges_enabled ?? account?.configuration?.merchant?.capabilities?.card_payments?.status === 'active',
  )
  const payoutsEnabled = Boolean(account?.payouts_enabled ?? (chargesEnabled && requirementsDue.length === 0))
  const onboardingStatus = chargesEnabled && payoutsEnabled ? 'COMPLETED' : requirementsDue.length > 0 ? 'RESTRICTED' : 'IN_PROGRESS'

  await prisma.ecommerceMerchant.updateMany({
    where: { providerMerchantId: connectAccountId },
    data: {
      chargesEnabled,
      payoutsEnabled,
      requirementsDue,
      onboardingStatus,
    },
  })
}

/**
 * Handles `payment_intent.succeeded` events from connected accounts.
 *
 * Today these arrive from the Stripe Elements (inline) flow for payment
 * links — the customer paid inside `pay.avoqado.io` via embedded Stripe
 * Elements (no Checkout Session was created). Routes to the payment-link
 * finalizer based on `metadata.type === 'payment_link'`; other types (e.g.
 * direct ad-hoc PaymentIntents) just log so we can extend later.
 */
async function processPaymentIntentSucceeded(event: VerifiedWebhookEvent) {
  const pi = event.data as {
    id?: string
    metadata?: Record<string, string> | null
    amount_received?: number | null
    // Stripe expands the PaymentMethod inline. Different shapes depending on
    // the method used — we only care about `.type` for mapping to our enum.
    payment_method?: { type?: string } | string | null
    // `charges` is a legacy shape; `latest_charge` is current. Both can
    // include `payment_method_details.type`.
    charges?: { data?: Array<{ payment_method_details?: { type?: string } }> } | null
    latest_charge?: { payment_method_details?: { type?: string } } | string | null
  }
  if (!pi.id) {
    logger.warn('⚠️ [STRIPE CONNECT] payment_intent.succeeded without id', { eventId: event.id })
    return
  }

  if (pi.metadata?.type !== 'payment_link') {
    logger.info('ℹ️ [STRIPE CONNECT] payment_intent.succeeded for non-payment-link source — ignored', {
      eventId: event.id,
      paymentIntentId: pi.id,
      type: pi.metadata?.type ?? 'unknown',
    })
    return
  }

  // Extract the Stripe payment_method.type from whichever shape Stripe sent.
  // Order of preference matches Stripe's own docs: latest_charge ▶
  // payment_method ▶ charges[0] (legacy).
  const stripePaymentMethodType =
    (typeof pi.latest_charge === 'object' && pi.latest_charge?.payment_method_details?.type) ||
    (typeof pi.payment_method === 'object' && pi.payment_method?.type) ||
    pi.charges?.data?.[0]?.payment_method_details?.type ||
    null

  try {
    // Idempotency guard via unique constraint — duplicate webhook deliveries
    // throw P2002 below and we no-op.
    await prisma.processedStripeEvent.create({
      data: {
        stripeEventId: event.id,
        endpoint: 'connect',
        eventType: event.type,
        account: event.account,
        payload: event.data as Prisma.InputJsonValue,
      },
    })
    await finalizePaymentLinkCheckout({
      stripeSessionId: pi.id, // sessionId column stores the pi_XXX for Elements flow
      paymentIntentId: pi.id,
      amountPaidCents: pi.amount_received ?? null,
      stripePaymentMethodType,
    })
  } catch (error: any) {
    if (error?.code === 'P2002') {
      logger.info('ℹ️ [STRIPE CONNECT] Duplicate payment_intent.succeeded ignored', { eventId: event.id })
      return
    }
    throw error
  }
}

/**
 * Marks a CheckoutSession as FAILED when Stripe reports a PaymentIntent
 * failure for the Elements (inline) flow. Records the failure reason from
 * Stripe so the UI can surface it. Only acts when metadata identifies the
 * intent as a payment-link flow — other failures are out of scope.
 */
async function processPaymentIntentFailed(event: VerifiedWebhookEvent) {
  const pi = event.data as {
    id?: string
    metadata?: Record<string, string> | null
    last_payment_error?: { message?: string; code?: string; type?: string } | null
  }
  if (!pi.id || pi.metadata?.type !== 'payment_link') return

  try {
    await prisma.processedStripeEvent.create({
      data: {
        stripeEventId: event.id,
        endpoint: 'connect',
        eventType: event.type,
        account: event.account,
        payload: event.data as Prisma.InputJsonValue,
      },
    })

    await prisma.checkoutSession.updateMany({
      where: { sessionId: pi.id, status: { in: ['PENDING', 'PROCESSING'] } },
      data: {
        status: 'FAILED',
        failedAt: new Date(),
        errorMessage: pi.last_payment_error?.message ?? 'PaymentIntent failed',
      },
    })

    logger.warn('⚠️ [STRIPE CONNECT] PaymentIntent failed', {
      paymentIntentId: pi.id,
      code: pi.last_payment_error?.code,
      type: pi.last_payment_error?.type,
    })
  } catch (error: any) {
    if (error?.code === 'P2002') return
    throw error
  }
}

export async function processStripeConnectWebhookEvent(event: VerifiedWebhookEvent) {
  switch (event.type) {
    case 'checkout.session.completed':
      await processCheckoutCompleted(event)
      return
    case 'checkout.session.expired':
      await processCheckoutExpired(event)
      return
    case 'payment_intent.succeeded':
      await processPaymentIntentSucceeded(event)
      return
    case 'payment_intent.payment_failed':
      await processPaymentIntentFailed(event)
      return
    case 'account.updated':
    case 'v2.core.account.updated':
      await processAccountUpdated(event)
      return
    default:
      logger.info('ℹ️ [STRIPE CONNECT] Unhandled event type', { eventId: event.id, type: event.type, account: event.account })
  }
}
