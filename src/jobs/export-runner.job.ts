import type { CronJob } from 'cron'
import logger from '../config/logger'
import { runInJobContext, scheduleJob } from '../observability/jobContext'
import { conNegocio } from '../services/demo/candadoDemo'
import { exportRunService } from '../services/exports/exportRun.service'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'
import { DATABASE_JOB_SCHEDULES } from './jobSchedules'

type CronHandle = Pick<CronJob, 'start' | 'stop'>
type Servicio = Pick<typeof exportRunService, 'reclamarSiguiente' | 'procesar' | 'barrerAvisos' | 'expirarVencidos'>

export class ExportRunnerJob {
  private enCurso = false // ponytail: candado en memoria; una sola instancia (una-sola-instancia.md). El lease de la base cubre reinicios.
  private readonly servicio: Servicio
  private readonly cron: CronHandle
  private readonly cronLimpieza: CronHandle

  constructor(o: { servicio?: Servicio; cron?: CronHandle; cronLimpieza?: CronHandle } = {}) {
    this.servicio = o.servicio ?? exportRunService
    this.cron =
      o.cron ??
      scheduleJob(
        'export-runner',
        DATABASE_JOB_SCHEDULES.exportRunner,
        async () => {
          await this.tick()
        },
        null,
        false,
        'America/Mexico_City',
      )
    this.cronLimpieza =
      o.cronLimpieza ??
      scheduleJob(
        'export-cleanup',
        DATABASE_JOB_SCHEDULES.exportCleanup,
        async () => {
          await this.limpiar()
        },
        null,
        false,
        'America/Mexico_City',
      )
  }

  start(): void {
    this.cron.start()
    this.cronLimpieza.start()
    logger.info('Export runner job started')
  }

  stop(): void {
    this.cron.stop()
    this.cronLimpieza.stop()
    logger.info('Export runner job stopped')
  }

  /** Lo llama el controller al encolar: no esperar 30 s. Corre con contexto de JOB, no con el de la petición que lo despierta. */
  despertar(): void {
    setImmediate(() => runInJobContext('export-runner', () => void this.tick()))
  }

  async tick(): Promise<number> {
    if (this.enCurso) return 0
    this.enCurso = true
    let n = 0
    try {
      await this.barrer() // Codex r2 B1: al EMPEZAR la vuelta, no al vaciar la fila
      for (;;) {
        const run = await retry(() => this.servicio.reclamarSiguiente(), {
          retries: 2,
          initialDelay: 1500,
          shouldRetry: shouldRetryDbConnectionError,
          context: 'export-runner.reclamar',
        })
        if (!run) break
        // candado demo, capa 3: cada pedido corre con SU negocio en el contexto (venueName en el log; correo de un demo apagado)
        await conNegocio(run.venueId, () => this.servicio.procesar(run.runId, run.attempt))
        n++
        await this.barrer() // y después de CADA pedido: una fila siempre llena no retrasa los avisos
      }
    } catch (e) {
      logger.warn('[exportes] tick falló', { motivo: (e as Error).message?.slice(0, 80) })
    } finally {
      this.enCurso = false
    }
    return n
  }

  /** Bandeja de avisos (hasta 10 pedidos por barrido, con sus plazos). Su error nunca tumba la vuelta. */
  private async barrer(): Promise<void> {
    try {
      await this.servicio.barrerAvisos()
    } catch (e) {
      logger.warn('[exportes] barrido de avisos falló', { motivo: (e as Error).message?.slice(0, 80) })
    }
  }

  async limpiar(): Promise<number> {
    try {
      return await this.servicio.expirarVencidos()
    } catch (e) {
      logger.warn('[exportes] limpieza falló', { motivo: (e as Error).message?.slice(0, 80) })
      return 0
    }
  }
}

export const exportRunnerJob = new ExportRunnerJob()
