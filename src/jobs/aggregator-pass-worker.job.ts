/**
 * Worker del conector de pases (TotalPass/Wellhub). Cada 30 s:
 *  1. reintenta eventos de webhook `FAILED` que ya toca reintentar y `RECEIVED` que se quedaron sin procesar;
 *  2. vence visitas sin validar y re-encola las que ya tienen asistencia registrada pero no están en la bandeja;
 *  3. cada 10 min, publica el horizonte (clases de los próximos 14 días de los productos ligados); sin el plan de
 *     pases (`AGGREGATOR_PASSES`) sólo re-sincroniza lo ya publicado;
 *  4. ejecuta la bandeja de salida de UNA fila a la vez (cada una con su propio lease), hasta 60 s (tope de 500 filas).
 * Misma forma que `angelpay-event-worker.job.ts`.
 */
import prisma from '../utils/prismaClient'
import logger from '../config/logger'
import { scheduleJob } from '../observability/jobContext'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'
import { DATABASE_JOB_SCHEDULES } from './jobSchedules'
import { processInboundEvent, MAX_EVENT_ATTEMPTS } from '../services/aggregators/core/eventProcessor.service'
import { expireVisits, requeueCheckedInVisits } from '../services/aggregators/core/visit.service'
import { claimPassOutbox, runPassOutboxRow } from '../services/aggregators/core/outbox.service'
import { enqueuePassSessionSync } from '../services/aggregators/core/sessionSync.service'
import { venuesWithFeatureAccess } from '../services/access/basePlan.service'

/** Días hacia adelante que se mantienen publicados en el proveedor. */
const HORIZON_DAYS = 14
/** Un evento `RECEIVED` más viejo que esto se considera huérfano (el webhook lo guardó pero no lo procesó). */
const ORPHAN_RECEIVED_MS = 2 * 60_000
const EVENTS_PER_TICK = 50
/** Sólo una red: el freno real es OUTBOX_BUDGET_MS (una fila sin cambios tarda milisegundos; una con llamadas, hasta 80 s). */
const OUTBOX_ROWS_PER_TICK = 500
/** R15: tope de tiempo de la bandeja de salida por vuelta (cada llamada al proveedor puede tardar hasta 20 s). */
const OUTBOX_BUDGET_MS = 60_000
const HORIZON_CONNECTIONS_TAKE = 500
const HORIZON_LINKS_TAKE = 200
const HORIZON_SESSIONS_TAKE = 500

type AggregatorPassWorkerDependencies = {
  pendingEvents: (now: Date) => Promise<string[]>
  processEvent: (id: string, now: Date) => Promise<void>
  expireVisits: (now: Date) => Promise<number>
  requeueVisits: (now: Date) => Promise<number>
  publishHorizon: (now: Date) => Promise<number>
  claim: (limit: number, now: Date) => Promise<Array<{ id: string; claimToken: string }>>
  runRow: (id: string, claimToken: string, now: Date) => Promise<void>
  now: () => Date
  cron: { start: () => void; stop: () => void }
}

/** FAILED con próxima vuelta vencida (un `nextAttemptAt` nulo es terminal y `lte` lo excluye) o RECEIVED huérfanos. */
async function findPendingEvents(now: Date): Promise<string[]> {
  const rows = await retry(
    () =>
      prisma.aggregatorInboundEvent.findMany({
        where: {
          OR: [
            { status: 'FAILED', nextAttemptAt: { lte: now }, attemptCount: { lt: MAX_EVENT_ATTEMPTS } },
            { status: 'RECEIVED', receivedAt: { lt: new Date(now.getTime() - ORPHAN_RECEIVED_MS) } },
          ],
        },
        select: { id: true },
        orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
        take: EVENTS_PER_TICK,
      }),
    { retries: 2, initialDelay: 1500, shouldRetry: shouldRetryDbConnectionError, context: 'aggregator-pass-worker.pendingEvents' },
  )
  return rows.map(r => r.id)
}

/**
 * Encola `SYNC_SESSION` de las clases programadas de los productos ligados en los próximos 14 días. Pausa suave (founder,
 * 3-oct): una conexión cuyo negocio perdió el plan sólo re-sincroniza lo que YA tiene publicado vivo a futuro (cupo,
 * detalles, baja), para que el proveedor no ofrezca lugares que ya no hay; nada nuevo se encola.
 */
async function publishHorizon(now: Date): Promise<number> {
  const until = new Date(now.getTime() + HORIZON_DAYS * 24 * 3600_000)
  const conns = await retry(
    () =>
      prisma.aggregatorConnection.findMany({
        where: { status: 'ACTIVE' },
        select: { id: true, venueId: true },
        orderBy: { id: 'asc' },
        take: HORIZON_CONNECTIONS_TAKE,
      }),
    { retries: 2, initialDelay: 1500, shouldRetry: shouldRetryDbConnectionError, context: 'aggregator-pass-worker.horizon' },
  )
  // Una sola tanda de consultas de acceso para todas las conexiones.
  const entitled = await venuesWithFeatureAccess([...new Set(conns.map(c => c.venueId))], 'AGGREGATOR_PASSES')
  const paused = conns.filter(c => !entitled.has(c.venueId)).length
  if (paused > 0) {
    logger.info(`[PASES] worker: ${paused} conexiones sin plan: no se publican clases nuevas; sólo se actualiza lo ya publicado`)
  }
  let enqueued = 0
  for (const c of conns) {
    const sessionIds = entitled.has(c.venueId) ? await horizonSessionIds(c, now, until) : await livePublishedSessionIds(c.id, now, until)
    for (const id of sessionIds) {
      await prisma.$transaction(tx => enqueuePassSessionSync(tx, c.venueId, id))
      enqueued++
    }
  }
  return enqueued
}

