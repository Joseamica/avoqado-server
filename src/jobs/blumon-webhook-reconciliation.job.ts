// jobs/blumon-webhook-reconciliation.job.ts

import { CronJob } from 'cron'
import { EventStatus, Prisma, ProviderType } from '@prisma/client'
import prisma from '../utils/prismaClient'
import logger from '../config/logger'
import {
  BLUMON_WEBHOOK_ERROR_REASONS,
  BLUMON_WEBHOOK_PENDING_TTL_MS,
  BlumonWebhookPayload,
  REVERSAL_OPERATION_TYPES,
  reconcileBlumonEvent,
} from '../services/tpv/blumon-webhook.service'
import { vencerLapidasSinRespuesta } from '../services/tpv/reversoDeLaTerminal.service'
import { DATABASE_JOB_SCHEDULES } from './jobSchedules'
import { scheduleJob } from '../observability/jobContext'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'

/**
 * Blumon TPV webhook async reconciliation job
 *
 * Handles the residual cases that the inline 5s retry inside
 * `processBlumonPaymentWebhook` cannot cover:
 *
 *   • TPV recorded the Payment 30s+ after Blumon webhook arrived (slow 4G,
 *     offline queue replay, app killed mid-record).
 *   • TPV will eventually record it within 24h (offline queue is bounded by
 *     `PaymentSyncWorker` retries on the device).
 *
 * Strategy
 * --------
 * 1. Every 30s pull up to 100 PENDING events younger than 24h, oldest first.
 * 2. Try the same matching logic again — but with `skipRetries=true` since
 *    we're already on a periodic schedule.
 * 3. Update each event row inline (status=PROCESSED on match,
 *    status=ERROR + errorReason=AMOUNT_MISMATCH on discrepancy, stays PENDING
 *    if still no match).
 * 4. Once per pass, sweep events older than 24h still PENDING → ERROR with
 *    errorReason=ORPHANED. Ops dashboards filter on that.
 * 5. (SDK propio, Tarea 6) Nothing is touched before its `nextAttemptAt` (the
 *    receiver's exclusive window). An event that entered WITH our attempt link
 *    is recovered by `reconcileBlumonEvent` through the shared core, with the
 *    identity and tariff saved at ingress — never the weak matching.
 * 6. (SDK propio, Tarea 7) Before anything else, each pass expires reversal
 *    tombstones still `reversing` past `VENTANA_DEL_REVERSO_MS` (→
 *    `reverse_unconfirmed`), so a webhook held by one is released in the same pass.
 *
 * Pattern matches the existing `AbandonedOrdersCleanupJob` / `tpvHealthMonitorJob`
 * structure used elsewhere in the codebase. Singleton, registered in
 * `src/server.ts`, gracefully stopped on SIGTERM.
 */
export class BlumonWebhookReconciliationJob {
  private job: CronJob | null = null

  /** Run every 30 seconds — sub-minute is fine, the work per pass is small. */
  private readonly CRON_PATTERN = DATABASE_JOB_SCHEDULES.blumonWebhookReconciliation
  private isRunning = false

  /** Cap per pass to avoid long transactions if a backlog builds up. */
  private readonly BATCH_SIZE = 100

  constructor() {
    this.job = scheduleJob('blumon-webhook-reconciliation', this.CRON_PATTERN, this.run.bind(this), null, false, 'America/Mexico_City')
  }

  start(): void {
    if (this.job) {
      this.job.start()
      logger.info(
        `🪝 Blumon webhook reconciliation job started — every 30s, batch ${this.BATCH_SIZE}, TTL ${BLUMON_WEBHOOK_PENDING_TTL_MS / 3600_000}h`,
      )
    }
  }

  stop(): void {
    if (this.job) {
      this.job.stop()
      logger.info('🪝 Blumon webhook reconciliation job stopped')
    }
  }

