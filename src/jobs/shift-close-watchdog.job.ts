import { ShiftStatus } from '@prisma/client'
import type { CronJob } from 'cron'
import logger from '../config/logger'
import { scheduleJob } from '../observability/jobContext'
import { SHIFT_CLOSE_STALE_MS } from '../services/tpv/shiftCloseClaim.constants'
import { lockShiftLifecycleForVenue } from '../services/shared/shiftLifecycleLock'
import prisma from '../utils/prismaClient'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'
import { DATABASE_JOB_SCHEDULES } from './jobSchedules'

const MAX_SHIFTS = 100
type CronHandle = Pick<CronJob, 'start' | 'stop'>

interface StaleShiftClaim {
  id: string
  venueId: string
  updatedAt: Date
}

interface ShiftCloseWatchdogDependencies {
  prisma: typeof prisma
  cron?: CronHandle
  now: () => Date
  retryEntry: typeof retry
}

const defaults: ShiftCloseWatchdogDependencies = {
  prisma,
  now: () => new Date(),
  retryEntry: retry,
}

export class ShiftCloseWatchdogJob {
  private readonly dependencies: ShiftCloseWatchdogDependencies
  private readonly cron: CronHandle
  private running = false

  constructor(overrides: Partial<ShiftCloseWatchdogDependencies> = {}) {
    this.dependencies = { ...defaults, ...overrides }
    this.cron =
      overrides.cron ??
      scheduleJob(
        'shift-close-watchdog',
        DATABASE_JOB_SCHEDULES.shiftCloseWatchdog,
        () => {
          void this.runNow().catch(error => logger.error('Shift close watchdog failed', { error }))
        },
        null,
        false,
        'America/Mexico_City',
      )
  }

  start(): void {
    this.cron.start()
    logger.info('Shift close watchdog started')
  }

  stop(): void {
    this.cron.stop()
    logger.info('Shift close watchdog stopped')
  }

  async runNow(): Promise<{ scanned: number; reopened: number; skipped: number; errors: number }> {
    if (this.running) return { scanned: 0, reopened: 0, skipped: 1, errors: 0 }
    this.running = true
    try {
      const now = this.dependencies.now()
      const staleBefore = new Date(now.getTime() - SHIFT_CLOSE_STALE_MS)
      const candidates = (await this.dependencies.retryEntry(
        () =>
          this.dependencies.prisma.shift.findMany({
            where: { status: ShiftStatus.CLOSING, endTime: null, updatedAt: { lte: staleBefore } },
            select: { id: true, venueId: true, updatedAt: true },
            orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
            take: MAX_SHIFTS,
          }),
        {
          retries: 2,
          initialDelay: 1500,
          shouldRetry: shouldRetryDbConnectionError,
          context: 'shift-close-watchdog.findStale',
        },
      )) as StaleShiftClaim[]
      let reopened = 0
      let skipped = 0
      let errors = 0
      for (const candidate of candidates) {
        try {
          const result = await this.dependencies.prisma.$transaction(async tx => {
            await lockShiftLifecycleForVenue(tx, candidate.venueId)
            return tx.shift.updateMany({
              where: {
                id: candidate.id,
                venueId: candidate.venueId,
                status: ShiftStatus.CLOSING,
                endTime: null,
                updatedAt: candidate.updatedAt,
              },
              data: { status: ShiftStatus.OPEN, updatedAt: now },
            })
          })
          if (result.count === 1) {
            reopened += 1
            logger.warn('Recovered stale CLOSING shift claim', {
              shiftId: candidate.id,
              venueId: candidate.venueId,
              claimedAt: candidate.updatedAt,
            })
          } else {
            skipped += 1
          }
        } catch (error) {
          errors += 1
          logger.error('Shift close watchdog candidate failed', { shiftId: candidate.id, venueId: candidate.venueId, error })
        }
      }
      return { scanned: candidates.length, reopened, skipped, errors }
    } finally {
      this.running = false
    }
  }
}

export const shiftCloseWatchdogJob = new ShiftCloseWatchdogJob()
