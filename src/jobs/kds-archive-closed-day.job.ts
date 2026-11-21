import type { CronJob } from 'cron'
import logger from '../config/logger'
import { scheduleJob } from '../observability/jobContext'
import { archivarComandas, comandasPorArchivar, type ComandaArchivada } from '../services/kds/kdsArchive.service'
import prisma from '../utils/prismaClient'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'
import { DATABASE_JOB_SCHEDULES } from './jobSchedules'

/**
 * D17 (founder, 20-nov-2026; Flautas «no me quita pedidos pasados»): archiva las comandas de un día del negocio que ya terminó cuya
 * cuenta ya se cerró. La regla vive en `services/kds/kdsArchive.service.ts`. Cada 15 min, hasta 500 por pasada (las más viejas
 * primero): el rezago de un negocio que nunca usó la pantalla (Testarudo juntó 3,068) se va en unas pasadas sin cargar al servidor.
 */
type CronHandle = Pick<CronJob, 'start' | 'stop'>

export class KdsArchiveClosedDayJob {
  private readonly cron: CronHandle
  private running = false

  constructor(cron?: CronHandle) {
    this.cron =
      cron ??
      scheduleJob(
        'kds-archive-closed-day',
        DATABASE_JOB_SCHEDULES.kdsArchiveClosedDay,
        () => {
          void this.runNow().catch(error => logger.error('🗄️ [kds-archive] falló la pasada', { error }))
        },
        null,
        false,
        'America/Mexico_City',
      )
  }

  start(): void {
    this.cron.start()
    logger.info('KDS archive (fin del día del negocio) started')
  }

  stop(): void {
    this.cron.stop()
  }

  async runNow(ahora: Date = new Date()): Promise<ComandaArchivada[]> {
    if (this.running) return []
    this.running = true
    try {
      // Entrada: lectura pura, con el reintento de conexión de la estampida del minuto (regla de los cron).
      const candidatas = await retry(() => comandasPorArchivar(prisma, ahora), {
        retries: 2,
        initialDelay: 1500,
        shouldRetry: shouldRetryDbConnectionError,
        context: 'kds-archive-closed-day.find',
      })
      if (candidatas.length === 0) return []
      const archivadas = await prisma.$transaction(tx =>
        archivarComandas(
          tx,
          candidatas.map(c => c.id),
          ahora,
        ),
      )
      if (archivadas.length > 0) {
        logger.info('🗄️ [kds-archive] comandas archivadas al cerrar el día', {
          total: archivadas.length,
          negocios: new Set(archivadas.map(a => a.venueId)).size,
        })
      }
      return archivadas
    } finally {
      this.running = false
    }
  }
}

export const kdsArchiveClosedDayJob = new KdsArchiveClosedDayJob()
