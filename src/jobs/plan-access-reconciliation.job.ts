import type { CronJob } from 'cron'
import type Stripe from 'stripe'
import logger from '../config/logger'
import { scheduleJob } from '../observability/jobContext'
import { logAction } from '../services/dashboard/activity-log.service'
import { PAID_PLAN_TIER_CODES } from '../services/access/basePlan.service'
import { handleSubscriptionUpdated } from '../services/stripe.webhook.service'
import { stripe } from '../services/stripe.service'
import prisma from '../utils/prismaClient'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'
import { DATABASE_JOB_SCHEDULES } from './jobSchedules'

/**
 * Reconciliador del acceso al plan — «pagó y se quedó sin plan» deja de ser posible.
 *
 * 🔴 EL HUECO QUE CIERRA (Codex gpt-6-astra xhigh, 19-sep). `fulfillPlanCheckout` guarda el
 * vínculo a la suscripción SIN conceder acceso cuando ésta todavía no está vigente, y confía en
 * que `invoice.payment_succeeded` o `customer.subscription.updated` concedan cuando el cobro
 * prospere. Pero esos dos avisos buscan el registro POR EL VÍNCULO, y pueden llegar ANTES de que
 * el vínculo exista: terminan sin encontrar nada, se marcan SUCCESS, y el cron de webhooks sólo
 * recoge FAILED/RETRYING. Nadie vuelve a mirar. El negocio pagó y no tiene su plan.
 *
 * 🔑 Y por qué es un BARRIDO y no otro parche dentro de los manejadores: el defecto es que el
 * acceso dependía del ORDEN en que Stripe entrega los avisos, y ese orden no lo controlamos. Este
 * job no depende del orden — pregunta por el estado REAL de la suscripción, que es la autoridad.
 * Es el mismo patrón con el que el repo ya cerró huecos equivalentes (`cash-drawer-reconciler`,
 * `paid-order-reconciler`): los eventos son el camino rápido, el barrido es la garantía.
 *
 * Lo que NO hace, a propósito:
 * - **No levanta una suspensión** (`suspendedAt`): ésa es una decisión deliberada de cobranza y la
 *   levanta el pago, no un barrido.
 * - **No concede por su cuenta.** Delega en `handleSubscriptionUpdated`, que revalida el estado
 *   vigente y aplica las mismas reglas endurecidas en las auditorías 7ª-10ª. Duplicar aquí la
 *   lógica de dinero sería crear una segunda verdad.
 */

/** Tope por corrida: acota el trabajo y, sobre todo, las llamadas a Stripe. */
const LOTE = 25

type CronHandle = Pick<CronJob, 'start' | 'stop'>

export interface ResultadoReconciliacion {
  revisados: number
  recuperados: number
  fallidos: number
}

interface Dependencias {
  cron?: CronHandle
  /** Inyectable para poder probar el barrido sin arrastrar el manejador completo. `true` = quedó concedido. */
  conceder?: (subscription: Stripe.Subscription) => Promise<boolean>
}

export class PlanAccessReconciliationJob {
  private readonly cron: CronHandle
  private readonly conceder: (subscription: Stripe.Subscription) => Promise<boolean>
  private corriendo = false
  /**
   * 🔴 Cursor ROTATIVO. `VenueFeature` no tiene columna de fecha con la que acotar, así que sin
   * rotación cada corrida miraría siempre las mismas 25 filas: un conjunto grande de planes
   * cancelados —que son legítimos y nunca salen de la consulta— taparía para siempre a quien sí
   * pagó. Rotando, el barrido recorre el conjunto entero y vuelve a empezar.
   */
  private cursor: string | null = null

  constructor(deps: Dependencias = {}) {
    this.conceder = deps.conceder ?? (subscription => handleSubscriptionUpdated(subscription))
    this.cron =
      deps.cron ??
      scheduleJob(
        'plan-access-reconciliation',
        DATABASE_JOB_SCHEDULES.planAccessReconciliation,
        () => {
          void this.runNow().catch(error => logger.error('Plan access reconciliation failed', { error }))
        },
        null,
        false,
        'America/Mexico_City',
      )
  }

  start(): void {
    this.cron.start()
    logger.info('Plan access reconciliation started')
  }

  stop(): void {
    this.cron.stop()
    logger.info('Plan access reconciliation stopped')
  }

  async runNow(): Promise<ResultadoReconciliacion> {
    if (this.corriendo) return { revisados: 0, recuperados: 0, fallidos: 0 }
    this.corriendo = true
    try {
      // Lectura de entrada envuelta por `.claude/rules/cron-jobs.md`: es una lectura pura, segura
      // de repetir durante la estampida de conexiones del minuto en punto.
      const candidatos = await retry(
        () =>
          prisma.venueFeature.findMany({
            where: {
              active: false,
              suspendedAt: null,
              stripeSubscriptionId: { not: null },
              feature: { code: { in: [...PAID_PLAN_TIER_CODES] } },
            },
            select: { id: true, venueId: true, stripeSubscriptionId: true, feature: { select: { code: true } } },
            orderBy: { id: 'asc' },
            take: LOTE,
            ...(this.cursor ? { cursor: { id: this.cursor }, skip: 1 } : {}),
          }),
        { retries: 2, initialDelay: 1500, shouldRetry: shouldRetryDbConnectionError, context: 'plan-access-reconciliation.findMany' },
      )

      // Fin de la lista: la próxima corrida vuelve a empezar.
      this.cursor = candidatos.length > 0 ? candidatos[candidatos.length - 1].id : null

      let recuperados = 0
      let fallidos = 0

      for (const candidato of candidatos) {
        try {
          const subscription = await stripe.subscriptions.retrieve(candidato.stripeSubscriptionId as string)
          if (subscription.status !== 'active' && subscription.status !== 'trialing') continue

          // 🔴 V5-A paso 6: el manejador puede NO conceder —la suscripción ya vende otro plan y la entrega decidió
          // retirar esta fila, o quedó en conflicto—. Sólo una concesión real es una recuperación: contarla y
          // auditarla sin serlo dejaba un rastro falso cada 10 minutos.
          if (!(await this.conceder(subscription))) continue
          recuperados += 1

          // 🚨 Llegar aquí significa que el negocio estaba pagando y el producto le negaba el acceso.
          logger.warn('🚨 Reconciliación: plan PAGADO sin acceso — se concedió', {
            venueId: candidato.venueId,
            featureCode: candidato.feature.code,
            subscriptionId: candidato.stripeSubscriptionId,
            status: subscription.status,
          })

          void logAction({
            action: 'PLAN_ACCESS_RECONCILED',
            entity: 'VenueFeature',
            entityId: candidato.id,
            venueId: candidato.venueId,
            data: {
              featureCode: candidato.feature.code,
              subscriptionId: candidato.stripeSubscriptionId,
              status: subscription.status,
            },
          })
        } catch (error) {
          // Una fila que falla no puede detener el barrido de las demás: la siguiente corrida
          // vuelve a intentarlo.
          fallidos += 1
          logger.error('Plan access reconciliation: fila fallida', {
            venueFeatureId: candidato.id,
            venueId: candidato.venueId,
            subscriptionId: candidato.stripeSubscriptionId,
            error,
          })
        }
      }

      if (recuperados > 0 || fallidos > 0) {
        logger.info('Plan access reconciliation done', { revisados: candidatos.length, recuperados, fallidos })
      }
      return { revisados: candidatos.length, recuperados, fallidos }
    } finally {
      this.corriendo = false
    }
  }
}

export const planAccessReconciliationJob = new PlanAccessReconciliationJob()
