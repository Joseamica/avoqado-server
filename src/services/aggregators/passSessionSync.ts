import { Prisma } from '@prisma/client'
import logger from '@/config/logger'
import { enqueuePassSessionSync } from './core/sessionSync.service'

/** Mismo horizonte que publica el job `aggregator-pass-worker` (HORIZON_DAYS): no se publica más allá. */
export const PASS_HORIZON_DAYS = 14
/** Dentro de 14 días esos productos no tienen más sesiones que esto (publicar). */
const SYNC_TAKE = 500
/** Dar de baja va en tandas de 500 hasta cubrir todas; el tope (10,000) sólo protege de un volumen patológico. */
const UNPUBLISH_MAX_BATCHES = 20

/** Publicar o actualizar: sesiones de esos productos que empiezan dentro del horizonte. */
export async function enqueueHorizonSessionsSync(
  tx: Prisma.TransactionClient,
  venueId: string,
  productIds: string[],
  now: Date,
): Promise<number> {
  if (productIds.length === 0) return 0
  const until = new Date(now.getTime() + PASS_HORIZON_DAYS * 24 * 3600e3)
  const sessions = await tx.classSession.findMany({
    where: { venueId, productId: { in: productIds }, startsAt: { gt: now, lt: until } },
    select: { id: true },
    orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
    take: SYNC_TAKE,
  })
  for (const s of sessions) await enqueuePassSessionSync(tx, venueId, s.id)
  return sessions.length
}

/**
 * Lo que de verdad está publicado en el proveedor: ocurrencias vivas a futuro de esa conexión y de esos productos (`null` =
 * de cualquier producto).
 */
const liveFutureWhere = (venueId: string, connectionId: string, productId: string | { in: string[] } | null, now: Date) =>
  ({
    connectionId,
    live: true,
    publishedStartsAt: { gt: now },
    classSession: productId === null ? { venueId } : { venueId, productId },
  }) satisfies Prisma.AggregatorSessionLinkWhereInput

/**
 * Dar de baja: las ocurrencias VIVAS de esa conexión cuyas sesiones son de esos productos (`null` = todas las de la
 * conexión; no depende del vínculo activo). En tandas con cursor por id hasta cubrirlas todas: una que quedara fuera
 * seguiría publicada sin trabajo pendiente.
 */
export async function enqueueLiveSessionsSync(
  tx: Prisma.TransactionClient,
  venueId: string,
  connectionId: string,
  productIds: string[] | null,
  now: Date,
): Promise<number> {
  if (productIds?.length === 0) return 0
  const where = liveFutureWhere(venueId, connectionId, productIds && { in: productIds }, now)
  let enqueued = 0
  let after: string | null = null
  for (let batch = 1; ; batch++) {
    const links: Array<{ id: string; classSessionId: string }> = await tx.aggregatorSessionLink.findMany({
      where: after ? { ...where, id: { gt: after } } : where,
      select: { id: true, classSessionId: true },
      orderBy: { id: 'asc' },
      take: SYNC_TAKE,
    })
    for (const l of links) await enqueuePassSessionSync(tx, venueId, l.classSessionId)
    enqueued += links.length
    if (links.length < SYNC_TAKE) return enqueued
    if (batch === UNPUBLISH_MAX_BATCHES) {
      logger.error(
        `[PASES] baja de la conexión ${connectionId}: se alcanzó el tope de ${enqueued} ocurrencias encoladas; puede quedar alguna`,
      )
      return enqueued
    }
    after = links[links.length - 1].id
  }
}

/** Cuántas ocurrencias vivas a futuro tiene ese producto en esa conexión. */
export async function countLiveFutureSessions(
  tx: Prisma.TransactionClient,
  venueId: string,
  connectionId: string,
  productId: string,
  now: Date,
): Promise<number> {
  return tx.aggregatorSessionLink.count({ where: liveFutureWhere(venueId, connectionId, productId, now) })
}
