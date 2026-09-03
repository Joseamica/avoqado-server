import type { CronJob } from 'cron'
import logger from '../config/logger'
import { scheduleJob } from '../observability/jobContext'
import { logAction } from '../services/dashboard/activity-log.service'
import { findPaidButOpenOrders, type CandidataPagadaAbierta } from '../services/shared/pagadaPeroAbierta'
import { reconcileOrderFromPayments } from '../services/tpv/payment.tpv.service'
import prisma from '../utils/prismaClient'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'
import { DATABASE_JOB_SCHEDULES } from './jobSchedules'

/**
 * Fase 0 del turno de caja del negocio: NINGUNA orden cobrada se queda «abierta».
 *
 * Caso semilla ORD-1788276418170 (Testarudo, 1-sep-2026): el `Payment` quedó COMPLETED y la
 * transición a PAID nunca aterrizó; el Cierre del día la lista como pendiente para siempre y
 * esa pantalla es de sólo lectura, así que el negocio no tiene con qué cerrarla. No es un caso
 * único: hay más órdenes así en producción.
 *
 * Sin tabla nueva: el `Payment` ya es la verdad. Reparar = reejecutar la MISMA transacción
 * del cobro (`reconcileOrderFromPayments`). Barrer dos veces no duplica: la segunda pasada no
 * encuentra candidatas.
 *
 * 🔴 Lo que este barrido NO hace, y aquí decía lo contrario hasta el 3-sep-2026: **no restaura
 * el invariante «orden PAID ⟺ vale de inventario»**. No puede — sin cobro nuevo,
 * `debeRegistrarPosting` queda en false y no nace vale (lo detalla el párrafo de abajo, que
 * siempre lo dijo bien: esta frase lo contradecía). Consecuencia real, y es el caso semilla:
 * ORD-1788276418170 nunca tuvo vale porque la segunda transacción de su cobro murió —por eso
 * quedó abierta—, así que cerrarla fue lo correcto y a la vez **borró la única señal** de que
 * la deducción se había perdido. Esa señal la recupera la 7ª invariante del vigilante de
 * dinero, «ORDEN SIN VALE DE INVENTARIO» (`money-integrity-watchdog.job.ts`), que OBSERVA sin
 * reparar: crear el vale días después reabriría la doble deducción que `settledBeforeThisPayment`
 * existe para evitar, y `inventory-posting-sweeper` sólo reclama vales que YA existen.
 *
 * 🔴 Nunca fuerza `status = COMPLETED` a mano: si esa transacción no puede cerrar la orden,
 * queda como estaba y el motivo va al log. Eso lo cazará el vigilante.
 *
 * Y reejecutar el cobro NO es inocuo — el docstring de `reconcileOrderFromPayments` lo detalla,
 * esto es lo que hay que saber al leer los logs de una pasada: se reestampa `completedAt` con la
 * hora del barrido, `tipAmount`/`total` se reescriben desde los cobros, la mesa se libera si la
 * orden quedó saldada, y una candidata con SOBREPAGO emite su `🚨 [Sobrepago]` y su fila
 * `SOBREPAGO_DETECTADO`. Nada de eso se suprime. Lo que NO ocurre —y por eso el asiento dice
 * `effects: 'ORDER_STATUS_ONLY'`— es el vale de inventario y la lealtad: el camino del cobro ya
 * los daba por hechos cuando la orden tiene al menos un `Payment`, que es justo lo que el
 * criterio exige.
 *
 * 🔴 Y cierra SIEMPRE por ese camino, nunca por `computeOrderBalance`: el criterio y el cierre
 * tienen que compartir aritmética, o una orden quedaría elegida por uno y rechazada por el otro
 * en cada pasada, para siempre. Hoy la base del criterio vive en `shared/pagadaPeroAbierta.ts`
 * (`baseQueDebeCubrirseSql`) y es `max(0, subtotal − descuento) + cargo por servicio`, con los
 * reembolsos fuera; la propina se cancela a los dos lados, que es lo que la reduce a esa forma.
 *
 * 🔴 Ese `+ cargo por servicio` NO sobra — hasta el 3-sep-2026 este comentario describía la
 * aritmética ANTERIOR (sin el cargo) y advertía de un peligro que el arreglo del 2-sep ya había
 * eliminado, así que invitaba justo a la regresión que costó dinero: omitiendo el cargo, una
 * cuenta de $100 + $10 con $100 cobrados salía elegida como pagada, el barrido la cerraba, le
 * reescribía el total hacia abajo y liberaba la mesa — $10 perdidos en silencio (auditoría Codex
 * 2-sep-2026). No lo «simplifiques» de vuelta.
 */

