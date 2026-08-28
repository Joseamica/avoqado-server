import type { CronJob } from 'cron'
import logger from '../config/logger'
import { logAction } from '../services/dashboard/activity-log.service'
import { scheduleJob } from '../observability/jobContext'
import {
  postCashRefundToDrawer,
  postCashSaleToDrawer,
  cashRefundDrawerLocalId,
  cashSaleDrawerLocalId,
} from '../services/shared/cashDrawerPosting'
import { paymentCountsAsDrawerCash, TENDER_SEMANTICS_SELECT } from '../services/shared/tenderSemantics'
import prisma from '../utils/prismaClient'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'
import { DATABASE_JOB_SCHEDULES } from './jobSchedules'

/**
 * Cash drawer reconciler — fase 3 de la unificación de caja: NINGUNA venta en efectivo se
 * queda sin anotar en el cajón.
 *
 * `postCashSaleToDrawer` corre DESPUÉS del commit del cobro y falla abierto (nunca lanza).
 * Si el proceso muere entre el commit y el posting, o la escritura truena, el Payment existe
 * y el cajón no se entera — para siempre. Es el riesgo P0 #1 de la auditoría del 27-ago:
 * un faltante inventado que el cierre le cobra al cajero.
 *
 * No hay tabla nueva ni outbox: el `Payment` YA es la fuente de verdad y el `localId` del
 * evento ya es determinista (`srv-cash-sale:<paymentId>`), así que "reponer" es llamar al
 * mismo helper, que es idempotente por índice único. Barrer dos veces no duplica.
 *
 * 🔴 LA REGLA QUE PROTEGE LOS CIERRES YA FIRMADOS: sólo se repone una venta que ocurrió DENTRO
 * de la ventana [openedAt, closedAt] de una sesión de caja del MISMO venue, y se anota en ESA
 * sesión (`targetSessionId`). Una venta hecha sin caja abierta NO se mete en la caja que se abra
 * después: eso movería dinero histórico a un cierre ajeno y cambiaría un `overShort` ya
 * calculado. Esas ventas se cuentan como `outsideDrawer` y se reportan — no se esconden.
 *
 * Compatibilidad con apps viejas: no depende de ellas. El servidor ya es dueño del CASH_SALE
 * (`syncEvents` descarta el del cliente), así que una app sin actualizar que siga empujando su
 * venta no produce doble conteo ni con el posting inline ni con este barrido.
 */

/** No pisar el posting inline, que corre segundos después del commit del cobro. */
const GRACE_MS = 3 * 60 * 1000
/** Ventana de búsqueda hacia atrás: más allá de esto, un cierre ya se dio por bueno. */
const LOOKBACK_DAYS = 7
const BATCH_LIMIT = 200

type CronHandle = Pick<CronJob, 'start' | 'stop'>

export interface UnpostedCashPayment {
  id: string
  venueId: string
  orderId: string | null
  status: string
  type: string | null
  method: string
  fundsFlow: string | null
  tenderTypeId: string | null
  tenderCountsAsCash: boolean | null
  amount: unknown
  tipAmount: unknown
  processedById: string | null
  createdAt: Date
}

export interface SessionWindow {
  id: string
  venueId: string
  openedAt: Date
  closedAt: Date | null
}

export interface ReconcilerResult {
  scanned: number
  reposted: number
  alreadyPosted: number
  outsideDrawer: number
  notDrawerCash: number
  errors: number
  skipped: number
}

interface Dependencies {
  cron?: CronHandle
  now: () => Date
  retryEntry: typeof retry
  findUnpostedCashPayments: (since: Date, until: Date, limit: number) => Promise<UnpostedCashPayment[]>
  findUnpostedCashRefunds: (since: Date, until: Date, limit: number) => Promise<UnpostedCashPayment[]>
  findSessionsCovering: (venueId: string, at: Date) => Promise<SessionWindow[]>
  postSale: (p: UnpostedCashPayment, sessionId: string) => Promise<string>
  postRefund: (p: UnpostedCashPayment, sessionId: string) => Promise<string>
}

/**
 * Pagos COMPLETED (no reembolso) que NO tienen su evento `srv-cash-sale:<id>`. El filtro
 * semántico fino (`paymentCountsAsDrawerCash`) se aplica en memoria porque su precedencia
 * (fundsFlow → snapshot → legacy) no cabe en un `where`; el SQL sólo acota candidatos.
 */
