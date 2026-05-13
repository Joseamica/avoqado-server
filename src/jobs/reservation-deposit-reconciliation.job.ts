import { CronJob } from 'cron'
import prisma from '../utils/prismaClient'
import logger from '../config/logger'
import { getProvider } from '../services/payments/provider-registry'
import { calculateApplicationFeeWithVAT, toStripeAmount } from '../services/payments/providers/money'
import { getVatRateBps } from '../services/superadmin/platformSettings.service'
import { processStripeConnectWebhookEvent } from '../services/payments/reservation-deposit-webhook.service'

export class ReservationDepositReconciliationJob {
  private job: CronJob | null = null
  private readonly CRON_PATTERN = '0 * * * *'
  private readonly ORPHAN_THRESHOLD_MINUTES = 5

  constructor() {
    this.job = new CronJob(this.CRON_PATTERN, this.reconcile.bind(this), null, false, 'America/Mexico_City')
  }

  start(): void {
    this.job?.start()
    logger.info('💳 Reservation Deposit Reconciliation Job started - running hourly')
  }

  stop(): void {
    this.job?.stop()
    logger.info('💳 Reservation Deposit Reconciliation Job stopped')
  }

  async reconcileNow(): Promise<void> {
    await this.reconcile()
  }

  private async reconcile(): Promise<void> {
    try {
      await this.expirePastDueReservations()
      await this.reconcileCheckoutSessions()
      await this.recoverOrphanCheckoutSessions()
    } catch (error) {
      logger.error('❌ [RESERVATION DEPOSIT RECONCILIATION] Job failed', error)
    }
  }

  private async expirePastDueReservations(): Promise<void> {
    const expired = await prisma.reservation.updateMany({
      where: {
        depositStatus: 'PENDING',
        depositExpiresAt: { lt: new Date() },
      },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelledBy: 'SYSTEM',
        cancellationReason: 'Reservation deposit payment window expired',
        depositStatus: 'EXPIRED',
      },
    })