/** Clases programadas de los productos ligados a la conexión, dentro del horizonte. */
async function horizonSessionIds(c: { id: string; venueId: string }, now: Date, until: Date): Promise<string[]> {
  const links = await prisma.aggregatorProductLink.findMany({
    where: { connectionId: c.id, active: true },
    select: { productId: true },
    orderBy: { id: 'asc' },
    take: HORIZON_LINKS_TAKE,
  })
  if (links.length === 0) return []
  const sessions = await prisma.classSession.findMany({
    where: { venueId: c.venueId, status: 'SCHEDULED', productId: { in: links.map(l => l.productId) }, startsAt: { gt: now, lt: until } },
    select: { id: true },
    orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
    take: HORIZON_SESSIONS_TAKE,
  })
  return sessions.map(s => s.id)
}

/** Clases con ocurrencia viva a futuro en la conexión, dentro del horizonte (lo que el proveedor ya ofrece). */
async function livePublishedSessionIds(connectionId: string, now: Date, until: Date): Promise<string[]> {
  const links = await prisma.aggregatorSessionLink.findMany({
    where: { connectionId, live: true, publishedStartsAt: { gt: now, lt: until } },
    select: { classSessionId: true },
    orderBy: [{ publishedStartsAt: 'asc' }, { id: 'asc' }],
    take: HORIZON_SESSIONS_TAKE,
  })
  return links.map(l => l.classSessionId)
}

export class AggregatorPassWorkerJob {
  private running = false
  private readonly deps: AggregatorPassWorkerDependencies

  constructor(overrides: Partial<AggregatorPassWorkerDependencies> = {}) {
    this.deps = {
      pendingEvents: findPendingEvents,
      processEvent: processInboundEvent,
      expireVisits,
      requeueVisits: requeueCheckedInVisits,
      publishHorizon,
      claim: claimPassOutbox,
      runRow: runPassOutboxRow,
      now: () => new Date(),
      cron:
        overrides.cron ??
        scheduleJob(
          'aggregator-pass-worker',
          DATABASE_JOB_SCHEDULES.aggregatorPassWorker,
          // Se devuelve la promesa (sin `void`): el registro de jobs sabe cuándo terminó la vuelta.
          () =>
            this.runOnce().catch(err => {
              logger.error(`[PASES] worker: la vuelta falló: ${err?.message}`)
            }),
          null,
          false,
          'America/Mexico_City',
        ),
      ...overrides,
    }
  }

  start(): void {
    this.deps.cron.start()
  }

  stop(): void {
    this.deps.cron.stop()
  }

  async runOnce(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      const startedAt = this.deps.now()
      // Cada etapa es independiente: si una truena (p. ej. la base parpadea), las demás corren igual en esta vuelta.
      await this.step('eventos', () => this.retryEvents(startedAt))
      await this.step('visitas', async () => {
        await this.deps.expireVisits(this.deps.now())
        await this.deps.requeueVisits(this.deps.now())
      })
      // Dos vueltas por minuto: sólo la primera del minuto múltiplo de 10 publica el horizonte.
      if (startedAt.getUTCMinutes() % 10 === 0 && startedAt.getUTCSeconds() < 30) {
        await this.step('horizonte', async () => {
          const n = await this.deps.publishHorizon(startedAt)
          if (n > 0) logger.info(`[PASES] worker: horizonte de ${HORIZON_DAYS} días, ${n} sesiones encoladas`)
        })
      }
      await this.step('salida', () => this.drainOutbox(startedAt))
    } finally {
      this.running = false
    }
  }

  private async step(name: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn()
    } catch (err: any) {
      logger.error(`[PASES] worker: la etapa ${name} falló: ${err?.message}`)
    }
  }

  private async retryEvents(startedAt: Date): Promise<void> {
    for (const id of await this.deps.pendingEvents(startedAt)) {
      try {
        await this.deps.processEvent(id, this.deps.now())
      } catch (err: any) {
        logger.error(`[PASES] worker: evento ${id}: ${err?.message}`)
      }
    }
  }

  /** R15: una fila por reclamo, para que el lease de 2 min cubra sólo la llamada en curso; tope de filas y de tiempo. */
  private async drainOutbox(startedAt: Date): Promise<void> {
    for (let done = 0; done < OUTBOX_ROWS_PER_TICK; done++) {
      const now = this.deps.now()
      if (now.getTime() - startedAt.getTime() >= OUTBOX_BUDGET_MS) break
      const [row] = await this.deps.claim(1, now)
      if (!row) break
      try {
        await this.deps.runRow(row.id, row.claimToken, now)
      } catch (err: any) {
        logger.error(`[PASES] worker: salida ${row.id}: ${err?.message}`)
      }
    }
  }
}

export const aggregatorPassWorkerJob = new AggregatorPassWorkerJob()
