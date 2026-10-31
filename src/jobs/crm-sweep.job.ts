import { CronJob } from 'cron'
import logger from '../config/logger'
import { scheduleJob } from '../observability/jobContext'
import { runSweep } from '../services/crm/sweep.service'
import { DATABASE_JOB_SCHEDULES } from './jobSchedules'

const TIMEZONE = 'America/Mexico_City'

/**
 * The CRM's repair sweep every five minutes (spec 2026-10-30 §5.3 step 5, plan task 6): landing entries not applied
 * yet, landing accounts to link, old signups without their account and the first money date (`runSweep`).
 *
 * 🔴 The connection retry of `.claude/rules/cron-jobs.md` lives in the service: each pass wraps its own first read,
 * which is pure. Nothing that writes is retried.
 */
export class CrmSweepJob {
  private job: CronJob | null = null
  private isRunning = false

  constructor() {
    // 🔴 `scheduleJob`, not `new CronJob`: every log line of a tick carries the job's name and its correlationId.
    this.job = scheduleJob(
      'crm-sweep',
      DATABASE_JOB_SCHEDULES.crmSweep,
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
    // A tick that overlaps the previous one would walk the same pages twice.
    if (this.isRunning) return
    this.isRunning = true
    try {
      await runSweep()
    } catch (err) {
      // `runSweep` keeps its passes apart; this is the last net, so a tick never takes the process down.
      logger.error('[CRM] The sweep failed', { err })
    } finally {
      this.isRunning = false
    }
  }
}

export const crmSweepJob = new CrmSweepJob()
