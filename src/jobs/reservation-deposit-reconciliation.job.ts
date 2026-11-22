import { CronJob } from 'cron'
import prisma from '../utils/prismaClient'
import logger from '../config/logger'
import { getProvider } from '../services/payments/provider-registry'
import { calculateApplicationFeeWithVAT, toStripeAmount } from '../services/payments/providers/money'
import { getVatRateBps } from '../services/superadmin/platformSettings.service'
import { processStripeConnectWebhookEvent } from '../services/payments/reservation-deposit-webhook.service'
import { aplicarAlDeposito, cuentaDeLaReserva, registrarLiga } from '../services/reservation/depositoDeReserva'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'
import { scheduleJob } from '../observability/jobContext'

/** La liga de Stripe más larga posible (24 h): una reserva sin fecha ni liga más vieja que esto ya no tiene cómo pagarse. */
const MAX_PAYMENT_WINDOW_MS = 24 * 3_600_000
/** Filas por página: el recorrido sigue página tras página, de la más vieja a la más nueva, hasta acabar o hasta su tope. */
const PAGINA = 100
/** Tope de tiempo de una pasada: menos que la cadencia (5 min) para que una pasada no se encime con la siguiente. */
const TOPE_DE_PASADA_MS = 4 * 60_000

/** La última fila vista de una página (orden: más vieja primero, desempate por id). */
type Despues = { createdAt: Date; id: string } | undefined
function despuesDe(d: Despues) {
  return d ? { OR: [{ createdAt: { gt: d.createdAt } }, { createdAt: d.createdAt, id: { gt: d.id } }] } : {}
}

export class ReservationDepositReconciliationJob {
  private job: CronJob | null = null
  // D681: cada 5 min (minuto 2, 7, 12…: fuera de la estampida de las :00). Si el aviso de Stripe se pierde, una liga vencida
  // sin pagar suelta su lugar a lo más 5 min después (antes, hasta una hora), sin adivinar por reloj si se pagó.
  private readonly CRON_PATTERN = '2-59/5 * * * *'
  private readonly ORPHAN_THRESHOLD_MINUTES = 5
  // ponytail: candado en memoria (una sola instancia, ver .claude/rules/una-sola-instancia.md). Con dos, cada una recorre;
  // los avisos repetidos ya son idempotentes (ProcessedStripeEvent) y el dueño del depósito escribe con CAS.
  private enCurso = false

  constructor() {
    this.job = scheduleJob(
      'reservation-deposit-reconciliation',
      this.CRON_PATTERN,
      this.reconcile.bind(this),
      null,
      false,
      'America/Mexico_City',
    )
  }

  start(): void {
    this.job?.start()
    logger.info('💳 Reservation Deposit Reconciliation Job started - running every 5 minutes')
  }

  stop(): void {
    this.job?.stop()
    logger.info('💳 Reservation Deposit Reconciliation Job stopped')
  }

  async reconcileNow(): Promise<void> {
    await this.reconcile()
  }

  private async reconcile(): Promise<void> {
    if (this.enCurso) return
    this.enCurso = true
    const hasta = Date.now() + TOPE_DE_PASADA_MS
    try {
      await this.expirePastDueReservations(hasta)
      await this.reconcileCheckoutSessions(hasta)
      await this.recoverOrphanCheckoutSessions()
    } catch (error) {
      logger.error('❌ [RESERVATION DEPOSIT RECONCILIATION] Job failed', error)
    } finally {
      this.enCurso = false
    }
  }

