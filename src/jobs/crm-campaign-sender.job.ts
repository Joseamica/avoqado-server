import { CronJob } from 'cron'
import logger from '../config/logger'
import { scheduleJob } from '../observability/jobContext'
import { correrEnvioDeCampanas } from '../services/crm/email/campaignSender.service'
import { DATABASE_JOB_SCHEDULES } from './jobSchedules'

const TIMEZONE = 'America/Mexico_City'

/**
 * Las campañas masivas del CRM (spec 2026-10-30 §5.6, fase 2): cada minuto vacía un poco la cola por Resend, con el tope
 * diario del subdominio. Todo lo de negocio vive en `correrEnvioDeCampanas` (lease, CAS, tope, ventana de 23 h, kill switch);
 * aquí sólo se programa y se evita que dos vueltas se encimen.
 *
 * 🔴 El reintento de conexión de `.claude/rules/cron-jobs.md` vive en el servicio, alrededor de la primera lectura (un COUNT).
 * El reclamo y los envíos nunca se reintentan a ciegas: un reintento pasa por la fila reclamada y su llave de idempotencia.
 */
export class CrmCampaignSenderJob {
  private job: CronJob | null = null
  private isRunning = false
  /** Un solo aviso por apagón: se vuelve a avisar si el interruptor se apaga y se prende otra vez. */
  private avisoKillSwitch = false

  constructor() {
    // 🔴 `scheduleJob`, no `new CronJob`: cada línea del log de una vuelta lleva el nombre del trabajo y su correlationId.
    this.job = scheduleJob(
      'crm-campaign-sender',
      DATABASE_JOB_SCHEDULES.crmCampaignSender,
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
    if (this.isRunning) return
    this.isRunning = true
    try {
      const resumen = await correrEnvioDeCampanas()
      if (resumen === null && !this.avisoKillSwitch) logger.warn('[CRM] MARKETING_KILL_SWITCH=true — campaign sender paused')
      this.avisoKillSwitch = resumen === null
    } catch (err) {
      // La última red: una vuelta que truena nunca tumba el proceso.
      logger.error('[CRM] The campaign sender tick failed', { err })
    } finally {
      this.isRunning = false
    }
  }
}

export const crmCampaignSenderJob = new CrmCampaignSenderJob()
