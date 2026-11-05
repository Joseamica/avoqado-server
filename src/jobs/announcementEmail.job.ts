/**
 * Correo de los anuncios de plataforma: encola lo repartido en las últimas 24 h y manda una tanda de 20, con el tope del día
 * y el cupo de Resend (`announcementEmail.service.ts`). `publishAnnouncement` no encola correos: si el proceso muere entre
 * publicar y encolar, este job lo retoma en la siguiente vuelta (codex r1 #2).
 */
import { CronJob } from 'cron'

import logger from '../config/logger'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'
import { DATABASE_JOB_SCHEDULES } from './jobSchedules'
import { scheduleJob } from '../observability/jobContext'
import {
  claimAnnouncementEmails,
  enqueuePendingAnnouncementEmails,
  sendClaimedAnnouncementEmails,
} from '../services/announcements/announcementEmail.service'

const TIMEZONE = 'America/Mexico_City'
const TANDA = 20

export class AnnouncementEmailJob {
  private job: CronJob | null = null
  private isRunning = false

  constructor() {
    this.job = scheduleJob(
      'announcement-email',
      DATABASE_JOB_SCHEDULES.announcementEmail,
      async () => {
        await this.process()
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

  private async process(): Promise<void> {
    if (this.isRunning) return
    this.isRunning = true
    try {
      await this.processNow(new Date())
    } catch (err) {
      logger.error('AnnouncementEmail failed', { err })
    } finally {
      this.isRunning = false
    }
  }

  async processNow(now: Date): Promise<void> {
    // La entrada va con retry de conexión (`.claude/rules/cron-jobs.md`): encolar es seguro de repetir (lecturas y un
    // `createMany` con `skipDuplicates`). Reclamar y mandar NO se envuelven.
    const encolados = await retry(() => enqueuePendingAnnouncementEmails(now), {
      retries: 2,
      initialDelay: 1500,
      shouldRetry: shouldRetryDbConnectionError,
      context: 'announcement-email.enqueue',
    })
    if (encolados) logger.info('[Anuncios] correos encolados', { encolados })

    const reclamos = await claimAnnouncementEmails({ limit: TANDA, now })
    if (reclamos.length === 0) return
    const r = await sendClaimedAnnouncementEmails(reclamos, { now })
    logger.info('[Anuncios] correos procesados', r)
  }
}

export const announcementEmailJob = new AnnouncementEmailJob()
