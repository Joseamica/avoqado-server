import { Prisma, ReservationStatus } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { VerifiedWebhookEvent } from './providers/provider.interface'
import { finalizePaymentLinkCheckout } from '@/services/dashboard/paymentLink.service'
import { finalizeVenueCheckout } from '@/services/dashboard/venueCheckout.service'
import { fulfillPurchase as fulfillCreditPackPurchase } from '@/services/dashboard/creditPack.public.service'
import emailService from '@/services/email.service'
import { sendReservationConfirmationWhatsApp, formatModifiersForWhatsApp } from '@/services/whatsapp.service'
import { formatInTimeZone } from 'date-fns-tz'
import { es as esLocale } from 'date-fns/locale'

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

  // Credit-pack purchases now settle on the venue's connected account (money
  // routing fix), so their checkout.session.completed lands HERE, not on the
  // platform webhook. Dispatch to the same fulfillment used before.
  if (session.metadata?.type === 'credit_pack_purchase') {
    try {
      // Claim the event first so duplicate deliveries no-op via the unique
      // stripeEventId constraint (fulfillPurchase is also idempotent on
      // stripeCheckoutSessionId — this just avoids a redundant Stripe retrieve).
      await prisma.processedStripeEvent.create({
        data: {
          stripeEventId: event.id,
          endpoint: 'connect',
          eventType: event.type,
          account: event.account,
          payload: event.data as Prisma.InputJsonValue,
        },
      })
      // Pass event.account so fulfillPurchase retrieves the session with the
      // correct connected-account (stripeAccount) scope.
      await fulfillCreditPackPurchase(session.id, event.account)
    } catch (error: any) {
      if (error?.code === 'P2002') {
        logger.info('ℹ️ [STRIPE CONNECT] Duplicate credit-pack webhook ignored', { eventId: event.id })
        return
      }
      throw error
    }
    return
  }

  let justConfirmedReservationId: string | null = null
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

      // Capture the row id BEFORE updating so we can fire the confirmation
      // email after the tx commits. updateMany doesn't return rows; the
      // findFirst+update pair keeps the original idempotency semantics
      // (no-op when depositStatus has already advanced past PENDING).
      const target = await tx.reservation.findFirst({
        where: {
          checkoutSessionId: session.id,
          depositStatus: 'PENDING',
        },
        select: { id: true },
      })

      const updated = target
        ? await tx.reservation.updateMany({
            where: { id: target.id, depositStatus: 'PENDING' },
            data: {
              status: ReservationStatus.CONFIRMED,
              confirmedAt: new Date(),
              depositStatus: 'PAID',
              depositPaidAt: new Date(),
              depositProcessorRef: paymentIntentId,
            },
          })
        : { count: 0 }

      if (updated.count === 1) {
        justConfirmedReservationId = target!.id
        return
      }

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

  // After the status flip commits, fire the booking confirmation email. We
  // do this OUTSIDE the transaction so a slow Resend round-trip doesn't hold
  // the row lock, and email failures NEVER roll back a paid booking.
  if (justConfirmedReservationId) {
    try {
      const reservation = await prisma.reservation.findUnique({
        where: { id: justConfirmedReservationId },
        select: {
          id: true,
          confirmationCode: true,
          cancelSecret: true,
          guestName: true,
          guestEmail: true,
          guestPhone: true,
          startsAt: true,
          productId: true,
          productIds: true,
          depositAmount: true,
          venue: { select: { name: true, slug: true, timezone: true } },
        },
      })
      if (reservation?.guestEmail) {
        const productIds =
          reservation.productIds && reservation.productIds.length > 0
            ? reservation.productIds
            : reservation.productId
              ? [reservation.productId]
              : []
        const products =
          productIds.length > 0
            ? await prisma.product.findMany({
                where: { id: { in: productIds } },
                select: { id: true, name: true },
              })
            : []
        const nameById = new Map(products.map(p => [p.id, p.name]))
        // Fetch picked modifiers so the email shows the full breakdown.
        const modifierRows = await prisma.reservationModifier.findMany({
          where: { reservationId: reservation.id },
          select: { productId: true, name: true, quantity: true, price: true },
          orderBy: { createdAt: 'asc' },
        })
        const modifiersByProduct = new Map<string, Array<{ name: string; quantity: number; price: number }>>()
        for (const m of modifierRows) {
          if (!m.name) continue
          if (!modifiersByProduct.has(m.productId)) modifiersByProduct.set(m.productId, [])
          modifiersByProduct.get(m.productId)!.push({ name: m.name, quantity: m.quantity, price: Number(m.price) })
        }
        const services = productIds
          .map(id => {
            const name = nameById.get(id)
            if (!name) return null
            return { name, modifiers: modifiersByProduct.get(id) ?? [] }
          })
          .filter((s): s is { name: string; modifiers: Array<{ name: string; quantity: number; price: number }> } => !!s)
        const tz = reservation.venue.timezone || 'America/Mexico_City'
        const dateLongRaw = formatInTimeZone(reservation.startsAt, tz, "EEEE d 'de' MMMM 'de' yyyy", { locale: esLocale })
        await emailService.sendReservationConfirmedEmail(reservation.guestEmail, {
          customerName: reservation.guestName ?? 'Cliente',
          venueName: reservation.venue.name,
          venueSlug: reservation.venue.slug,
          confirmationCode: reservation.confirmationCode,
          cancelSecret: reservation.cancelSecret,
          dateLong: dateLongRaw.charAt(0).toUpperCase() + dateLongRaw.slice(1),
          time: formatInTimeZone(reservation.startsAt, tz, 'HH:mm'),
          services,
          // Deposit path: payment cleared this very webhook tick.
          depositPaidMxn: reservation.depositAmount ? Number(reservation.depositAmount) : null,
          owedAtVenueMxn: null,
        })
      }
      // WhatsApp confirmation (parallel to email, fire-and-forget). Routes to
      // `reservation_confirmation_with_extras` when modifiers are present.
      if (reservation?.guestPhone) {
        try {
          const productIdsForWa =
            reservation.productIds && reservation.productIds.length > 0
              ? reservation.productIds
              : reservation.productId
                ? [reservation.productId]
                : []
          const waModifierRows = await prisma.reservationModifier.findMany({
            where: { reservationId: reservation.id },
            select: { name: true, quantity: true, price: true },
            orderBy: { createdAt: 'asc' },
          })
          const tz = reservation.venue.timezone || 'America/Mexico_City'
          const waDateRaw = formatInTimeZone(reservation.startsAt, tz, "EEEE d 'de' MMMM 'de' yyyy", { locale: esLocale })
          await sendReservationConfirmationWhatsApp(reservation.guestPhone, {
            customerName: reservation.guestName ?? 'Cliente',
            venueName: reservation.venue.name,
            date: waDateRaw.charAt(0).toUpperCase() + waDateRaw.slice(1),
            time: formatInTimeZone(reservation.startsAt, tz, 'HH:mm'),
            extras:
              productIdsForWa.length > 0
                ? formatModifiersForWhatsApp(waModifierRows.map(m => ({ name: m.name, quantity: m.quantity, price: Number(m.price) })))
                : '',
            // Feeds the optional "Gestionar mi cita" WhatsApp button.
            venueSlug: reservation.venue.slug,
            cancelSecret: reservation.cancelSecret,
          })
        } catch (waError) {
          logger.warn(
            `[STRIPE CONNECT] confirmation whatsapp failed for reservation ${justConfirmedReservationId}: ${(waError as Error).message}`,
          )
        }
      }
    } catch (mailError) {
      logger.warn(
        `[STRIPE CONNECT] confirmation email failed for reservation ${justConfirmedReservationId}: ${(mailError as Error).message}`,
      )
    }
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

  // Both the payment-link Elements flow and the venue-checkout widget store
  // the PaymentIntent id in CheckoutSession.sessionId and tag the intent with
  // metadata.type. Route to the matching finalizer; anything else is ignored.
  const piType = pi.metadata?.type
  if (piType !== 'payment_link' && piType !== 'venue_checkout') {
    logger.info('ℹ️ [STRIPE CONNECT] payment_intent.succeeded for unrecognized source — ignored', {
      eventId: event.id,
      paymentIntentId: pi.id,
      type: piType ?? 'unknown',
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
    if (piType === 'venue_checkout') {
      await finalizeVenueCheckout({
        stripeSessionId: pi.id,
        paymentIntentId: pi.id,
        amountPaidCents: pi.amount_received ?? null,
        stripePaymentMethodType,
      })
    } else {
      await finalizePaymentLinkCheckout({
        stripeSessionId: pi.id, // sessionId column stores the pi_XXX for Elements flow
        paymentIntentId: pi.id,
        amountPaidCents: pi.amount_received ?? null,
        stripePaymentMethodType,
      })
    }
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
  if (!pi.id || (pi.metadata?.type !== 'payment_link' && pi.metadata?.type !== 'venue_checkout')) return

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
