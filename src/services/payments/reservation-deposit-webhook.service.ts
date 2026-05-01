import { Prisma, ReservationStatus } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { VerifiedWebhookEvent } from './providers/provider.interface'

type CheckoutSessionLike = {
  id: string
  payment_status?: string | null
  payment_intent?: string | { id?: string } | null
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

export async function processStripeConnectWebhookEvent(event: VerifiedWebhookEvent) {
  switch (event.type) {
    case 'checkout.session.completed':
      await processCheckoutCompleted(event)
      return
    case 'checkout.session.expired':
      await processCheckoutExpired(event)
      return
    case 'account.updated':
    case 'v2.core.account.updated':
      await processAccountUpdated(event)
      return
    default:
      logger.info('ℹ️ [STRIPE CONNECT] Unhandled event type', { eventId: event.id, type: event.type, account: event.account })
  }
}
