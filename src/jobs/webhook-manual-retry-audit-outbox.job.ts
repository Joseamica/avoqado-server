import { Prisma } from '@prisma/client'
import logger from '@/config/logger'
import { scheduleJob } from '@/observability/jobContext'
import { webhookManualRetryOutbox } from '@/services/superadmin/webhookManualRetryOutbox.service'
import prisma from '@/utils/prismaClient'
import { retry, shouldRetryDbConnectionError } from '@/utils/retry'

interface ScheduleLike {
  start(): void
  stop(): void
}

interface JobLogger {
  info(message: string, meta?: Record<string, unknown>): void
  error(message: string, meta?: Record<string, unknown>): void
}

async function manualRetryAuditReadiness(): Promise<void> {
  await retry(() => prisma.$queryRaw(Prisma.sql`SELECT 1`), {
    retries: 2,
    initialDelay: 1500,
    shouldRetry: shouldRetryDbConnectionError,
    context: 'webhook-manual-retry-audit-outbox.readiness',
  })
}

export class WebhookManualRetryAuditOutboxJob {
  private running = false
  private started = false
  private readonly schedule: ScheduleLike

  constructor(
    private readonly dependencies: {
      enabled: boolean
      readiness: () => Promise<void>
      deliverDueResults: () => Promise<{ claimed: number; delivered: number; waiting: number; failed: number }>
      logger: JobLogger
      schedule?: ScheduleLike
    },
  ) {
    this.schedule =
      dependencies.schedule ??
      scheduleJob('webhook-manual-retry-audit-outbox', '* * * * *', this.runOnce.bind(this), null, false, 'America/Mexico_City')
  }

  start(): void {
    if (!this.dependencies.enabled || this.started) return
    this.started = true
    this.schedule.start()
    this.dependencies.logger.info('Manual webhook retry audit outbox job started')
  }

  stop(): void {
    if (!this.started) return
    this.started = false
    this.schedule.stop()
  }

  async runOnce(): Promise<void> {
    if (!this.dependencies.enabled || this.running) return
    this.running = true
    try {
      await this.dependencies.readiness()
      const result = await this.dependencies.deliverDueResults()
      if (result.claimed > 0) this.dependencies.logger.info('Manual webhook retry audit outbox tick completed', result)
    } catch (error) {
      this.dependencies.logger.error('Manual webhook retry audit outbox tick failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      this.running = false
    }
  }
}

export const webhookManualRetryAuditOutboxJob = new WebhookManualRetryAuditOutboxJob({
  enabled: true,
  readiness: manualRetryAuditReadiness,
  deliverDueResults: () => webhookManualRetryOutbox.deliverDueResults(),
  logger,
})
