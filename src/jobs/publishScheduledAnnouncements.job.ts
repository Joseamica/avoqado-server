import { CronJob } from 'cron'
import { PlatformAnnouncementStatus } from '@prisma/client'
import prisma from '../utils/prismaClient'
import logger from '../config/logger'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'
import { DATABASE_JOB_SCHEDULES } from './jobSchedules'
import { scheduleJob } from '../observability/jobContext'
import { publishAnnouncement } from '../services/announcements/announcement.service'

const TIMEZONE = 'America/Mexico_City'

/**
 * Publica los anuncios de plataforma programados cuya hora ya llegó.
 *
 * 🔴 El read de entrada va envuelto en `retry(shouldRetryDbConnectionError)` porque al
 * top de cada hora TODOS los crons se alinean, la ráfaga de conexiones nuevas excede el
 * `connect_timeout` de Prisma y el read muere con P1001 (ver `.claude/rules/cron-jobs.md`).
 *
 * 🔴 El reparto NO se envuelve en retry: duplicaría avisos. Sólo el read de entrada, que
 * es puro y seguro de repetir.
 */
export async function publishScheduledAnnouncements(): Promise<number> {
  const pendientes = await retry(
    () =>
      prisma.platformAnnouncement.findMany({
        where: {
          status: PlatformAnnouncementStatus.SCHEDULED,
          scheduledFor: { lte: new Date() },
        },
        select: { id: true },
      }),
    {
      retries: 2,
      initialDelay: 1500,
      shouldRetry: shouldRetryDbConnectionError,
      context: 'publishScheduledAnnouncements.findMany',
    },
  )

  let publicados = 0
  for (const a of pendientes) {
    try {
      // `alreadyPublished` no cuenta: si otro proceso ya lo repartió, este tick no
      // publicó nada y reportarlo infla la bitácora con publicaciones inexistentes.
      const r = await publishAnnouncement(a.id)
      if (!r.alreadyPublished) publicados++
    } catch (error) {
      // Un anuncio que falla no puede impedir que salgan los demás.
      logger.error('No se pudo publicar un anuncio programado', { announcementId: a.id, error })
    }
  }

  if (publicados > 0) logger.info('Anuncios programados publicados', { publicados })
  return publicados
}

export class PublishScheduledAnnouncementsJob {
  private job: CronJob | null = null
  private isRunning = false

  constructor() {
    // 🔴 `scheduleJob`, no `new CronJob`: abre el contexto de observabilidad para que cada
    // `logger.*` de esta corrida salga con el nombre del job y su correlationId.
    this.job = scheduleJob(
      'publish-scheduled-announcements',
      DATABASE_JOB_SCHEDULES.publishScheduledAnnouncements,
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
    // Un tick que se solapa con el anterior no puede repartir dos veces.
    if (this.isRunning) return
    this.isRunning = true
    try {
      await publishScheduledAnnouncements()
    } catch (err) {
      // Un tick que truena no puede tumbar el proceso: los anuncios siguen en la tabla
      // y el siguiente tick vuelve a intentarlo.
      logger.error('PublishScheduledAnnouncements failed', { err })
    } finally {
      this.isRunning = false
    }
  }
}

export const publishScheduledAnnouncementsJob = new PublishScheduledAnnouncementsJob()
