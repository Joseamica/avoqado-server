import type { CronJob } from 'cron'
import logger from '../config/logger'
import { scheduleJob } from '../observability/jobContext'
import { expireDisplayModeRequest } from '../services/display-mode-request.service'
import prisma from '../utils/prismaClient'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'
import { DATABASE_JOB_SCHEDULES } from './jobSchedules'

const MAX_CANDIDATES_PER_TICK = 100

type CronHandle = Pick<CronJob, 'start' | 'stop'>

interface DisplayModeExpiryCandidate {
  id: string
  venueId: string
}

interface DisplayModeRequestExpiryDependencies {
  prisma: typeof prisma
  cron?: CronHandle
  now: () => Date
  expireRequest: typeof expireDisplayModeRequest
  retryEntry: typeof retry
}

interface DisplayModeRequestExpiryResult {
  scanned: number
  expired: number
  noop: number
  errors: number
  skipped?: true
}

const defaults: DisplayModeRequestExpiryDependencies = {
  prisma,
  now: () => new Date(),
  expireRequest: expireDisplayModeRequest,
  retryEntry: retry,
}

export class DisplayModeRequestExpiryJob {
  private readonly dependencies: DisplayModeRequestExpiryDependencies
  private readonly job: CronHandle
  private isRunning = false

  constructor(overrides: Partial<DisplayModeRequestExpiryDependencies> = {}) {
    this.dependencies = { ...defaults, ...overrides }
    this.job =
      overrides.cron ??
      scheduleJob(
        'display-mode-request-expiry',
        DATABASE_JOB_SCHEDULES.displayModeRequestExpiry,
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
    logger.info('Display-mode request expiry job started')
  }

  stop(): void {
    this.job.stop()
    logger.info('Display-mode request expiry job stopped')
  }

  async checkNow(): Promise<DisplayModeRequestExpiryResult> {
    if (this.isRunning) {
      logger.warn('[Display-mode request expiry] tick skipped — previous run still in progress')
      return { scanned: 0, expired: 0, noop: 0, errors: 0, skipped: true }
    }
    this.isRunning = true

    try {
      const now = this.dependencies.now()
      const candidates = (await this.dependencies.retryEntry(
        () =>
          this.dependencies.prisma.terminal.findMany({
            where: { customerDisplayRequestExpiresAt: { lte: now } },
            select: { id: true, venueId: true },
            orderBy: [{ customerDisplayRequestExpiresAt: 'asc' }, { id: 'asc' }],
            take: MAX_CANDIDATES_PER_TICK,
          }),
        {
          retries: 2,
          initialDelay: 1500,
          shouldRetry: shouldRetryDbConnectionError,
          context: 'display-mode-request-expiry.findDue',
        },
      )) as DisplayModeExpiryCandidate[]

      let expired = 0
      let noop = 0
      let errors = 0

      for (const candidate of candidates) {
        try {
          const result = await this.dependencies.expireRequest({
            venueId: candidate.venueId,
            terminalId: candidate.id,
            now,
          })
          if (result.mutated) expired += 1
          else noop += 1
        } catch (error) {
          errors += 1
          logger.error('Display-mode request expiry candidate failed', {
            terminalId: candidate.id,
            venueId: candidate.venueId,
            error,
          })
        }
      }

      return { scanned: candidates.length, expired, noop, errors }
    } catch (error) {
      logger.error('Display-mode request expiry pass failed', { error })
      return { scanned: 0, expired: 0, noop: 0, errors: 1 }
    } finally {
      this.isRunning = false
    }
  }
}

export const displayModeRequestExpiryJob = new DisplayModeRequestExpiryJob()
