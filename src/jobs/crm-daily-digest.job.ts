import { CronJob } from 'cron'
import logger from '../config/logger'
import { scheduleJob } from '../observability/jobContext'
import { runDailyDigest } from '../services/crm/digest.service'
import { DATABASE_JOB_SCHEDULES } from './jobSchedules'

const TIMEZONE = 'America/Mexico_City'

/**
 * The CRM's daily digest (spec 2026-10-30 §5.4, plan task 7): «Tus pendientes de hoy» to each seller at 8:30 on weekdays,
 * and every 15 minutes until 11:00 to retake what a dead process or a Resend failure left halfway (`runDailyDigest`,
 * which also checks the weekday and the window).
 *
 * 🔴 The connection retry of `.claude/rules/cron-jobs.md` lives in the service, around the tick's first read, which is
 * pure. The send and the marks are never retried blindly: a retry goes through the reserved row and its email key.
 */
export class CrmDailyDigestJob {
  private job: CronJob | null = null
  private isRunning = false

  constructor() {
    // 🔴 `scheduleJob`, not `new CronJob`: every log line of a tick carries the job's name and its correlationId.
    this.job = scheduleJob(
      'crm-daily-digest',
      DATABASE_JOB_SCHEDULES.crmDailyDigest,
      async () => {
        await this.run()
      },
      null,
      false,
      TIMEZONE,
    )
  }

  start(): void {
    this.job?.start()
  }

  stop(): void {
    this.job?.stop()
  }

  async run(): Promise<void> {
    // The reserved rows already stop a double send; this only saves an overlapping tick the work.
    if (this.isRunning) return
    this.isRunning = true
    try {
      await runDailyDigest(new Date())
    } catch (err) {
      // `runDailyDigest` keeps each person apart; this is the last net, so a tick never takes the process down.
      logger.error('[CRM] The daily digest failed', { err })
    } finally {
      this.isRunning = false
    }
  }
}

export const crmDailyDigestJob = new CrmDailyDigestJob()
