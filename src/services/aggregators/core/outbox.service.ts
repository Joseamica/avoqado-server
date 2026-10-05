import crypto from 'crypto'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { utcTs } from '@/utils/sqlDates'
import { adapterFor } from './adapterRegistry'
import { decryptCredential } from './credentials'
import { venueHasFeatureAccess } from '@/services/access/basePlan.service'
// Ciclo de imports aceptado (ruling R2): sessionSync.service importa `enqueuePassOutbox` de aquí. Los dos lados sólo se
// usan dentro de funciones, nunca al cargar el módulo.
import { buildSessionPublication } from './sessionSync.service'
// Mismo caso (R2): bookingIngestion importa `enqueuePassOutbox` de aquí; los dos sólo se usan dentro de funciones.
import { cancelPassBookingsOfReplacedOccurrence } from './bookingIngestion.service'
import { ActionResult, ConnectionCtx, DenyReason, PassAdapter, PROVIDER_LABEL, SessionPublication } from './types'

export type PassOutboxOp = 'SYNC_SESSION' | 'RESPOND_BOOKING' | 'VALIDATE_VISIT' | 'CANCEL_BOOKING'

/** `CREATED` = fila nueva · `COALESCED` = se juntó con una igual que esperaba · `IN_FLIGHT` = una validación igual ya corre. */
export type PassOutboxEnqueue = 'CREATED' | 'COALESCED' | 'IN_FLIGHT'

/**
 * Encola trabajo para el proveedor dentro de la MISMA transacción que lo origina (si la transacción se deshace, el
 * trabajo también). Junta trabajo repetido: si ya hay uno igual esperando (`PENDING` o `FAILED` con la misma llave), no
 * crea otro, sólo lo adelanta — el worker recalcula el estado al ejecutar, así que una sola corrida basta.
 * Una validación de visita que ya está en curso (`IN_PROGRESS` con lease vivo) tampoco se repite: otra fila mandaría una
 * segunda validación al proveedor. Lo demás (p. ej. resincronizar una sesión) sí crea otra: el estado pudo cambiar después
 * de que el worker lo leyó.
 */
export async function enqueuePassOutbox(
  tx: Prisma.TransactionClient,
  p: {
    venueId: string
    connectionId: string
    operation: PassOutboxOp
    classSessionId?: string
    aggregatorBookingId?: string
    aggregatorVisitId?: string
  },
): Promise<PassOutboxEnqueue> {
  const objectId = p.classSessionId ?? p.aggregatorBookingId ?? p.aggregatorVisitId
  const coalesceKey = `${p.operation}:${p.connectionId}:${objectId}`
  const pending = await tx.aggregatorOutbox.findFirst({
    where: { coalesceKey, status: { in: ['PENDING', 'FAILED'] } },
    select: { id: true },
  })
  if (pending) {
    await tx.aggregatorOutbox.update({ where: { id: pending.id }, data: { scheduledAt: new Date() } })
    return 'COALESCED'
  }
  if (p.operation === 'VALIDATE_VISIT') {
    const inFlight = await tx.aggregatorOutbox.findFirst({
      where: { coalesceKey, status: 'IN_PROGRESS', leaseUntil: { gt: new Date() } },
      select: { id: true },
    })
    if (inFlight) return 'IN_FLIGHT'
  }
  await tx.aggregatorOutbox.create({
    data: {
      venueId: p.venueId,
      connectionId: p.connectionId,
      operation: p.operation,
      classSessionId: p.classSessionId ?? null,
      aggregatorBookingId: p.aggregatorBookingId ?? null,
      aggregatorVisitId: p.aggregatorVisitId ?? null,
      coalesceKey,
    },
  })
  return 'CREATED'
}

// ─────────────────────────────────────────────────────────────────────────────
// Worker: ejecuta las llamadas al proveedor
// ─────────────────────────────────────────────────────────────────────────────

