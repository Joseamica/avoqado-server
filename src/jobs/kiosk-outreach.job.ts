/**
 * Fase 9 del kiosco — el aviso nocturno de renovación.
 *
 * Dos ritmos en un solo job:
 *   · una vez por noche arma la lista (quién está por quedarse sin créditos o con el
 *     paquete por vencer), y
 *   · cada minuto vacía la fila que quedó.
 *
 * Separarlos es lo que hace que un fallo a media entrega no obligue a rehacer el barrido:
 * la intención ya está en la base y el siguiente tick la retoma.
 *
 * 🔴 No manda nada por su cuenta. Sólo salen mensajes de negocios que lo prendieron
 * (`ReservationSettings.nightlyOutreachEnabled`, apagado por defecto) y a clientes con
 * `marketingConsent`. Con la lista vacía, este job es un no-op que cuesta una consulta.
 */
import { CronJob } from 'cron'

import logger from '../config/logger'
import { scheduleJob } from '../observability/jobContext'
import { enqueueNightlyOutreach, sweepOnce } from '../services/reservation/kioskOutreach.service'

const TIMEZONE = 'America/Mexico_City'
const BATCH_SIZE = 50

export class KioskOutreachJob {
  private enqueueJob: CronJob | null = null
  private sweepJob: CronJob | null = null
  private isRunning = false

  constructor() {
    // 4:30 a. m. hora del centro: el negocio ya cerró y el cliente lo lee al despertar.
    // Mandarlo a las 11 de la noche se siente intrusivo; a las 9 a. m. compite con todo
    // lo demás de su bandeja.
    this.enqueueJob = scheduleJob('kiosk-outreach-enqueue', '0 30 4 * * *', async () => { await this.enqueue() }, null, false, TIMEZONE)
    this.sweepJob = scheduleJob('kiosk-outreach-sweep', '0 * * * * *', async () => { await this.sweep() }, null, false, TIMEZONE)
  }

  start(): void {
    this.enqueueJob?.start()
    this.sweepJob?.start()
    logger.info('🌙 [KIOSK OUTREACH] Job iniciado (4:30 AM enqueue · barrido cada minuto)')
  }

  stop(): void {
    this.enqueueJob?.stop()
    this.sweepJob?.stop()
  }

  private async enqueue(): Promise<void> {
    try {
      await enqueueNightlyOutreach({ now: new Date() })
    } catch (err) {
      logger.error('Kiosk outreach enqueue failed', { err })
    }
  }

  private async sweep(): Promise<void> {
    // Un tick lento no puede encimarse con el siguiente: mandaría dos veces lo mismo.
    if (this.isRunning) return
    this.isRunning = true
    try {
      const result = await sweepOnce({ now: new Date(), batchSize: BATCH_SIZE })
      if (result.sent || result.failed) logger.info('[Kiosk outreach] barrido', result)
    } catch (err) {
      logger.error('Kiosk outreach sweep failed', { err })
    } finally {
      this.isRunning = false
    }
  }
}

export const kioskOutreachJob = new KioskOutreachJob()
