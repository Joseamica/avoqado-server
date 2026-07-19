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

export class BlumonPaymentAuditJob {
  private job: CronJob | null = null

  /** Every 10 minutes — the window is 30min–48h, so cadence need not be tight. */
  private readonly CRON_PATTERN = '0 */10 * * * *'

  private readonly BATCH_SIZE = 50

  start(): void {
    if (this.job) return
    this.job = new CronJob(this.CRON_PATTERN, () => void this.runOnce(), null, false, 'America/Mexico_City')
    this.job.start()
    logger.info('🪝 Blumon payment audit job started — every 10min, window 30min–48h')
  }

  stop(): void {
    if (!this.job) return
    this.job.stop()
    this.job = null
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
}

export const blumonPaymentAuditJob = new BlumonPaymentAuditJob()