/** Lo que dura el reclamo de una fila; si el proceso muere con la fila en curso, otra corrida la retoma al vencer. */
const LEASE_MS = 120_000
/** Espera tras cada intento fallido (minutos): 30 s, 2 min, 10 min, 1 h, 6 h. */
const BACKOFF_MIN = [0.5, 2, 10, 60, 360]
/** Al llegar a este número de intentos la fila queda `DEAD_LETTER` (la decide una persona). */
const MAX_ATTEMPTS = 6
/** Plazo del proveedor para aceptar o rechazar una reserva; pasado, se manda igual (puede aceptarla tarde) con aviso. */
const RESPOND_WINDOW_MS = 5 * 60e3
const MAX_CLAIM = 50
const MAX_ERROR_CHARS = 2000
const DENY_REASONS: readonly DenyReason[] = ['CLASS_FULL', 'CLASS_CANCELLED', 'NOT_ELIGIBLE', 'ALREADY_IN_CLASS', 'OTHER']
/** Fallas de red (no llegó la respuesta): al estudio se le dicen en palabras normales, sin el error técnico. */
const NETWORK_CODES = new Set(['NETWORK', 'TIMEOUT'])

/**
 * Reclama un lote (lo más antiguo primero) con `FOR UPDATE SKIP LOCKED` y un lease de 2 min, como
 * `claimPendingAngelPayEvents`. Una fila `IN_PROGRESS` con el lease vencido (el proceso murió a media llamada) se
 * retoma, y ese lease perdido cuenta como un intento: si con él llega al tope, queda `DEAD_LETTER` sin devolverse
 * (así una fila que tumba el proceso no se reintenta para siempre).
 */
export async function claimPassOutbox(limit: number, now: Date): Promise<Array<{ id: string; claimToken: string }>> {
  const take = Number.isFinite(limit) ? Math.min(MAX_CLAIM, Math.max(1, Math.floor(limit))) : MAX_CLAIM
  const token = crypto.randomUUID()
  const leaseUntil = new Date(now.getTime() + LEASE_MS)
  // El RETURNING de un UPDATE … FROM no conserva el orden de la selección: se vuelve a ordenar al final.
  // Primero lo que tiene plazo del proveedor (contestar una reserva: 5 min; validar un check-in: 90 min) y después las
  // publicaciones de clases: el horizonte encola cientos cada 10 min y una reserva no puede hacer fila detrás de ellas.
  const rows = await prisma.$queryRaw<Array<{ id: string; claimToken: string | null; status: string }>>`
    WITH picked AS (
      SELECT id FROM "AggregatorOutbox"
      WHERE (status IN ('PENDING', 'FAILED') AND "scheduledAt" <= ${utcTs(now)})
         OR (status = 'IN_PROGRESS' AND "leaseUntil" < ${utcTs(now)})
      ORDER BY CASE operation WHEN 'RESPOND_BOOKING' THEN 0 WHEN 'VALIDATE_VISIT' THEN 1 WHEN 'CANCEL_BOOKING' THEN 1 ELSE 2 END ASC, "scheduledAt" ASC, id ASC
      LIMIT ${take}
      FOR UPDATE SKIP LOCKED
    ),
    reclamados AS (
      UPDATE "AggregatorOutbox" o SET
        attempts = CASE WHEN o.status = 'IN_PROGRESS' THEN o.attempts + 1 ELSE o.attempts END,
        status = CASE WHEN o.status = 'IN_PROGRESS' AND o.attempts + 1 >= ${MAX_ATTEMPTS}
          THEN 'DEAD_LETTER'::"AggregatorOutboxStatus" ELSE 'IN_PROGRESS'::"AggregatorOutboxStatus" END,
        "lastError" = CASE WHEN o.status = 'IN_PROGRESS' AND o.attempts + 1 >= ${MAX_ATTEMPTS}
          THEN 'LEASE_EXPIRED: el proceso no terminó la llamada' ELSE o."lastError" END,
        "processedAt" = CASE WHEN o.status = 'IN_PROGRESS' AND o.attempts + 1 >= ${MAX_ATTEMPTS}
          THEN ${utcTs(now)} ELSE o."processedAt" END,
        "claimToken" = CASE WHEN o.status = 'IN_PROGRESS' AND o.attempts + 1 >= ${MAX_ATTEMPTS}
          THEN NULL ELSE ${token} END,
        "leaseUntil" = CASE WHEN o.status = 'IN_PROGRESS' AND o.attempts + 1 >= ${MAX_ATTEMPTS}
          THEN NULL ELSE ${utcTs(leaseUntil)} END
      FROM picked WHERE o.id = picked.id
      RETURNING o.id, o."claimToken", o.status::text AS status, o."scheduledAt", o.operation
    )
    SELECT id, "claimToken", status FROM reclamados
    ORDER BY CASE operation WHEN 'RESPOND_BOOKING' THEN 0 WHEN 'VALIDATE_VISIT' THEN 1 WHEN 'CANCEL_BOOKING' THEN 1 ELSE 2 END ASC, "scheduledAt" ASC, id ASC
  `
  const dead = rows.filter(r => r.status === 'DEAD_LETTER')
  if (dead.length > 0)
    logger.error(`[PASES] bandeja: ${dead.length} fila(s) con el lease vencido agotaron sus intentos ⇒ DEAD_LETTER`, {
      ids: dead.map(r => r.id),
    })
  return rows.filter(r => r.status === 'IN_PROGRESS' && r.claimToken).map(r => ({ id: r.id, claimToken: r.claimToken as string }))
}

