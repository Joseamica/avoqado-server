import type { CronJob } from 'cron'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { retry, shouldRetryDbConnectionError } from '@/utils/retry'
import { scheduleJob, runInJobContext } from '@/observability/jobContext'
import { runSupportBatch } from '@/services/support/worker.service'
import { purgeSupportBatch } from '@/services/support/retention.service'
import { DATABASE_JOB_SCHEDULES } from './jobSchedules'

export class SupportWhatsappJob {
  private running = false
  private job: CronJob
  constructor() {
    this.job = scheduleJob(
      'support-whatsapp',
      DATABASE_JOB_SCHEDULES.supportWhatsapp,
      async () => {
        await this.runNow()
      },
      null,
      false,
      'America/Mexico_City',
    )
  }
  start(): void {
    this.job.start()
    void this.runNow()
  }
  stop(): void {
    this.job.stop()
  }
  async runNow(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      await runInJobContext('support-whatsapp', async () => {
        const pending = await retry(
          () => prisma.supportMessage.count({ where: { status: { in: ['QUEUED', 'CLAIMED', 'ANSWER_READY', 'AI_UNKNOWN'] } } }),
          { retries: 2, initialDelay: 1500, shouldRetry: shouldRetryDbConnectionError, context: 'support-whatsapp.count' },
        )
        const cleanup = await purgeSupportBatch()
        if (cleanup.redacted || cleanup.deleted) logger.info('Support WhatsApp retention', cleanup)
        if (!pending) return
        const result = await runSupportBatch()
        if (result.claimed || result.unknown) logger.info('Support WhatsApp batch', result)
      })
    } catch {
      logger.error('Support WhatsApp tick failed', { code: 'SUPPORT_TICK_FAILED' })
    } finally {
      this.running = false
    }
  }
}
export const supportWhatsappJob = new SupportWhatsappJob()
