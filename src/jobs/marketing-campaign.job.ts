/**
 * Marketing Campaign Job
 *
 * Processes the email sending queue for marketing campaigns.
 * Runs every 5 minutes and sends up to 50 emails per batch.
 *
 * Rate Limiting Strategy:
 * - Batch size: 50 emails
 * - Delay between emails: 500ms (2/second safe limit for Resend)
 * - Batch frequency: Every 5 minutes
 * - Throughput: ~600 emails/hour, ~14,400/day
 *
 * This conservative rate limiting ensures:
 * - No rate limit errors from Resend
 * - Deliverability is maintained (not flagged as spam)
 * - Server resources are not overwhelmed
 */

import { CronJob } from 'cron'
import logger from '@/config/logger'
import * as marketingService from '../services/superadmin/marketing.superadmin.service'

export class MarketingCampaignJob {
  private job: CronJob | null = null
  private isRunning: boolean = false

  constructor() {
    // Run every 5 minutes
    this.job = new CronJob(
      '*/5 * * * *', // Every 5 minutes
      async () => {
        // CronJob expects void | Promise<void>, so we wrap and ignore return value
        await this.processQueue()
      },
      null, // onComplete callback
      false, // Don't start immediately
      'America/Mexico_City', // Timezone
    )
  }

  /**
   * Start the marketing campaign job
   */
  start(): void {
    if (this.job) {
      this.job.start()
      logger.info('📧 Marketing Campaign Job started - runs every 5 minutes')
    }
  }

  /**
   * Stop the job
   */
  stop(): void {
    if (this.job) {
      this.job.stop()
      logger.info('📧 Marketing Campaign Job stopped')
    }
  }

  /**
   * Manually trigger queue processing (for testing)
   */
  async runNow(): Promise<{ processed: number; success: number; failed: number }> {
    return this.processQueue()
  }

  /**
   * Process pending email deliveries
   */
  private async processQueue(): Promise<{ processed: number; success: number; failed: number }> {
    // Prevent concurrent execution
    if (this.isRunning) {
      logger.info('📧 [Marketing Job] Already running, skipping this cycle')
      return { processed: 0, success: 0, failed: 0 }
    }

    this.isRunning = true
    logger.info('📧 [Marketing Job] Starting queue processing...')

    try {
      const result = await marketingService.processPendingDeliveries()

      if (result.processed > 0) {
        logger.info(`📧 [Marketing Job] Queue processing complete:`, {
          processed: result.processed,
          success: result.success,
          failed: result.failed,
        })
      }

      return result
    } catch (error) {
      logger.error('📧 [Marketing Job] Error processing queue:', error)
      return { processed: 0, success: 0, failed: 0 }
    } finally {
      this.isRunning = false
    }
  }

  /**
   * Get job status info
   */
  getJobStatus(): {
    isRunning: boolean
    isProcessing: boolean
    cronPattern: string
    description: string
    batchSize: number
    batchDelayMs: number
  } {
    return {
      isRunning: !!this.job,
      isProcessing: this.isRunning,
      cronPattern: '*/5 * * * *',
      description: 'Processes marketing campaign email queue every 5 minutes',
      batchSize: marketingService.BATCH_SIZE,
      batchDelayMs: marketingService.BATCH_DELAY_MS,
    }
  }
}

// Export singleton instance
export const marketingCampaignJob = new MarketingCampaignJob()
