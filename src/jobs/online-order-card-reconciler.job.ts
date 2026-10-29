import type { CronJob } from 'cron'
import logger from '../config/logger'
import { scheduleJob } from '../observability/jobContext'
import { reconcileCardCharges, type ReconcileResult } from '../services/online-ordering/card/reconcile.service'
import { sweepCardRefunds, type CardRefundSweepResult } from '../services/online-ordering/card/refund-reconciler.service'
import type { ReadCandidates } from '../services/online-ordering/types'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'
import { DATABASE_JOB_SCHEDULES } from './jobSchedules'

type CronHandle = Pick<CronJob, 'start' | 'stop'>

interface OnlineOrderCardReconcilerDependencies {
  cron?: CronHandle
  now: () => Date
  reconcile: (now: Date, readEntry: ReadCandidates) => Promise<ReconcileResult>
  /** T10: el recorrido de devoluciones a la tarjeta, en la misma pasada (después de los cargos). */
  sweepRefunds: (now: Date, readEntry: ReadCandidates) => Promise<CardRefundSweepResult>
  retryEntry: typeof retry
}

type PassResult = ReconcileResult & { refunds?: CardRefundSweepResult; skipped?: true }

const EMPTY: ReconcileResult = { scanned: 0, finished: 0, released: 0, abandoned: 0, stuck: 0, errors: 0 }

const defaults: OnlineOrderCardReconcilerDependencies = {
  now: () => new Date(),
  reconcile: reconcileCardCharges,
  sweepRefunds: sweepCardRefunds,
  retryEntry: retry,
}

/** Fase 2 (pedidos con tarjeta): cada minuto termina los cobros, liberaciones, borradores y devoluciones que quedaron en duda. */
export class OnlineOrderCardReconcilerJob {
  private readonly dependencies: OnlineOrderCardReconcilerDependencies
  private readonly job: CronHandle
  private isRunning = false

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
    if (this.isRunning) {
      logger.warn('[Online-order card reconciler] tick skipped — previous run still in progress')
      return { ...EMPTY, skipped: true }
    }
    this.isRunning = true
    try {
      const now = this.dependencies.now()
      let result: PassResult
      try {
        result = { ...(await this.dependencies.reconcile(now, this.readEntry)) }
      } catch (error) {
        logger.error('Online-order card reconciler pass failed', { error })
        result = { ...EMPTY, errors: 1 }
      }
      // Cada recorrido en su propio try: unos cargos que truenan no frenan las devoluciones, ni al revés.
      try {
        result.refunds = await this.dependencies.sweepRefunds(now, this.readEntry)
      } catch (error) {
        logger.error('Online-order card refund sweep failed', { error })
        result.refunds = { scanned: 0, advanced: 0, alerted: 0, errors: 1 }
      }
      return result
    } finally {
      this.isRunning = false
    }
  }
}

export const onlineOrderCardReconcilerJob = new OnlineOrderCardReconcilerJob()
