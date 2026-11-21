import type { CronJob } from 'cron'
import logger from '../config/logger'
import { scheduleJob } from '../observability/jobContext'
import { reconcileCardCharges, visitEarlyNadieDrafts, type ReconcileResult } from '../services/online-ordering/card/reconcile.service'
import { sweepCardRefunds, type CardRefundSweepResult } from '../services/online-ordering/card/refund-reconciler.service'
import type { ReadCandidates } from '../services/online-ordering/types'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'
import { DATABASE_JOB_SCHEDULES } from './jobSchedules'

type CronHandle = Pick<CronJob, 'start' | 'stop'>

interface OnlineOrderCardReconcilerDependencies {
  cron?: CronHandle
  now: () => Date
  reconcile: (now: Date, readEntry: ReadCandidates) => Promise<ReconcileResult>
  /** D661 (A2): la visita temprana de «Nadie» sola, para el minuto en que la pasada anterior todavía corre. */
  visitEarly: (now: Date, readEntry: ReadCandidates) => Promise<ReconcileResult>
  /** T10: el recorrido de devoluciones a la tarjeta, después de los cargos y (D661, Ruling 99) con su PROPIA bandera. */
  sweepRefunds: (now: Date, readEntry: ReadCandidates) => Promise<CardRefundSweepResult>
  retryEntry: typeof retry
}

type PassResult = ReconcileResult & { refunds?: CardRefundSweepResult; skipped?: true }

const EMPTY: ReconcileResult = { scanned: 0, finished: 0, released: 0, abandoned: 0, stuck: 0, errors: 0 }

const defaults: OnlineOrderCardReconcilerDependencies = {
  now: () => new Date(),
  reconcile: reconcileCardCharges,
  visitEarly: visitEarlyNadieDrafts,
  sweepRefunds: sweepCardRefunds,
  retryEntry: retry,
}

/** Fase 2 (pedidos con tarjeta): cada minuto termina los cobros, liberaciones, borradores y devoluciones que quedaron en duda. */
export class OnlineOrderCardReconcilerJob {
  private readonly dependencies: OnlineOrderCardReconcilerDependencies
  private readonly job: CronHandle
  private isRunning = false
  /**
   * D661 (Ruling 99): el recorrido de devoluciones con SU bandera, aparte de la pasada y de la visita temprana: uno colgado (sólo la API de
   * devoluciones de Stripe se atora, ≤ 120 s por llamada) se retiene a sí mismo y nunca retrasa la pasada del siguiente tick, que puede
   * tener que cobrar un apartado de «Nadie» dentro de su ventana de reintento (a veces de ~2.5 min).
   */
  private isSweeping = false

  constructor(overrides: Partial<OnlineOrderCardReconcilerDependencies> = {}) {
    this.dependencies = { ...defaults, ...overrides }
    this.job =
      overrides.cron ??
      scheduleJob(
        'online-order-card-reconciler',
        DATABASE_JOB_SCHEDULES.onlineOrderCardReconciler,
        async () => {
          await this.checkNow()
        },
        null,
        false,
        'America/Mexico_City',
      )
  }

  start(): void {
    this.job.start()
    logger.info('Online-order card reconciler job started')
  }

  stop(): void {
    this.job.stop()
    logger.info('Online-order card reconciler job stopped')
  }

  /** Lectura de entrada con reintento por conexión (regla cron-jobs.md). Los CAS, Stripe y los avisos quedan FUERA. */
  private readonly readEntry: ReadCandidates = read =>
    this.dependencies.retryEntry(read, {
      retries: 2,
      initialDelay: 1500,
      shouldRetry: shouldRetryDbConnectionError,
      context: 'online-order-card-reconciler.findDue',
    })

  async checkNow(): Promise<PassResult> {
    const result = await this.pasada()
    // Cada recorrido en su propio try: unos cargos que truenan no frenan las devoluciones, ni al revés. D661 (Ruling 99): el recorrido
    // corre con su bandera y con la hora de ahora (la pasada pudo tardar); si el anterior sigue, éste se salta sin esperarlo.
    if (this.isSweeping) {
      logger.warn('[Online-order card reconciler] refund sweep skipped — previous sweep still in progress')
      return result
    }
    this.isSweeping = true
    try {
      result.refunds = await this.dependencies.sweepRefunds(this.dependencies.now(), this.readEntry)
    } catch (error) {
      logger.error('Online-order card refund sweep failed', { error })
      result.refunds = { scanned: 0, advanced: 0, alerted: 0, errors: 1, closed: 0 }
    } finally {
      this.isSweeping = false
    }
    return result
  }

  /** La pasada de los cargos; si la anterior sigue, sólo la visita temprana. Suelta su bandera al terminar, antes del recorrido. */
  private async pasada(): Promise<PassResult> {
    if (this.isRunning) {
      logger.warn('[Online-order card reconciler] tick skipped — previous run still in progress')
      // D661 (A2): una pasada lenta no deja sin visitar los borradores de «Nadie» (su plazo es de 10 min): sólo esa visita, con su
      // propio presupuesto (el servicio nunca corre dos a la vez).
      try {
        return { ...(await this.dependencies.visitEarly(this.dependencies.now(), this.readEntry)), skipped: true }
      } catch (error) {
        logger.error('Online-order card early visit failed', { error })
        return { ...EMPTY, errors: 1, skipped: true }
      }
    }
    this.isRunning = true
    try {
      return { ...(await this.dependencies.reconcile(this.dependencies.now(), this.readEntry)) }
    } catch (error) {
      logger.error('Online-order card reconciler pass failed', { error })
      return { ...EMPTY, errors: 1 }
    } finally {
      this.isRunning = false
    }
  }
}

export const onlineOrderCardReconcilerJob = new OnlineOrderCardReconcilerJob()
