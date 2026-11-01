import type { CronJob } from 'cron'
import logger from '../config/logger'
import { scheduleJob } from '../observability/jobContext'
import { entregarTarjetas, hayEntregasPendientes, type ResultadoDeEntrega } from '../services/giftCards/giftCardDelivery.service'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'
import { DATABASE_JOB_SCHEDULES } from './jobSchedules'

/**
 * Entrega de tarjetas de regalo por WhatsApp y correo (1b S3, índice Q1). Cada minuto pregunta si hay algo que hacer —una lectura
 * pura, la única que va con el reintento de conexión (regla de cron)— y sólo entonces corre la vuelta, que reclama en la fila,
 * manda fuera de toda transacción y escribe el resultado con CAS (`giftCardDelivery.service.ts`). Cubre los cobros que no patean
 * la entrega (la PAX desde «Órdenes», el panel) y los reintentos a +1, +5 y +30 min.
 */

type CronHandle = Pick<CronJob, 'start' | 'stop'>

interface Dependencies {
  cron?: CronHandle
  now: () => Date
  retryEntry: typeof retry
  hayPendientes: typeof hayEntregasPendientes
  entregar: typeof entregarTarjetas
}

const defaults: Dependencies = {
  now: () => new Date(),
  retryEntry: retry,
  hayPendientes: hayEntregasPendientes,
  entregar: entregarTarjetas,
}

const SIN_NADA: ResultadoDeEntrega = { reclamadas: 0, enviadas: 0, reprogramadas: 0, fallidas: 0, atoradas: 0 }

export class GiftCardDeliveryJob {
  private readonly d: Dependencies
  private readonly cron: CronHandle
  private running = false

  constructor(overrides: Partial<Dependencies> = {}) {
    this.d = { ...defaults, ...overrides }
    this.cron =
      overrides.cron ??
      scheduleJob(
        'gift-card-delivery',
        DATABASE_JOB_SCHEDULES.giftCardDelivery,
        () => {
          void this.runNow().catch(error =>
            logger.error('🎁 [tarjetas de regalo] entrega: la vuelta falló', { error: (error as Error)?.message }),
          )
        },
        null,
        false,
        'America/Mexico_City',
      )
  }

  start(): void {
    this.cron.start()
    logger.info('Gift-card delivery started')
  }

  stop(): void {
    this.cron.stop()
    logger.info('Gift-card delivery stopped')
  }

  async runNow(): Promise<ResultadoDeEntrega & { skipped: boolean }> {
    if (this.running) return { ...SIN_NADA, skipped: true }
    this.running = true
    try {
      const ahora = this.d.now()
      const hay = await this.d.retryEntry(() => this.d.hayPendientes(ahora), {
        retries: 2,
        initialDelay: 1500,
        shouldRetry: shouldRetryDbConnectionError,
        context: 'gift-card-delivery.pendientes',
      })
      if (!hay) return { ...SIN_NADA, skipped: false }
      // Fuera del reintento: la vuelta manda mensajes y suma intentos (regla de cron).
      const r = await this.d.entregar({ ahora })
      if (r.reclamadas + r.atoradas > 0) logger.info('🎁 [tarjetas de regalo] entrega: vuelta', r)
      return { ...r, skipped: false }
    } finally {
      this.running = false
    }
  }
}

export const giftCardDeliveryJob = new GiftCardDeliveryJob()
