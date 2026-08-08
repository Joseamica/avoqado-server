// jobs/tpv-health-monitor.job.ts

import { CronJob } from 'cron'
import { tpvHealthService } from '../services/tpv/tpv-health.service'
import logger from '../config/logger'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'
import { DATABASE_JOB_SCHEDULES } from './jobSchedules'

/**
 * Job que monitorea la salud de las terminales TPV
 * Se ejecuta cada 2 minutos para detectar terminales offline
 */
export class TpvHealthMonitorJob {
  private job: CronJob | null = null
  private isChecking = false

  constructor() {
    // Crear el cron job que se ejecuta cada 2 minutos
    this.job = new CronJob(
      DATABASE_JOB_SCHEDULES.tpvHealthMonitor, // Cada 2 minutos, desfasado de otros jobs de DB
      this.checkTerminalHealth.bind(this),
      null, // onComplete callback
      false, // Start job immediately
      'America/Mexico_City', // Timezone
    )
  }

  /**
   * Iniciar el monitoreo de salud de terminales
   */
  start(): void {
    if (this.job) {
      this.job.start()
      logger.info('TPV Health Monitor Job started - checking every 2 minutes')
    }
  }

  /**
   * Detener el monitoreo
   */
  stop(): void {
    if (this.job) {
      this.job.stop()
      logger.info('TPV Health Monitor Job stopped')
    }
  }

  /**
   * Verificar manualmente la salud de las terminales
   */
  async checkNow(): Promise<void> {
    await this.checkTerminalHealth()
  }

  /**
   * Función principal que verifica la salud de todas las terminales
   */
  private async checkTerminalHealth(): Promise<void> {
    if (this.isChecking) {
      logger.warn('[TPV health] tick skipped — previous run still in progress')
      return
    }
    this.isChecking = true

    try {
      logger.debug('Running TPV health check...')

      // checkOfflineTerminals() is a single idempotent updateMany, so it is safe to
      // retry on a transient DB connection blip — e.g. the top-of-hour cron stampede
      // that briefly exhausts Prisma's connect_timeout and surfaces as P1001.
      // Only connection errors are retried; any other error fails through to the catch.
      await retry(() => tpvHealthService.checkOfflineTerminals(), {
        retries: 2,
        initialDelay: 1500,
        shouldRetry: shouldRetryDbConnectionError,
        context: 'tpv-health.checkOfflineTerminals',
      })

      logger.debug('TPV health check completed successfully')
    } catch (error) {
      logger.error('Error during TPV health check:', error)
    } finally {
      this.isChecking = false
    }
  }

  /**
   * Obtener información sobre el estado del job
   */
  getJobStatus(): {
    isRunning: boolean
    nextRun: Date | null
    lastRun: Date | null
    cronPattern: string
  } {
    return {
      isRunning: !!this.job,
      nextRun: null, // CronJob type issues, keeping simple for now
      lastRun: null, // CronJob type issues, keeping simple for now
      cronPattern: DATABASE_JOB_SCHEDULES.tpvHealthMonitor,
    }
  }
}

// Exportar instancia singleton
export const tpvHealthMonitorJob = new TpvHealthMonitorJob()
