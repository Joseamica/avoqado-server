import type { CronJob } from 'cron'
import logger from '../config/logger'
import { scheduleJob } from '../observability/jobContext'
import { cerrarAltaSinNavegador } from '../services/onboarding/planActivation.service'
import { PLAN_ACTIVATION_STATUS } from '../services/launchCampaigns/launchCampaignEnums'
import prisma from '../utils/prismaClient'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'
import { DATABASE_JOB_SCHEDULES } from './jobSchedules'

/**
 * R1 y R2 de la campaña 3DS — el alta que se quedó «esperando al banco» sin nadie en la pantalla.
 *
 * Cuando el banco pide autorizar el primer cobro, el alta queda IN_PROGRESS con el lease suelto mientras el cliente hace el
 * reto. Si nunca vuelve, nadie la resolvía: con el pago autorizado quedaba cobrada sin acceso (R2), y con el reto abandonado
 * su lugar de la campaña quedaba apartado para siempre (R1). Mismo patrón que `plan-access-reconciliation`: el navegador es
 * el camino rápido, este barrido es la garantía. La decisión de cada alta (y su candado) vive en `cerrarAltaSinNavegador`.
 */

/** Tope por corrida: acota las llamadas a Stripe. */
const LOTE = 25
/** Quieta al menos esto: deja terminar al navegador que acaba de hacer el reto antes de que el barrido lo intente. */
const QUIETA_MS = 15 * 60_000

type CronHandle = Pick<CronJob, 'start' | 'stop'>

export interface ResultadoAltasAMedioPago {
  revisadas: number
  cerradas: number
  liberadas: number
  fallidas: number
}

interface Dependencias {
  cron?: CronHandle
  resolver?: (organizationId: string) => Promise<'CERRADA' | 'LIBERADA' | 'NADA'>
}

export class AltasAMedioPagoJob {
  private readonly cron: CronHandle
  private readonly resolver: (organizationId: string) => Promise<'CERRADA' | 'LIBERADA' | 'NADA'>
  private corriendo = false
  /** Cursor rotativo: un puñado de altas que siguen esperando al banco (hasta 23 h) no tapa a las demás. */
  private cursor: string | null = null

  constructor(deps: Dependencias = {}) {
    this.resolver = deps.resolver ?? cerrarAltaSinNavegador
    this.cron =
      deps.cron ??
      scheduleJob(
        'altas-a-medio-pago',
        DATABASE_JOB_SCHEDULES.altasAMedioPago,
        () => {
          void this.runNow().catch(error => logger.error('Altas a medio pago: la corrida falló', { error }))
        },
        null,
        false,
        'America/Mexico_City',
      )
  }

  start(): void {
    this.cron.start()
    logger.info('Altas a medio pago started')
  }

  stop(): void {
    this.cron.stop()
  }

  async runNow(): Promise<ResultadoAltasAMedioPago> {
    const resultado = { revisadas: 0, cerradas: 0, liberadas: 0, fallidas: 0 }
    if (this.corriendo) return resultado
    this.corriendo = true
    try {
      const ahora = Date.now()
      const altas = await retry(
        () =>
          prisma.onboardingProgress.findMany({
            where: {
              completedAt: null,
              planActivationStatus: PLAN_ACTIVATION_STATUS.IN_PROGRESS,
              planStripeSubscriptionId: { not: null },
              OR: [{ planActivationLeaseUntil: null }, { planActivationLeaseUntil: { lt: new Date(ahora) } }],
              updatedAt: { lt: new Date(ahora - QUIETA_MS) },
            },
            select: { id: true, organizationId: true },
            orderBy: { id: 'asc' },
            take: LOTE,
            ...(this.cursor ? { cursor: { id: this.cursor }, skip: 1 } : {}),
          }),
        { retries: 2, initialDelay: 1500, shouldRetry: shouldRetryDbConnectionError, context: 'altas-a-medio-pago.findMany' },
      )
      this.cursor = altas.length > 0 ? altas[altas.length - 1].id : null

      for (const { organizationId } of altas) {
        resultado.revisadas += 1
        try {
          const r = await this.resolver(organizationId)
          if (r === 'CERRADA') resultado.cerradas += 1
          if (r === 'LIBERADA') resultado.liberadas += 1
        } catch (error) {
          // Una que falla no detiene a las demás; la siguiente corrida la vuelve a mirar.
          resultado.fallidas += 1
          logger.warn('Altas a medio pago: no se pudo resolver un alta', {
            organizationId,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
      if (resultado.cerradas || resultado.liberadas || resultado.fallidas) logger.info('Altas a medio pago: corrida', resultado)
      return resultado
    } finally {
      this.corriendo = false
    }
  }
}

export const altasAMedioPagoJob = new AltasAMedioPagoJob()
