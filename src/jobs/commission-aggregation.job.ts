/**
 * Commission Aggregation Job
 *
 * Daily cron job that aggregates commission calculations into summaries.
 * Runs at 3:00 AM Mexico City time.
 *
 * What it does:
 * 1. Finds all CALCULATED commission records across all venues
 * 2. Groups them by staff and period
 * 3. Creates/updates CommissionSummary records
 * 4. Marks calculations as AGGREGATED
 *
 * Can also be triggered manually via runNow() for testing.
 */

import { CronJob } from 'cron'
import logger from '../config/logger'
import { aggregateAllPendingCommissions } from '../services/dashboard/commission/commission-aggregation.service'

export class CommissionAggregationJob {
  private job: CronJob | null = null
  private isRunning: boolean = false

  constructor() {
    // Run daily at 3:00 AM Mexico City time
    // This gives time for all venues to close their day
    this.job = new CronJob(
      '0 3 * * *', // At 03:00 every day
      async () => {
        await this.aggregate()
      },
      null,
      false, // Don't start automatically
      'America/Mexico_City',
    )
  }

  /**
   * Start the cron job
   */
  start(): void {
    if (this.job) {
      this.job.start()
      logger.info('📊 Commission Aggregation Job started - daily at 3:00 AM Mexico City')
    }
  }

  /**
   * Stop the cron job
   */
  stop(): void {
    if (this.job) {
      this.job.stop()
      logger.info('Commission Aggregation Job stopped')
    }
  }

  /**
   * Run aggregation manually (for testing or ad-hoc execution)
   */
  async runNow(): Promise<{ venues: number; summarized: number }> {
    return this.aggregate()
  }

  /**
   * Main aggregation logic
   */
  private async aggregate(): Promise<{ venues: number; summarized: number }> {
    // Prevent concurrent runs
    if (this.isRunning) {
      logger.warn('Commission aggregation already in progress, skipping')
      return { venues: 0, summarized: 0 }
    }

    this.isRunning = true
    const startTime = Date.now()

    try {
      logger.info('📊 Starting commission aggregation job...')

      const result = await aggregateAllPendingCommissions()

      const duration = ((Date.now() - startTime) / 1000).toFixed(2)

      logger.info('✅ Commission aggregation completed', {
        venues: result.venues,
        calculationsSummarized: result.summarized,
        durationSeconds: duration,
      })

      return result
    } catch (error) {
      logger.error('❌ Commission aggregation job failed', {
        error,
        durationSeconds: ((Date.now() - startTime) / 1000).toFixed(2),
      })

      throw error
    } finally {
      this.isRunning = false
    }
  }

  /**
   * Check if job is currently running
   */
  isJobRunning(): boolean {
    return this.isRunning
  }

  /**
   * Get next scheduled run time
   */
  getNextRun(): Date | null {
    if (this.job) {
      return this.job.nextDate()?.toJSDate() ?? null
    }
    return null
  }
}

// Export singleton instance
export const commissionAggregationJob = new CommissionAggregationJob()
