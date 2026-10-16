import type { CronJob } from 'cron'
import logger from '../config/logger'
import { scheduleJob } from '../observability/jobContext'
import { syncOnlineOrdersOfCancelledOrders } from '../services/online-ordering/cancelledOrderSync'
import { EXPIRY_BATCH_SIZE } from '../services/online-ordering/constants'
import { expireOnlineOrder } from '../services/online-ordering/transitions.service'
import prisma from '../utils/prismaClient'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'
import { DATABASE_JOB_SCHEDULES } from './jobSchedules'

type CronHandle = Pick<CronJob, 'start' | 'stop'>

/** H7: tope de páginas por pasada (10 × 100 candidatos). Sin estado entre pasadas: la siguiente vuelve a empezar. */
const EXPIRY_MAX_PAGES = 10

interface ExpiryCandidate {
  id: string
  orderId: string
  venueId: string
  acceptDeadlineAt: Date
}

interface OnlineOrderAcceptanceExpiryDependencies {
  prisma: typeof prisma
  cron?: CronHandle
  now: () => Date
  expireOrder: typeof expireOnlineOrder
  retryEntry: typeof retry
  /** R2: cierra los pedidos cuya cuenta se canceló por otra vía, en TODOS los negocios, antes de buscar vencidos. */
  syncCancelled: (now: Date) => Promise<number>
}

interface ExpiryResult {
  scanned: number
  expired: number
  noop: number
  errors: number
  synced: number
  skipped?: true
}

const defaults: OnlineOrderAcceptanceExpiryDependencies = {
  prisma,
  now: () => new Date(),
  expireOrder: expireOnlineOrder,
  retryEntry: retry,
  syncCancelled: now => syncOnlineOrdersOfCancelledOrders(prisma, {}, now),
}

export class OnlineOrderAcceptanceExpiryJob {
  private readonly dependencies: OnlineOrderAcceptanceExpiryDependencies
  private readonly job: CronHandle
  private isRunning = false

  constructor(overrides: Partial<OnlineOrderAcceptanceExpiryDependencies> = {}) {
    this.dependencies = { ...defaults, ...overrides }
    this.job =
      overrides.cron ??
      scheduleJob(
        'online-order-acceptance-expiry',
        DATABASE_JOB_SCHEDULES.onlineOrderAcceptanceExpiry,
        async () => {
          await this.checkNow()
        },
        null,
        false,
        'America/Mexico_City',
      )
  }

  start(): void {
    this.job.start()
    logger.info('Online-order acceptance expiry job started')
  }

  stop(): void {
    this.job.stop()
    logger.info('Online-order acceptance expiry job stopped')
  }

  async checkNow(): Promise<ExpiryResult> {
    if (this.isRunning) {
      logger.warn('[Online-order expiry] tick skipped — previous run still in progress')
      return { scanned: 0, expired: 0, noop: 0, errors: 0, synced: 0, skipped: true }
    }
    this.isRunning = true
    let synced = 0

    try {
      const now = this.dependencies.now()

      // R2: es una escritura (CAS), así que NO va dentro del reintento de lectura; si falla, la pasada sigue.
      try {
        synced = await this.dependencies.syncCancelled(now)
      } catch (error) {
        logger.error('Online-order expiry: no se pudieron cerrar los pedidos de cuentas canceladas (la pasada sigue)', { error })
      }

      let scanned = 0
      let expired = 0
      let noop = 0
      let errors = 0
      let cursor: { at: Date; id: string } | null = null

      // H7: por llave estable (acceptDeadlineAt, id), página tras página, también cuando un candidato sale `noop` (un cobro de
      // terminal incierto lo deja bloqueado): 100 bloqueados delante no detienen a los que siguen.
      for (let page = 0; page < EXPIRY_MAX_PAGES; page++) {
        const after = cursor
        // Lectura de entrada con reintento por conexión (regla cron-jobs.md). Los avisos y la transacción quedan FUERA.
        // R1: sólo pedidos sin dinero y cuya cuenta sigue viva: uno ya cobrado no vence.
        const candidates = (await this.dependencies.retryEntry(
          () =>
            this.dependencies.prisma.onlineOrder.findMany({
              where: {
                status: 'PENDING_ACCEPTANCE',
                acceptDeadlineAt: { lte: now },
                order: { paymentStatus: 'PENDING', status: { notIn: ['CANCELLED', 'DELETED'] } },
                ...(after ? { OR: [{ acceptDeadlineAt: { gt: after.at } }, { acceptDeadlineAt: after.at, id: { gt: after.id } }] } : {}),
              },
              select: { id: true, orderId: true, venueId: true, acceptDeadlineAt: true },
              orderBy: [{ acceptDeadlineAt: 'asc' }, { id: 'asc' }],
              take: EXPIRY_BATCH_SIZE,
            }),
          {
            retries: 2,
            initialDelay: 1500,
            shouldRetry: shouldRetryDbConnectionError,
            context: 'online-order-acceptance-expiry.findDue',
          },
        )) as ExpiryCandidate[]

        for (const candidate of candidates) {
          try {
            const r = await this.dependencies.expireOrder({ venueId: candidate.venueId, orderId: candidate.orderId, now })
            if (r.outcome === 'OK') expired += 1
            else noop += 1
          } catch (error) {
            errors += 1
            logger.error('Online-order expiry candidate failed', { orderId: candidate.orderId, venueId: candidate.venueId, error })
          }
        }
        scanned += candidates.length
        if (candidates.length < EXPIRY_BATCH_SIZE) break
        const last = candidates[candidates.length - 1]
        cursor = { at: last.acceptDeadlineAt, id: last.id }
      }

      return { scanned, expired, noop, errors, synced }
    } catch (error) {
      logger.error('Online-order expiry pass failed', { error })
      return { scanned: 0, expired: 0, noop: 0, errors: 1, synced }
    } finally {
      this.isRunning = false
    }
  }
}

export const onlineOrderAcceptanceExpiryJob = new OnlineOrderAcceptanceExpiryJob()
