/**
 * Plan Win-back Job (Subscription Lifecycle Emails — Phase 1.5)
 *
 * Runs daily at 10:00 America/Mexico_City.
 *
 * Finds PLAN_PRO VenueFeatures that were suspended ~3 days ago (payment failure),
 * have not yet been sent a win-back email, and are still suspended (not
 * reactivated). Sends a one-time win-back offer (first month free) and stamps
 * `VenueFeature.winbackSentAt` so it only ever fires once per suspension.
 *
 * Suspension semantics (verified against `stripe.service.ts`): a payment-failure
 * suspension sets BOTH `suspendedAt = now` AND `active = false`
 * (see `handleSubscriptionPaymentFailed`: first-payment immediate suspension at
 * ~line 1204-1205 and Day-7 soft suspension at ~line 1296-1297). Therefore the
 * "currently suspended" filter is `active: false` + `suspendedAt` set. A
 * reactivated venue flips `active` back to true, so `active: false` also excludes
 * reactivations.
 *
 * Per `.claude/rules/cron-jobs.md`: the entry DB read is wrapped in
 * `retry(..., shouldRetryDbConnectionError)`. Email sends and the per-row `update`
 * stay OUTSIDE the retry. Each venue is processed in its own try/catch; email
 * failures are non-blocking.
 */

import { CronJob } from 'cron'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { retry, shouldRetryDbConnectionError } from '@/utils/retry'
import emailService from '@/services/email.service'
import { resolvePlanNotificationTarget } from '@/services/access/planNotification.service'

export class PlanWinbackJob {
  private job: CronJob | null = null

  /**
   * Start the daily win-back cron (10:00 America/Mexico_City).
   */
  start(): void {
    this.job = new CronJob('0 10 * * *', () => this.runNow(), null, true, 'America/Mexico_City')
    logger.info('🗓️ Plan Win-back Job started - runs daily at 10:00 AM')
  }

  /**
   * Stop the job.
   */
  stop(): void {
    if (this.job) {
      this.job.stop()
      logger.info('Plan Win-back Job stopped')
    }
  }

  /**
   * Manually trigger the job (for tests / ops).
   */
  async runNow(): Promise<void> {
    try {
      await this.run()
    } catch (e) {
      logger.error('❌ plan-winback failed', e)
    }
  }

  private async run(): Promise<void> {
    logger.info('🔍 Starting plan win-back check...')

    const fourDaysAgo = new Date(Date.now() - 4 * 86400000)
    const twoDaysAgo = new Date(Date.now() - 2 * 86400000)

    // Entry read — wrapped in retry per cron-jobs.md (pure read, safe to re-run).
    const features = await retry(
      () =>
        prisma.venueFeature.findMany({
          where: {
            feature: { code: 'PLAN_PRO' },
            // Suspended ~3 days ago (window 2-4 days back).
            suspendedAt: { not: null, gte: fourDaysAgo, lte: twoDaysAgo },
            winbackSentAt: null,
            // Still suspended, not reactivated. Suspension sets active:false (verified).
            active: false,
          },
          select: {
            id: true,
            venueId: true,
            venue: { select: { slug: true } },
          },
        }),
      { retries: 2, initialDelay: 1500, shouldRetry: shouldRetryDbConnectionError, context: 'plan-winback.findMany' },
    )

    if (features.length === 0) {
      logger.info('✅ No suspended PLAN_PRO subscriptions eligible for win-back')
      return
    }

    let sentCount = 0
    let errorCount = 0

    for (const vf of features) {
      try {
        const target = await resolvePlanNotificationTarget(vf.venueId)
        if (!target.email) {
          logger.warn(`winback: no recipient for venue ${vf.venueId}; skipping`)
          continue
        }

        const FRONTEND_URL = process.env.FRONTEND_URL || 'https://dashboard.avoqado.io'

        await emailService.sendPlanWinbackEmail(target.email, {
          locale: target.locale,
          venueName: target.venueName,
          reactivateUrl: `${FRONTEND_URL}/dashboard/venues/${vf.venue.slug}/billing?winback=1`,
        })

        await prisma.venueFeature.update({
          where: { id: vf.id },
          data: { winbackSentAt: new Date() },
        })

        sentCount++
      } catch (err) {
        errorCount++
        logger.error(`❌ winback failed for venueFeature ${vf.id}`, {
          error: err instanceof Error ? err.message : 'Unknown error',
          venueFeatureId: vf.id,
        })
      }
    }

    logger.info('✅ Plan win-back check complete', {
      total: features.length,
      sent: sentCount,
      errors: errorCount,
    })
  }
}

// Export singleton instance
export const planWinbackJob = new PlanWinbackJob()