  /**
   * D681: el reloj sólo decide cuando Stripe NUNCA creó la liga (sin sesión no hay forma de haber pagado). Una reserva con
   * sesión la decide Stripe (el aviso `checkout.session.expired` o `reconcileCheckoutSessions`): quien pagó a tiempo con el
   * aviso retrasado no pierde su lugar. Cada vencida pasa por el dueño del depósito, que sólo cancela una reserva que sigue
   * PENDING. Las filas viejas sin fecha se juzgan por su `createdAt` más la liga más larga posible.
   */
  private async expirePastDueReservations(hasta = Date.now() + TOPE_DE_PASADA_MS): Promise<void> {
    const now = new Date()
    let despues: Despues = undefined
    let vencidas = 0
    while (Date.now() < hasta) {
      // Entry read only (idempotent) — retried on a connection blip. See .claude/rules/cron-jobs.md
      const pagina = await retry(
        () =>
          prisma.reservation.findMany({
            where: {
              depositStatus: 'PENDING',
              status: 'PENDING',
              checkoutSessionId: null,
              AND: [
                {
                  OR: [
                    { depositExpiresAt: { lt: now } },
                    { depositExpiresAt: null, createdAt: { lt: new Date(now.getTime() - MAX_PAYMENT_WINDOW_MS) } },
                  ],
                },
                despuesDe(despues),
              ],
            },
            select: { id: true, venueId: true, createdAt: true },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            take: PAGINA,
          }),
        { retries: 2, initialDelay: 1500, shouldRetry: shouldRetryDbConnectionError, context: 'deposit-reconciliation.expirePastDue' },
      )
      for (const r of pagina) {
        const v = await aplicarAlDeposito(
          prisma,
          { reservationId: r.id, venueId: r.venueId },
          { tipo: 'VENCIDO', sesionId: null, motivo: 'Reservation deposit payment window expired' },
        )
        if (v.resultado === 'APLICADO') vencidas++
      }
      if (pagina.length < PAGINA) break
      despues = pagina[pagina.length - 1]
    }

    if (vencidas > 0) {
      logger.warn(`⏱️ [RESERVATION DEPOSIT RECONCILIATION] Expired ${vencidas} unpaid deposit reservation(s)`)
    }
  }

  /**
   * D681: le pregunta a Stripe por TODAS las ligas pendientes, de la más vieja a la más nueva, página tras página, hasta acabar
   * o hasta el tope de la pasada (la siguiente vuelve a empezar por las más viejas). Antes tomaba 100 sin orden y podía saltarse
   * una liga varias pasadas seguidas.
   */
  private async reconcileCheckoutSessions(hasta = Date.now() + TOPE_DE_PASADA_MS): Promise<void> {
    let despues: Despues = undefined
    while (Date.now() < hasta) {
      // Entry read only — the Stripe polling loop below is NOT retried. See .claude/rules/cron-jobs.md
      const pagina = await retry(
        () =>
          prisma.reservation.findMany({
            where: { depositStatus: 'PENDING', checkoutSessionId: { not: null }, ...despuesDe(despues) },
            select: { id: true, venueId: true, checkoutSessionId: true, ecommerceMerchantId: true, createdAt: true },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            take: PAGINA,
          }),
        { retries: 2, initialDelay: 1500, shouldRetry: shouldRetryDbConnectionError, context: 'deposit-reconciliation.findPending' },
      )

      for (const reservation of pagina) {
        if (Date.now() >= hasta) return
        // Poll Stripe through the SAME connected account that minted the session.
        const merchant = await cuentaDeLaReserva(reservation.venueId, reservation.ecommerceMerchantId)
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
      if (pagina.length < PAGINA) return
      despues = pagina[pagina.length - 1]
    }
  }

  private async recoverOrphanCheckoutSessions(): Promise<void> {
    const threshold = new Date(Date.now() - this.ORPHAN_THRESHOLD_MINUTES * 60_000)
    // Entry read only — the Stripe createCheckoutSession recovery loop below is NOT retried. See .claude/rules/cron-jobs.md
    const orphans = await retry(
      () =>
        prisma.reservation.findMany({
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
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: 50,
        }),
      { retries: 2, initialDelay: 1500, shouldRetry: shouldRetryDbConnectionError, context: 'deposit-reconciliation.findOrphans' },
    )

    for (const reservation of orphans) {
      // Orphan recovery may not have a pinned merchant yet (the original
      // mint failed before stamping). Use the pinned one when present;
      // otherwise fall back to "latest active" — and the stamp below will
      // pin it going forward.
      const merchant = await cuentaDeLaReserva(reservation.venueId, reservation.ecommerceMerchantId)
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

        // D681: la liga se guarda por el dueño del depósito; si la reserva ya no la acepta, se cierra y no se usa.
        await registrarLiga({ reservationId: reservation.id, venueId: reservation.venueId, merchant, session })
      } catch (error) {
        logger.error('❌ [RESERVATION DEPOSIT RECONCILIATION] Failed to recover orphan checkout session', {
          reservationId: reservation.id,
          error,
        })
      }
    }
  }
}

export const reservationDepositReconciliationJob = new ReservationDepositReconciliationJob()
