import { CronJob } from 'cron'
import logger from '../config/logger'
import { scheduleJob } from '../observability/jobContext'
import { reconciliarDesconocidos } from '../services/crm/email/gmailSend.service'
import { sincronizarRespuestas } from '../services/crm/email/gmailReplies.service'
import { DATABASE_JOB_SCHEDULES } from './jobSchedules'

const TIMEZONE = 'America/Mexico_City'

/**
 * El Gmail del vendedor (spec 2026-10-30 §5.6, fase 2): cada 5 min busca en «Enviados» lo que no sabemos si salió y trae
 * a la ficha lo que contestaron. Todo lo de negocio vive en los servicios (errores por hilo y por conexión, CAS por
 * `version`, nunca reenviar); aquí sólo se programa y se evita que dos vueltas se encimen.
 *
 * 🔴 El reintento de conexión de `.claude/rules/cron-jobs.md` vive en los servicios, alrededor de su primera lectura (las
 * conexiones ACTIVAS, `conexionesActivas`). Ninguna llamada a Google se reintenta.
 */
export class CrmGmailRepliesJob {
  private job: CronJob | null = null
  private isRunning = false

  constructor() {
    // 🔴 `scheduleJob`, no `new CronJob`: cada línea del log de una vuelta lleva el nombre del trabajo y su correlationId.
    this.job = scheduleJob(
      'crm-gmail-replies',
      DATABASE_JOB_SCHEDULES.crmGmailReplies,
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

  async run(ahora: Date = new Date()): Promise<void> {
    if (this.isRunning) return
    this.isRunning = true
    try {
      // Las dos mitades por separado: si una truena, la otra corre igual.
      try {
        await reconciliarDesconocidos(ahora)
      } catch (err) {
        logger.error('[CRM] The Gmail reconciliation tick failed', { error: err instanceof Error ? err.message : String(err) })
      }
      try {
        await sincronizarRespuestas(ahora)
      } catch (err) {
        logger.error('[CRM] The Gmail replies tick failed', { error: err instanceof Error ? err.message : String(err) })
      }
    } finally {
      this.isRunning = false
    }
  }
}

export const crmGmailRepliesJob = new CrmGmailRepliesJob()
