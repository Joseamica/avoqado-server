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
      await paso('stale requests sweep', () => terminalPaymentService.reconcileStaleRequests())
      // UNKNOWN is not a dead end anymore: a terminal that is back (and stays back) + 20 min with
      // no card payment frees the slot; released rows are still swept for a late payment (see
      // reconcileUnknownRequests). A row parked UNKNOWN by the sweep above is seen by this one in
      // the same tick, which at most stamps "terminal returned" 30 s earlier — never frees it.
      await paso('unknown sweep', () => terminalPaymentService.reconcileUnknownRequests())
      // Ventana de confirmación (plan 16-sep): un negativo de la terminal sin evidencia que lleve ≥ 30 s se libera
      // aquí si el temporizador en proceso no llegó (reinicio, otra instancia). Idempotente por CAS. Un barrido que falle
      // (base caída a media pasada) no puede dejar sin la recuperación del long-poll de S5 a un POS que ya tiene su fila
      // COMPLETED — el barrido se repite en el siguiente tick, el 504 del POS no.
      await paso('confirmation window sweep', () => terminalPaymentService.releaseUnprovenNegativesAfterWindow())
      // S5: un POS que sigue esperando en memoria mientras la fila ya quedó COMPLETED con Payment (el webhook
      // confirmó desde otra instancia, o el aviso se perdió) recibe el resultado durable en vez de un 504.
      await paso('long-poll recovery', () => terminalPaymentService.resolvePendingFromDurableState())
      // S2 («ninguna duda de un cobro sin salida», A4b): la red durable del temporizador de 10 s que suelta la RANURA (nunca la
      // venta) tras el cese acreditado por la terminal nueva (reinicio, o el gancho nunca se llamó). DESPUÉS del rescate del
      // long-poll (revisión A4, I-1): recorre hasta 200 filas en serie y no puede retrasar a un POS que ya tiene su respuesta en la
      // base. Corre aunque el rescate truene.
      await paso('execution-closed release sweep', () => terminalPaymentService.liberarTrasCierreDeEjecucion())
      await paso('approved without references alert recovery', () => recuperarAvisosAprobadosSinReferencias())
    } finally {
      this.isRunning = false
    }
  }
}

export const terminalPaymentWatchdogJob = new TerminalPaymentWatchdogJob()