    if (expired.count > 0) {
      logger.warn(`⏱️ [RESERVATION DEPOSIT RECONCILIATION] Expired ${expired.count} unpaid deposit reservation(s)`)
    }
  }

  private async reconcileCheckoutSessions(): Promise<void> {
    const pending = await prisma.reservation.findMany({
      where: {
        depositStatus: 'PENDING',
        checkoutSessionId: { not: null },
      },
      include: {
        venue: { select: { id: true, slug: true } },
      },
      take: 100,
    })

    for (const reservation of pending) {
      // Poll Stripe through the SAME connected account that minted the
      // session — falling back to "latest active" here would query a
      // different account and return PENDING forever for venues that
      // swapped Stripe accounts.
      const merchant = await this.resolveMerchantForReservation(reservation.venueId, reservation.ecommerceMerchantId)
      if (!merchant || !reservation.checkoutSessionId) continue

      try {
        const provider = getProvider(merchant)
        const status = await provider.getPaymentStatus(merchant, reservation.checkoutSessionId)

        if (status.status === 'PAID') {
          await processStripeConnectWebhookEvent({
            id: `reconciliation:${reservation.checkoutSessionId}:paid`,
            type: 'checkout.session.completed',
            account: merchant.providerMerchantId ?? undefined,
            livemode: false,
            data: {
              id: reservation.checkoutSessionId,
              payment_status: 'paid',
              payment_intent: status.paymentIntentId,
            },
          })
        } else if (status.status === 'EXPIRED') {
          await processStripeConnectWebhookEvent({
            id: `reconciliation:${reservation.checkoutSessionId}:expired`,
            type: 'checkout.session.expired',
            account: merchant.providerMerchantId ?? undefined,
            livemode: false,
            data: { id: reservation.checkoutSessionId },
          })
        }
      } catch (error) {
        logger.error('❌ [RESERVATION DEPOSIT RECONCILIATION] Failed to reconcile session', {
          reservationId: reservation.id,
          checkoutSessionId: reservation.checkoutSessionId,
          error,
        })
      }
    }
  }

  private async recoverOrphanCheckoutSessions(): Promise<void> {
    const threshold = new Date(Date.now() - this.ORPHAN_THRESHOLD_MINUTES * 60_000)
    const orphans = await prisma.reservation.findMany({
      where: {
        depositStatus: 'PENDING',
        checkoutSessionId: null,
        idempotencyKey: { not: null },
        createdAt: { lt: threshold },
        depositExpiresAt: { gt: new Date() },
        depositAmount: { not: null },
      },
      include: {
        venue: { select: { id: true, name: true, slug: true } },
      },
      take: 50,
    })

    for (const reservation of orphans) {
      // Orphan recovery may not have a pinned merchant yet (the original
      // mint failed before stamping). Use the pinned one when present;
      // otherwise fall back to "latest active" — and the stamp below will
      // pin it going forward.
      const merchant = await this.resolveMerchantForReservation(reservation.venueId, reservation.ecommerceMerchantId)
      if (!merchant || !reservation.depositAmount || !reservation.depositExpiresAt || !reservation.idempotencyKey) continue

      try {
        const provider = getProvider(merchant)
        const stripeAmount = toStripeAmount(reservation.depositAmount)
        const vatRateBps = await getVatRateBps()
        // Land the customer back on the public booking site (book.avoqado.io/{slug}),
        // not the dashboard's legacy /book/{slug} route. Orphan recovery has no
        // access to the original widget's successUrl, so this is the best default.
        const bookingPublicUrl = process.env.BOOKING_PUBLIC_URL || 'http://localhost:5174'
        const session = await provider.createCheckoutSession(merchant, {
          amount: stripeAmount,
          currency: 'mxn',
          applicationFeeAmount: calculateApplicationFeeWithVAT(stripeAmount, merchant.platformFeeBps, vatRateBps),
          successUrl: `${bookingPublicUrl}/${reservation.venue.slug}?payment=success&reservationId=${reservation.id}&session_id={CHECKOUT_SESSION_ID}`,
          cancelUrl: `${bookingPublicUrl}/${reservation.venue.slug}?payment=cancelled&reservationId=${reservation.id}`,
          expiresAt: reservation.depositExpiresAt,
          customerEmail: reservation.guestEmail ?? undefined,
          metadata: {
            type: 'reservation_deposit',
            reservationId: reservation.id,
            venueId: reservation.venueId,
            confirmationCode: reservation.confirmationCode,
          },
          description: `Reserva ${reservation.venue.name}`,
          statementDescriptorSuffix: 'RESERVA',
          idempotencyKey: reservation.idempotencyKey,
          paymentMethodTypes: ['card'],
        })

        await prisma.reservation.updateMany({
          where: { id: reservation.id, checkoutSessionId: null },
          data: { checkoutSessionId: session.id, ecommerceMerchantId: merchant.id },
        })
      } catch (error) {
        logger.error('❌ [RESERVATION DEPOSIT RECONCILIATION] Failed to recover orphan checkout session', {
          reservationId: reservation.id,
          error,
        })
      }
    }
  }

  /**
   * Pick the EcommerceMerchant that should process this reservation's charge
   * operations. When the reservation has a pinned merchant from checkout-mint
   * time we use it — refunds and status polls MUST hit the same connected
   * account. Falls back to "newest active" only for legacy/orphan rows that
   * predate the pin.
   */
  private async resolveMerchantForReservation(venueId: string, pinnedMerchantId: string | null) {
    if (pinnedMerchantId) {
      const pinned = await prisma.ecommerceMerchant.findFirst({
        where: { id: pinnedMerchantId, provider: { code: 'STRIPE_CONNECT' } },
        include: { provider: true },
      })
      if (pinned) return pinned
      logger.warn(
        `⚠️ [RESERVATION DEPOSIT RECONCILIATION] Pinned merchant ${pinnedMerchantId} not found; falling back to latest active for venue ${venueId}`,
      )
    }
    return prisma.ecommerceMerchant.findFirst({
      where: {
        venueId,
        active: true,
        provider: { code: 'STRIPE_CONNECT', active: true },
      },
      include: { provider: true },
      orderBy: { createdAt: 'desc' },
    })
  }
}

export const reservationDepositReconciliationJob = new ReservationDepositReconciliationJob()
