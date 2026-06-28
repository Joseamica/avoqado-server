/**
 * Cash Out Settlement Job — the daily corte.
 *
 * Runs at 18:15 Mexico City time: materializes approved sales into saldo,
 * reconciles clawbacks, and generates the Finanzas dispersion report for every
 * CASH_OUT venue. 18:15 (offset minute) avoids the on-the-hour cron stampede;
 * the entry read inside runCashOutSettlement is retry-wrapped (see cron-jobs.md).
 *
 * Can be triggered manually via runNow() for testing.
 */
import { CronJob } from 'cron'
import logger from '../config/logger'
import { runCashOutSettlement } from '../services/dashboard/cash-out/cash-out.settlement.service'

export class CashOutSettlementJob {
  private job: CronJob | null = null
  private isRunning = false

  constructor() {
    this.job = new CronJob(
      '15 18 * * *', // 18:15 every day
      async () => {
        await this.run()
      },
      null,
      false, // don't start automatically
      'America/Mexico_City',
    )
  }

  start(): void {
    if (this.job) {
      this.job.start()
      logger.info('💸 Cash Out Settlement Job started - daily at 18:15 Mexico City')
    }
  }

  stop(): void {
    if (this.job) {
      this.job.stop()
      logger.info('Cash Out Settlement Job stopped')
    }
  }

  /** Run the corte manually (testing / ad-hoc). */
  async runNow(): Promise<{ venues: number; created: number; clawedBack: number; reported: number }> {
    return this.run()
  }

  private async run(): Promise<{ venues: number; created: number; clawedBack: number; reported: number }> {
    if (this.isRunning) {
      logger.warn('Cash Out Settlement already in progress, skipping')
      return { venues: 0, created: 0, clawedBack: 0, reported: 0 }
    }
    this.isRunning = true
    const startTime = Date.now()
    try {
      logger.info('💸 Starting Cash Out Settlement corte...')
      const result = await runCashOutSettlement()
      logger.info('✅ Cash Out Settlement completed', { ...result, durationSeconds: ((Date.now() - startTime) / 1000).toFixed(2) })
      return result
    } catch (error) {
      logger.error('❌ Cash Out Settlement job failed', { error, durationSeconds: ((Date.now() - startTime) / 1000).toFixed(2) })
      throw error
    } finally {
      this.isRunning = false
    }
  }

  getNextRun(): Date | null {
    return this.job?.nextDate()?.toJSDate() ?? null
  }
}

export const cashOutSettlementJob = new CashOutSettlementJob()
