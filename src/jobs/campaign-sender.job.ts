/**
 * Fase 1A, Task 8 — el job que vacía el carril de envío de campañas.
 *
 * Cada 5 minutos reclama un lote con `reclamarLote` (Task 6 — lease + `SKIP LOCKED` +
 * reparto justo por venue) y manda cada delivery reclamada con `enviarDelivery` (Task 7,
 * que decide y ejecuta el correo: consentimiento, supresión y estado de la campaña se
 * revalidan AHÍ, al borde, nunca aquí). Este archivo no decide NADA de negocio — sólo
 * reclama y despacha.
 *
 * 🔴 Segundo 7, no el 0 ni el 5: `marketing-campaign.job.ts` (el job de MARKETING DE
 * SUPERADMIN — Avoqado → venues/staff, un carril distinto, no se toca aquí) ya corre
 * cada 5 minutos en el segundo 5. Alinear dos jobs de correo en el mismo segundo duplica
 * la presión sobre el proveedor de email justo en el instante en que el pool de
 * conexiones a Postgres también se satura (`.claude/rules/cron-jobs.md`).
 */
import { CronJob } from 'cron'

import logger from '../config/logger'
import { env } from '../config/env'
import prisma from '../utils/prismaClient'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'
import { scheduleJob } from '../observability/jobContext'
import { reclamarLote } from '../services/marketing/campaignScheduler.service'
import { enviarDelivery, type ResultadoEnvio } from '../services/marketing/campaignSender.service'

const TIMEZONE = 'America/Mexico_City'

type ClaveResumen = 'sent' | 'skipped' | 'retrying' | 'dead' | 'unknown'

/** `ResultadoEnvio` en MAYÚSCULAS → la clave en minúsculas que pide R6 del brief. */
const CLAVE_POR_RESULTADO: Record<ResultadoEnvio, ClaveResumen> = {
  SENT: 'sent',
  SKIPPED: 'skipped',
  RETRYING: 'retrying',
  DEAD: 'dead',
  UNKNOWN: 'unknown',
}

export class CampaignSenderJob {
  private job: CronJob | null = null
  private isRunning = false
  // Bandera de INSTANCIA, no "una vez por proceso": sólo el primer tick con el switch
  // prendido avisa (R2). Se reinicia en cuanto el switch vuelve a 'false', así que si se
  // prende, se apaga y se vuelve a prender, el segundo apagón avisa otra vez — decisión
  // deliberada: un aviso ausente en un apagón real sería peor que uno "de más".
  private avisoKillSwitchEmitido = false

  constructor() {
    this.job = scheduleJob(
      'campaign-sender',
      '7 */5 * * * *',
      async () => {
        await this.tick()
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

  private async tick(): Promise<void> {
    // Un tick lento no puede encimarse con el siguiente: dos workers reclamando a la vez
    // sólo generarían reintentos inútiles sobre el mismo backlog (R4).
    if (this.isRunning) return
    this.isRunning = true
    try {
      // R2 — kill switch: ni una consulta cuando está prendido.
      if (env.MARKETING_KILL_SWITCH === 'true') {
        if (!this.avisoKillSwitchEmitido) {
          logger.warn('[campaign-sender] MARKETING_KILL_SWITCH=true — el tick no reclama nada')
          this.avisoKillSwitchEmitido = true
        }
        return
      }
      this.avisoKillSwitchEmitido = false

      // La lectura de ENTRADA va con retry (`.claude/rules/cron-jobs.md`): un COUNT puro,
      // seguro de repetir si la ráfaga de conexiones del top-of-hour lo tumba con P1001.
      // `reclamarLote`, dos líneas abajo, es un UPDATE — nunca se envuelve: bajo un
      // ECONNRESET a media respuesta no hay forma de saber si ya corrió del lado del
      // servidor, y reintentarlo podría reclamar el lote dos veces. El COUNT es a
      // propósito un SUPERSET de la elegibilidad real de `reclamarLote` (no filtra por
      // `nextAttemptAt`/`leaseUntil`): un falso "sí hay trabajo" sólo cuesta un
      // `reclamarLote` que regresa vacío; un falso "no hay" perdería el tick entero.
      const hayTrabajo = await retry(
        () =>
          prisma.customerCampaignDelivery.count({
            where: { status: { in: ['PENDING', 'RETRYING', 'SENDING'] } },
          }),
        { retries: 2, initialDelay: 1500, shouldRetry: shouldRetryDbConnectionError, context: 'campaign-sender.count' },
      )
      if (hayTrabajo === 0) return

      const reclamadas = await reclamarLote({
        topeGlobal: env.MARKETING_TOPE_GLOBAL_POR_TICK,
        lotePorVenue: env.MARKETING_LOTE_POR_VENUE,
        ahora: new Date(),
      })
      if (reclamadas.length === 0) return

      const resumen: Record<ClaveResumen, number> = { sent: 0, skipped: 0, retrying: 0, dead: 0, unknown: 0 }
      for (const delivery of reclamadas) {
        // R3 — el fallo de UNA delivery no aborta el resto del lote: cada una en su propio
        // try/catch. `enviarDelivery` ya resuelve casi todo como `ResultadoEnvio` (nunca
        // lanza por un resultado de negocio esperado — ver su docstring); sólo deja
        // escapar una excepción si la relectura inicial revienta, y eso también se atrapa
        // aquí para que el resto del lote se siga procesando.
        try {
          const resultado = await enviarDelivery(delivery.id)
          resumen[CLAVE_POR_RESULTADO[resultado]] += 1
        } catch (err) {
          logger.error('[campaign-sender] enviarDelivery reventó para una delivery — se sigue con el resto del lote', {
            deliveryId: delivery.id,
            venueId: delivery.venueId,
            err,
          })
        }
      }

      // R6 — un solo resumen por tick, y sólo porque hubo algo que hacer (con lote vacío
      // ya se salió arriba: nada de "0 de 0" cada 5 minutos).
      logger.info('[campaign-sender] tick', { reclamadas: reclamadas.length, ...resumen })
    } catch (err) {
      // R5 — el job NUNCA lanza hacia arriba: un error de `reclamarLote`, o del COUNT de
      // entrada agotando sus reintentos, se registra y el tick termina limpio. Si escapara,
      // tumbaría el proceso del cron.
      logger.error('[campaign-sender] tick falló', { err })
    } finally {
      this.isRunning = false
    }
  }
}

export const campaignSenderJob = new CampaignSenderJob()
