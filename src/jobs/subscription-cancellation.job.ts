/**
 * Subscription Hard Cancellation Job
 *
 * Runs daily to:
 * 1. Hard-cancel Stripe subscriptions suspended for 14+ days (payment failure)
 * 2. Expire DB-only trials (superadmin-granted trials without Stripe)
 *
 * Dunning Flow (Stripe):
 * - Day 0-7: Grace period (emails + warnings)
 * - Day 7: Soft suspension (access blocked, data kept)
 * - Day 14: HARD CANCEL (this job) - Cancel subscription in Stripe
 *
 * DB-only Trial Flow:
 * - Superadmin grants trial with X days
 * - endDate set to current date + X days
 * - This job expires features where endDate < now and no Stripe subscription
 */

import { CronJob } from 'cron'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import Stripe from 'stripe'
import { subDays } from 'date-fns'
import emailService from '@/services/email.service'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '')

export class SubscriptionCancellationJob {
  private job: CronJob | null = null

  constructor() {
    // Run daily at 2:00 AM (low-traffic time)
    this.job = new CronJob(
      '0 2 * * *', // Every day at 2:00 AM
      this.runAllTasks.bind(this),
      null, // onComplete callback
      false, // Start job immediately
      'America/Mexico_City', // Timezone
    )
  }

  /**
   * Start the subscription cancellation job
   */
  start(): void {
    if (this.job) {
      this.job.start()
      logger.info('🗓️ Subscription Cancellation Job started - runs daily at 2:00 AM')
    }
  }

  /**
   * Stop the job
   */
  stop(): void {
    if (this.job) {
      this.job.stop()
      logger.info('Subscription Cancellation Job stopped')
    }
  }

  /**
   * Manually trigger cancellation check (for testing)
   */
  async runNow(): Promise<void> {
    await this.runAllTasks()
  }

  /**
   * Main orchestrator: Runs all subscription-related cleanup tasks
   */
  private async runAllTasks(): Promise<void> {
    logger.info('🔍 Starting daily subscription tasks...')

    // Task 1: Cancel Stripe subscriptions that exceeded grace period (14+ days)
    await this.cancelExpiredStripeSubscriptions()

    // Task 2: Expire DB-only trials that have passed their end date
    await this.expireDbOnlyTrials()

    logger.info('✅ Daily subscription tasks complete')
  }

  /**
   * Expire DB-only trials (superadmin-granted trials without Stripe)
   * These trials have an endDate but no stripeSubscriptionId
   */
  private async expireDbOnlyTrials(): Promise<void> {
    try {
      logger.info('🔍 Checking for expired DB-only trials...')

      const now = new Date()

      // Find active features where:
      // - endDate has passed
      // - No Stripe subscription (DB-only trial)
      // - Feature is still active
      const expiredTrials = await prisma.venueFeature.findMany({
        where: {
          active: true,
          endDate: {
            lt: now, // End date has passed
          },
          stripeSubscriptionId: null, // No Stripe subscription = DB-only trial
        },
        include: {
          venue: {
            include: {
              organization: true,
            },
          },
          feature: true,
        },
      })

      if (expiredTrials.length === 0) {
        logger.info('✅ No expired DB-only trials found')
        return
      }

      logger.info(`📋 Found ${expiredTrials.length} expired DB-only trial(s) to deactivate`)

      let successCount = 0
      let errorCount = 0

      for (const venueFeature of expiredTrials) {
        try {
          logger.info(`⏰ Expiring DB-only trial for ${venueFeature.feature.name} (Venue: ${venueFeature.venue.name})`, {
            venueFeatureId: venueFeature.id,
            endDate: venueFeature.endDate,
            daysPastExpiration: Math.floor((now.getTime() - (venueFeature.endDate?.getTime() || 0)) / (1000 * 60 * 60 * 24)),
          })

          // Deactivate the feature
          await prisma.venueFeature.update({
            where: { id: venueFeature.id },
            data: {
              active: false,
              // Keep endDate for historical tracking
            },
          })

          // Send trial expired email
          try {
            const emailSent = await emailService.sendTrialExpiredEmail(venueFeature.venue.organization.email, {
              venueName: venueFeature.venue.name,
              featureName: venueFeature.feature.name,
              expiredAt: venueFeature.endDate || now,
            })

            if (emailSent) {
              logger.info('✅ Trial expired email sent', {
                email: venueFeature.venue.organization.email,
                venueId: venueFeature.venueId,
                featureName: venueFeature.feature.name,
              })
            } else {
              logger.warn('⚠️ Trial expired email failed to send', {
                email: venueFeature.venue.organization.email,
                venueId: venueFeature.venueId,
              })
            }
          } catch (emailError) {
            // Non-blocking: Log error but continue
            logger.error('❌ Error sending trial expired email', {
              venueFeatureId: venueFeature.id,
              error: emailError instanceof Error ? emailError.message : 'Unknown error',
            })
          }

          successCount++
          logger.info(`✅ Expired DB-only trial for ${venueFeature.feature.name} (Venue: ${venueFeature.venue.name})`)
        } catch (error) {
          errorCount++
          logger.error(`❌ Failed to expire trial for VenueFeature ${venueFeature.id}`, {
            error: error instanceof Error ? error.message : 'Unknown error',
            venueFeatureId: venueFeature.id,
          })
        }
      }

      logger.info(`✅ DB-only trial expiration check complete`, {
        total: expiredTrials.length,
        successful: successCount,
        failed: errorCount,
      })
    } catch (error) {
      logger.error('❌ Error during DB-only trial expiration check', {
        error: error instanceof Error ? error.message : 'Unknown error',
      })
    }
  }

