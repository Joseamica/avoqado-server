// jobs/stripe-webhook-reconciliation.job.ts

import { CronJob } from 'cron'
import { Prisma } from '@prisma/client'
import prisma from '../utils/prismaClient'
import logger from '../config/logger'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'
import { STRIPE_WEBHOOK_MAX_RETRIES, replayStripeWebhookEvent } from '../services/stripe.webhook.service'

/**
 * Stripe PLATFORM webhook reconciliation job
 *
 * Why this exists
 * ---------------
 * The Stripe platform webhook had no recovery path at all, unlike its three
 * siblings (`BlumonWebhookReconciliationJob`,
 * `DeliveryWebhookReconciliationJob`, `ReservationDepositReconciliationJob`).
 * Three facts combined to lose events silently:
 *
 *   1. `webhook.controller.ts` returns **200 to Stripe even when processing
 *      fails** (deliberately, to prevent Stripe retries) → Stripe never
 *      redelivers.
 *   2. `handleStripeWebhookEvent` claims the event with a `create` on a UNIQUE
 *      column, so any second call for the same event id hits P2002 and returns
 *      early → an already-claimed FAILED row could never be reprocessed.
 *   3. Nothing swept FAILED rows.
 *
 * Net effect: one transient blip (DB hiccup, timeout) during
 * `invoice.payment_succeeded` or the base-plan checkout fulfillment — the event
 * that creates the venue's `VenueFeature` tier row — meant **the venue paid and
 * never got its plan**, with no alert. This job closes that hole.
 *
 * Strategy
 * --------
 * 1. Every 5 minutes (offset off the top of the hour, see CRON_PATTERN) pull up
 *    to BATCH_SIZE rows that are FAILED (or stale RETRYING) with
 *    `retryCount < STRIPE_WEBHOOK_MAX_RETRIES`, oldest first.
 * 2. Replay each via `replayStripeWebhookEvent`, which counts the attempt
 *    up-front and reuses the stored payload. That function owns the
 *    SUCCESS/FAILED bookkeeping.
 * 3. Rows that exhaust their attempts are alerted ONCE with a 🚨 line and then
 *    fall out of the query naturally (the `retryCount` guard excludes them), so
 *    they wait for manual investigation instead of looping forever.
 *
 * Stale RETRYING rows are included because a hard crash mid-replay leaves the
 * row in RETRYING; the attempt was already counted, so re-picking it up is safe
 * and bounded.
 */
export class StripeWebhookReconciliationJob {
  private job: CronJob | null = null

  /**
   * Every 5 minutes, offset to minute 3 (3, 8, 13, … 58). The offset matters:
   * `cron-jobs.md` documents a real P1001 stampede when many schedules align on
   * minute :00.
   */
  private readonly CRON_PATTERN = '3-58/5 * * * *'

  /** Cap per pass — each row does real work (Stripe/DB writes). */
  private readonly BATCH_SIZE = 25

  /**
   * A RETRYING row older than this is assumed to be an abandoned in-flight
   * replay (process died) and becomes eligible again. Comfortably longer than
   * any single event's processing time.
   */
  private readonly STALE_RETRYING_MS = 10 * 60 * 1000

  /** Don't chase events older than this — beyond it, it's a manual job. */
  private readonly MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

  constructor() {
    this.job = new CronJob(this.CRON_PATTERN, this.run.bind(this), null, false, 'America/Mexico_City')
  }

  start(): void {
    if (this.job) {
      this.job.start()
      logger.info(
        `🪝 Stripe webhook reconciliation job started — ${this.CRON_PATTERN}, batch ${this.BATCH_SIZE}, max ${STRIPE_WEBHOOK_MAX_RETRIES} attempts`,
      )
    }
  }

  stop(): void {
    if (this.job) {
      this.job.stop()
      logger.info('🪝 Stripe webhook reconciliation job stopped')
    }
  }