async function findUnpostedCashPaymentsDb(since: Date, until: Date, limit: number): Promise<UnpostedCashPayment[]> {
  const rows = await prisma.payment.findMany({
    where: {
      status: 'COMPLETED',
      type: { notIn: ['REFUND', 'TEST'] },
      createdAt: { gte: since, lte: until },
      OR: [{ fundsFlow: 'CASH_DRAWER' }, { fundsFlow: null, method: 'CASH' }, { fundsFlow: null, tenderCountsAsCash: true }],
    },
    select: {
      id: true,
      venueId: true,
      orderId: true,
      status: true,
      type: true,
      amount: true,
      tipAmount: true,
      processedById: true,
      createdAt: true,
      ...TENDER_SEMANTICS_SELECT,
    },
    orderBy: { createdAt: 'asc' },
    take: limit,
  })
  if (rows.length === 0) return []
  const existing = await prisma.cashDrawerEvent.findMany({
    where: { localId: { in: rows.map(r => cashSaleDrawerLocalId(r.id)) } },
    select: { localId: true },
  })
  const posted = new Set(existing.map(e => e.localId))
  return rows.filter(r => !posted.has(cashSaleDrawerLocalId(r.id))) as UnpostedCashPayment[]
}

async function findUnpostedCashRefundsDb(since: Date, until: Date, limit: number): Promise<UnpostedCashPayment[]> {
  const rows = await prisma.payment.findMany({
    where: {
      status: 'COMPLETED',
      type: 'REFUND',
      createdAt: { gte: since, lte: until },
      OR: [{ fundsFlow: 'CASH_DRAWER' }, { fundsFlow: null, method: 'CASH' }, { fundsFlow: null, tenderCountsAsCash: true }],
    },
    select: {
      id: true,
      venueId: true,
      orderId: true,
      status: true,
      type: true,
      amount: true,
      tipAmount: true,
      processedById: true,
      createdAt: true,
      ...TENDER_SEMANTICS_SELECT,
    },
    orderBy: { createdAt: 'asc' },
    take: limit,
  })
  if (rows.length === 0) return []
  const existing = await prisma.cashDrawerEvent.findMany({
    where: { localId: { in: rows.map(r => cashRefundDrawerLocalId(r.id)) } },
    select: { localId: true },
  })
  const posted = new Set(existing.map(e => e.localId))
  return rows.filter(r => !posted.has(cashRefundDrawerLocalId(r.id))) as UnpostedCashPayment[]
}

/** Sesiones del venue cuya ventana [openedAt, closedAt ∨ ahora] cubre el instante. */
async function findSessionsCoveringDb(venueId: string, at: Date): Promise<SessionWindow[]> {
  return prisma.cashDrawerSession.findMany({
    where: { venueId, openedAt: { lte: at }, OR: [{ closedAt: null }, { closedAt: { gte: at } }] },
    select: { id: true, venueId: true, openedAt: true, closedAt: true },
    orderBy: { openedAt: 'desc' },
  })
}

const defaults: Dependencies = {
  now: () => new Date(),
  retryEntry: retry,
  findUnpostedCashPayments: findUnpostedCashPaymentsDb,
  findUnpostedCashRefunds: findUnpostedCashRefundsDb,
  findSessionsCovering: findSessionsCoveringDb,
  postSale: (p, sessionId) =>
    postCashSaleToDrawer({
      venueId: p.venueId,
      paymentId: p.id,
      orderId: p.orderId,
      status: p.status,
      type: p.type,
      amount: p.amount as never,
      tipAmount: p.tipAmount as never,
      method: p.method,
      fundsFlow: p.fundsFlow,
      tenderTypeId: p.tenderTypeId,
      tenderCountsAsCash: p.tenderCountsAsCash,
      staffId: p.processedById,
      targetSessionId: sessionId,
    }),
  postRefund: (p, sessionId) =>
    postCashRefundToDrawer({
      venueId: p.venueId,
      refundPaymentId: p.id,
      orderId: p.orderId,
      amount: p.amount as never,
      method: p.method,
      fundsFlow: p.fundsFlow,
      tenderTypeId: p.tenderTypeId,
      tenderCountsAsCash: p.tenderCountsAsCash,
      staffId: p.processedById,
      targetSessionId: sessionId,
    }),
}