type OutboxRowWithConnection = Prisma.AggregatorOutboxGetPayload<{ include: { connection: true } }>

function ctxOf(conn: OutboxRowWithConnection['connection']): ConnectionCtx {
  return {
    id: conn.id,
    venueId: conn.venueId,
    provider: conn.provider,
    externalPlaceId: conn.externalPlaceId,
    credential: decryptCredential(conn.credentialCiphertext),
    config: (conn.config ?? {}) as Record<string, unknown>,
  }
}

/**
 * Texto apto para `lastError` y logs: sin URLs (la de validación lleva un token de un solo uso) y acotado. Las llaves
 * nunca llegan aquí (viven cifradas en la conexión y sólo las ve el adaptador).
 */
function safeText(s: unknown): string {
  return String(s ?? '')
    .replace(/https?:\/\/\S+/gi, '<url>')
    .slice(0, MAX_ERROR_CHARS)
}

/** Cierra la fila sólo si el lease sigue siendo nuestro. */
async function finish(id: string, claimToken: string, data: Prisma.AggregatorOutboxUpdateManyMutationInput): Promise<void> {
  await prisma.aggregatorOutbox.updateMany({ where: { id, claimToken }, data: { ...data, claimToken: null, leaseUntil: null } })
}

/** Resultado de una operación: `ActionResult` del proveedor, o «no había nada que hacer» con su motivo. */
type Outcome = ActionResult | { skipped: string }

/**
 * Ejecuta UNA fila reclamada. Recalcula el estado al ejecutar (la bandeja junta trabajo repetido), y deja la fila en:
 * - `DONE`: hecho (o la visita quedó en estado terminal: confirmada, ya confirmada o vencida).
 * - `SKIPPED`: nada que hacer — la conexión no está `ACTIVE`, la visita ya no está `PENDING`, la reserva ya se canceló,
 *   o la sesión no tiene ocurrencia viva que tocar. Una validación saltada por conexión no activa la re-encola el
 *   barrido de visitas al reactivarse.
 * - `FAILED` con espera creciente, o `DEAD_LETTER` tras `MAX_ATTEMPTS` o con un error no reintentable.
 * Un 401 (`UNAUTHORIZED`) marca la conexión `REVOKED` y la fila `SKIPPED` (al reconectar se vuelve a encolar).
 */
