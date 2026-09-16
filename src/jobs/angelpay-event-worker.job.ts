/** S4: barrido del worker de eventos PENDING de AngelPay. Misma forma que `payment-effects.job.ts`. */
import {
  AngelPayEventClaim,
  claimPendingAngelPayEvents,
  failClaimedAngelPayEvent,
  runClaimedAngelPayEvent,
} from '../services/tpv/angelpayEventWorker.service'
import logger from '../config/logger'
import { scheduleJob } from '../observability/jobContext'
import { DATABASE_JOB_SCHEDULES } from './jobSchedules'

type AngelPayEventWorkerDependencies = {
  now: () => Date
  claim: (input: { now: Date; limit: number }) => Promise<AngelPayEventClaim[]>
  apply: (claim: AngelPayEventClaim) => Promise<'PROCESSED' | 'PENDING' | 'ERROR' | 'SKIPPED'>
  fail: (claim: AngelPayEventClaim, now: Date, error: unknown) => Promise<boolean>
  cron: { start: () => void; stop: () => void }
}
export class AngelPayEventWorkerJob {
  private running = false
  private readonly dependencies: AngelPayEventWorkerDependencies
  constructor(overrides: Partial<AngelPayEventWorkerDependencies> = {}) {
    this.dependencies = {
      now: () => new Date(),
      claim: claimPendingAngelPayEvents,
      apply: runClaimedAngelPayEvent,
      fail: failClaimedAngelPayEvent,
      cron:
        overrides.cron ??
        scheduleJob(
          'angelpay-event-worker',
          DATABASE_JOB_SCHEDULES.angelpayEventWorker,
          () => void this.runNow().catch(() => logger.error('AngelPay event worker sweep failed')),
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
  async runNow(): Promise<{ processed: number; pending: number; errors: number; skipped: number; failed: number }> {
    if (this.running) return { processed: 0, pending: 0, errors: 0, skipped: 1, failed: 0 }
    this.running = true
    const totals = { processed: 0, pending: 0, errors: 0, skipped: 0, failed: 0 }
    try {
      const claims = await this.dependencies.claim({ now: this.dependencies.now(), limit: 25 })
      for (const claim of claims) {
        try {
          const outcome = await this.dependencies.apply(claim)
          if (outcome === 'PROCESSED') totals.processed++
          else if (outcome === 'PENDING') totals.pending++
          else if (outcome === 'ERROR') totals.errors++
          else totals.skipped++
        } catch (error) {
          totals.failed++
          try {
            await this.dependencies.fail(claim, this.dependencies.now(), error)
          } catch {
            logger.warn('AngelPay event failure remains leased for recovery', { eventLogId: claim.id })
          }
        }
      }
      if (claims.length > 0) logger.info('🪝 [AngelPay worker] barrido', { claimed: claims.length, ...totals })
      return totals
    } finally {
      this.running = false
    }
  }
}
export const angelpayEventWorkerJob = new AngelPayEventWorkerJob()
