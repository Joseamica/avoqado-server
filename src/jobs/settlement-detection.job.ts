import { CronJob } from 'cron'
import * as settlementIncidentService from '../services/dashboard/settlementIncident.service'
import logger from '../config/logger'

/**
 * Settlement Detection Job
 *
 * Runs daily at 9:00 AM Mexico City time to detect settlements that didn't arrive
 * on their expected date. This is the core "detection by absence" strategy for
 * identifying processor settlement delays.
 *
 * When a settlement is detected as missing:
 * 1. Creates a SettlementIncident record
 * 2. Notifies venue for manual confirmation
 * 3. Alerts SOFOM if threshold exceeded
 */
export class SettlementDetectionJob {
  private job: CronJob | null = null

  constructor() {
    // Run every day at 9:00 AM Mexico City time
    // Cron pattern: minute hour day month dayOfWeek
    // '0 9 * * *' = At 9:00 AM every day
    this.job = new CronJob(
      '0 9 * * *', // Daily at 9:00 AM
      this.detectMissingSettlements.bind(this),
      null, // onComplete callback
      false, // Don't start immediately
      'America/Mexico_City', // Timezone
    )
  }

  /**
   * Start the settlement detection job
   */
  start(): void {
    if (this.job) {
      this.job.start()
      logger.info('🔍 Settlement Detection Job started - running daily at 9:00 AM Mexico City time')
    }
  }

  /**
   * Stop the job
   */
  stop(): void {
    if (this.job) {
      this.job.stop()
      logger.info('Settlement Detection Job stopped')
    }
  }

  /**
   * Run detection manually (useful for testing)
   */
  async runNow(): Promise<void> {
    await this.detectMissingSettlements()
  }

  /**
   * Main detection function - runs daily to find missing settlements
   */
  private async detectMissingSettlements(): Promise<void> {
    try {
      logger.info('🔍 Running daily settlement detection...')

      const result = await settlementIncidentService.detectMissingSettlements()

      if (result.detected > 0) {
        logger.warn(`⚠️  Detected ${result.detected} missing settlements - incidents created`)

        // Log summary of incidents by processor
        const byProcessor = result.incidents.reduce(
          (acc, inc) => {
            acc[inc.processorName] = (acc[inc.processorName] || 0) + 1
            return acc
          },
          {} as Record<string, number>,
        )

        logger.info('Incidents by processor:', byProcessor)

        // TODO: Send email alerts to venues
        // TODO: Alert SOFOM if critical threshold exceeded
      } else {
        logger.info('✅ All settlements arrived on time - no incidents detected')
      }

      logger.info('Settlement detection completed successfully')
    } catch (error) {
      logger.error('❌ Error during settlement detection:', error)
    }
  }

  /**
   * Get job status and next run time
   */
  getJobStatus(): {
    isRunning: boolean
    cronPattern: string
    timezone: string
  } {
    return {
      isRunning: !!this.job,
      cronPattern: '0 9 * * *',
      timezone: 'America/Mexico_City',
    }
  }
}

// Export singleton instance
export const settlementDetectionJob = new SettlementDetectionJob()
