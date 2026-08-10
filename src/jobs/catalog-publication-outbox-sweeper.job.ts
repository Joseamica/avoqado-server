import { randomUUID } from 'node:crypto'
import { CronJob } from 'cron'
import logger from '../config/logger'
import { catalogPublicationOutboxService } from '../services/master-catalog/catalogPublicationOutbox.service'
import prisma from '../utils/prismaClient'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'
import { DATABASE_JOB_SCHEDULES } from './jobSchedules'

type SweepResult = { claimed: number; delivered: number; failed: number }
type CronHandle = Pick<CronJob, 'start' | 'stop'>

interface SweeperDependencies {
  cron?: CronHandle
  sweepOnce: (input: { workerId: string; limit: number }) => Promise<SweepResult>
  workerId: string
  entryRead: () => Promise<boolean>
  retryEntry: typeof retry
}

const defaults: SweeperDependencies = {
  sweepOnce: input => catalogPublicationOutboxService.sweepOnce(input),
  workerId: `catalog-publication-outbox:${process.pid}:${randomUUID()}`,
  entryRead: async () => {
    const readyAt = new Date()
    const row = await prisma.catalogPublicationOutbox.findFirst({
      where: {
        status: 'PENDING',
        nextAttemptAt: { lte: readyAt },
        OR: [{ claimExpiresAt: null }, { claimExpiresAt: { lte: readyAt } }],
      },
      select: { id: true },
    })
    return row !== null
  },
  retryEntry: retry,
}

export class CatalogPublicationOutboxSweeperJob {
  private readonly dependencies: SweeperDependencies
  private readonly cron: CronHandle
  private running = false

  constructor(overrides: Partial<SweeperDependencies> = {}) {
    this.dependencies = { ...defaults, ...overrides }
    this.cron =
      overrides.cron ??
      new CronJob(
        DATABASE_JOB_SCHEDULES.catalogPublicationOutboxSweeper,
        () => {
          void this.runNow().catch(error => logger.error('Catalog publication outbox sweep failed', { error }))
        },
        null,
        false,
        'America/Mexico_City',
      )
  }

  start(): void {
    this.cron.start()
    logger.info('Catalog publication outbox sweeper started')
  }

  stop(): void {
    this.cron.stop()
    logger.info('Catalog publication outbox sweeper stopped')
  }

  async runNow(): Promise<SweepResult | (SweepResult & { skipped: true })> {
    // WHY: A single process never stacks claims; cross-process exclusion is
    // still provided by the durable outbox lease/CAS.
    if (this.running) return { claimed: 0, delivered: 0, failed: 0, skipped: true }
    this.running = true
    try {
      // WHY: The retry encloses only a pure readiness read. Delivery, claims,
      // external socket broadcasts and transactions are never replayed.
      const ready = await this.dependencies.retryEntry(() => this.dependencies.entryRead(), {
        retries: 2,
        initialDelay: 1500,
        shouldRetry: shouldRetryDbConnectionError,
        context: 'catalog-publication-outbox-sweeper.findReady',
      })
      if (!ready) return { claimed: 0, delivered: 0, failed: 0 }
      return await this.dependencies.sweepOnce({ workerId: this.dependencies.workerId, limit: 100 })
    } finally {
      this.running = false
    }
  }
}

export const catalogPublicationOutboxSweeperJob = new CatalogPublicationOutboxSweeperJob()