export class CashDrawerReconcilerJob {
  private readonly d: Dependencies
  private readonly cron: CronHandle
  private running = false

  constructor(overrides: Partial<Dependencies> = {}) {
    this.d = { ...defaults, ...overrides }
    this.cron =
      overrides.cron ??
      scheduleJob(
        'cash-drawer-reconciler',
        DATABASE_JOB_SCHEDULES.cashDrawerReconciler,
        () => {
          void this.runNow().catch(error => logger.error('Cash drawer reconcile failed', { error }))
        },
        null,
        false,
        'America/Mexico_City',
      )
  }

  start(): void {
    this.cron.start()
    logger.info('Cash drawer reconciler started')
  }

  stop(): void {
    this.cron.stop()
    logger.info('Cash drawer reconciler stopped')
  }

  async runNow(): Promise<ReconcilerResult> {
    const empty: ReconcilerResult = { scanned: 0, reposted: 0, alreadyPosted: 0, outsideDrawer: 0, notDrawerCash: 0, errors: 0, skipped: 0 }
    if (this.running) return { ...empty, skipped: 1 }
    this.running = true
    try {
      const now = this.d.now()
      const until = new Date(now.getTime() - GRACE_MS)
      const since = new Date(now.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000)

      // La lectura de entrada va con retry: es la que muere en la estampida de crons (regla del repo).
      const [sales, refunds] = await this.d.retryEntry(
        () =>
          Promise.all([
            this.d.findUnpostedCashPayments(since, until, BATCH_LIMIT),
            this.d.findUnpostedCashRefunds(since, until, BATCH_LIMIT),
          ]),
        { retries: 2, initialDelay: 1500, shouldRetry: shouldRetryDbConnectionError, context: 'cash-drawer-reconciler.find' },
      )

      const result: ReconcilerResult = { ...empty, scanned: sales.length + refunds.length }
      const repostedByVenue = new Map<string, number>()
      const sessionCache = new Map<string, SessionWindow[]>()

      const resolveSession = async (p: UnpostedCashPayment): Promise<string | null> => {
        const key = `${p.venueId}:${p.createdAt.toISOString()}`
        let windows = sessionCache.get(key)
        if (!windows) {
          windows = await this.d.findSessionsCovering(p.venueId, p.createdAt)
          sessionCache.set(key, windows)
        }
        return windows[0]?.id ?? null
      }

      const handle = async (p: UnpostedCashPayment, post: (p: UnpostedCashPayment, sid: string) => Promise<string>) => {
        try {
          if (!paymentCountsAsDrawerCash(p)) {
            result.notDrawerCash += 1
            return
          }
          const sessionId = await resolveSession(p)
          if (!sessionId) {
            result.outsideDrawer += 1
            return
          }
          const outcome = await post(p, sessionId)
          if (outcome === 'POSTED') {
            result.reposted += 1
            repostedByVenue.set(p.venueId, (repostedByVenue.get(p.venueId) ?? 0) + 1)
          } else if (outcome === 'ALREADY_POSTED') {
            result.alreadyPosted += 1
          } else if (outcome === 'NOT_DRAWER_CASH') {
            result.notDrawerCash += 1
          } else {
            result.errors += 1
          }
        } catch (error) {
          result.errors += 1
          logger.error('[CASH-DRAWER] reconcile: falló reponer un movimiento', {
            paymentId: p.id,
            venueId: p.venueId,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }

      for (const p of sales) await handle(p, this.d.postSale)
      for (const p of refunds) await handle(p, this.d.postRefund)

      // Reponer algo ES una anomalía (el posting inline falló): va a la bitácora del venue.
      // Un barrido vacío es el estado normal y no ensucia nada.
      for (const [venueId, count] of repostedByVenue) {
        void logAction({
          venueId,
          action: 'CASH_DRAWER_EVENT_REPOSTED',
          entity: 'CashDrawerSession',
          entityId: venueId,
          data: { count, window: { since: since.toISOString(), until: until.toISOString() } },
        })
      }

      if (result.reposted || result.outsideDrawer || result.errors) {
        logger.warn('💵 [CASH-DRAWER] reconcile', result)
      } else {
        logger.debug('💵 [CASH-DRAWER] reconcile: nada que reponer', result)
      }
      return result
    } finally {
      this.running = false
    }
  }
}

export const cashDrawerReconcilerJob = new CashDrawerReconcilerJob()
