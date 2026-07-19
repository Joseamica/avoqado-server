// jobs/delivery-webhook-reconciliation.job.ts

import { CronJob } from 'cron'
import { DeliveryOrderEventStatus, Prisma } from '@prisma/client'
import prisma from '../utils/prismaClient'
import logger from '../config/logger'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'
import { parseDeliverectOrder } from '../services/delivery-channels/providers/deliverect/deliverect.mapper'
import { ingestDeliveryOrder } from '../services/delivery-channels/core/deliveryOrderIngestion.service'
import { markEventResult } from '../services/delivery-channels/core/deliveryWebhookEvent.service'

/**
 * Delivery order webhook reconciliation job.
 *
 * Sweeps `DeliveryOrderEvent` rows that never reached a terminal state:
 *
 *   • FAILED — ingestion threw AFTER the event was persisted. The controller
 *     already ACKed 200 to the provider (`deliverect.webhook.controller.ts`),
 *     so the provider will NOT re-post; this job is the only thing that
 *     retries it.
 *   • RECEIVED older than 10 minutes — the Task 5 Critical: `ingestDeliveryOrder`
 *     can succeed while the FOLLOW-UP bookkeeping write (`markEventResult`)
 *     itself fails, leaving the row stuck in RECEIVED forever. The provider
 *     won't retry (dedup already has the event via the unique index), so
 *     without this sweep the event is invisible to any retry path.
 *
 * Re-processing is safe because `ingestDeliveryOrder` upserts the Order by
 * `venueId_externalId` and gates Payment creation behind a count===0 guard —
 * replaying an event whose order already exists just re-confirms it and lands
 * on `markEventResult(PROCESSED, orderId)`, exactly the write the original
 * request couldn't make.
 *
 * A RECEIVED event younger than 10 minutes is left untouched — it may still
 * be mid-flight inside the live request that created it.
 *
 * Events older than 24h (FAILED or RECEIVED) are swept to `error: 'ORPHANED'`
 * (status stays FAILED — this model has no ERROR status) and are excluded
 * from every future pass via `error: { not: 'ORPHANED' }`, so a permanently
 * broken payload (or a channel link that was deleted) doesn't get retried
 * forever.
 *
 * Structure mirrors `blumon-webhook-reconciliation.job.ts`: singleton class,
 * CronJob, `America/Mexico_City`, start()/stop() registered in `src/server.ts`.
 */
export class DeliveryWebhookReconciliationJob {
  private job: CronJob | null = null

  /** Every 2 minutes at :45s — NEVER :00, anti-stampede rule (.claude/rules/cron-jobs.md). */
  private readonly CRON_PATTERN = '45 */2 * * * *'

  /** Cap per pass to avoid long transactions if a backlog builds up. */
  private readonly BATCH_SIZE = 50

  /** A RECEIVED event younger than this may still be mid-flight in the live request that created it. */
  private readonly RECEIVED_MIN_AGE_MS = 10 * 60_000

  /** Events older than this (FAILED or RECEIVED) are swept to ORPHANED and never retried again. */
  private readonly ORPHAN_TTL_MS = 24 * 3600_000

  /** Sentinel written to `error` by the ORPHANED sweep — used to exclude already-orphaned rows from every future pass. */
  private static readonly ORPHANED_MARKER = 'ORPHANED'

  /**
   * Fix B2 (audit §10.2): without an attempt cap, a handful of permanently-broken
   * ("poison") events — malformed payload, deleted dependency, whatever keeps
   * throwing — would occupy a BATCH_SIZE slot on EVERY pass (~720 times/24h),
   * starving younger events out of the batch. Once a row's attemptCount reaches
   * this, the scan query excludes it forever: it stays FAILED, gets logged once
   * (the pass that pushed it over the cap), and is never selected again.
   * attemptCount/nextAttemptAt track ONLY this job's own retry attempts — the
   * original webhook ingestion failure that first set status=FAILED does not
   * count towards it.
   */
  private readonly MAX_ATTEMPTS = 10

  /** Backoff cap in minutes for `nextAttemptAt` scheduling (exponential: 2^attemptCount, capped here). */
  private readonly BACKOFF_CAP_MINUTES = 60

  start(): void {
    if (this.job) return
    this.job = new CronJob(this.CRON_PATTERN, () => void this.runOnce(), null, false, 'America/Mexico_City')
    this.job.start()
    logger.info(`🛵 Delivery webhook reconciliation job started — every 2min, batch ${this.BATCH_SIZE}`)
  }

  stop(): void {
    if (!this.job) return
    this.job.stop()
    this.job = null
    logger.info('🛵 Delivery webhook reconciliation job stopped')
  }

