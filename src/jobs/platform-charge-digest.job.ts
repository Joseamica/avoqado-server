import { CronJob } from 'cron'
import logger from '../config/logger'
import { scheduleJob } from '../observability/jobContext'
import { runPlatformChargeDigest } from '../services/superadmin/platform-charges/digest.service'
import { DATABASE_JOB_SCHEDULES } from './jobSchedules'

const TIMEZONE = 'America/Mexico_City'

/**
 * «Por cobrar»: el correo diario al founder con lo que le deben (spec 2026-11-02-por-cobrar-superadmin §7). Cada 15 minutos todo el
 * día, porque el servicio manda desde las 9:00 de CDMX pero a cualquier hora termina lo que un proceso muerto o un fallo de Resend dejó
 * a medias (`runPlatformChargeDigest`); y de paso corre, una vez al día por proceso, la generación de las fechas por cobrar. Sólo
 * trabaja en producción o, fuera de ella, con `PLATFORM_CHARGES_SANDBOX=true`: sin eso la vuelta termina al instante sin hacer nada.
 *
 * 🔴 La lectura de conexión con reintento de `.claude/rules/cron-jobs.md` vive en el servicio, alrededor de la primera lectura de la
 * vuelta, que es pura. El envío y las marcas nunca se reintentan a ciegas: un reintento pasa por la fila reservada y su llave.
 */
export class PlatformChargeDigestJob {
  private job: CronJob | null = null
  private isRunning = false

  constructor() {
    // 🔴 `scheduleJob`, no `new CronJob`: cada línea de log de una vuelta lleva el nombre de la tarea y su correlationId.
    this.job = scheduleJob(
      'platform-charge-digest',
      DATABASE_JOB_SCHEDULES.platformChargeDigest,
      async () => {
        await this.run()
      },
      null,
      false,
      TIMEZONE,
    )
  }

  start(): void {
    this.job?.start()
  }

  stop(): void {
    this.job?.stop()
  }

  async run(): Promise<void> {
    // La fila reservada ya impide un doble envío; esto sólo le ahorra el trabajo a una vuelta que se encima con la anterior.
    if (this.isRunning) return
    this.isRunning = true
    try {
      await runPlatformChargeDigest(new Date())
    } catch (err) {
      // Última red: una vuelta nunca tumba el proceso. Lo reservado queda en su fila y la vuelta siguiente lo retoma.
      logger.error('[platform-charges] El correo diario de «Por cobrar» falló', { err })
    } finally {
      this.isRunning = false
    }
  }
}

export const platformChargeDigestJob = new PlatformChargeDigestJob()
