import type { CronJob } from 'cron'
import logger from '@/config/logger'
import { getSupportHandoffConfig } from '@/config/supportWhatsapp'
import { scheduleJob, runInJobContext } from '@/observability/jobContext'
import { runSupportNotices } from '@/services/support/notices.service'
import { DATABASE_JOB_SCHEDULES } from './jobSchedules'

/** El correo del aviso al equipo, en su propio job y con su propio candado: SupportWhatsappJob nunca lo espera (R2-08). */
export class SupportNoticesJob {
  private running = false
  private job: CronJob
  constructor() {
    this.job = scheduleJob(
      'support-notices',
      DATABASE_JOB_SCHEDULES.supportNotices,
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
    if (this.running || !getSupportHandoffConfig()) return
    this.running = true
    try {
      await runInJobContext('support-notices', async () => {
        const result = await runSupportNotices()
        if (result.sent || result.failed || result.skipped || result.uncertain) logger.info('Support notices', result)
      })
    } catch {
      logger.error('Support notices tick failed', { code: 'SUPPORT_NOTICES_TICK_FAILED' })
    } finally {
      this.running = false
    }
  }
}
export const supportNoticesJob = new SupportNoticesJob()
