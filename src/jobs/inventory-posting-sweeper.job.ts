import type { CronJob } from 'cron'
import logger from '../config/logger'
import { scheduleJob } from '../observability/jobContext'
import { applySalePosting } from '../services/inventory/inventoryPosting.service'
import prisma from '../utils/prismaClient'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'
import { DATABASE_JOB_SCHEDULES } from './jobSchedules'

/**
 * Inventory posting sweeper — el "job de respaldo" que el outbox de
 * InventoryPosting promete desde su diseño: si el proceso muere entre el commit
 * del cobro y la aplicación del posting (o una línea falla con error
 * transitorio), la deducción queda PENDING/PARTIAL_FAILED — y si muere DENTRO
 * de la aplicación, queda APPLYING huérfano. Sin este barrido, esa venta jamás
 * deduce stock y el registro "durable" es solo un epitafio.
 *
 * Seguridad del re-apply: applySalePosting es reintentable por línea (las
 * APPLIED/SKIPPED no se tocan), trae guard anti doble-deducción por movimientos
 * (postingLineId en InventoryMovement y RawMaterialMovement) y su claim CAS
 * sólo re-reclama APPLYING más viejo que el lease — dos workers nunca aplican
 * el mismo posting a la vez.
 */

/** No pisar el apply inline que corre segundos después del commit del cobro. */
const PENDING_GRACE_MS = 3 * 60 * 1000
/** Debe ser >= APPLYING_LEASE_MS del servicio (10 min) — el claim decide. */
const STALE_APPLYING_MS = 10 * 60 * 1000
/** Un posting que falló 15 veces necesita un humano, no un intento 16. */
const MAX_ATTEMPTS = 15
const BATCH_LIMIT = 25

type CronHandle = Pick<CronJob, 'start' | 'stop'>

interface SweepCandidate {
  id: string
  venueId: string
  status: string
  attempts: number
}

interface InventoryPostingSweeperDependencies {
  prisma: typeof prisma
  cron?: CronHandle
  now: () => Date
  retryEntry: typeof retry
  apply: typeof applySalePosting
}

const defaults: InventoryPostingSweeperDependencies = {
  prisma,
  now: () => new Date(),
  retryEntry: retry,
  apply: applySalePosting,
}

export class InventoryPostingSweeperJob {
  private readonly dependencies: InventoryPostingSweeperDependencies
  private readonly cron: CronHandle
  private running = false

  constructor(overrides: Partial<InventoryPostingSweeperDependencies> = {}) {
    this.dependencies = { ...defaults, ...overrides }
    this.cron =
      overrides.cron ??
      scheduleJob(
        'inventory-posting-sweeper',
        DATABASE_JOB_SCHEDULES.inventoryPostingSweeper,
        () => {
          void this.runNow().catch(error => logger.error('Inventory posting sweep failed', { error }))
        },
        null,
        false,
        'America/Mexico_City',
      )
  }

  start(): void {
    this.cron.start()
    logger.info('Inventory posting sweeper started')
  }

  stop(): void {
    this.cron.stop()
    logger.info('Inventory posting sweeper stopped')
  }

  async runNow(): Promise<{ scanned: number; applied: number; partial: number; skipped: number; errors: number }> {
    if (this.running) return { scanned: 0, applied: 0, partial: 0, skipped: 1, errors: 0 }
    this.running = true
    try {
      const now = this.dependencies.now()
      const pendingBefore = new Date(now.getTime() - PENDING_GRACE_MS)
      const staleBefore = new Date(now.getTime() - STALE_APPLYING_MS)

      const candidates = (await this.dependencies.retryEntry(
        () =>
          this.dependencies.prisma.inventoryPosting.findMany({
            where: {
              attempts: { lt: MAX_ATTEMPTS },
              OR: [
                { status: { in: ['PENDING', 'PARTIAL_FAILED'] }, updatedAt: { lt: pendingBefore } },
                { status: 'APPLYING', updatedAt: { lt: staleBefore } },
              ],
            },
            select: { id: true, venueId: true, status: true, attempts: true },
            orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
            take: BATCH_LIMIT,
          }),
        {
          retries: 2,
          initialDelay: 1500,
          shouldRetry: shouldRetryDbConnectionError,
          context: 'inventory-posting-sweeper.findStale',
        },
      )) as SweepCandidate[]

      let applied = 0
      let partial = 0
      let skipped = 0
      let errors = 0

      for (const candidate of candidates) {
        try {
          const result = await this.dependencies.apply(candidate.id, null)
          if (result === null) {
            // Otro worker tiene el claim (o el posting ya no es reclamable).
            skipped += 1
          } else if (result.applied) {
            applied += 1
            logger.warn('🧹 [InventoryPostingSweeper] Posting rezagado aplicado', {
              postingId: candidate.id,
              venueId: candidate.venueId,
              previousStatus: candidate.status,
              attempts: candidate.attempts + 1,
            })
          } else {
            partial += 1
          }
        } catch (error) {
          errors += 1
          logger.error('Inventory posting sweeper candidate failed', {
            postingId: candidate.id,
            venueId: candidate.venueId,
            error,
          })
        }
      }

      if (candidates.length > 0) {
        logger.info('🧹 [InventoryPostingSweeper] Barrido terminado', {
          scanned: candidates.length,
          applied,
          partial,
          skipped,
          errors,
        })
      }

      return { scanned: candidates.length, applied, partial, skipped, errors }
    } finally {
      this.running = false
    }
  }
}

export const inventoryPostingSweeperJob = new InventoryPostingSweeperJob()
