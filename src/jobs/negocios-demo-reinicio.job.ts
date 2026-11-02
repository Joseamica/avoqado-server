import { CronJob } from 'cron'
import logger from '../config/logger'
import { scheduleJob } from '../observability/jobContext'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'
import { reiniciarNegociosDemo } from '../services/demo/negociosDemo.service'

/**
 * Cada noche a las 3:00 (Ciudad de México) los negocios demo vuelven a quedar como nuevos: se borran y vuelven a nacer con
 * el mismo nombre, enlace y usuario (`services/demo/negociosDemo.service.ts`). Sólo si la organización demo ya existe: la
 * primera creación en producción es a mano, con el founder. Un negocio que falla no detiene a los demás.
 */
export class NegociosDemoReinicioJob {
  private job: CronJob | null = null
  private corriendo = false

  constructor() {
    this.job = scheduleJob('negocios-demo-reinicio', '0 0 3 * * *', () => this.tick(), null, false, 'America/Mexico_City')
  }

  start(): void {
    this.job?.start()
  }

  stop(): void {
    this.job?.stop()
  }

  async tick(): Promise<void> {
    if (this.corriendo) return
    this.corriendo = true
    try {
      // La lectura de entrada con `retry` (regla cron-jobs): a la hora en punto se alinean varios crones.
      const resultado = await retry(() => reiniciarNegociosDemo(), {
        retries: 2,
        initialDelay: 1500,
        shouldRetry: shouldRetryDbConnectionError,
        context: 'negocios-demo-reinicio',
      })
      if (!resultado) return
      if (resultado.fallas.length) logger.error(`🚨 Negocios demo: ${resultado.ok} reiniciados; fallaron ${resultado.fallas.join(', ')}`)
      else logger.info(`🧪 Negocios demo: ${resultado.ok} reiniciados como nuevos`)
    } catch (error) {
      logger.error('🚨 El reinicio de los negocios demo falló', { error })
    } finally {
      this.corriendo = false
    }
  }
}

export const negociosDemoReinicioJob = new NegociosDemoReinicioJob()
