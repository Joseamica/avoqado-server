/**
 * CFDI Reconcile Job
 *
 * Closes the one residual double-stamp gap left by the STAMPING-reservation pattern:
 * a process crash / rolling deploy that lands AFTER facturapi stamped but BEFORE we persisted.
 * Such a row sits in `STAMPING` forever; the issuance reclaim path (3-min TTL) would re-stamp it
 * at the PAC → two real fiscal documents. This job reconciles those rows against facturapi first.
 *
 * Each tick: find `Cfdi` rows stuck in `STAMPING` older than the stuck-threshold and, per row,
 * ask the PAC whether a document actually exists (reconcileStuckCfdi):
 *   - COMPLETED   → a stamp was found; row marked STAMPED with downloaded XML/PDF.
 *   - RESET       → the PAC definitively has none; row reset to STAMP_FAILED (retryable).
 *   - INCONCLUSIVE→ PAC unreachable / ambiguous; row left STAMPING for the next tick.
 *
 * Schedule: every 5 minutes (offset to :02 to reduce top-of-hour stampede overlap).
 *
 * Rules:
 *   - Entry DB read MUST be wrapped with retry(fn, shouldRetryDbConnectionError) per
 *     .claude/rules/cron-jobs.md (prevents P1001 stampede deaths at top-of-hour).
 *   - Per-row try/catch: one row's failure must not abort the rest.
 *   - Job does NOT start in test environments (NODE_ENV guard in server.ts).
 */

import { CronJob } from 'cron'
import prisma from '../utils/prismaClient'
import logger from '../config/logger'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'
import { reconcileStuckCfdi, StuckCfdi } from '../services/fiscal/cfdiReconcile.service'
import {
  CANCEL_SYNC_MAX_PER_TICK,
  refreshPendingCancellation,
  syncPendingCancellations,
  tocaRevisarCancelaciones,
} from '../services/fiscal/cfdi.service'
import { NODE_ENV } from '../config/env'
import { asegurarWebhooksFaltantes, defaultAsegurarFaltantesDeps } from '../services/fiscal/facturapiWebhook.service'
import { scheduleJob } from '../observability/jobContext'

// Only reconcile rows that have been STAMPING for longer than this. Comfortably larger than the
// 3-min issuance reclaim TTL (STAMPING_TTL_MS / GLOBAL_STAMPING_TTL_MS) plus a normal stamp's
// duration, so we never race a slow-but-alive stamp — only genuinely crashed reservations qualify.
const STUCK_THRESHOLD_MS = 10 * 60_000

// Bound how many stuck rows a single tick processes (defensive — there should rarely be any).
const MAX_PER_TICK = 200

export class CfdiReconcileJob {
  private job: CronJob | null = null
  private isRunning = false
  /** Última pasada del barrido de cancelaciones (en memoria: el server corre UNA instancia). */
  private ultimaRevisionDeCancelaciones: number | null = null