export async function runPassOutboxRow(id: string, claimToken: string, now: Date): Promise<void> {
  const row = await prisma.aggregatorOutbox.findFirst({ where: { id, claimToken }, include: { connection: true } })
  if (!row) return
  if (row.connection.status !== 'ACTIVE') {
    return finish(id, claimToken, { status: 'SKIPPED', processedAt: now, lastError: `conexión ${row.connection.status}` })
  }

  let outcome: Outcome
  try {
    outcome = await execute(row, now)
  } catch (err: any) {
    outcome = { ok: false, retryable: true, code: 'EXCEPTION', message: String(err?.message ?? err) }
  }

  if ('skipped' in outcome) return finish(id, claimToken, { status: 'SKIPPED', processedAt: now, lastError: safeText(outcome.skipped) })
  if (outcome.ok) return finish(id, claimToken, { status: 'DONE', processedAt: now, lastError: null })

  const message = safeText(outcome.message)
  const lastError = safeText(`${outcome.code}: ${message}`)
  if (outcome.code === 'UNAUTHORIZED') {
    // Sólo si seguía activa (no se pisa una pausa que el estudio puso mientras tanto) y con la MISMA credencial con la que
    // salió esta llamada: si el estudio pegó una llave nueva mientras volaba, el 401 es de la vieja y no apaga la conexión.
    const revoked = await prisma.aggregatorConnection.updateMany({
      where: { id: row.connectionId, status: 'ACTIVE', credentialCiphertext: row.connection.credentialCiphertext },
      data: { status: 'REVOKED', lastError: 'El proveedor rechazó las llaves (401): hay que volver a conectar.' },
    })
    if (revoked.count === 0) {
      logger.warn(`[PASES] ${row.operation} ${id}: 401 de una credencial que ya cambió o de una conexión no activa; se reintenta`)
      return finish(id, claimToken, { status: 'FAILED', attempts: row.attempts + 1, lastError, scheduledAt: now })
    }
    logger.error(`[PASES] ${row.operation} ${id}: el proveedor rechazó las llaves ⇒ conexión ${row.connectionId} REVOKED`)
    return finish(id, claimToken, { status: 'SKIPPED', processedAt: now, attempts: row.attempts + 1, lastError })
  }

  const attempts = row.attempts + 1
  const dead = !outcome.retryable || attempts >= MAX_ATTEMPTS
  // La pantalla de check-ins lee la visita, no la bandeja: se le anota el motivo (ya sin URLs) mientras siga PENDING.
  // Es accesorio: si falla, la fila se cierra igual (si no, quedaría IN_PROGRESS hasta que venza el lease).
  if (row.operation === 'VALIDATE_VISIT' && row.aggregatorVisitId) {
    // Una falla de red va en palabras normales (la fila de la bandeja conserva el motivo técnico); las demás, como siempre.
    const unreachable = `No pudimos comunicarnos con ${PROVIDER_LABEL[row.connection.provider]}`
    const note = NETWORK_CODES.has(outcome.code)
      ? dead
        ? `${unreachable}.`
        : `${unreachable}; lo reintentamos.`
      : dead
        ? `No se pudo confirmar con el proveedor: ${lastError}`
        : `Reintentando con el proveedor: ${lastError}`
    try {
      await prisma.aggregatorVisit.updateMany({
        where: { id: row.aggregatorVisitId, status: 'PENDING' },
        data: { lastError: note },
      })
    } catch (err: any) {
      logger.warn(`[PASES] no se pudo anotar el motivo en la visita ${row.aggregatorVisitId}: ${safeText(err?.message ?? err)}`)
    }
  }
  if (dead) {
    logger.error(`[PASES] ${row.operation} ${id} ⇒ DEAD_LETTER tras ${attempts} intento(s): ${lastError}`)
    return finish(id, claimToken, { status: 'DEAD_LETTER', attempts, processedAt: now, lastError })
  }
  const waitMin = BACKOFF_MIN[Math.min(attempts - 1, BACKOFF_MIN.length - 1)]
  let scheduledAt = new Date(now.getTime() + waitMin * 60e3)
  if (row.operation === 'VALIDATE_VISIT') scheduledAt = await beforeVisitDeadline(row.aggregatorVisitId, now, scheduledAt)
  logger.warn(`[PASES] ${row.operation} ${id} falló (intento ${attempts}), otro a las ${scheduledAt.toISOString()}: ${lastError}`)
  return finish(id, claimToken, { status: 'FAILED', attempts, lastError, scheduledAt })
}

/**
 * Una validación nunca duerme más allá del plazo de su visita (la espera de 1 h o 6 h la dejaría vencer con el proveedor
 * ya recuperado): a más tardar 1 min antes de vencer, y nunca antes de 30 s (no se repite el golpe al proveedor). Si el
 * plazo no se puede leer, se queda la espera normal.
 */
async function beforeVisitDeadline(visitId: string | null, now: Date, at: Date): Promise<Date> {
  if (!visitId) return at
  let v: { deadlineAt: Date } | null = null
  try {
    v = await prisma.aggregatorVisit.findUnique({ where: { id: visitId }, select: { deadlineAt: true } })
  } catch {
    return at
  }
  if (!v) return at
  const latest = Math.max(v.deadlineAt.getTime() - 60e3, now.getTime() + 30e3)
  return at.getTime() > latest ? new Date(latest) : at
}

