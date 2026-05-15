// jobs/blumon-webhook-reconciliation.job.ts

import { CronJob } from 'cron'
import { EventStatus, ProviderType } from '@prisma/client'
import prisma from '../utils/prismaClient'
import logger from '../config/logger'
import {
  BLUMON_WEBHOOK_ERROR_REASONS,
  BLUMON_WEBHOOK_PENDING_TTL_MS,
  BlumonWebhookPayload,
  reconcileBlumonEvent,
} from '../services/tpv/blumon-webhook.service'

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
 *
 * Pattern matches the existing `AbandonedOrdersCleanupJob` / `tpvHealthMonitorJob`
 * structure used elsewhere in the codebase. Singleton, registered in
 * `src/server.ts`, gracefully stopped on SIGTERM.
 */
export class BlumonWebhookReconciliationJob {
  private job: CronJob | null = null

  /** Run every 30 seconds — sub-minute is fine, the work per pass is small. */
  private readonly CRON_PATTERN = '*/30 * * * * *'

  /** Cap per pass to avoid long transactions if a backlog builds up. */
  private readonly BATCH_SIZE = 100

  constructor() {
    this.job = new CronJob(this.CRON_PATTERN, this.run.bind(this), null, false, 'America/Mexico_City')
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
    const startedAt = Date.now()
    try {
      const reconciled = await this.reconcilePending()
      const orphaned = await this.markOrphaned()
      if (reconciled > 0 || orphaned > 0) {
        logger.info('🪝 [Blumon recon] Pass complete', {
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
    }
  }

  /**
   * Pull PENDING events and retry matching once each.
   * Returns the count of events that newly transitioned out of PENDING.
   */
  private async reconcilePending(): Promise<number> {
    const cutoff = new Date(Date.now() - BLUMON_WEBHOOK_PENDING_TTL_MS)
    const pending = await prisma.providerEventLog.findMany({
      where: {
        provider: ProviderType.PAYMENT_PROCESSOR,
        status: EventStatus.PENDING,
        createdAt: { gte: cutoff },
        // Only Blumon TPV events have eventId starting with 'blumon-tpv-'.
        // Use a startsWith to leave room for other providers in the same table.
        eventId: { startsWith: 'blumon-tpv-' },
      },
      take: this.BATCH_SIZE,
      orderBy: { createdAt: 'asc' },
      select: { id: true, payload: true },
    })

    if (pending.length === 0) return 0

    let resolved = 0
    for (const row of pending) {
      try {
        const payload = row.payload as unknown as BlumonWebhookPayload
        // No explicit scope — `reconcileBlumonEvent` re-resolves the venue
        // scope from `payload.serialNumber` on every pass so a shared Blumon
        // MerchantAccount (one merchant → N venues) doesn't get pinned to the
        // single terminal's venue that was cached at insert time.
        const result = await reconcileBlumonEvent(row.id, payload)
        if (result.action !== 'NOT_FOUND') resolved++
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
   */
  private async markOrphaned(): Promise<number> {
    const cutoff = new Date(Date.now() - BLUMON_WEBHOOK_PENDING_TTL_MS)
    const result = await prisma.providerEventLog.updateMany({
      where: {
        provider: ProviderType.PAYMENT_PROCESSOR,
        status: EventStatus.PENDING,
        createdAt: { lt: cutoff },
        eventId: { startsWith: 'blumon-tpv-' },
      },
      data: {
        status: EventStatus.ERROR,
        errorReason: BLUMON_WEBHOOK_ERROR_REASONS.ORPHANED,
        processedAt: new Date(),
      },
    })

    if (result.count > 0) {
      logger.warn('🚨 [Blumon recon] Marked orphaned events (no Payment match within 24h)', {
        count: result.count,
      })
    }

    return result.count
  }
}

export const blumonWebhookReconciliationJob = new BlumonWebhookReconciliationJob()