/** No pisar el cobro en vivo: una orden recién tocada todavía puede estar cerrándose sola. */
const GRACE_MS = 5 * 60 * 1000
/**
 * Ventana hacia atrás del tic. El criterio no tiene índice que sirva (`status NOT IN (...)`,
 * `updatedAt <`), así que sin este tope cada pasada recorrería la historia entera de órdenes
 * no terminales. El rezago más viejo lo alcanza el script a mano pasando su propio `since`.
 */
const LOOKBACK_DAYS = 30
const BATCH_LIMIT = 50

type CronHandle = Pick<CronJob, 'start' | 'stop'>

export interface ReconcileResult {
  scanned: number
  reconciled: number
  failed: number
  skipped: number
  dryRun: boolean
  candidates: CandidataPagadaAbierta[]
}

interface Dependencies {
  cron?: CronHandle
  now: () => Date
  retryEntry: typeof retry
  findCandidates: (opts: { graceMs: number; limit: number; now: Date; since: Date }) => Promise<CandidataPagadaAbierta[]>
  reconcile: (orderId: string) => Promise<{ orderId: string; warning: unknown }>
}

export const defaults: Dependencies = {
  now: () => new Date(),
  retryEntry: retry,
  findCandidates: opts => findPaidButOpenOrders(prisma, opts),
  reconcile: reconcileOrderFromPayments,
}

export class PaidOrderReconcilerJob {
  private readonly d: Dependencies
  private readonly cron: CronHandle
  private running = false

  constructor(overrides: Partial<Dependencies> = {}) {
    this.d = { ...defaults, ...overrides }
    this.cron =
      overrides.cron ??
      scheduleJob(
        'paid-order-reconciler',
        DATABASE_JOB_SCHEDULES.paidOrderReconciler,
        () => {
          void this.runNow().catch(error => logger.error('Paid-order reconcile failed', { error }))
        },
        null,
        false,
        'America/Mexico_City',
      )
  }

  start(): void {
    this.cron.start()
    logger.info('Paid-order reconciler started')
  }

  stop(): void {
    this.cron.stop()
    logger.info('Paid-order reconciler stopped')
  }

  /**
   * `dryRun` lista sin tocar nada — es lo que hace seguro correrlo a mano contra producción
   * antes de aplicarlo. `since` abre la ventana más allá de los 30 días del tic, y sólo lo
   * usa ese barrido manual.
   */
  async runNow(opts: { dryRun?: boolean; since?: Date } = {}): Promise<ReconcileResult> {
    const dryRun = opts.dryRun === true
    const empty: ReconcileResult = { scanned: 0, reconciled: 0, failed: 0, skipped: 0, dryRun, candidates: [] }
    if (this.running) return { ...empty, skipped: 1 }
    this.running = true
    try {
      const now = this.d.now()
      const since = opts.since ?? new Date(now.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000)
      // La lectura de entrada va con retry: es la que muere en la estampida de crons (regla del repo).
      const candidates = await this.d.retryEntry(() => this.d.findCandidates({ graceMs: GRACE_MS, limit: BATCH_LIMIT, now, since }), {
        retries: 2,
        initialDelay: 1500,
        shouldRetry: shouldRetryDbConnectionError,
        context: 'paid-order-reconciler.find',
      })
      const result: ReconcileResult = { ...empty, scanned: candidates.length, candidates }
      if (dryRun) return result
      for (const c of candidates) {
        try {
          await this.d.reconcile(c.id)
          result.reconciled += 1
          // `logAction` nunca lanza (su contrato), así que esperarla no puede convertir una
          // orden ya cerrada en un `failed`; y esperarla deja el asiento escrito antes de que
          // el tic termine.
          await logAction({
            staffId: null,
            venueId: c.venueId,
            action: 'ORDER_RECONCILED_PAID',
            entity: 'Order',
            entityId: c.id,
            data: {
              orderNumber: c.orderNumber,
              before: { status: c.status, paymentStatus: c.paymentStatus },
              base: c.base,
              pagado: c.pagado,
              paymentIds: c.paymentIds,
              sweep: 'paid-order-reconciler',
              effects: 'ORDER_STATUS_ONLY',
            },
          })
        } catch (error) {
          result.failed += 1
          logger.warn('🧾 [paid-order-reconciler] no se pudo cerrar la orden; se conserva como está', {
            orderId: c.id,
            venueId: c.venueId,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
      if (result.scanned > 0) logger.info('🧾 [paid-order-reconciler] barrido', { ...result, candidates: undefined })
      return result
    } finally {
      this.running = false
    }
  }
}

export const paidOrderReconcilerJob = new PaidOrderReconcilerJob()
