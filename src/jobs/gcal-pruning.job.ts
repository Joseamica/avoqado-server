/**
 * Google Calendar Block Pruning (Phase 1)
 *
 * Deletes ExternalBusyBlock rows whose events ended more than 7 days ago.
 * Availability queries only care about future events plus a small grace window
 * for audit/debug; without pruning, the table grows unbounded over time.
 *
 * Cron: daily at 04:30 Mexico City (after horizon refresh).
 */
import { CronJob } from 'cron'
import logger from '../config/logger'
import prisma from '../utils/prismaClient'

const TIMEZONE = 'America/Mexico_City'
const RETENTION_DAYS = 7

export class GcalPruningJob {
  private job: CronJob | null = null
  private isRunning = false

  constructor() {
    this.job = new CronJob(
      '30 4 * * *',
      async () => {
        await this.process()
      },
      null,
      false,
      TIMEZONE,
    )
  }

  start(): void {
    if (this.job) {
      this.job.start()
      logger.info('Gcal Pruning Job started — daily at 04:30 Mexico City')
    }
  }

  stop(): void {
    if (this.job) {
      this.job.stop()
      logger.info('Gcal Pruning Job stopped')
    }
  }

  async runNow(): Promise<void> {
    return this.process()
  }

  private async process(): Promise<void> {
    if (this.isRunning) return
    this.isRunning = true

    try {
      const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400_000)
      const result = await prisma.externalBusyBlock.deleteMany({
        where: { endsAt: { lt: cutoff } },
      })
      if (result.count > 0) {
        logger.info('🧹 Gcal Pruning: removed expired ExternalBusyBlock rows', { deleted: result.count, cutoff })
      }
    } catch (err) {
      logger.error('Gcal Pruning Job failed', { err })
    } finally {
      this.isRunning = false
    }
  }
}

export const gcalPruningJob = new GcalPruningJob()