  private async run(): Promise<void> {
    if (this.isRunning) {
      logger.warn('[Blumon recon] tick skipped — previous run still in progress')
      return
    }
    this.isRunning = true
    const startedAt = Date.now()
    try {
      // Un solo «ahora» por pase (Tarea 7, pendiente de la 6): lo que `reconcilePending` deja fuera por su turno, `markOrphaned`
      // tampoco lo vence. Primero las lápidas del reverso que vencieron: así su aviso retenido sale en este mismo pase.
      const ahora = new Date()
      // F8: una falla del barrido de lápidas (p. ej. P1001) no tumba el pase: los avisos pendientes se recuperan igual.
      let lapidasVencidas = 0
      try {
        lapidasVencidas = await vencerLapidasSinRespuesta(ahora)
      } catch (err) {
        logger.error('❌ [Blumon recon] El barrido de lápidas del reverso falló — el pase sigue con los avisos pendientes', {
          error: err instanceof Error ? err.message : err,
          stack: err instanceof Error ? err.stack : undefined,
        })
      }
      // F5: los avisos que este pase intentó; `markOrphaned` no vence uno con contexto que no se intentó (quedó fuera del lote).
      const intentados = new Set<string>()
      const reconciled = await this.reconcilePending(ahora, intentados)
      const orphaned = await this.markOrphaned(ahora, intentados)
      if (reconciled > 0 || orphaned > 0 || lapidasVencidas > 0) {
        logger.info('🪝 [Blumon recon] Pass complete', {
          lapidasVencidas,
          reconciled,
          orphaned,
          elapsedMs: Date.now() - startedAt,
        })
      }
    } catch (err) {
      logger.error('❌ [Blumon recon] Job pass failed', {
        error: err instanceof Error ? err.message : err,
        stack: err instanceof Error ? err.stack : undefined,
      })
    } finally {
      this.isRunning = false
    }
  }