  /**
   * Cancel Stripe subscriptions that exceeded grace period (14+ days suspended)
   */
  private async cancelExpiredStripeSubscriptions(): Promise<void> {
    try {
      logger.info('🔍 Checking for expired Stripe subscriptions...')

      const now = new Date()

      // Find all suspended subscriptions where grace period ended 7+ days ago (14+ days total)
      // gracePeriodEndsAt is set to +7 days on first failure
      // So if gracePeriodEndsAt < now - 7 days, it's been 14+ days total
      const sevenDaysAgo = subDays(now, 7)

      const expiredSubscriptions = await prisma.venueFeature.findMany({
        where: {
          suspendedAt: {
            not: null, // Must be suspended
          },
          gracePeriodEndsAt: {
            lt: sevenDaysAgo, // Grace period ended more than 7 days ago (14+ days total)
          },
          stripeSubscriptionId: {
            not: null, // Must have Stripe subscription
          },
          active: false, // Must be inactive (suspended)
        },
        include: {
          venue: {
            include: {
              organization: true,
            },
          },
          feature: true,
        },
      })

      if (expiredSubscriptions.length === 0) {
        logger.info('✅ No expired subscriptions found')
        return
      }

      logger.info(`📋 Found ${expiredSubscriptions.length} subscription(s) to cancel`)

      let successCount = 0
      let errorCount = 0

      for (const venueFeature of expiredSubscriptions) {
        try {
          logger.info(`🚨 Canceling subscription for ${venueFeature.feature.name} (Venue: ${venueFeature.venue.name})`, {
            venueFeatureId: venueFeature.id,
            subscriptionId: venueFeature.stripeSubscriptionId,
            suspendedAt: venueFeature.suspendedAt,
            gracePeriodEndsAt: venueFeature.gracePeriodEndsAt,
            daysSinceGracePeriodEnd: Math.floor((now.getTime() - (venueFeature.gracePeriodEndsAt?.getTime() || 0)) / (1000 * 60 * 60 * 24)),
          })

          // Cancel subscription in Stripe
          if (venueFeature.stripeSubscriptionId) {
            await stripe.subscriptions.cancel(venueFeature.stripeSubscriptionId, {
              prorate: false, // Don't charge for partial period
            })

            logger.info(`✅ Stripe subscription canceled: ${venueFeature.stripeSubscriptionId}`)
          }

          // Update VenueFeature record (keep as inactive, clear Stripe IDs)
          await prisma.venueFeature.update({
            where: { id: venueFeature.id },
            data: {
              active: false, // Keep inactive
              stripeSubscriptionId: null, // Clear subscription
              stripeSubscriptionItemId: null, // Clear subscription item
              // Keep suspendedAt and gracePeriodEndsAt for historical tracking
            },
          })

          // Send cancellation email
          try {
            const emailSent = await emailService.sendSubscriptionCanceledEmail(venueFeature.venue.organization.email, {
              venueName: venueFeature.venue.name,
              featureName: venueFeature.feature.name,
              canceledAt: now,
              suspendedAt: venueFeature.suspendedAt || now,
            })

            if (emailSent) {
              logger.info('✅ Subscription canceled email sent', {
                email: venueFeature.venue.organization.email,
                venueId: venueFeature.venueId,
                featureName: venueFeature.feature.name,
              })
            } else {
              logger.warn('⚠️ Subscription canceled email failed to send', {
                email: venueFeature.venue.organization.email,
                venueId: venueFeature.venueId,
              })
            }
          } catch (emailError) {
            // Non-blocking: Log error but continue cancellation process
            logger.error('❌ Error sending subscription canceled email', {
              venueFeatureId: venueFeature.id,
              error: emailError instanceof Error ? emailError.message : 'Unknown error',
            })
          }

          successCount++

          logger.info(`✅ Hard canceled subscription for ${venueFeature.feature.name} (Venue: ${venueFeature.venue.name})`)
        } catch (error) {
          errorCount++
          logger.error(`❌ Failed to cancel subscription for VenueFeature ${venueFeature.id}`, {
            error: error instanceof Error ? error.message : 'Unknown error',
            venueFeatureId: venueFeature.id,
            subscriptionId: venueFeature.stripeSubscriptionId,
          })
        }
      }

      logger.info(`✅ Stripe subscription cancellation check complete`, {
        total: expiredSubscriptions.length,
        successful: successCount,
        failed: errorCount,
      })
    } catch (error) {
      logger.error('❌ Error during Stripe subscription cancellation check', {
        error: error instanceof Error ? error.message : 'Unknown error',
      })
    }
  }

  /**
   * Get job status info
   */
  getJobStatus(): {
    isRunning: boolean
    cronPattern: string
    description: string
  } {
    return {
      isRunning: !!this.job,
      cronPattern: '0 2 * * *',
      description: 'Runs daily at 2:00 AM to: 1) Cancel Stripe subscriptions suspended 14+ days, 2) Expire DB-only trials',
    }
  }
}

// Export singleton instance
export const subscriptionCancellationJob = new SubscriptionCancellationJob()
