import type { CronJob } from 'cron'
import logger from '../config/logger'
import { scheduleJob } from '../observability/jobContext'
import { renombrarProductosDelPlan, type EstadoDelNombre } from '../services/billing/nombreDelPlanEnStripe'
import type { PlanPagado } from '../services/billing/planOffer'
import { DATABASE_JOB_SCHEDULES } from './jobSchedules'

/**
 * Planes editables (B1, Task 8): el nombre del producto de Stripe de cada plan converge con la oferta vigente.
 *
 * Una versión publicada puede renombrar un plan; el publicador lo intenta en cuanto mueve el puntero (`runNow()`, sin esperarlo) y
 * este job lo reintenta cada minuto, en el segundo :03. Mientras Stripe diga otro nombre, el checkout de «Tu plan» responde 503
 * `PLAN_RENAME_PENDING`. Sin versiones o con sólo la v1, cada vuelta es una lectura de la base y nada más.
 *
 * 🔴 Ni este job ni lo que importa conocen al publicador (`planOfferPublisher.ts` importa este archivo, nunca al revés).
 */

type CronHandle = Pick<CronJob, 'start' | 'stop'>
type Resultado = Record<PlanPagado, EstadoDelNombre>

interface Dependencias {
  cron?: CronHandle
  renombrar?: () => Promise<Resultado>
}

export class PlanOfferRenameJob {
  private readonly cron: CronHandle
  private readonly renombrar: () => Promise<Resultado>
  private corriendo = false
  /** Alguien pidió una vuelta mientras otra corría (un publicador que movió el puntero a media vuelta): se corre una más al terminar. */
  private otraVuelta = false

  constructor(deps: Dependencias = {}) {
    this.renombrar = deps.renombrar ?? renombrarProductosDelPlan
    this.cron =
      deps.cron ??
      scheduleJob(
        'plan-offer-rename',
        DATABASE_JOB_SCHEDULES.planOfferRename,
        () => {
          void this.runNow().catch(error => logger.error('Renombre de los planes: la corrida falló', { error }))
        },
        null,
        false,
        'America/Mexico_City',
      )
  }

  start(): void {
    this.cron.start()
    logger.info('Plan offer rename started')
  }

  stop(): void {
    this.cron.stop()
  }

  /**
   * Una vuelta. `null` si otra sigue corriendo: entonces queda pedida UNA vuelta más, que arranca en cuanto ésa termine (pudo leer la
   * vigente antes de que se publicara la nueva). La marca se suelta en `finally`, también si la vuelta falla.
   */
  async runNow(): Promise<Resultado | null> {
    if (this.corriendo) {
      this.otraVuelta = true
      return null
    }
    this.corriendo = true
    try {
      const resultado = await this.renombrar()
      if (Object.values(resultado).some((estado: EstadoDelNombre) => estado === 'RENOMBRADO' || estado === 'FALLO'))
        logger.info('Renombre de los planes: corrida', resultado)
      return resultado
    } finally {
      this.corriendo = false
      if (this.otraVuelta) {
        this.otraVuelta = false
        void this.runNow().catch(error => logger.error('Renombre de los planes: la corrida falló', { error }))
      }
    }
  }
}

export const planOfferRenameJob = new PlanOfferRenameJob()
