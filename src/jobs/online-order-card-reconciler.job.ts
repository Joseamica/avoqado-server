import type { CronJob } from 'cron'
import logger from '../config/logger'
import { scheduleJob } from '../observability/jobContext'
import { reconcileCardCharges, type ReconcileResult } from '../services/online-ordering/card/reconcile.service'
import type { ReadCandidates } from '../services/online-ordering/types'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'
import { DATABASE_JOB_SCHEDULES } from './jobSchedules'

type CronHandle = Pick<CronJob, 'start' | 'stop'>

interface OnlineOrderCardReconcilerDependencies {
  cron?: CronHandle
  now: () => Date
  reconcile: (now: Date, readEntry: ReadCandidates) => Promise<ReconcileResult>
  retryEntry: typeof retry
}

const EMPTY: ReconcileResult = { scanned: 0, finished: 0, released: 0, abandoned: 0, stuck: 0, errors: 0 }

const defaults: OnlineOrderCardReconcilerDependencies = {
  now: () => new Date(),
  reconcile: reconcileCardCharges,
  retryEntry: retry,
}

/** Fase 2 (pedidos con tarjeta): cada minuto termina los cobros, liberaciones y borradores que quedaron en duda. */
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

  async checkNow(): Promise<ReconcileResult & { skipped?: true }> {
    if (this.isRunning) {
      logger.warn('[Online-order card reconciler] tick skipped — previous run still in progress')
      return { ...EMPTY, skipped: true }
    }
    this.isRunning = true
    try {
      return await this.dependencies.reconcile(this.dependencies.now(), this.readEntry)
    } catch (error) {
      logger.error('Online-order card reconciler pass failed', { error })
      return { ...EMPTY, errors: 1 }
    } finally {
      this.isRunning = false
    }
  }
}

export const onlineOrderCardReconcilerJob = new OnlineOrderCardReconcilerJob()
