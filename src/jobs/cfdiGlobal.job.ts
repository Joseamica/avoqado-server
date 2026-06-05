/**
 * CFDI Global Job (Flow C)
 *
 * Daily cron job that issues a factura global to "Público en General" (RFC XAXX010101000)
 * for each active FiscalEmisor, covering all PAID orders in the most-recently closed period
 * (per the emisor's globalPeriodicity) that were NOT individually invoiced (Flow A/B).
 *
 * Schedule: 0 4 * * * (04:00 AM Mexico City — after day-close, before opening hours)
 *
 * Rules:
 *   - Entry DB read MUST be wrapped with retry(fn, shouldRetryDbConnectionError) per
 *     .claude/rules/cron-jobs.md (prevents P1001 stampede deaths at top-of-hour).
 *   - Per-emisor try/catch: one emisor's failure must not abort the rest.
 *   - Job does NOT start in test environments (NODE_ENV guard in server.ts).
 */

import { CronJob } from 'cron'
import prisma from '../utils/prismaClient'
import logger from '../config/logger'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'
import { issueGlobalForEmisor } from '../services/fiscal/cfdiGlobal.service'
import { NODE_ENV } from '../config/env'

export class CfdiGlobalJob {
  private job: CronJob | null = null
  private isRunning = false

  constructor() {
    // 04:00 AM Mexico City — offset from hour boundary to reduce stampede overlap
    this.job = new CronJob(
      '0 4 * * *',
      async () => {
        await this.run()
      },
      null,
      false, // Don't start automatically — server.ts calls .start()
      'America/Mexico_City',
    )
  }

  start(): void {
    this.job?.start()
    logger.info('[cfdiGlobal] job started — daily at 04:00 AM Mexico City')
  }

  stop(): void {
    this.job?.stop()
    logger.info('[cfdiGlobal] job stopped')
  }

  /** Manual trigger (for testing / ad-hoc execution). */
  async runNow(): Promise<void> {
    await this.run()
  }

  private async run(): Promise<void> {
    if (this.isRunning) {
      logger.warn('[cfdiGlobal] tick skipped — previous run still in progress')
      return
    }
    this.isRunning = true
    const startTime = Date.now()

    try {
      logger.info('[cfdiGlobal] tick started')

      // ── Entry read: load all ACTIVE-CSD emisores ──────────────────────────
      // MANDATORY per .claude/rules/cron-jobs.md: wrap with retry to prevent
      // P1001 stampede deaths when many crons fire at the same top-of-hour.
      const emisores = await retry(
        () =>
          prisma.fiscalEmisor.findMany({
            where: { csdStatus: 'ACTIVE' },
            select: { id: true },
          }),
        {
          retries: 2,
          initialDelay: 1500,
          shouldRetry: shouldRetryDbConnectionError,
          context: 'cfdiGlobal.findActiveEmisores',
        },
      )

      logger.info(`[cfdiGlobal] found ${emisores.length} active emisor(s)`)

      const sandbox = NODE_ENV !== 'production'
      const now = new Date()
      const summary: Array<{ emisorId: string; status: string; period?: string; count?: number }> = []

      // ── Per-emisor processing — isolated try/catch ────────────────────────
      for (const { id: emisorId } of emisores) {
        try {
          const result = await issueGlobalForEmisor({ emisorId, now, sandbox })

          const periodLabel = result.period ? `${result.period.meses}/${result.period.anio}` : 'n/a'
          logger.info(
            `[cfdiGlobal] emisor=${emisorId} status=${result.status} period=${periodLabel} candidates=${result.candidateCount ?? 0}`,
          )
          summary.push({ emisorId, status: result.status, period: periodLabel, count: result.candidateCount })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          logger.error(`[cfdiGlobal] unhandled error for emisor=${emisorId}: ${message}`)
          summary.push({ emisorId, status: 'ERROR' })
        }
      }

      const durationMs = Date.now() - startTime
      logger.info(`[cfdiGlobal] tick complete — ${emisores.length} emisor(s) in ${durationMs}ms`, { summary })
    } catch (err) {
      logger.error('[cfdiGlobal] tick failed (top-level)', err)
    } finally {
      this.isRunning = false
    }
  }
}

// Export singleton instance — server.ts calls .start() and .stop()
export const cfdiGlobalJob = new CfdiGlobalJob()
