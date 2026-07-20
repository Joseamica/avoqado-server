/**
 * Symmetric Payment→webhook audit for Blumon TPV.
 *
 * `blumon-webhook-reconciliation.job.ts` answers one direction: "a webhook
 * arrived — is there a Payment?". This job answers the INVERSE, which was
 * invisible until now: "a card Payment was recorded — did its Blumon webhook
 * ever arrive?".
 *
 * That blind spot is the Mindform $1,400 class (2026-07-16): the bank approved
 * and the charge captured, but nothing on our side ever cross-checked the
 * Payment against Blumon's confirmation.
 *
 * READ-ONLY except for a single idempotent antispam stamp
 * (`processorData.webhookAuditAlertedAt`), so the same payment alerts once.
 *
 * Window: 30 min old (give the webhook time to arrive) … 48 h old (bounded
 * scan). All time math is done in SQL/UTC — never in the process's local zone.
 * BetterStack alerts on the '🚨 [Blumon audit]' log line.
 *
 * Scoped to webhook-enabled merchants (see the EXISTS clause below): merchants
 * whose Blumon affiliation never delivers webhooks to us ("Externo"/aggregator
 * accounts) are excluded, because "no webhook" is their normal state — alerting
 * on them is noise that would bury a genuine orphan at a real merchant.
 */

import { CronJob } from 'cron'
import prisma from '../utils/prismaClient'
import logger from '../config/logger'
import retry, { shouldRetryDbConnectionError } from '../utils/retry'

interface AuditRow {
  id: string
  amount: string
  authorizationNumber: string | null
  createdAt: Date
  venueName: string | null
}

interface WebhookGapRow {
  merchant: string | null
  serial: string
  posId: string | null
  payments: number
  totalAmount: string
  lastPayment: Date
}

export class BlumonPaymentAuditJob {
  private job: CronJob | null = null
  private gapJob: CronJob | null = null

  /** Every 10 minutes — the window is 30min–48h, so cadence need not be tight. */
  private readonly CRON_PATTERN = '0 */10 * * * *'

  /**
   * Daily at 08:00 Mexico City. The per-payment scan above stays quiet for
   * merchants that never deliver webhooks (see its EXISTS clause) so the 🚨
   * alert doesn't fatigue — but the FACT that a production merchant has card
   * volume with zero webhook reconciliation is exactly what ops needs to see.
   * This report surfaces that gap once a day, as one line, so it's actionable
   * (register the affiliation's webhook with Blumon) without per-payment spam.
   */
  private readonly GAP_CRON_PATTERN = '0 0 8 * * *'

  private readonly BATCH_SIZE = 50

  start(): void {
    if (!this.job) {
      this.job = new CronJob(this.CRON_PATTERN, () => void this.runOnce(), null, false, 'America/Mexico_City')
      this.job.start()
      logger.info('🪝 Blumon payment audit job started — every 10min, window 30min–48h')
    }
    if (!this.gapJob) {
      this.gapJob = new CronJob(this.GAP_CRON_PATTERN, () => void this.reportWebhookGaps(), null, false, 'America/Mexico_City')
      this.gapJob.start()
      logger.info('🪝 Blumon webhook-gap report started — daily 08:00 America/Mexico_City')
    }
  }

  stop(): void {
    if (this.job) {
      this.job.stop()
      this.job = null
    }
    if (this.gapJob) {
      this.gapJob.stop()
      this.gapJob = null
    }
    logger.info('🛑 Blumon payment audit job stopped')
  }