async function execute(row: OutboxRowWithConnection, now: Date): Promise<Outcome> {
  const adapter = adapterFor(row.connection.provider)
  const ctx = ctxOf(row.connection)
  switch (row.operation) {
    case 'VALIDATE_VISIT':
      return validateVisit(row, adapter, ctx, now)
    case 'RESPOND_BOOKING':
      return respondBooking(row, adapter, ctx, now)
    case 'SYNC_SESSION':
      return syncSession(row, adapter, ctx, now)
    case 'CANCEL_BOOKING':
      return cancelBooking(row, adapter, ctx)
    default:
      return { ok: false, retryable: false, code: 'UNKNOWN_OPERATION', message: `operación desconocida ${String(row.operation)}` }
  }
}

async function validateVisit(row: OutboxRowWithConnection, adapter: PassAdapter, ctx: ConnectionCtx, now: Date): Promise<Outcome> {
  if (!row.aggregatorVisitId) return { skipped: 'fila sin visita' }
  const v = await prisma.aggregatorVisit.findUnique({
    where: { id: row.aggregatorVisitId },
    include: { connection: { select: { confirmMode: true } } },
  })
  if (!v) return { skipped: 'la visita ya no existe' }
  if (v.status !== 'PENDING') return { skipped: `visita ${v.status}` }
  // Pasado el plazo no se llama: ese cobro ya se perdió, y la visita queda en estado terminal (el barrido no la repite).
  // La escritura va con candado de estado (`status: 'PENDING'`): si el estudio u otro camino la cambió entre la lectura
  // y aquí, no se pisa (count 0 = ya la resolvió alguien más; la fila queda DONE igual).
  if (v.deadlineAt.getTime() <= now.getTime()) {
    await settleVisit(v.id, { status: 'EXPIRED', lastError: 'venció antes de validar' })
    return { ok: true }
  }
  const r = await adapter.validateVisit(ctx, v.validationRef)
  if (r.ok || r.alreadyValidated || r.expired) {
    const status = r.ok ? 'CONFIRMED' : r.alreadyValidated ? 'ALREADY_CONFIRMED' : 'EXPIRED'
    const confirmed = status !== 'EXPIRED'
    await settleVisit(v.id, {
      status,
      confirmedAt: confirmed ? now : null,
      // Si una persona la confirmó desde el dashboard (`confirmPassVisit` deja VENUE), se conserva aunque la conexión sea AUTO.
      confirmedBy: confirmed ? (v.confirmedBy ?? (v.connection.confirmMode === 'AUTO' ? 'AUTO' : 'VENUE')) : null,
      lastError: r.ok ? null : safeText(r.message),
    })
    return { ok: true }
  }
  return r
}

/** Deja la visita en estado terminal sólo si sigue `PENDING`. */
async function settleVisit(visitId: string, data: Prisma.AggregatorVisitUpdateManyMutationInput): Promise<void> {
  const res = await prisma.aggregatorVisit.updateMany({ where: { id: visitId, status: 'PENDING' }, data })
  if (res?.count === 0) logger.info(`[PASES] visita ${visitId}: ya no estaba PENDING al cerrarla; se respeta su estado`)
}

async function respondBooking(row: OutboxRowWithConnection, adapter: PassAdapter, ctx: ConnectionCtx, now: Date): Promise<Outcome> {
  if (!row.aggregatorBookingId) return { skipped: 'fila sin reserva' }
  const b = await prisma.aggregatorBooking.findUnique({ where: { id: row.aggregatorBookingId } })
  if (!b) return { skipped: 'la reserva ya no existe' }
  // El socio canceló antes de que respondiéramos: el proveedor ya la dio de baja, no hay nada que contestar.
  if (b.decision === 'CANCELLED') return { skipped: 'reserva cancelada por el socio' }
  if (now.getTime() - b.createdAt.getTime() > RESPOND_WINDOW_MS) {
    logger.warn(`[PASES] respuesta a la reserva ${b.externalBookingId} fuera de los 5 min del proveedor; se manda igual`)
  }
  if (b.decision === 'DENIED') {
    const reason = DENY_REASONS.includes(b.denyReason as DenyReason) ? (b.denyReason as DenyReason) : 'OTHER'
    return adapter.respondBooking(ctx, b.externalBookingId, { accept: false, reason })
  }
  return adapter.respondBooking(ctx, b.externalBookingId, { accept: true })
}

