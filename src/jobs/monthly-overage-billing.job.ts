/**
 * Monthly Overage Billing Job
 *
 * Daily cron that finds venues whose billing period has rolled over with
 * outstanding chatbot token overage and bills it via Stripe.
 *
 * Why daily (not monthly)? Because each venue has its own period boundary
 * (`currentPeriodEnd`). Running daily lets us catch every venue's rollover
 * without locking the world to a single billing day. The query filters to
 * venues that ACTUALLY have expired periods with overage, so most days do
 * nothing.
 *
 * Failures (declined cards, Stripe outage) keep the overage on the budget so
 * we can retry the next day. We log everything for ops visibility.
 *
 * Runs at 3:17 AM Mexico City time (offset from other cron jobs).
 */

import { CronJob } from 'cron'
import logger from '../config/logger'
import prisma from '../utils/prismaClient'
import tokenBudgetService from '../services/dashboard/token-budget.service'

export interface OverageBillingResult {
  venuesScanned: number
  venuesCharged: number
  venuesSkipped: number
  venuesFailed: number
  totalAmountUSD: number
}

export class MonthlyOverageBillingJob {
  private job: CronJob | null = null
  private isRunning = false

  constructor() {
    // Daily at 3:17 AM Mexico City — late enough that no human is using the app,
    // offset from other 3 AM jobs to keep Stripe webhook traffic spread out.
    this.job = new CronJob(
      '17 3 * * *',
      async () => {
        await this.run()
      },
      null,
      false,
      'America/Mexico_City',
    )
  }

  start(): void {
    if (this.job) {
      this.job.start()
      logger.info('Monthly Overage Billing Job started — daily at 3:17 AM Mexico City')
    }
  }

  stop(): void {
    if (this.job) {
      this.job.stop()
    }
  }

  async run(): Promise<OverageBillingResult> {
    if (this.isRunning) {
      logger.warn('[OVERAGE_BILLING] previous run still in progress, skipping')
      return { venuesScanned: 0, venuesCharged: 0, venuesSkipped: 0, venuesFailed: 0, totalAmountUSD: 0 }
    }
    this.isRunning = true
    const startedAt = Date.now()
    const result: OverageBillingResult = {
      venuesScanned: 0,
      venuesCharged: 0,
      venuesSkipped: 0,
      venuesFailed: 0,
      totalAmountUSD: 0,
    }

    try {
      const now = new Date()
      const expiredBudgets = await prisma.chatbotTokenBudget.findMany({
        where: {
          currentPeriodEnd: { lte: now },
          overageTokensUsed: { gt: 0 },
        },
        select: { venueId: true, overageTokensUsed: true },
      })

      result.venuesScanned = expiredBudgets.length
      if (expiredBudgets.length === 0) {
        logger.debug('[OVERAGE_BILLING] no venues with billable overage today')
        return result
      }

      logger.info('[OVERAGE_BILLING] starting daily run', { venuesToProcess: expiredBudgets.length })

      for (const budget of expiredBudgets) {
        try {
          const charge = await tokenBudgetService.chargeOverage(budget.venueId)
          if ('charged' in charge && charge.charged) {
            result.venuesCharged += 1
            result.totalAmountUSD += charge.amountUSD
          } else if ('skipped' in charge) {
            result.venuesSkipped += 1
          } else {
            // charged: false
            result.venuesFailed += 1
          }
        } catch (err) {
          result.venuesFailed += 1
          logger.error('[OVERAGE_BILLING] unexpected error charging venue', {
            venueId: budget.venueId,
            overage: budget.overageTokensUsed,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }

      logger.info('[OVERAGE_BILLING] daily run finished', {
        durationMs: Date.now() - startedAt,
        ...result,
      })
    } catch (err) {
      logger.error('[OVERAGE_BILLING] daily run aborted', {
        error: err instanceof Error ? err.message : String(err),
      })
    } finally {
      this.isRunning = false
    }

    return result
  }
}

export const monthlyOverageBillingJob = new MonthlyOverageBillingJob()