  /**
   * One pass. Returns how many payments were alerted (0 on a transient failure,
   * so a blip is never mistaken for "nothing pending" — it just retries next tick).
   */
  async runOnce(): Promise<number> {
    let rows: AuditRow[]

    try {
      // Retried because a dropped connection here would otherwise look
      // identical to "no missing webhooks" (repo pattern: src/utils/retry.ts).
      rows = await retry(
        () =>
          prisma.$queryRaw<AuditRow[]>`
            SELECT p.id,
                   p.amount::text AS amount,
                   p."authorizationNumber",
                   p."createdAt",
                   v.name AS "venueName"
            FROM "Payment" p
            JOIN "MerchantAccount" ma ON ma.id = p."merchantAccountId"
            LEFT JOIN "Order" o ON o.id = p."orderId"
            LEFT JOIN "Venue" v ON v.id = o."venueId"
            WHERE p.method IN ('CREDIT_CARD','DEBIT_CARD')
              AND p.status = 'COMPLETED'
              AND p.source = 'TPV'
              AND p.type <> 'REFUND'
              AND ma."blumonSerialNumber" IS NOT NULL
              AND p."createdAt" BETWEEN now() - interval '48 hours' AND now() - interval '30 minutes'
              AND (p."processorData"->>'blumonWebhookReceived') IS NULL
              AND (p."processorData"->>'blumonDiscrepancy') IS NULL
              AND (p."processorData"->>'webhookAuditAlertedAt') IS NULL
              -- Scope to WEBHOOK-ENABLED merchants only. A missing webhook is
              -- an anomaly ONLY for a merchant that normally produces them.
              -- "Externo"/aggregator merchants (21 of 40 Blumon merchants, e.g.
              -- Doña Simona serial 2840744168) structurally never deliver a
              -- webhook to Avoqado (their affiliation isn't wired to our
              -- endpoint), so flagging every one of their payments is pure noise
              -- that buries a real orphan. Self-correcting: the moment a
              -- merchant's webhook config is (re)registered and webhooks start
              -- arriving, it re-enters this audit automatically.
              AND EXISTS (
                SELECT 1 FROM "ProviderEventLog" e
                WHERE e."eventId" LIKE 'blumon-tpv-%'
                  AND e.payload->>'serialNumber' = ma."blumonSerialNumber"
                  AND e."createdAt" > now() - interval '30 days'
              )
            LIMIT ${this.BATCH_SIZE}
          `,
        { shouldRetry: shouldRetryDbConnectionError, context: 'blumonPaymentAudit.scan' },
      )
    } catch (error) {
      logger.error('❌ Blumon payment audit: scan failed after retries', {
        error: error instanceof Error ? error.message : error,
      })
      return 0
    }

    if (rows.length === 0) return 0

    let alerted = 0

    for (const row of rows) {
      logger.error('🚨 [Blumon audit] Card payment WITHOUT Blumon webhook — verify capture', {
        paymentId: row.id,
        amount: row.amount,
        venue: row.venueName,
        authorizationNumber: row.authorizationNumber,
        createdAt: row.createdAt,
      })

      try {
        // MERGE, never replace: processorData holds the blumon* keys written
        // by the webhook service. A bare update would wipe them.
        const current = await prisma.payment.findUnique({
          where: { id: row.id },
          select: { processorData: true },
        })
        const existing = (current?.processorData as Record<string, unknown>) ?? {}

        await prisma.payment.update({
          where: { id: row.id },
          data: {
            processorData: {
              ...existing,
              webhookAuditAlertedAt: new Date().toISOString(),
            } as never,
          },
        })
        alerted++
      } catch (error) {
        // The alert already fired — failing to stamp only risks a repeat alert,
        // never a missed one. Never let it break the batch.
        logger.warn('Blumon audit: failed to stamp antispam marker', {
          paymentId: row.id,
          error: error instanceof Error ? error.message : error,
        })
      }
    }

    return alerted
  }

  /**
   * Merchant-level reconciliation-gap report. Lists PRODUCTION Blumon merchants
   * that took card payments in the last 30 days but received ZERO webhooks — a
   * standing "no independent reconciliation" gap that ops should close by
   * (re)registering the merchant/affiliation webhook in the Blumon portal.
   *
   * Excludes SANDBOX merchants (`blumonEnvironment <> 'PRODUCTION'`) so the
   * money-safe demo venue (a SANDBOX merchant deliberately living in prod)
   * never shows up as a false gap. Returns the number of gap merchants.
   */
  async reportWebhookGaps(): Promise<number> {
    let rows: WebhookGapRow[]

    try {
      rows = await retry(
        () =>
          prisma.$queryRaw<WebhookGapRow[]>`
            SELECT coalesce(v.name, ma."displayName") AS merchant,
                   ma."blumonSerialNumber" AS serial,
                   ma."blumonPosId" AS "posId",
                   count(*)::int AS payments,
                   sum(p.amount)::text AS "totalAmount",
                   max(p."createdAt") AS "lastPayment"
            FROM "Payment" p
            JOIN "MerchantAccount" ma ON ma.id = p."merchantAccountId"
            LEFT JOIN "Order" o ON o.id = p."orderId"
            LEFT JOIN "Venue" v ON v.id = o."venueId"
            WHERE p.method IN ('CREDIT_CARD','DEBIT_CARD')
              AND p.status = 'COMPLETED'
              AND p.source = 'TPV'
              AND p.type <> 'REFUND'
              AND ma."blumonSerialNumber" IS NOT NULL
              AND ma."blumonEnvironment" = 'PRODUCTION'
              AND p."createdAt" > now() - interval '30 days'
              AND NOT EXISTS (
                SELECT 1 FROM "ProviderEventLog" e
                WHERE e."eventId" LIKE 'blumon-tpv-%'
                  AND e.payload->>'serialNumber' = ma."blumonSerialNumber"
                  AND e."createdAt" > now() - interval '30 days'
              )
            GROUP BY 1, ma."blumonSerialNumber", ma."blumonPosId"
            ORDER BY count(*) DESC
          `,
        { shouldRetry: shouldRetryDbConnectionError, context: 'blumonPaymentAudit.gapReport' },
      )
    } catch (error) {
      logger.error('❌ Blumon webhook-gap report failed after retries', {
        error: error instanceof Error ? error.message : error,
      })
      return 0
    }

    if (rows.length === 0) {
      logger.info('📋 [Blumon gap] All production merchants with card volume are receiving webhooks (30d) — no reconciliation gap')
      return 0
    }

    logger.warn(
      '📋 [Blumon gap] Production merchants with card payments but NO Blumon webhooks (30d) — reconciliation gap; register/repair the affiliation webhook in the Blumon portal',
      {
        merchantCount: rows.length,
        merchants: rows.map(r => ({
          merchant: r.merchant,
          serial: r.serial,
          posId: r.posId,
          payments: r.payments,
          totalAmount: r.totalAmount,
          lastPayment: r.lastPayment,
        })),
      },
    )
    return rows.length
  }
}

export const blumonPaymentAuditJob = new BlumonPaymentAuditJob()
