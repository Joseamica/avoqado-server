import { CronJob } from 'cron'
import logger from '../config/logger'
import { env } from '../config/env'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'
import { scheduleJob } from '../observability/jobContext'
import { barrerCumpleanos } from '../services/marketing/birthdaySweep.service'

const TIMEZONE = 'America/Mexico_City'

/**
 * Barrido HORARIO del cumpleaños automático.
 *
 * 🔴 Horario y no diario, a propósito: los venues viven en zonas distintas y la medianoche
 * de cada uno cae en una hora distinta. Un job diario tendría que elegir UNA hora y llegaría
 * tarde o temprano según el negocio. Barriendo cada hora, cada venue se procesa en cuanto su
 * fecha civil cambia, y el cursor (`lastEvaluatedLocalDate`) hace que las 23 pasadas
 * restantes del día no hagan nada.
 *
 * NO manda correos: sólo encola en la misma cola que las campañas puntuales, que ya tiene su
 * reparto justo, su cuota y su backoff probados.
 *
 * Minuto 13 para no coincidir con el sender (minuto 7 de cada 5) ni con el resto de la
 * pasarela de jobs.
 */
export class BirthdaySweepJob {
  private job: CronJob | null = null
  private isRunning = false
  private avisoKillSwitchEmitido = false

  constructor() {
    this.job = scheduleJob(
      'birthday-sweep',
      '23 13 * * * *',
      async () => {
        await this.tick()
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

  private async tick(): Promise<void> {
    // Un barrido lento nunca se solapa consigo mismo: el siguiente tick se salta.
    if (this.isRunning) return
    this.isRunning = true
    try {
      // El mismo interruptor de emergencia que el sender: apaga TODO el carril de marketing
      // sin desplegar.
      if (env.MARKETING_KILL_SWITCH === 'true') {
        if (!this.avisoKillSwitchEmitido) {
          logger.warn('[birthday-sweep] MARKETING_KILL_SWITCH=true — no se encola ninguna felicitación')
          this.avisoKillSwitchEmitido = true
        }
        return
      }
      this.avisoKillSwitchEmitido = false

      // `retry` en la lectura de entrada: regla `cron-jobs.md` — evita que una P1001 en el
      // tope de la hora mate el job.
      const resultado = await retry(() => barrerCumpleanos(new Date()), {
        retries: 2,
        initialDelay: 1500,
        shouldRetry: shouldRetryDbConnectionError,
        context: 'birthday-sweep',
      })

      // Se registra sólo cuando hubo algo que contar; si no, 24 líneas vacías al día.
      if (resultado.encoladas > 0 || resultado.saltados.length > 0) {
        logger.info('[birthday-sweep] barrido terminado', {
          automatizacionesRevisadas: resultado.automatizacionesRevisadas,
          encoladas: resultado.encoladas,
          saltados: resultado.saltados.length,
          // Los motivos van en el log: un venue saltado se REPORTA, nunca se descarta en
          // silencio — es lo que permite enterarse de que a alguien le falta la zona horaria
          // o se le cayó el plan.
          motivos: resultado.saltados.slice(0, 10),
        })
      }
    } catch (error: any) {
      logger.error('[birthday-sweep] el barrido falló entero', { error: error?.message })
    } finally {
      this.isRunning = false
    }
  }
}

export const birthdaySweepJob = new BirthdaySweepJob()
