// jobs/terminal-payment-watchdog.job.ts

import { CronJob } from 'cron'
import logger from '../config/logger'
import { terminalPaymentService } from '../services/terminal-payment.service'
import { DATABASE_JOB_SCHEDULES } from './jobSchedules'
import { scheduleJob } from '../observability/jobContext'
import { recuperarAvisosAprobadosSinReferencias } from '../services/tpv/angelpay-webhook.service'

/**
 * Terminal Payment Watchdog
 *
 * The POS→TPV arbitration lock is a durable `TerminalPaymentRequest` row whose
 * partial UNIQUE index holds a per-terminal slot. The happy path closes the row
 * (socket result, or the TPV's REST payment-record). This job is the recovery
 * backstop for rows that never got closed (socket result lost, server restart
 * mid-payment, TPV crash):
 *
 *   • stale in-flight (past expiresAt) or cancel-requested past a short grace →
 *     if a Payment exists for the order, mark COMPLETED (late); otherwise mark
 *     UNKNOWN and HOLD the slot (never free blind — the PAX may still be
 *     mid-charge; freeing would risk a double charge) + emit a 🚨 alert.
 *
 * The entry read is retry-wrapped inside `reconcileStaleRequests` per
 * .claude/rules/cron-jobs.md. Singleton, registered in `src/server.ts`,
 * gracefully stopped on SIGTERM. Runs once at boot to catch rows orphaned by a
 * restart, then every 30s.
 */
export class TerminalPaymentWatchdogJob {
  private job: CronJob | null = null
  private readonly CRON_PATTERN = DATABASE_JOB_SCHEDULES.terminalPaymentWatchdog
  private isRunning = false

  constructor() {
    this.job = scheduleJob('terminal-payment-watchdog', this.CRON_PATTERN, this.run.bind(this), null, false, 'America/Mexico_City')
  }

  start(): void {
    if (this.job) {
      this.job.start()
      logger.info('🛡️ Terminal-payment watchdog started — every 30s (boot sweep + reconcile)')
      // Boot sweep: reconcile rows orphaned by a restart before the first tick.
      void this.run()
    }
  }

  stop(): void {
    if (this.job) {
      this.job.stop()
      logger.info('🛡️ Terminal-payment watchdog stopped')
    }
  }

  /** Exposed for tests / manual runs. */
  async run(): Promise<void> {
    if (this.isRunning) {
      logger.warn('[Terminal-payment watchdog] tick skipped — previous run still in progress')
      return
    }
    this.isRunning = true

    // Revisión A4 · fix round 2 (ruling del controlador, 21-oct): CADA paso en su propio try/catch. Antes un fallo del rescate
    // del long-poll (o de un barrido anterior) saltaba el resto de la pasada; una falla persistente dejaba sin correr, para
    // siempre, la liberación tras el cese (S2) y la terminal no se soltaba nunca. El orden se conserva.
    const paso = async (nombre: string, fn: () => Promise<unknown>): Promise<void> => {
      try {
        await fn()
      } catch (err) {
        logger.error(`❌ [Terminal-payment watchdog] ${nombre} failed`, { error: err instanceof Error ? err.message : String(err) })
      }
    }
    try {
      // 🔴 Cobro simple · S1 (22-nov): «sin respuesta ⇒ 10 s ⇒ no cobrado». Vencidas en vuelo o canceladas sin respuesta entran a
      // «sin respuesta» (el cancel otra vez a la terminal).
      await paso('stale requests sweep', () => terminalPaymentService.reconcileStaleRequests())
      // Las SENT con acuse de hace > 60 s sin final: se le pregunta a la terminal; sin «sigo cobrando», «sin respuesta».
      await paso('sent without final sweep', () => terminalPaymentService.preguntarPorSolicitudesSinFinal())
      // La conciliación tardía de lo ya cerrado (un Payment registrado sin el requestId) y la sonda a las UNKNOWN.
      await paso('unknown sweep', () => terminalPaymentService.reconcileUnknownRequests())
      // La RED del temporizador de 10 s (reinicio, publicación) y las filas de antes de S1 (S1.4): cierra lo vencido.
      await paso('no-response close sweep', () => terminalPaymentService.cerrarSinRespuestaVencidas())
      // S5: un POS que sigue esperando en memoria mientras la fila ya quedó COMPLETED con Payment recibe el resultado durable.
      await paso('long-poll recovery', () => terminalPaymentService.resolvePendingFromDurableState())
      await paso('approved without references alert recovery', () => recuperarAvisosAprobadosSinReferencias())
    } finally {
      this.isRunning = false
    }
  }
}

export const terminalPaymentWatchdogJob = new TerminalPaymentWatchdogJob()
