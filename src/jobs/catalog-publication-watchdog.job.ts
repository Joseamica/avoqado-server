import { Prisma } from '@prisma/client'
import { CronJob } from 'cron'
import logger from '../config/logger'
import { acquireCatalogPublicationAttemptLockTx } from '../services/master-catalog/catalogPublicationConfirmation.service'
import prisma from '../utils/prismaClient'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'
import { DATABASE_JOB_SCHEDULES } from './jobSchedules'

const MAX_BATCHES = 100
const FAILURE_CODE = 'CATALOG_PUBLICATION_ATTEMPT_EXPIRED'
type CronHandle = Pick<CronJob, 'start' | 'stop'>

interface ExpiredAttempt {
  id: string
  organizationId: string
  operation: string
  attemptId: string | null
  leaseExpiresAt: Date | null
}

interface WatchdogDependencies {
  prisma: typeof prisma
  cron?: CronHandle
  now: () => Date
  acquireAttemptLockTx: typeof acquireCatalogPublicationAttemptLockTx
  retryEntry: typeof retry
}

const defaults: WatchdogDependencies = {
  prisma,
  now: () => new Date(),
  acquireAttemptLockTx: acquireCatalogPublicationAttemptLockTx,
  retryEntry: retry,
}

export class CatalogPublicationWatchdogJob {
  private readonly dependencies: WatchdogDependencies
  private readonly cron: CronHandle
  private running = false

  constructor(overrides: Partial<WatchdogDependencies> = {}) {
    this.dependencies = { ...defaults, ...overrides }
    this.cron =
      overrides.cron ??
      new CronJob(
        DATABASE_JOB_SCHEDULES.catalogPublicationWatchdog,
        () => {
          void this.runNow().catch(error => logger.error('Catalog publication watchdog failed', { error }))
        },
        null,
        false,
        'America/Mexico_City',
      )
  }

  start(): void {
    this.cron.start()
    logger.info('Catalog publication watchdog started')
  }

  stop(): void {
    this.cron.stop()
    logger.info('Catalog publication watchdog stopped')
  }

  async runNow(): Promise<{ scanned: number; failed: number; skipped: number; errors: number }> {
    if (this.running) return { scanned: 0, failed: 0, skipped: 1, errors: 0 }
    this.running = true
    try {
      const now = this.dependencies.now()
      const candidates = (await this.dependencies.retryEntry(
        () =>
          this.dependencies.prisma.catalogPublicationBatch.findMany({
            where: { state: 'APPLYING', leaseExpiresAt: { lte: now }, attemptId: { not: null } },
            select: { id: true, organizationId: true, operation: true, attemptId: true, leaseExpiresAt: true },
            orderBy: [{ leaseExpiresAt: 'asc' }, { id: 'asc' }],
            take: MAX_BATCHES,
          }),
        {
          retries: 2,
          initialDelay: 1500,
          shouldRetry: shouldRetryDbConnectionError,
          context: 'catalog-publication-watchdog.findExpired',
        },
      )) as ExpiredAttempt[]
      let failed = 0
      let skipped = 0
      let errors = 0
      for (const candidate of candidates) {
        try {
          const changed = await this.failExpired(candidate, now)
          if (changed) failed += 1
          else skipped += 1
        } catch (error) {
          errors += 1
          logger.error('Catalog publication watchdog candidate failed', { batchId: candidate.id, error })
        }
      }
      return { scanned: candidates.length, failed, skipped, errors }
    } finally {
      this.running = false
    }
  }

  private async failExpired(candidate: ExpiredAttempt, now: Date): Promise<boolean> {
    if (!candidate.attemptId || !candidate.leaseExpiresAt) return false
    const leaseExpiresAt = candidate.leaseExpiresAt
    return this.dependencies.prisma.$transaction(
      async tx => {
        // WHY: Confirmation and watchdog acquire the exact attempt lock first;
        // after waiting, this reread makes APPLIED immutable and only the exact
        // expired lease tuple eligible for FAILED.
        await this.dependencies.acquireAttemptLockTx(tx, candidate.organizationId, candidate.id)
        const live = await tx.catalogPublicationBatch.findFirst({
          where: {
            id: candidate.id,
            organizationId: candidate.organizationId,
            state: 'APPLYING',
            attemptId: candidate.attemptId,
            leaseExpiresAt,
          },
          select: { id: true },
        })
        if (!live || leaseExpiresAt.getTime() > now.getTime()) return false
        const terminal = {
          state: 'FAILED' as const,
          attemptId: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          failureCode: FAILURE_CODE,
          failureMessage: 'El intento de publicación expiró.',
          completedAt: now,
        }
        const batch = await tx.catalogPublicationBatch.updateMany({
          where: {
            id: candidate.id,
            organizationId: candidate.organizationId,
            state: 'APPLYING',
            attemptId: candidate.attemptId,
            leaseExpiresAt: candidate.leaseExpiresAt,
          },
          data: terminal,
        })
        const record = await tx.catalogIdempotencyRecord.updateMany({
          where: {
            organizationId: candidate.organizationId,
            operation: candidate.operation,
            resourceType: 'CatalogPublicationBatch',
            resourceId: candidate.id,
            state: 'APPLYING',
            attemptId: candidate.attemptId,
            leaseExpiresAt: candidate.leaseExpiresAt,
          },
          data: terminal,
        })
        if (batch.count !== 1 || record.count !== 1) throw new Error('CATALOG_PUBLICATION_WATCHDOG_DUAL_CAS_INVALID')
        return true
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 90_000 },
    )
  }
}

export const catalogPublicationWatchdogJob = new CatalogPublicationWatchdogJob()