/** El estudio canceló la reserva de un socio desde Avoqado (`cancelPassBookingFromVenue`): se da de baja en el proveedor. */
async function cancelBooking(row: OutboxRowWithConnection, adapter: PassAdapter, ctx: ConnectionCtx): Promise<Outcome> {
  if (!row.aggregatorBookingId) return { skipped: 'fila sin reserva' }
  const b = await prisma.aggregatorBooking.findUnique({ where: { id: row.aggregatorBookingId } })
  if (!b) return { skipped: 'la reserva ya no existe' }
  if (b.decision !== 'CANCELLED') return { skipped: `reserva ${b.decision}` }
  return adapter.cancelBooking(ctx, b.externalBookingId)
}

/**
 * Huella de lo que el proveedor deja editar en una ocurrencia viva sin cancelar reservas (título, coach, duración y cierre
 * de reservas; contrato de TotalPass §3.6). La hora y el cupo van aparte (`publishedStartsAt`, `publishedSpots`).
 */
export function publicationHash(p: SessionPublication): string {
  const fields = [p.title, p.coachName, p.durationMin, p.bookingClosesAt?.toISOString() ?? null]
  return crypto.createHash('sha256').update(JSON.stringify(fields)).digest('hex').slice(0, 16)
}

async function syncSession(row: OutboxRowWithConnection, adapter: PassAdapter, ctx: ConnectionCtx, now: Date): Promise<Outcome> {
  if (!row.classSessionId) return { skipped: 'fila sin sesión' }
  const classSessionId = row.classSessionId
  const built = await buildSessionPublication(classSessionId, row.connectionId, now)
  const linkKey = { connectionId_classSessionId: { connectionId: row.connectionId, classSessionId } }
  const link = await prisma.aggregatorSessionLink.findUnique({ where: linkKey })

  if (!built.publication) {
    // Cancelada, sin ligar o borrada ⇒ se da de baja si sigue viva. Una clase PASADA nunca se da de baja (el socio ya
    // asistió: darla de baja le cancelaría la reserva en el proveedor); también se mira la hora publicada, por defensa.
    const publishedPast = link?.publishedStartsAt ? link.publishedStartsAt.getTime() <= now.getTime() : false
    if (built.reason !== 'PAST' && !publishedPast && link?.live && link.externalOccurrenceId) {
      const r = await adapter.unpublishSession(ctx, link.externalOccurrenceId)
      if (r.ok) await prisma.aggregatorSessionLink.update({ where: { id: link.id }, data: { live: false, lastSyncedAt: now } })
      return r
    }
    return { skipped: `sin ocurrencia viva que tocar (${built.reason})` }
  }

  const pub = built.publication
  const isLive = Boolean(link?.live && link.externalOccurrenceId)
  if (!isLive) {
    // Una publicación anterior de esta clase quedó en el proveedor SIN vínculo (falló guardarlo, o no devolvió el id):
    // publicar otra vez dejaría dos clases allá. Hasta que una persona ligue a mano la que ya existe, no se publica.
    // ponytail: el reemplazo por cambio de hora (vínculo vivo) no pasa por aquí; si ahí falla guardar el vínculo, el
    // siguiente reemplazo puede crear otra ocurrencia (raro: falla de base justo tras el ok del proveedor).
    const dead = await prisma.aggregatorOutbox.findFirst({
      where: {
        coalesceKey: row.coalesceKey,
        status: 'DEAD_LETTER',
        OR: [{ lastError: { startsWith: 'LINK_SAVE_FAILED' } }, { lastError: { startsWith: 'NO_OCCURRENCE_ID' } }],
      },
      select: { id: true, lastError: true },
    })
    if (dead) {
      logger.warn(
        `[PASES] SYNC_SESSION ${row.id}: la clase ${classSessionId} tiene una publicación sin vincular (fila ${dead.id}); no se publica otra`,
      )
      return { skipped: `publicación en revisión manual (fila ${dead.id}): ${dead.lastError}` }
    }
  }
  // Una ocurrencia anterior que ya pasó no se le entrega al adaptador (la daría de baja): se publica una nueva y ya.
  const prevIsFuture = Boolean(link?.publishedStartsAt && link.publishedStartsAt.getTime() > now.getTime())
  if (!link || !isLive || link.publishedStartsAt?.getTime() !== pub.startsAt.getTime()) {
    // Primera vez, o volvió a publicarse, o cambió de hora: el adaptador recibe la ocurrencia anterior (si sigue viva)
    // y decide (TotalPass no reprograma: da de baja la vieja y crea otra).
    const prevOccurrenceId = isLive && prevIsFuture ? (link?.externalOccurrenceId ?? null) : null
    // Pausa suave (founder, 3-oct): sin el plan no se publica una clase NUEVA (nada vivo a futuro que reemplazar). Lo ya
    // publicado sigue: cupo, detalles, baja y el reemplazo por cambio de hora, para que ningún socio se quede plantado.
    if (!prevOccurrenceId && !(await venueHasFeatureAccess(row.venueId, 'AGGREGATOR_PASSES'))) {
      return { skipped: 'el plan del negocio ya no incluye pases: no se publican clases nuevas' }
    }
    // Corte del reemplazo, ANTES de llamar: lo aceptado hasta aquí es de la ocurrencia vieja; lo de después, de la nueva.
    const replacedAt = new Date()
    const r = await adapter.publishSession(ctx, pub, {
      externalOccurrenceId: prevOccurrenceId,
      publishedStartsAt: link?.publishedStartsAt ?? null,
    })
    if (!r.ok) return r
    // Sin id no se puede guardar el vínculo, y reintentar publicaría otra ocurrencia: que lo vea una persona.
    if (!r.externalOccurrenceId) {
      return { ok: false, retryable: false, code: 'NO_OCCURRENCE_ID', message: 'el proveedor publicó sin devolver la ocurrencia' }
    }
    const data = {
      externalOccurrenceId: r.externalOccurrenceId,
      publishedStartsAt: pub.startsAt,
      publishedSpots: built.spots,
      publishedHash: publicationHash(pub),
      live: true,
      lastSyncedAt: now,
    }
    try {
      await prisma.aggregatorSessionLink.upsert({
        where: linkKey,
        create: { connectionId: row.connectionId, venueId: row.venueId, classSessionId, ...data },
        update: data,
      })
    } catch (err: any) {
      // Ya está publicada en el proveedor: reintentar publicaría una SEGUNDA ocurrencia. Que lo vea una persona, con el
      // id para ligarla a mano.
      return {
        ok: false,
        retryable: false,
        code: 'LINK_SAVE_FAILED',
        message: `publicada como ocurrencia ${r.externalOccurrenceId} pero no se pudo guardar el vínculo: ${String(err?.message ?? err)}`,
      }
    }
    // El proveedor no movió la ocurrencia: la dio de baja (cancelando a sus socios) y creó otra. Esas reservas se
    // cancelan aquí también (decisión del founder, 3-oct). Un proveedor que sí mueve la clase devuelve el mismo id.
    if (prevOccurrenceId && r.externalOccurrenceId !== prevOccurrenceId) {
      try {
        await cancelPassBookingsOfReplacedOccurrence(
          { id: row.connectionId, venueId: row.venueId, provider: row.connection.provider },
          classSessionId,
          replacedAt,
          now,
        )
      } catch (err: any) {
        // La clase nueva ya está publicada: reintentar la fila publicaría otra. Que lo vea una persona.
        return {
          ok: false,
          retryable: false,
          code: 'REPLACED_BOOKINGS_NOT_CANCELLED',
          message: `la clase cambió de hora y no se pudieron cancelar aquí las reservas de la ocurrencia ${prevOccurrenceId}: ${String(err?.message ?? err)}`,
        }
      }
    }
    return r
  }
  // Misma hora: se editan en la ocurrencia viva el cupo y, si cambiaron, coach/título/duración (sin cancelar reservas).
  if (link.publishedSpots !== built.spots && link.externalOccurrenceId) {
    const r = await adapter.updateSpots(ctx, link.externalOccurrenceId, built.spots)
    if (!r.ok) return r
    await prisma.aggregatorSessionLink.update({ where: { id: link.id }, data: { publishedSpots: built.spots, lastSyncedAt: now } })
  }
  const hash = publicationHash(pub)
  if (link.publishedHash !== hash && link.externalOccurrenceId) {
    const r = await adapter.updateSessionDetails(ctx, link.externalOccurrenceId, pub)
    if (!r.ok) return r
    await prisma.aggregatorSessionLink.update({ where: { id: link.id }, data: { publishedHash: hash, lastSyncedAt: now } })
  }
  return { ok: true }
}
