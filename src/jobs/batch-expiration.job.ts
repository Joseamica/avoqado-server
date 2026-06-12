// jobs/batch-expiration.job.ts

import { CronJob } from 'cron'
import logger from '../config/logger'
import { markExpiredBatches } from '../services/dashboard/fifoBatch.service'

/**
 * Job diario que expira lotes FIFO caducados.
 *
 * **Problema**: los StockBatch con expirationDate vencida se quedaban ACTIVE
 * para siempre (nada invocaba markExpiredBatches) — FIFO seguía vendiendo
 * producto caducado y el inventario nunca reflejaba la merma.
 *
 * **Solución**: markExpiredBatches marca EXPIRED cada lote ACTIVE vencido,
 * descuenta su remanente de RawMaterial.currentStock y deja un movimiento
 * SPOILAGE auditable (todo transaccional, con claim condicional contra
 * dobles ejecuciones).
 *
 * **Frecuencia**: diario a las 02:17 (hora CDMX), fuera de horario operativo
 * y desfasado de los demás crons.
 */
export class BatchExpirationJob {
  private job: CronJob | null = null
  private readonly CRON_PATTERN = '17 2 * * *' // Diario 02:17 America/Mexico_City

  constructor() {
    this.job = new CronJob(this.CRON_PATTERN, this.expireBatches.bind(this), null, false, 'America/Mexico_City')
  }

  start(): void {
    if (this.job) {
      this.job.start()
      logger.info('🗓️ Batch Expiration Job started - daily at 02:17 (expira lotes FIFO caducados y descuenta stock)')
    }
  }

  stop(): void {
    if (this.job) {
      this.job.stop()
      logger.info('🗓️ Batch Expiration Job stopped')
    }
  }

  /** Disparo manual (tests / ops). */
  async runNow(): Promise<void> {
    await this.expireBatches()
  }

  private async expireBatches(): Promise<void> {
    try {
      const expired = await markExpiredBatches()
      if (expired > 0) {
        logger.info(`🗓️ [BATCH EXPIRATION] ${expired} lote(s) caducado(s) expirados y descontados del inventario`)
      } else {
        logger.debug('🗓️ [BATCH EXPIRATION] Sin lotes caducados')
      }
    } catch (error) {
      logger.error('🗓️ [BATCH EXPIRATION] Error expirando lotes', error)
    }
  }
}

export const batchExpirationJob = new BatchExpirationJob()
