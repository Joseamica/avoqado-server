import { randomUUID } from 'node:crypto'
import type { CronJob } from 'cron'
import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import { retry, shouldRetryDbConnectionError } from '@/utils/retry'
import { commercialOutboxService } from '@/services/commercial/commercialOutbox.service'
import { DATABASE_JOB_SCHEDULES } from './jobSchedules'
import { scheduleJob } from '@/observability/jobContext'

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
  sweepOnce: input => commercialOutboxService.sweepOnce(input),
  workerId: `commercial-publication-outbox:${process.pid}:${randomUUID()}`,
  entryRead: async () => {
    const readyAt = new Date()
    const row = await prisma.commercialPublicationOutbox.findFirst({
      where: {
        OR: [
          { status: 'PENDING', nextAttemptAt: { lte: readyAt } },
          { status: 'CLAIMED', claimExpiresAt: { lte: readyAt } },
        ],
      },
      select: { id: true },
    })
    return row !== null
  },
  retryEntry: retry,
}

export class CommercialPublicationOutboxSweeperJob {
  private readonly dependencies: SweeperDependencies
  private readonly cron: CronHandle
  private running = false

  constructor(overrides: Partial<SweeperDependencies> = {}) {
    this.dependencies = { ...defaults, ...overrides }
    this.cron =
      overrides.cron ??
      scheduleJob(
        'commercial-publication-outbox-sweeper',
        DATABASE_JOB_SCHEDULES.commercialPublicationOutboxSweeper,
        () => {
          void this.runNow().catch(error => logger.error('Commercial publication outbox sweep failed', { error }))
        },
        null,
        false,
        'America/Mexico_City',
      )
  }

  start(): void {
    this.cron.start()
    logger.info('Commercial publication outbox sweeper started')
  }

  stop(): void {
    this.cron.stop()
    logger.info('Commercial publication outbox sweeper stopped')
  }

  async runNow(): Promise<SweepResult | (SweepResult & { skipped: true })> {
    if (this.running) return { claimed: 0, delivered: 0, failed: 0, skipped: true }
    this.running = true
    try {
      // Only this side-effect-free readiness read is retried. Claims and
      // delivery are never automatically replayed by the scheduler wrapper.
      const ready = await this.dependencies.retryEntry(() => this.dependencies.entryRead(), {
        retries: 2,
        initialDelay: 1500,
        shouldRetry: shouldRetryDbConnectionError,
        context: 'commercial-publication-outbox-sweeper.findReady',
      })
      if (!ready) return { claimed: 0, delivered: 0, failed: 0 }
      return this.dependencies.sweepOnce({ workerId: this.dependencies.workerId, limit: 100 })
    } finally {
      this.running = false
    }
  }
}

export const commercialPublicationOutboxSweeperJob = new CommercialPublicationOutboxSweeperJob()
