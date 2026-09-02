import type { CronJob } from 'cron'
import logger from '../config/logger'
import { scheduleJob } from '../observability/jobContext'
import { awardLoyaltyForPaidOrder } from '../services/shared/loyaltyOnPaidOrder'
import prisma from '../utils/prismaClient'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'
import { DATABASE_JOB_SCHEDULES } from './jobSchedules'

const BATCH_LIMIT = 25
const MAX_ATTEMPTS = 15
const LEASE_MS = 10 * 60 * 1000

type CronHandle = Pick<CronJob, 'start' | 'stop'>

interface LoyaltyReconciliationDependencies {
  prisma: typeof prisma
  cron?: CronHandle
  now: () => Date
  award: typeof awardLoyaltyForPaidOrder
}

const defaults: LoyaltyReconciliationDependencies = {
  prisma,
  now: () => new Date(),
  award: awardLoyaltyForPaidOrder,
}

/**
 * Recovers paid-order loyalty work left behind by a process crash or transient
 * database failure. The paid Order is the durable outbox row: the settlement
 * transaction sets loyaltyEligibleAt, and this bounded worker retries until the
 * shared idempotent rule marks loyaltyProcessedAt.
 */
export class LoyaltyReconciliationJob {
  private readonly dependencies: LoyaltyReconciliationDependencies
  private readonly cron: CronHandle
  private running = false

  constructor(overrides: Partial<LoyaltyReconciliationDependencies> = {}) {
    this.dependencies = { ...defaults, ...overrides }
    this.cron =
      overrides.cron ??
      scheduleJob(
        'loyalty-reconciliation',
        DATABASE_JOB_SCHEDULES.loyaltyReconciliation,
        () => void this.runNow().catch(error => logger.error('Loyalty reconciliation sweep failed', { error })),
        null,
        false,
        'America/Mexico_City',
      )
  }

  start(): void {
    this.cron.start()
    logger.info('Loyalty reconciliation job started')
  }

  stop(): void {
    this.cron.stop()
    logger.info('Loyalty reconciliation job stopped')
  }

  async runNow(): Promise<{ scanned: number; applied: number; failed: number; skipped: number }> {
    if (this.running) return { scanned: 0, applied: 0, failed: 0, skipped: 1 }
    this.running = true
    try {
      const now = this.dependencies.now()
      const staleBefore = new Date(now.getTime() - LEASE_MS)
      // Regla cron-jobs.md: la lectura de ENTRADA reintenta errores transitorios de
      // conexión — sin esto, un P1001 en la estampida de la hora en punto mata el tick
      // (lo cazó jobDbRetryGuard en la verificación pre-push del 2026-09-01).
      const candidates = await retry(
        () =>
          this.dependencies.prisma.order.findMany({
            where: {
              loyaltyEligibleAt: { not: null },
              loyaltyProcessedAt: null,
              loyaltyAttempts: { lt: MAX_ATTEMPTS },
              OR: [{ loyaltyProcessingAt: null }, { loyaltyProcessingAt: { lt: staleBefore } }],
            },
            select: {
              id: true,
              venueId: true,
              total: true,
              loyaltyEligibleAt: true,
              loyaltyProcessingAt: true,
              loyaltyAttempts: true,
              loyaltyStaffId: true,
              customer: { select: { id: true, firstName: true, lastName: true } },
            },
            orderBy: [{ loyaltyEligibleAt: 'asc' }, { id: 'asc' }],
            take: BATCH_LIMIT,
          }),
        { retries: 2, initialDelay: 1500, shouldRetry: shouldRetryDbConnectionError, context: 'loyalty-reconciliation.find' },
      )

      let applied = 0
      let failed = 0
      let skipped = 0

      for (const order of candidates) {
        const claimStamp = new Date(now)
        const claim = await this.dependencies.prisma.order.updateMany({
          where: {
            id: order.id,
            loyaltyEligibleAt: { not: null },
            loyaltyProcessedAt: null,
            loyaltyAttempts: { lt: MAX_ATTEMPTS },
            OR: [{ loyaltyProcessingAt: null }, { loyaltyProcessingAt: { lt: staleBefore } }],
          },
          data: { loyaltyProcessingAt: claimStamp, loyaltyAttempts: { increment: 1 } },
        })
        if (claim.count !== 1) {
          skipped += 1
          continue
        }

        try {
          const result = await this.dependencies.award({
            venueId: order.venueId,
            orderId: order.id,
            orderTotal: Number(order.total),
            staffId: order.loyaltyStaffId,
            legacyCustomer: order.customer,
          })

          if (result.complete) {
            await this.dependencies.prisma.order.updateMany({
              where: {
                id: order.id,
                loyaltyProcessedAt: null,
                OR: [{ loyaltyProcessingAt: claimStamp }, { loyaltyProcessingAt: null }],
              },
              data: { loyaltyProcessedAt: now, loyaltyProcessingAt: null, loyaltyLastError: null },
            })
            applied += 1
          } else {
            await this.dependencies.prisma.order.updateMany({
              where: { id: order.id, loyaltyProcessedAt: null, loyaltyProcessingAt: claimStamp },
              data: { loyaltyProcessingAt: null, loyaltyLastError: result.errors.join(' | ').slice(0, 4000) },
            })
            failed += 1
          }
        } catch (error) {
          await this.dependencies.prisma.order.updateMany({
            where: { id: order.id, loyaltyProcessedAt: null, loyaltyProcessingAt: claimStamp },
            data: {
              loyaltyProcessingAt: null,
              loyaltyLastError: (error instanceof Error ? error.message : String(error)).slice(0, 4000),
            },
          })
          failed += 1
          logger.error('Loyalty reconciliation candidate failed', { orderId: order.id, venueId: order.venueId, error })
        }
      }

      return { scanned: candidates.length, applied, failed, skipped }
    } finally {
      this.running = false
    }
  }
}

export const loyaltyReconciliationJob = new LoyaltyReconciliationJob()
