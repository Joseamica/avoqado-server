/**
 * Entrega los anuncios de plataforma encolados.
 *
 * Publicar sólo escribe las filas de entrega; este job las convierte en avisos del buzón,
 * con lease, reintentos y `FOR UPDATE SKIP LOCKED`. Es el mismo mecanismo de
 * `customer-approval-outbox.job.ts`.
 *
 * ⚠️ Este server corre UNA sola instancia (`.claude/rules/una-sola-instancia.md`), así que
 * el cron no está duplicado. Aun así el reclamo usa lease + SKIP LOCKED: es lo que hace
 * que un segundo proceso —un deploy solapado, un script de mantenimiento— no entregue dos
 * veces el mismo aviso.
 */
import { CronJob } from 'cron'

import logger from '../config/logger'
import prisma from '../utils/prismaClient'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'
import { DATABASE_JOB_SCHEDULES } from './jobSchedules'
import { scheduleJob } from '../observability/jobContext'
import { claimDeliveries, deliverClaimed } from '../services/announcements/announcementOutbox.service'

const TIMEZONE = 'America/Mexico_City'
const BATCH_SIZE = 200

export class AnnouncementOutboxJob {
  private job: CronJob | null = null
  private isRunning = false

  constructor() {
    // `scheduleJob`, no `new CronJob`: abre el contexto de observabilidad para que cada
    // `logger.*` de esta corrida salga con el nombre del job y su correlationId.
    this.job = scheduleJob(
      'announcement-outbox',
      DATABASE_JOB_SCHEDULES.announcementOutbox,
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
      const now = new Date()

      // El read de entrada va con retry: al top de cada hora todos los crons se alinean y
      // la ráfaga de conexiones nuevas lo mata con P1001 (`.claude/rules/cron-jobs.md`).
      // Es un COUNT puro, seguro de repetir. El reclamo y la entrega NO se envuelven.
      const pendientes = await retry(
        () =>
          prisma.platformAnnouncementDelivery.count({
            where: { status: { in: ['PENDING', 'FAILED'] }, nextAttemptAt: { lte: now } },
          }),
        {
          retries: 2,
          initialDelay: 1500,
          shouldRetry: shouldRetryDbConnectionError,
          context: 'announcement-outbox.count',
        },
      )
      if (pendientes === 0) return

      const ids = await claimDeliveries({ limit: BATCH_SIZE, now })
      if (ids.length === 0) return

      const r = await deliverClaimed(ids, { now })
      if (r.sent || r.failed) logger.info('[Anuncios] entregas procesadas', r)
    } catch (err) {
      // Un tick que truena no puede tumbar el proceso: las filas siguen en la tabla y el
      // siguiente tick vuelve a intentarlo.
      logger.error('AnnouncementOutbox failed', { err })
    } finally {
      this.isRunning = false
    }
  }
}

export const announcementOutboxJob = new AnnouncementOutboxJob()