  constructor() {
    // Every 5 minutes at :02 offset — avoids aligning with top-of-hour / :00 / :05 cron bursts.
    this.job = scheduleJob(
      'cfdi-reconcile',
      '2-59/5 * * * *',
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
    logger.info('[cfdiReconcile] job started — every 5 minutes')
  }

  stop(): void {
    this.job?.stop()
    logger.info('[cfdiReconcile] job stopped')
  }

  /** Manual trigger (for testing / ad-hoc execution). */
  async runNow(): Promise<void> {
    await this.run()
  }

  private async run(): Promise<void> {
    if (this.isRunning) {
      logger.warn('[cfdiReconcile] tick skipped — previous run still in progress')
      return
    }
    this.isRunning = true
    const startTime = Date.now()

    try {
      // Pase 1: cancelaciones que el SAT dejó «en trámite». Independiente del pase de STAMPING: si falla,
      // no impide conciliar timbres atorados (y viceversa).
      // Red de seguridad del webhook de Facturapi: una pasada por hora (ver CANCEL_SYNC_EVERY_MS).
      if (tocaRevisarCancelaciones(this.ultimaRevisionDeCancelaciones, startTime)) {
        this.ultimaRevisionDeCancelaciones = startTime
        await this.syncCancellations(startTime)
        await this.webhooksFaltantes()
      }

      const cutoff = new Date(startTime - STUCK_THRESHOLD_MS)

      // ── Entry read: stuck STAMPING rows older than the threshold ───────────
      // MANDATORY per .claude/rules/cron-jobs.md: wrap with retry to survive the
      // top-of-hour P1001 connection stampede. Pure read — safe to run twice.
      const stuck = (await retry(
        () =>
          prisma.cfdi.findMany({
            where: { status: 'STAMPING', updatedAt: { lt: cutoff } },
            orderBy: { updatedAt: 'asc' },
            take: MAX_PER_TICK,
            select: {
              id: true,
              venueId: true,
              fiscalEmisorId: true,
              status: true,
              isGlobal: true,
              orderId: true,
              facturapiId: true,
              idempotencyKey: true,
              receptorRfc: true,
              totalCents: true,
              createdAt: true,
              updatedAt: true,
            },
          }),
        {
          retries: 2,
          initialDelay: 1500,
          shouldRetry: shouldRetryDbConnectionError,
          context: 'cfdiReconcile.findStuck',
        },
      )) as StuckCfdi[]

      if (stuck.length === 0) {
        this.isRunning = false
        return // nothing to do — keep quiet on the happy path
      }

      logger.info(`[cfdiReconcile] tick started — ${stuck.length} stuck STAMPING row(s)`)

      const sandbox = NODE_ENV !== 'production'
      const now = new Date()
      const tally: Record<string, number> = { COMPLETED: 0, RESET: 0, INCONCLUSIVE: 0, SKIPPED: 0, ERROR: 0 }

      // ── Per-row processing — isolated try/catch ───────────────────────────
      for (const cfdi of stuck) {
        try {
          const result = await reconcileStuckCfdi({ cfdi, now, sandbox })
          tally[result.outcome] = (tally[result.outcome] ?? 0) + 1
          logger.info(`[cfdiReconcile] cfdi=${cfdi.id} outcome=${result.outcome}${result.detail ? ` (${result.detail})` : ''}`)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          logger.error(`[cfdiReconcile] unhandled error for cfdi=${cfdi.id}: ${message}`)
          tally.ERROR += 1
        }
      }

      const durationMs = Date.now() - startTime
      logger.info(`[cfdiReconcile] tick complete — ${stuck.length} row(s) in ${durationMs}ms`, { tally })
    } catch (err) {
      logger.error('[cfdiReconcile] tick failed (top-level)', err)
    } finally {
      this.isRunning = false
    }
  }

  /**
   * Le pregunta al PAC por las cancelaciones que quedaron «en trámite». Sin esto una factura cancelada en
   * el SAT seguía «Timbrada» en Avoqado para siempre y la venta no se podía volver a facturar
   * (Testarudo, A-14, 21→24-sep-2026). Silencioso cuando no hay nada pendiente.
   */
  private async syncCancellations(startTime: number): Promise<void> {
    try {
      const sandbox = NODE_ENV !== 'production'
      const tally = await syncPendingCancellations(
        { sandbox, now: new Date(startTime) },
        {
          findPending: cutoff =>
            retry(
              () =>
                prisma.cfdi.findMany({
                  where: { cancelStatus: 'REQUESTED', cancelRequestedAt: { lt: cutoff } },
                  orderBy: [{ cancelRequestedAt: 'asc' }, { id: 'asc' }],
                  take: CANCEL_SYNC_MAX_PER_TICK,
                  include: { fiscalEmisor: true },
                }),
              { retries: 2, initialDelay: 1500, shouldRetry: shouldRetryDbConnectionError, context: 'cfdiReconcile.findPendingCancels' },
            ),
          refresh: cfdi => refreshPendingCancellation(cfdi, { sandbox }),
        },
      )
      if (tally.revisadas > 0) logger.info('[cfdiReconcile] cancelaciones en trámite revisadas', { tally })
    } catch (err) {
      logger.error('[cfdiReconcile] no se pudieron revisar las cancelaciones en trámite', err)
    }
  }

  /** Emisores sin webhook de Facturapi (los que ya existían, o a los que les falló el alta). Silencioso si no hay. */
  private async webhooksFaltantes(): Promise<void> {
    try {
      const deps = defaultAsegurarFaltantesDeps()
      const tally = await asegurarWebhooksFaltantes({
        ...deps,
        findSinWebhook: () =>
          retry(deps.findSinWebhook, {
            retries: 2,
            initialDelay: 1500,
            shouldRetry: shouldRetryDbConnectionError,
            context: 'cfdiReconcile.findEmisoresSinWebhook',
          }),
      })
      if (tally.revisados > 0) logger.info('[cfdiReconcile] webhooks de Facturapi dados de alta', { tally })
    } catch (err) {
      logger.warn('[cfdiReconcile] no se pudieron revisar los webhooks de Facturapi', err)
    }
  }
}

// Export singleton instance — server.ts calls .start() and .stop()
export const cfdiReconcileJob = new CfdiReconcileJob()
