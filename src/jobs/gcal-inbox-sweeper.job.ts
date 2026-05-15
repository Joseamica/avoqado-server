/**
 * Google Calendar Inbox Sweeper (Phase 1)
 *
 * Picks up GoogleCalendarWebhookInbox rows that the RabbitMQ pull consumer
 * didn't process within 1 minute (e.g., RabbitMQ down, worker crashed mid-flight)
 * and drives `pullConnection` directly. Idempotent — `pullConnection` itself is
 * single-flight-locked by connectionId.
 *
 * Cron: every 30 seconds.
 */
import { CronJob } from 'cron'
import logger from '../config/logger'
import prisma from '../utils/prismaClient'
import { pullConnection } from '../services/google-calendar/pull.service'

const TIMEZONE = 'America/Mexico_City'
const STALE_AFTER_MS = 60_000
const BATCH_SIZE = 100

export class GcalInboxSweeperJob {
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
      logger.info('Gcal Inbox Sweeper started — every 30 seconds')
    }
  }

  stop(): void {
    if (this.job) {
      this.job.stop()
      logger.info('Gcal Inbox Sweeper stopped')
    }
  }

  async runNow(): Promise<void> {
    return this.process()
  }

  private async process(): Promise<void> {
    if (this.isRunning) return
    this.isRunning = true

    try {
      const cutoff = new Date(Date.now() - STALE_AFTER_MS)
      const rows = await prisma.googleCalendarWebhookInbox.findMany({
        where: { processedAt: null, receivedAt: { lt: cutoff } },
        distinct: ['connectionId'],
        take: BATCH_SIZE,
      })
      if (rows.length === 0) return

      for (const row of rows) {
        try {
          await pullConnection(row.connectionId)
          await prisma.googleCalendarWebhookInbox.updateMany({
            where: { connectionId: row.connectionId, processedAt: null },
            data: { processedAt: new Date() },
          })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          logger.warn('gcal inbox sweeper failed for connection', { err, connectionId: row.connectionId })
          await prisma.googleCalendarWebhookInbox
            .updateMany({
              where: { connectionId: row.connectionId, processedAt: null },
              data: { attempts: { increment: 1 }, lastError: message.slice(0, 500) },
            })
            .catch(() => {})
        }
      }
    } catch (err) {
      logger.error('Gcal Inbox Sweeper failed', { err })
    } finally {
      this.isRunning = false
    }
  }
}

export const gcalInboxSweeperJob = new GcalInboxSweeperJob()
