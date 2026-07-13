// jobs/terminal-payment-watchdog.job.ts

import { CronJob } from 'cron'
import logger from '../config/logger'
import { terminalPaymentService } from '../services/terminal-payment.service'

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
  private readonly CRON_PATTERN = '*/30 * * * * *'

  constructor() {
    this.job = new CronJob(this.CRON_PATTERN, this.run.bind(this), null, false, 'America/Mexico_City')
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
    try {
      await terminalPaymentService.reconcileStaleRequests()
    } catch (err) {
      logger.error('❌ [Terminal-payment watchdog] pass failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}

export const terminalPaymentWatchdogJob = new TerminalPaymentWatchdogJob()