  private async run(): Promise<void> {
    const startedAt = Date.now()
    try {
      const { recovered, stillFailing, exhausted } = await this.replayFailed()
      if (recovered > 0 || stillFailing > 0 || exhausted > 0) {
        logger.info('🪝 [Stripe recon] Pass complete', {
          recovered,
          stillFailing,
          exhausted,
          elapsedMs: Date.now() - startedAt,
        })
      }
    } catch (err) {
      logger.error('❌ [Stripe recon] Job pass failed', {
        error: err instanceof Error ? err.message : err,
        stack: err instanceof Error ? err.stack : undefined,
      })
    }
  }

  private async replayFailed(): Promise<{ recovered: number; stillFailing: number; exhausted: number }> {
    const now = Date.now()
    const staleRetryingBefore = new Date(now - this.STALE_RETRYING_MS)
    const minCreatedAt = new Date(now - this.MAX_AGE_MS)

    const where = {
      retryCount: { lt: STRIPE_WEBHOOK_MAX_RETRIES },
      createdAt: { gte: minCreatedAt },
      OR: [
        { status: 'FAILED' as const },
        // Abandoned in-flight replay (process died before SUCCESS/FAILED).
        { status: 'RETRYING' as const, createdAt: { lt: staleRetryingBefore } },
      ],
    } satisfies Prisma.WebhookEventWhereInput

    // Entry read wrapped per `.claude/rules/cron-jobs.md` — a pure read, safe to
    // retry on a P1001 connection stampede.
    const candidates = await retry(
      () =>
        prisma.webhookEvent.findMany({
          where,
          take: this.BATCH_SIZE,
          orderBy: { createdAt: 'asc' },
          select: { id: true, stripeEventId: true, eventType: true, retryCount: true, venueId: true, errorMessage: true },
        }),
      {
        retries: 2,
        initialDelay: 1500,
        shouldRetry: shouldRetryDbConnectionError,
        context: 'stripe-webhook-reconciliation.findFailed',
      },
    )

    if (candidates.length === 0) return { recovered: 0, stillFailing: 0, exhausted: 0 }

    let recovered = 0
    let stillFailing = 0
    let exhausted = 0

    for (const row of candidates) {
      try {
        const result = await replayStripeWebhookEvent(row.id)
        if (result.replayed) {
          recovered++
          logger.info('✅ [Stripe recon] Recovered previously-failed webhook', {
            webhookEventId: row.id,
            stripeEventId: row.stripeEventId,
            eventType: row.eventType,
          })
        }
      } catch (err) {
        stillFailing++
        // `replayStripeWebhookEvent` already flipped the row back to FAILED and
        // the attempt is counted. Decide whether this was the last one.
        const attemptsUsed = row.retryCount + 1
        if (attemptsUsed >= STRIPE_WEBHOOK_MAX_RETRIES) {
          exhausted++
          // Alert ONCE, as the row crosses the threshold — afterwards the
          // `retryCount` guard keeps it out of this query entirely.
          // BetterStack should alert on '🚨 [Stripe recon] EXHAUSTED'.
          logger.error('🚨 [Stripe recon] EXHAUSTED — Stripe event never processed, needs manual reconciliation', {
            webhookEventId: row.id,
            stripeEventId: row.stripeEventId,
            eventType: row.eventType,
            venueId: row.venueId,
            attempts: attemptsUsed,
            lastError: err instanceof Error ? err.message : String(err),
          })
        } else {
          logger.warn('⚠️ [Stripe recon] Replay failed, will retry next pass', {
            webhookEventId: row.id,
            stripeEventId: row.stripeEventId,
            eventType: row.eventType,
            attemptsUsed,
            error: err instanceof Error ? err.message : err,
          })
        }
      }
    }

    return { recovered, stillFailing, exhausted }
  }
}

export const stripeWebhookReconciliationJob = new StripeWebhookReconciliationJob()
