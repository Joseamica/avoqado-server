import {
  PaymentEffectClaim,
  claimPaymentEffects,
  runClaimedPaymentEffect,
  failClaimedPaymentEffect,
} from '../services/tpv/paymentEffects.service'
import logger from '../config/logger'
import { scheduleJob } from '../observability/jobContext'
import { DATABASE_JOB_SCHEDULES } from './jobSchedules'

type PaymentEffectsJobDependencies = {
  now: () => Date
  claim: (input: { now: Date; limit: number }) => Promise<PaymentEffectClaim[]>
  apply: (claim: PaymentEffectClaim) => Promise<boolean>
  fail: (claim: PaymentEffectClaim, now: Date, error: unknown) => Promise<boolean>
  cron: { start: () => void; stop: () => void }
}
export class PaymentEffectsJob {
  private running = false
  private readonly dependencies: PaymentEffectsJobDependencies
  constructor(overrides: Partial<PaymentEffectsJobDependencies> = {}) {
    this.dependencies = {
      now: () => new Date(),
      claim: claimPaymentEffects,
      apply: runClaimedPaymentEffect,
      fail: failClaimedPaymentEffect,
      cron:
        overrides.cron ??
        scheduleJob(
          'payment-effects',
          DATABASE_JOB_SCHEDULES.paymentEffects,
          () => void this.runNow().catch(() => logger.error('Payment effects sweep failed')),
          null,
          false,
          'America/Mexico_City',
        ),
      ...overrides,
    }
  }
  start(): void {
    this.dependencies.cron.start()
  }
  stop(): void {
    this.dependencies.cron.stop()
  }
  async runNow(): Promise<{ applied: number; failed: number; skipped: number }> {
    if (this.running) return { applied: 0, failed: 0, skipped: 1 }
    this.running = true
    let applied = 0,
      failed = 0,
      skipped = 0
    try {
      const claims = await this.dependencies.claim({ now: this.dependencies.now(), limit: 25 })
      for (const claim of claims) {
        try {
          if (await this.dependencies.apply(claim)) applied++
          else skipped++
        } catch (error) {
          failed++
          try {
            await this.dependencies.fail(claim, this.dependencies.now(), error)
          } catch {
            logger.warn('Payment effect failure remains leased for recovery', { paymentId: claim.paymentId, venueId: claim.venueId })
          }
        }
      }
      return { applied, failed, skipped }
    } finally {
      this.running = false
    }
  }
}
export const paymentEffectsJob = new PaymentEffectsJob()
