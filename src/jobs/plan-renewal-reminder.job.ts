/**
 * Plan Renewal Reminder Job (Subscription Lifecycle Emails — Phase 1.5)
 *
 * Runs daily at 09:00 America/Mexico_City.
 *
 * Finds active PLAN_PRO / PLAN_PREMIUM VenueFeatures that have a Stripe subscription and emails
 * the venue's notification target a heads-up before the next charge (`diasParaAvisar`: 0 < days < 9).
 * With the per-period dedup the first send normally lands 8-9 days out (Visa: ≥7 days before the first
 * charge after a trial; LFPC 76 Bis VIII: ≥5); a failed run is retried by the next daily runs until the charge.
 * The amount is what Stripe will really charge (invoice preview), never the list price; without it nothing is
 * sent or stamped. A trialing subscription gets the "your trial ends" variant.
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
import { subscriptionPeriod } from '@/utils/stripeSubscriptionPeriod'
import emailService from '@/services/email.service'
import { resolvePlanNotificationTarget } from '@/services/access/planNotification.service'
import { montoDelSiguienteCobro, noHabraCobro } from '@/services/billing/siguienteCobro'
import { billingPageUrl } from '@/utils/dashboardLinks'
import { scheduleJob } from '../observability/jobContext'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '')

/** `true` while the charge at `periodEndMs` is less than 9 days (and still in the future) away. */
export function diasParaAvisar(periodEndMs: number, nowMs: number): boolean {
  const dias = (periodEndMs - nowMs) / 86400000
  return dias > 0 && dias < 9
}

export class PlanRenewalReminderJob {
  private job: CronJob | null = null

  /**
   * Start the daily renewal-reminder cron (09:00 America/Mexico_City).
   */
  start(): void {
    this.job = scheduleJob('plan-renewal-reminder', '0 9 * * *', () => this.runNow(), null, true, 'America/Mexico_City')
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
            feature: { code: { in: ['PLAN_PRO', 'PLAN_PREMIUM'] } },
          },
          select: {
            id: true,
            venueId: true,
            stripeSubscriptionId: true,
            renewalReminderSentAt: true,
            feature: { select: { code: true } },
            venue: { select: { slug: true, timezone: true } },
          },
        }),
      { retries: 2, initialDelay: 1500, shouldRetry: shouldRetryDbConnectionError, context: 'plan-renewal-reminder.findMany' },
    )

    if (features.length === 0) {
      logger.info('✅ No active plan subscriptions to evaluate for renewal reminders')
      return
    }

    const now = Date.now()
    let sentCount = 0
    let errorCount = 0
    let sinMonto = 0
    // One email per subscription per run, even if a residue left two active plan rows on it (PRO + PREMIUM).
    const avisadas = new Set<string>()

    for (const vf of features) {
      try {
        if (avisadas.has(vf.stripeSubscriptionId!)) continue
        const sub = await stripe.subscriptions.retrieve(vf.stripeSubscriptionId!)

        if (sub.status !== 'active' && sub.status !== 'trialing') continue

        // The pinned API carries the period on the item, not the subscription. Without a real date we skip:
        // NaN would slip past both checks below and email "Invalid Date" every day.
        const period = subscriptionPeriod(sub)
        if (!period.start || !period.end) {
          logger.warn(`renewal reminder: subscription ${vf.stripeSubscriptionId} has no billing period; skipping`)
          continue
        }
        const periodEndMs = period.end.getTime()
        const periodStartMs = period.start.getTime()

        if (!diasParaAvisar(periodEndMs, now)) continue

        // Dedup: already reminded this billing period?
        if (vf.renewalReminderSentAt && vf.renewalReminderSentAt.getTime() > periodStartMs) continue

        // No charge at period end (canceled, cancel_at before it, or collection paused through it): never announce one.
        if (noHabraCobro(sub, periodEndMs)) continue

        const target = await resolvePlanNotificationTarget(vf.venueId)
        if (!target.email) {
          logger.warn(`renewal reminder: no recipient for venue ${vf.venueId}; skipping`)
          continue
        }

        // 🔴 No list-price fallback: unknown amount → no email, no stamp; tomorrow's run (still in the window) retries.
        const amountCents = await montoDelSiguienteCobro(stripe, vf.stripeSubscriptionId!)
        if (amountCents === null) {
          sinMonto++
          continue
        }

        const interval = sub.items.data[0]?.price.recurring?.interval === 'year' ? 'annual' : 'monthly'

        const sent = await emailService.sendPlanRenewalReminderEmail(target.email, {
          locale: target.locale,
          venueName: target.venueName,
          interval,
          renewalDate: new Date(periodEndMs),
          amountCents,
          billingPortalUrl: billingPageUrl(vf.venue?.slug),
          planName: vf.feature?.code === 'PLAN_PREMIUM' ? 'Premium' : 'Pro',
          isTrialEnd: sub.status === 'trialing',
          // `||`, not `??`: an empty zone makes toLocaleDateString throw.
          timeZone: vf.venue?.timezone || 'America/Mexico_City',
        })
        // Not delivered → no stamp, so the next daily run retries.
        if (!sent) {
          logger.warn(`renewal reminder: email not sent for venueFeature ${vf.id}; will retry on the next run`)
          continue
        }

        avisadas.add(vf.stripeSubscriptionId!)

        // Idempotent stamp, retried on a connection error so a P1001 at 09:00 doesn't re-send tomorrow. The email above
        // is NOT inside any retry.
        await retry(
          () =>
            prisma.venueFeature.update({
              where: { id: vf.id },
              data: { renewalReminderSentAt: new Date() },
            }),
          { retries: 2, initialDelay: 1500, shouldRetry: shouldRetryDbConnectionError, context: 'plan-renewal-reminder.stamp' },
        )

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
      sinMonto,
      errors: errorCount,
    })
  }
}

// Export singleton instance
export const planRenewalReminderJob = new PlanRenewalReminderJob()