  /**
   * Pull PENDING events and retry matching once each.
   * Returns the count of events that newly transitioned out of PENDING.
   */
  async reconcilePending(now: Date = new Date(), intentados?: Set<string>): Promise<number> {
    const cutoff = new Date(now.getTime() - BLUMON_WEBHOOK_PENDING_TTL_MS)
    const pending = await retry(
      () =>
        prisma.providerEventLog.findMany({
          take: this.BATCH_SIZE,
          where: {
            provider: ProviderType.PAYMENT_PROCESSOR,
            status: EventStatus.PENDING,
            // Only Blumon TPV events have eventId starting with 'blumon-tpv-'.
            // Use a startsWith to leave room for other providers in the same table.
            eventId: { startsWith: 'blumon-tpv-' },
            AND: [
              // Reversals are informational — they must never enter the sale
              // reconciliation path. Written as an explicit exclusion (rather than
              // `type: 'VENTA'`) so rows typed 'UNKNOWN' or null — which ARE sales —
              // keep being reconciled.
              { OR: [{ type: null }, { type: { notIn: [...REVERSAL_OPERATION_TYPES] } }] },
              // Tarea 6: la exclusiva del receptor (y de quien programe el siguiente turno): nada antes de su `nextAttemptAt`.
              // Los PENDING de antes (`nextAttemptAt` null) siguen como hoy.
              { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
              // La ventana de 24 h. Un evento con turno (con contexto) que la cruzó esperando su turno recibe su último
              // intento por el vínculo; si sigue PENDING, `markOrphaned` lo vence justo después en el mismo pase.
              { OR: [{ createdAt: { gte: cutoff } }, { nextAttemptAt: { not: null } }] },
            ],
          },
          orderBy: { createdAt: 'asc' },
          select: { id: true, payload: true },
        }),
      { retries: 2, initialDelay: 1500, shouldRetry: shouldRetryDbConnectionError, context: 'blumon-webhook-reconciliation.findPending' },
    )

    if (pending.length === 0) return 0

    let resolved = 0
    for (const row of pending) {
      intentados?.add(row.id)
      try {
        const payload = row.payload as unknown as BlumonWebhookPayload
        // No explicit scope — `reconcileBlumonEvent` re-resolves the venue
        // scope from `payload.serialNumber` on every pass so a shared Blumon
        // MerchantAccount (one merchant → N venues) doesn't get pinned to the
        // single terminal's venue that was cached at insert time.
        const result = await reconcileBlumonEvent(row.id, payload)
        // Con contexto, el núcleo contesta PENDING cuando el evento sigue esperando (p. ej. AMOUNT_MISMATCH): no salió.
        // HELD_BY_REVERSAL: retenido por la lápida del reverso, sigue PENDING.
        if (result.action !== 'NOT_FOUND' && result.action !== 'PENDING' && result.action !== 'HELD_BY_REVERSAL') resolved++
      } catch (err) {
        logger.error('❌ [Blumon recon] Failed to retry event', {
          eventLogId: row.id,
          error: err instanceof Error ? err.message : err,
        })
      }
    }

    return resolved
  }

  /**
   * Promote stale PENDING events (> TTL) to ERROR with errorReason=ORPHANED.
   * Bulk update is fine — these are not eligible for further retries.
   * F5: un evento con contexto (`nextAttemptAt` no nulo: el que `reconcilePending` todavía intenta pasadas las 24 h) sólo se
   * vence si ESTE pase lo intentó (`intentados`); uno que quedó fuera del lote espera al siguiente pase, que lo toma primero
   * (orden por antigüedad), así que no se atasca.
   */
  async markOrphaned(now: Date = new Date(), intentados: ReadonlySet<string> = new Set()): Promise<number> {
    const cutoff = new Date(now.getTime() - BLUMON_WEBHOOK_PENDING_TTL_MS)
    const orphanWhere = {
      provider: ProviderType.PAYMENT_PROCESSOR,
      status: EventStatus.PENDING,
      createdAt: { lt: cutoff },
      eventId: { startsWith: 'blumon-tpv-' },
      AND: [
        // Never orphan-alert a reversal: it is money LEAVING, so "charge with no
        // Avoqado payment" would be a false alarm. Same NULL-tolerant exclusion
        // as the pending sweep above.
        { OR: [{ type: null }, { type: { notIn: [...REVERSAL_OPERATION_TYPES] } }] },
        // Tarea 6: nunca se vence un evento antes de su turno: su recuperación por el vínculo todavía va a correr.
        { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
        // F5: con contexto, sólo si este pase ya le dio su último intento.
        { OR: [{ nextAttemptAt: null }, { id: { in: [...intentados] } }] },
      ],
    } satisfies Prisma.ProviderEventLogWhereInput

    // Fetch the rows BEFORE flipping them so we can emit a per-event alert with
    // enough detail for manual reconciliation. An ORPHANED event means Blumon
    // confirmed a charge but no Avoqado Payment ever recorded it (e.g. the TPV
    // never synced its offline queue). Ops must reconcile these by hand.
    // BetterStack alerts on the '🚨 [Blumon recon] ORPHANED' message.
    const toOrphan = await prisma.providerEventLog.findMany({
      where: orphanWhere,
      select: { id: true, venueId: true, terminalId: true, payload: true, createdAt: true },
    })

    if (toOrphan.length === 0) return 0

    for (const row of toOrphan) {
      const p = row.payload as unknown as BlumonWebhookPayload
      logger.error('🚨 [Blumon recon] ORPHANED webhook — Blumon charge with NO Avoqado payment', {
        eventLogId: row.id,
        venueId: row.venueId,
        terminalId: row.terminalId,
        amount: p?.amount,
        authorizationCode: p?.authorizationCode, // R6: sin lastFour en el log
        reference: p?.reference,
        operationNumber: p?.operationNumber,
        serialNumber: p?.serialNumber,
        ageHours: Math.round((Date.now() - new Date(row.createdAt).getTime()) / 3_600_000),
      })
    }

    const result = await prisma.providerEventLog.updateMany({
      where: orphanWhere,
      data: {
        status: EventStatus.ERROR,
        errorReason: BLUMON_WEBHOOK_ERROR_REASONS.ORPHANED,
        processedAt: new Date(),
      },
    })

    logger.warn('🚨 [Blumon recon] Marked orphaned events (no Payment match within 24h)', {
      count: result.count,
    })

    return result.count
  }
}

export const blumonWebhookReconciliationJob = new BlumonWebhookReconciliationJob()
