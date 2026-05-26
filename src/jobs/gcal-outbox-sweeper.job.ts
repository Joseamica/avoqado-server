/**
 * Google Calendar Outbox Sweeper (Phase 2 — Section C)
 *
 * Drains the `CalendarSyncOutbox` table by calling `processOutboxRow` for any
 * row that's ready for work. The RabbitMQ push consumer (`gcal-push-consumer`)
 * is the primary driver; this sweeper is the durability safety net for the
 * cases the consumer can't cover:
 *
 *   • RabbitMQ is down at commit time → publish .catch() swallows + the row
 *     stays PENDING here.
 *   • Worker crashed mid-flight → row is FAILED with a future scheduledAt.
 *   • Debounced UPDATE_ROSTER rows → only pickable once debounceUntil passes.
 *
 * Pickup criteria:
 *   • status IN ('PENDING','FAILED')
 *   • scheduledAt <= NOW()       — respects exponential backoff stamps
 *   • debounceUntil IS NULL OR debounceUntil <= NOW()
 *
 * Concurrency:
 *   • IN_PROGRESS rows are NEVER picked up here — stuck-row recovery is a
 *     separate future task.
 *   • `processOutboxRow` holds a pg_try_advisory_xact_lock per syncKey, so
 *     even when the sweeper races the RabbitMQ consumer for the same row,
 *     only one path actually performs the Google call.
 *
 * Cron: every 30 seconds.
 */
import { CronJob } from 'cron'

import logger from '../config/logger'
import { processOutboxRow } from '../services/google-calendar/push.service'
import prisma from '../utils/prismaClient'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'

const TIMEZONE = 'America/Mexico_City'
const BATCH_SIZE = 100

export class GcalOutboxSweeperJob {
  private job: CronJob | null = null
  private isRunning = false

  constructor() {
    this.job = new CronJob(
      '*/30 * * * * *',
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
      logger.info('Gcal Outbox Sweeper started — every 30 seconds')
    }
  }

  stop(): void {
    if (this.job) {
      this.job.stop()
      logger.info('Gcal Outbox Sweeper stopped')
    }
  }

  /** Manual trigger for tests + ops tooling. */
  async runNow(): Promise<void> {
    return this.process()
  }

  private async process(): Promise<void> {
    // Guard against overlapping ticks if the previous run is still draining a
    // batch (e.g. slow Google API). CronJob is single-threaded but its ticks
    // can stack if a run exceeds the 30s interval.
    if (this.isRunning) return
    this.isRunning = true

    try {
      const now = new Date()
      // Retry only on transient DB connection blips (P1001 during the cron stampede). See .claude/rules/cron-jobs.md
      const rows = await retry(
        () =>
          prisma.calendarSyncOutbox.findMany({
            where: {
              status: { in: ['PENDING', 'FAILED'] },
              scheduledAt: { lte: now },
              OR: [{ debounceUntil: null }, { debounceUntil: { lte: now } }],
            },
            orderBy: { scheduledAt: 'asc' },
            take: BATCH_SIZE,
            select: { id: true, syncKey: true },
          }),
        { retries: 2, initialDelay: 1500, shouldRetry: shouldRetryDbConnectionError, context: 'gcal-outbox-sweeper.findReady' },
      )
      if (rows.length === 0) return

      // Process sequentially — processOutboxRow takes its own advisory lock
      // and persists all failure paths. Parallelism here only buys us
      // throughput at the cost of harder log triage; defer until profiling
      // proves we need it.
      for (const row of rows) {
        try {
          await processOutboxRow(row.id)
        } catch (err) {
          // processOutboxRow already absorbs Google failures into the row.
          // This catch is for truly unexpected DB-layer issues.
          logger.warn('gcal outbox sweeper: unexpected error processing row', {
            err,
            rowId: row.id,
            syncKey: row.syncKey,
          })
        }
      }
    } catch (err) {
      logger.error('Gcal Outbox Sweeper failed', { err })
    } finally {
      this.isRunning = false
    }
  }
}

export const gcalOutboxSweeperJob = new GcalOutboxSweeperJob()
