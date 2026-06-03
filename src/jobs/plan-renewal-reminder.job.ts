/**
 * Plan Renewal Reminder Job (Subscription Lifecycle Emails — Phase 1.5)
 *
 * Runs daily at 09:00 America/Mexico_City.
 *
 * Finds active PLAN_PRO VenueFeatures that have a Stripe subscription and emails
 * the venue's notification target a heads-up ~3 days before the next renewal.
 *
 * Dedup: `VenueFeature.renewalReminderSentAt` is stamped once per billing period.
 * A reminder is (re-)sent only if it was never sent OR the last send predates the
 * current Stripe billing period (`current_period_start`).
 *
 * Per `.claude/rules/cron-jobs.md`: the entry DB read is wrapped in
 * `retry(..., shouldRetryDbConnectionError)` to survive the top-of-hour P1001
 * connection stampede. Stripe calls, email sends and the per-row `update` stay
 * OUTSIDE the retry (they must never double-execute). Each venue is processed in
 * its own try/catch so one failure never aborts the batch; email failures are
 * non-blocking.
 */

import { CronJob } from 'cron'
import Stripe from 'stripe'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { retry, shouldRetryDbConnectionError } from '@/utils/retry'
import emailService from '@/services/email.service'
import { resolvePlanNotificationTarget } from '@/services/access/planNotification.service'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '')

export class PlanRenewalReminderJob {
  private job: CronJob | null = null

  /**
   * Start the daily renewal-reminder cron (09:00 America/Mexico_City).
   */
  start(): void {
    this.job = new CronJob('0 9 * * *', () => this.runNow(), null, true, 'America/Mexico_City')
    logger.info('🗓️ Plan Renewal Reminder Job started - runs daily at 9:00 AM')
  }

  /**
   * Stop the job.
   */
  stop(): void {
    if (this.job) {
      this.job.stop()
      logger.info('Plan Renewal Reminder Job stopped')
    }
  }

  /**
   * Manually trigger the job (for tests / ops).
   */
  async runNow(): Promise<void> {
    try {
      await this.run()
    } catch (e) {
      logger.error('❌ plan-renewal-reminder failed', e)
    }
  }

  private async run(): Promise<void> {
    logger.info('🔍 Starting plan renewal reminder check...')

    // Entry read — wrapped in retry per cron-jobs.md (pure read, safe to re-run).
    const features = await retry(
      () =>
        prisma.venueFeature.findMany({
          where: {
            active: true,
            stripeSubscriptionId: { not: null },
            feature: { code: 'PLAN_PRO' },
          },
          select: {
            id: true,
            venueId: true,
            stripeSubscriptionId: true,
            renewalReminderSentAt: true,
          },
        }),
      { retries: 2, initialDelay: 1500, shouldRetry: shouldRetryDbConnectionError, context: 'plan-renewal-reminder.findMany' },
    )

    if (features.length === 0) {
      logger.info('✅ No active PLAN_PRO subscriptions to evaluate for renewal reminders')
      return
    }

    const now = Date.now()
    let sentCount = 0
    let errorCount = 0

    for (const vf of features) {
      try {
        const sub = await stripe.subscriptions.retrieve(vf.stripeSubscriptionId!)

        if (sub.status !== 'active' && sub.status !== 'trialing') continue

        // Stripe's TS types (v19) omit current_period_* on the Subscription type;
        // the API returns them. Cast like the rest of the codebase.
        const periodEndMs = (sub as any).current_period_end * 1000
        const periodStartMs = (sub as any).current_period_start * 1000
        const daysToRenewal = (periodEndMs - now) / 86400000

        // ~3-day window (2-4 days out).
        if (daysToRenewal < 2 || daysToRenewal > 4) continue

        // Dedup: already reminded this billing period?
        if (vf.renewalReminderSentAt && vf.renewalReminderSentAt.getTime() > periodStartMs) continue

        const target = await resolvePlanNotificationTarget(vf.venueId)
        if (!target.email) {
          logger.warn(`renewal reminder: no recipient for venue ${vf.venueId}; skipping`)
          continue
        }

        const interval = sub.items.data[0]?.price.recurring?.interval === 'year' ? 'annual' : 'monthly'
        const amountCents = sub.items.data[0]?.price.unit_amount ?? 0
        const FRONTEND_URL = process.env.FRONTEND_URL || 'https://dashboard.avoqado.io'

        await emailService.sendPlanRenewalReminderEmail(target.email, {
          locale: target.locale,
          venueName: target.venueName,
          interval,
          renewalDate: new Date(periodEndMs),
          amountCents,
          billingPortalUrl: `${FRONTEND_URL}/dashboard/venues/billing`,
        })

        await prisma.venueFeature.update({
          where: { id: vf.id },
          data: { renewalReminderSentAt: new Date() },
        })

        sentCount++
      } catch (err) {
        errorCount++
        logger.error(`❌ renewal reminder failed for venueFeature ${vf.id}`, {
          error: err instanceof Error ? err.message : 'Unknown error',
          venueFeatureId: vf.id,
        })
      }
    }

    logger.info('✅ Plan renewal reminder check complete', {
      total: features.length,
      sent: sentCount,
      errors: errorCount,
    })
  }
}

// Export singleton instance
export const planRenewalReminderJob = new PlanRenewalReminderJob()