  /**
   * One pass. Returns counters (never throws — a failed pass just retries on
   * the next tick, same as `blumon-webhook-reconciliation.job.ts`).
   */
  async runOnce(): Promise<{ reprocessed: number; orphaned: number }> {
    const startedAt = Date.now()
    try {
      const { reprocessed, orphanedImmediate } = await this.reprocessStuckEvents()
      const orphanedSwept = await this.markOrphaned()
      const orphaned = orphanedImmediate + orphanedSwept
      if (reprocessed > 0 || orphaned > 0) {
        logger.info('🛵 [Delivery recon] Pass complete', { reprocessed, orphaned, elapsedMs: Date.now() - startedAt })
      }
      return { reprocessed, orphaned }
    } catch (err) {
      logger.error('❌ [Delivery recon] Job pass failed', {
        error: err instanceof Error ? err.message : err,
        stack: err instanceof Error ? err.stack : undefined,
      })
      return { reprocessed: 0, orphaned: 0 }
    }
  }

  /**
   * Pull FAILED (<24h) + stuck RECEIVED (10min–24h) events and retry each once.
   * `channelLinkId === null` (channel link deleted) is an immediate ORPHANED —
   * there is nothing to re-parse against, so waiting out the 24h TTL would
   * just waste passes.
   */
  private async reprocessStuckEvents(): Promise<{ reprocessed: number; orphanedImmediate: number }> {
    const now = Date.now()
    const orphanCutoff = new Date(now - this.ORPHAN_TTL_MS)
    const receivedCutoff = new Date(now - this.RECEIVED_MIN_AGE_MS)

    const events = await retry(
      () =>
        prisma.deliveryOrderEvent.findMany({
          where: {
            AND: [
              // Never re-pick a row the ORPHANED sweep already gave up on. Written as an
              // explicit null-tolerant OR (rather than a bare `error: { not: 'ORPHANED' }`)
              // so rows with error=null (never failed before) are NOT accidentally excluded —
              // same pattern as blumon-webhook-reconciliation.job.ts's REVERSAL_OPERATION_TYPES guard.
              { OR: [{ error: null }, { error: { not: DeliveryWebhookReconciliationJob.ORPHANED_MARKER } }] },
              {
                OR: [
                  { status: DeliveryOrderEventStatus.FAILED, receivedAt: { gte: orphanCutoff } },
                  { status: DeliveryOrderEventStatus.RECEIVED, receivedAt: { gte: orphanCutoff, lt: receivedCutoff } },
                ],
              },
              // Fix B2: never re-select a poison event (maxed out its retry budget) —
              // it stays FAILED forever, excluded here rather than re-touched every pass.
              { attemptCount: { lt: this.MAX_ATTEMPTS } },
              // Fix B2: respect the backoff window — a row that just failed schedules
              // nextAttemptAt in the future and must not be re-picked before then.
              // Null-tolerant (never-yet-retried rows have nextAttemptAt=null by default).
              { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date(now) } }] },
            ],
          },
          orderBy: { receivedAt: 'asc' },
          take: this.BATCH_SIZE,
          include: { channelLink: true },
        }),
      { shouldRetry: shouldRetryDbConnectionError, context: 'deliveryWebhookReconciliation.scan' },
    )

    if (events.length === 0) return { reprocessed: 0, orphanedImmediate: 0 }

    let reprocessed = 0
    let orphanedImmediate = 0

    for (const event of events) {
      const { channelLink } = event
      try {
        if (!channelLink) {
          // Same per-event alert shape/prefix as the 24h sweep below — BetterStack
          // alerts on the '🚨 [Delivery recon] ORPHANED' pattern. Without this, a
          // deleted DeliveryChannelLink (venue turning off its integration) would
          // orphan events silently, with only an aggregate info-level count.
          logger.error('🚨 [Delivery recon] ORPHANED delivery event — channel link deleted, nothing to re-parse against', {
            eventId: event.id,
            provider: event.provider,
            externalEventId: event.externalEventId,
            venueId: event.venueId,
            reason: 'CHANNEL_LINK_DELETED',
            ageHours: Math.round((Date.now() - new Date(event.receivedAt).getTime()) / 3_600_000),
          })
          await markEventResult(event.id, DeliveryOrderEventStatus.FAILED, undefined, DeliveryWebhookReconciliationJob.ORPHANED_MARKER)
          orphanedImmediate++
          continue
        }

        const normalized = parseDeliverectOrder(Buffer.from(JSON.stringify(event.payload)), channelLink)
        const { order } = await ingestDeliveryOrder(normalized, channelLink)
        await markEventResult(event.id, DeliveryOrderEventStatus.PROCESSED, order.id)
        reprocessed++
      } catch (err) {
        // Fix B2: track this job's own retry attempts + schedule exponential
        // backoff so a poison event doesn't occupy every 2-minute pass forever.
        // The row itself is left FAILED/RECEIVED either way — only the
        // attemptCount/nextAttemptAt bookkeeping changes here.
        const attemptCount = (event.attemptCount ?? 0) + 1
        const isPoison = attemptCount >= this.MAX_ATTEMPTS
        const nextAttemptAt = isPoison ? null : new Date(now + this.backoffMs(attemptCount))

        try {
          await prisma.deliveryOrderEvent.update({
            where: { id: event.id },
            data: { attemptCount, nextAttemptAt },
          })
        } catch (bookErr) {
          // Best-effort — same per-event isolation guarantee as the rest of this
          // loop: a failed bookkeeping write must NEVER abort the batch. Worst
          // case the row keeps its old attemptCount/nextAttemptAt and gets
          // reselected next pass with no backoff applied yet (never worse than
          // pre-fix behavior).
          logger.error('❌ [Delivery recon] Failed to persist attemptCount/nextAttemptAt backoff bookkeeping (event stays for next pass)', {
            eventId: event.id,
            error: bookErr instanceof Error ? bookErr.message : bookErr,
          })
        }

        if (isPoison) {
          // Logged exactly ONCE: the pass that pushes attemptCount to MAX_ATTEMPTS
          // is the last one that will ever select this row again (excluded by the
          // scan's attemptCount filter from here on) — no repeat alerts.
          logger.error('🚨 [Delivery recon] POISON delivery event — reached MAX_ATTEMPTS, giving up (stays FAILED, never retried again)', {
            eventId: event.id,
            provider: event.provider,
            externalEventId: event.externalEventId,
            venueId: event.venueId,
            attemptCount,
          })
        } else {
          logger.error('❌ [Delivery recon] Failed to reprocess event (stays for next pass, unless >24h old)', {
            eventId: event.id,
            status: event.status,
            attemptCount,
            nextAttemptAt,
            error: err instanceof Error ? err.message : err,
          })
        }
      }
    }

    return { reprocessed, orphanedImmediate }
  }

  /** Fix B2: exponential backoff in ms — `2^attemptCount` minutes, capped at `BACKOFF_CAP_MINUTES`. */
  private backoffMs(attemptCount: number): number {
    return Math.min(2 ** attemptCount, this.BACKOFF_CAP_MINUTES) * 60_000
  }

  /**
   * Sweep FAILED/RECEIVED events older than 24h to `error: 'ORPHANED'`.
   * Bulk `updateMany` is fine — these are not eligible for further retries.
   */
  private async markOrphaned(): Promise<number> {
    const cutoff = new Date(Date.now() - this.ORPHAN_TTL_MS)
    const orphanWhere = {
      status: { in: [DeliveryOrderEventStatus.FAILED, DeliveryOrderEventStatus.RECEIVED] },
      receivedAt: { lt: cutoff },
      // Idempotent — never re-log/re-touch a row already marked ORPHANED. Null-tolerant
      // OR (not a bare `not: 'ORPHANED'`) so error=null rows (first time aging out) still match.
      OR: [{ error: null }, { error: { not: DeliveryWebhookReconciliationJob.ORPHANED_MARKER } }],
    } satisfies Prisma.DeliveryOrderEventWhereInput

    // Fetch rows BEFORE flipping them so we can emit a per-event alert with enough detail
    // for manual reconciliation (pattern: blumon recon job). Capped at BATCH_SIZE — same cap
    // as the rest of the job — so a large orphan backlog can't be loaded into memory (and
    // logged, one line per row) in a single unbounded pass; it finishes across subsequent
    // 2-minute passes instead.
    const toOrphan = await prisma.deliveryOrderEvent.findMany({
      where: orphanWhere,
      select: { id: true, provider: true, externalEventId: true, status: true, venueId: true, receivedAt: true },
      take: this.BATCH_SIZE,
    })

    if (toOrphan.length === 0) return 0

    for (const row of toOrphan) {
      logger.error('🚨 [Delivery recon] ORPHANED delivery event — never reached a terminal state within 24h', {
        eventId: row.id,
        provider: row.provider,
        externalEventId: row.externalEventId,
        previousStatus: row.status,
        venueId: row.venueId,
        ageHours: Math.round((Date.now() - new Date(row.receivedAt).getTime()) / 3_600_000),
      })
    }

    // Scope the bulk flip to EXACTLY the rows just fetched/logged above — `updateMany` has no
    // `take`, so re-using the broader `orphanWhere` here would flip every matching row
    // regardless of the fetch cap, silently marking rows ORPHANED (and excluding them from all
    // future passes) WITHOUT ever emitting their per-event alert. Scoping by id keeps the
    // alert and the state change in lockstep and keeps this pass genuinely bounded.
    const result = await prisma.deliveryOrderEvent.updateMany({
      where: { id: { in: toOrphan.map(row => row.id) } },
      data: {
        status: DeliveryOrderEventStatus.FAILED,
        error: DeliveryWebhookReconciliationJob.ORPHANED_MARKER,
        processedAt: new Date(),
      },
    })

    logger.warn('🚨 [Delivery recon] Marked orphaned delivery events (no terminal state within 24h)', { count: result.count })

    return result.count
  }
}

export const deliveryWebhookReconciliationJob = new DeliveryWebhookReconciliationJob()
