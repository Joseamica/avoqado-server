// jobs/delivery-connect-intent-cleanup.job.ts

import type { CronJob } from 'cron'

import logger from '../config/logger'
import { scheduleJob } from '../observability/jobContext'
import { limpiarIntents } from '../services/delivery-channels/core/deliveryStoreClaim.service'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'
import { DATABASE_JOB_SCHEDULES } from './jobSchedules'

/**
 * Limpieza diaria de las intenciones de conexión de Uber (spec KDS Uber §4.1 y §4.3):
 * vencidas ⇒ `EXPIRED` (token borrado), reclamaciones de tiendas de intents muertos ⇒ liberadas
 * (si no, un enlace que nadie terminó dejaría la tienda en `CLAIMED_BY_OTHER` para siempre),
 * y terminales de más de 7 días ⇒ borradas. Todo por lotes, en `limpiarIntents`.
 */
export class DeliveryConnectIntentCleanupJob {
  private job: CronJob | null = null
  private enCurso = false

  start(): void {
    if (this.job) return
    this.job = scheduleJob('delivery-connect-intent-cleanup', DATABASE_JOB_SCHEDULES.deliveryConnectIntentCleanup, async () => {
      await this.runOnce()
    })
    this.job.start()
    logger.info('🛵 Delivery connect-intent cleanup started — diario')
  }

  stop(): void {
    this.job?.stop()
    this.job = null
  }

  async runOnce(): Promise<void> {
    if (this.enCurso) return
    this.enCurso = true
    try {
      await retry(() => limpiarIntents(), { shouldRetry: shouldRetryDbConnectionError, context: 'deliveryConnectIntentCleanup' })
    } catch (error) {
      logger.error('🚨 [UberConnect] falló la limpieza diaria de intents', { error: (error as Error).message })
    } finally {
      this.enCurso = false
    }
  }
}

export const deliveryConnectIntentCleanupJob = new DeliveryConnectIntentCleanupJob()
