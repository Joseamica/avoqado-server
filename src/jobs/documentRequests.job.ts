import { CronJob } from 'cron'
import { scheduleJob } from '../observability/jobContext'
import logger from '../config/logger'
import { DATABASE_JOB_SCHEDULES } from './jobSchedules'
import { cleanupFiles } from '../services/document-requests/documentRequests.service'
import { deliverNotifications } from '../services/document-requests/notifications'

class DocumentRequestsJob {
  private running = false
  private job: CronJob = scheduleJob(
    'document-requests',
    DATABASE_JOB_SCHEDULES.documentRequests,
    async () => {
      if (this.running) return
      this.running = true
      try {
        await deliverNotifications()
        await cleanupFiles()
      } catch {
        logger.error('Document requests background work failed; retrying next tick')
      } finally {
        this.running = false
      }
    },
    null,
    false,
    'America/Mexico_City',
  )
  start() {
    this.job.start()
  }
  stop() {
    this.job.stop()
  }
}
export const documentRequestsJob = new DocumentRequestsJob()
