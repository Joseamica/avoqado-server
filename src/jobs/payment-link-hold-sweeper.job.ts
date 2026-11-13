import type { CronJob } from 'cron'
import Stripe from 'stripe'
import logger from '../config/logger'
import { scheduleJob } from '../observability/jobContext'
import prisma from '../utils/prismaClient'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'
import { DATABASE_JOB_SCHEDULES } from './jobSchedules'

/**
 * Liga por prenda (diseño §5 r3): suelta las fichas de apartado vencidas (15 min) y cierra su intento en Stripe.
 *
 * 🔴 La regla es la hora: la disponibilidad ya no cuenta una ficha vencida aunque este barrido no corra; aquí sólo se deja la
 * ficha `RELEASED` y se cierra el intento para acotar un cobro tardío. Por eso la ficha se suelta ANTES de hablar con Stripe y
 * un Stripe caído no la regresa.
 *
 * Por intento, con la cuenta CONGELADA en la ficha: cancelable → se cancela y, con `canceled` confirmado, `intento_cancelado`;
 * `succeeded` → `intento_cobrado` (NO se cancela: su cierre normal lo vende); `processing` o error → se queda `vencida` y lo
 * revisa el siguiente POST del mismo navegador (`cerrarIntentoPrevio`).
 */

const BATCH_LIMIT = 100
const CANCELABLE = new Set(['requires_payment_method', 'requires_confirmation', 'requires_action'])

type CronHandle = Pick<CronJob, 'start' | 'stop'>

interface PaymentLinkHoldSweeperDependencies {
  prisma: typeof prisma
  cron?: CronHandle
  now: () => Date
  retryEntry: typeof retry
  /** Sin inyectar: el cliente de plataforma, creado al primer uso. */
  stripe?: Pick<Stripe, 'paymentIntents'>
}

let stripeClient: Stripe | null = null
const defaults: PaymentLinkHoldSweeperDependencies = {
  prisma,
  now: () => new Date(),
  retryEntry: retry,
}

export class PaymentLinkHoldSweeperJob {
  private readonly dependencies: PaymentLinkHoldSweeperDependencies
  private readonly cron: CronHandle
  private running = false

  constructor(overrides: Partial<PaymentLinkHoldSweeperDependencies> = {}) {
    this.dependencies = { ...defaults, ...overrides }
    this.cron =
      overrides.cron ??
      scheduleJob(
        'payment-link-hold-sweeper',
        DATABASE_JOB_SCHEDULES.paymentLinkHoldSweeper,
        () => {
          void this.runNow().catch(error => logger.error('Payment link hold sweep failed', { error }))
        },
        null,
        false,
        'America/Mexico_City',
      )
  }

  start(): void {
    this.cron.start()
    logger.info('Payment link hold sweeper started')
  }

  stop(): void {
    this.cron.stop()
    logger.info('Payment link hold sweeper stopped')
  }

  private stripe(): Pick<Stripe, 'paymentIntents'> {
    if (this.dependencies.stripe) return this.dependencies.stripe
    stripeClient ??= new Stripe(process.env.STRIPE_SECRET_KEY || '', { apiVersion: '2026-02-25.clover' as any })
    return stripeClient
  }

  async runNow(): Promise<{ released: number; canceled: number; errors: number; skipped?: true }> {
    if (this.running) return { released: 0, canceled: 0, errors: 0, skipped: true }
    this.running = true
    try {
      const { prisma: db } = this.dependencies
      const now = this.dependencies.now()
      const vencidas = await this.dependencies.retryEntry(
        () =>
          db.paymentLinkStockHold.findMany({
            where: { status: 'ACTIVE', expiresAt: { lte: now } },
            select: { id: true },
            orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
            take: BATCH_LIMIT,
          }),
        { retries: 2, initialDelay: 1500, shouldRetry: shouldRetryDbConnectionError, context: 'payment-link-hold-sweeper.findExpired' },
      )
      if (vencidas.length === 0) return { released: 0, canceled: 0, errors: 0 }

      // CAS: sólo las que siguen ACTIVE (el cierre del cobro pudo consumir una entre la lectura y aquí).
      const soltadas = await db.paymentLinkStockHold.updateManyAndReturn({
        where: { id: { in: vencidas.map(v => v.id) }, status: 'ACTIVE', expiresAt: { lte: now } },
        data: { status: 'RELEASED', releasedReason: 'vencida' },
        select: { id: true, venueId: true, stripePaymentIntentId: true, stripeAccountId: true },
      })

      let canceled = 0
      let errors = 0
      for (const h of soltadas) {
        if (!h.stripePaymentIntentId || !h.stripeAccountId) continue
        const opciones = { stripeAccount: h.stripeAccountId }
        try {
          let pi = await this.stripe().paymentIntents.retrieve(h.stripePaymentIntentId, undefined, opciones)
          if (CANCELABLE.has(pi.status)) pi = await this.stripe().paymentIntents.cancel(h.stripePaymentIntentId, undefined, opciones)
          const reason = pi.status === 'canceled' ? 'intento_cancelado' : pi.status === 'succeeded' ? 'intento_cobrado' : null
          if (reason === 'intento_cancelado') canceled += 1
          if (reason) {
            await db.paymentLinkStockHold.updateMany({
              where: { id: h.id, status: 'RELEASED', releasedReason: 'vencida' },
              data: { releasedReason: reason },
            })
          }
        } catch (error) {
          errors += 1
          logger.error('🧹 [PaymentLinkHoldSweeper] No se pudo cerrar el intento de una ficha vencida (la ficha ya quedó soltada)', {
            holdId: h.id,
            venueId: h.venueId,
            paymentIntentId: h.stripePaymentIntentId,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }

      logger.info('🧹 [PaymentLinkHoldSweeper] Fichas vencidas soltadas', { released: soltadas.length, canceled, errors })
      return { released: soltadas.length, canceled, errors }
    } finally {
      this.running = false
    }
  }
}

export const paymentLinkHoldSweeperJob = new PaymentLinkHoldSweeperJob()
