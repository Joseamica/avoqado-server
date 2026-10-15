import type { CronJob } from 'cron'
import logger from '../config/logger'
import { scheduleJob } from '../observability/jobContext'
import { MARCA_LEALTAD_REABIERTA } from '../services/shared/lealtadReabierta'
import { otorgarLealtadRespetandoReembolsos } from '../services/shared/loyaltyOnLateCustomer'
import type { awardLoyaltyForPaidOrder } from '../services/shared/loyaltyOnPaidOrder'
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
  // 🔴 B2 (auditoría de Codex, ronda B, 14-oct-2026): NUNCA `awardLoyaltyForPaidOrder` directo. Esa función no mira
  // reembolsos: si el intento inmediato fallaba antes del sello y luego se devolvía el pago, este barrido creaba el sello
  // sobre una venta devuelta. El envoltorio no otorga a una venta reembolsada y revierte si el reembolso entra a media.
  award: otorgarLealtadRespetandoReembolsos,
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
              tipAmount: true,
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

      /**
       * Suelta SU reclamo dejando el error, sin pisar la marca de una liga tardía (H2, auditoría de Codex del código +
       * revisión final Minor 3, 15-oct-2026). Si la fila trae la marca, se suelta el reclamo igual (la siguiente vuelta la
       * vuelve a tomar) y el error queda sólo en el log: la marca es lo que detiene a un cierre «sin cliente» que espera.
       */
      const soltarConError = async (orderId: string, venueId: string, claimStamp: Date, texto: string): Promise<void> => {
        const escrita = await this.dependencies.prisma.order.updateMany({
          where: {
            id: orderId,
            loyaltyProcessedAt: null,
            loyaltyProcessingAt: claimStamp,
            OR: [{ loyaltyLastError: null }, { loyaltyLastError: { not: MARCA_LEALTAD_REABIERTA } }],
          },
          data: { loyaltyProcessingAt: null, loyaltyLastError: texto.slice(0, 4000) },
        })
        if (escrita.count === 1) return
        const soltada = await this.dependencies.prisma.order.updateMany({
          where: { id: orderId, loyaltyProcessedAt: null, loyaltyProcessingAt: claimStamp },
          data: { loyaltyProcessingAt: null },
        })
        if (soltada.count === 1) {
          logger.warn('Loyalty reconciliation failed on a reopened order; marker kept, error only logged', {
            orderId,
            venueId,
            error: texto.slice(0, 4000),
          })
        }
      }

      for (const order of candidates) {
        const claimStamp = new Date(now)
        const claim = await this.dependencies.prisma.order.updateMany({
          where: {
            id: order.id,
            loyaltyEligibleAt: { not: null },
            loyaltyProcessedAt: null,
            loyaltyAttempts: { lt: MAX_ATTEMPTS },
            // 🔴 H5 (auditoría de Codex del código, 15-oct-2026): el reclamo exige el MISMO actor que se leyó. Una liga tardía
            // guarda a quien agregó al cliente en `loyaltyStaffId`; si lo cambió entre la lectura y este reclamo, esta vuelta
            // no la toma (sellaría a nombre de quien cobró) y la siguiente lee el valor vigente.
            loyaltyStaffId: order.loyaltyStaffId,
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
            orderTotal: Math.max(0, Number(order.total) - Number(order.tipAmount ?? 0)),
            staffId: order.loyaltyStaffId,
            legacyCustomer: order.customer,
          })

          if (result.complete) {
            // 🔴 B1 (auditoría de Codex, ronda B): sólo SU reclamo. Una liga tardía que reabrió la venta pone
            // `loyaltyProcessingAt` en null; si este barrido leyó la venta «sin cliente» antes de esa liga, cerrarla aquí
            // borraría la reapertura y el sello se perdería si el intento de la liga también falla. Antes también se
            // aceptaba `loyaltyProcessingAt: null`, que justo es lo que escribe la reapertura. Cuando la lealtad sí cerró
            // la venta (lo normal), esto no cambia nada: `loyaltyProcessedAt` ya no es null.
            await this.dependencies.prisma.order.updateMany({
              where: { id: order.id, loyaltyProcessedAt: null, loyaltyProcessingAt: claimStamp },
              data: { loyaltyProcessedAt: now, loyaltyProcessingAt: null, loyaltyLastError: null },
            })
            applied += 1
          } else {
            await soltarConError(order.id, order.venueId, claimStamp, result.errors.join(' | '))
            failed += 1
          }
        } catch (error) {
          await soltarConError(order.id, order.venueId, claimStamp, error instanceof Error ? error.message : String(error))
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
