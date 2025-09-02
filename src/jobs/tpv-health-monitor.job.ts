// jobs/tpv-health-monitor.job.ts

import { CronJob } from 'cron'
import { tpvHealthService } from '../services/tpv/tpv-health.service'
import logger from '../config/logger'

/**
 * Job que monitorea la salud de las terminales TPV
 * Se ejecuta cada 2 minutos para detectar terminales offline
 */
export class TpvHealthMonitorJob {
  private job: CronJob | null = null

  constructor() {
    // Crear el cron job que se ejecuta cada 2 minutos
    this.job = new CronJob(
      '*/2 * * * *', // Cada 2 minutos
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
    try {
      logger.debug('Running TPV health check...')

      // Ejecutar verificación de terminales offline
      await tpvHealthService.checkOfflineTerminals()

      logger.debug('TPV health check completed successfully')
    } catch (error) {
      logger.error('Error during TPV health check:', error)
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
      cronPattern: '*/2 * * * *',
    }
  }
}

// Exportar instancia singleton
export const tpvHealthMonitorJob = new TpvHealthMonitorJob()
