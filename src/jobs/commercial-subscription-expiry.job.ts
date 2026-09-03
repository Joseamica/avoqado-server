import type { CronJob } from 'cron'

import logger from '@/config/logger'
import { scheduleJob } from '@/observability/jobContext'
import {
  sweepExpiredCommercialSubscriptionPeriods,
  type SweepExpiredCommercialSubscriptionPeriodsResult,
} from '@/services/commercial/billing/subscriptionExpiry.service'
import { DATABASE_JOB_SCHEDULES } from './jobSchedules'

type CronHandle = Pick<CronJob, 'start' | 'stop'>

interface ExpiryJobDependencies {
  cron?: CronHandle
  sweepOnce: (input: { limit: number }) => Promise<SweepExpiredCommercialSubscriptionPeriodsResult>
}

const defaults: ExpiryJobDependencies = {
  sweepOnce: input => sweepExpiredCommercialSubscriptionPeriods(input),
}

export class CommercialSubscriptionExpiryJob {
  private readonly dependencies: ExpiryJobDependencies
  private readonly cron: CronHandle
  private running = false

  constructor(overrides: Partial<ExpiryJobDependencies> = {}) {
    this.dependencies = { ...defaults, ...overrides }
    this.cron =
      overrides.cron ??
      scheduleJob(
        'commercial-subscription-expiry',
        DATABASE_JOB_SCHEDULES.commercialSubscriptionExpiry,
        () => {
          void this.runNow().catch(error => logger.error('Commercial subscription expiry sweep failed', { error }))
        },
        null,
        false,
        'America/Mexico_City',
      )
  }

  start(): void {
    this.cron.start()
    logger.info('Commercial subscription expiry job started')
  }

  stop(): void {
    this.cron.stop()
    logger.info('Commercial subscription expiry job stopped')
  }

  async runNow(): Promise<SweepExpiredCommercialSubscriptionPeriodsResult & { skipped?: true }> {
    if (this.running) return { claimed: 0, expired: 0, contractsPaused: 0, skipped: true }
    this.running = true
    try {
      const result = await this.dependencies.sweepOnce({ limit: 100 })
      if (result.expired > 0) logger.info('Commercial subscription periods expired', result)
      return result
    } finally {
      this.running = false
    }
  }
}

export const commercialSubscriptionExpiryJob = new CommercialSubscriptionExpiryJob()
