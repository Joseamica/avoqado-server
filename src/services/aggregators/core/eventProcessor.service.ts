import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { adapterFor } from './adapterRegistry'
import { ingestBookingCancelled, ingestBookingRequested } from './bookingIngestion.service'
import { ingestCheckin } from './visit.service'

/** La espera entre intentos crece 2^n minutos y se topa aquí. */
const BACKOFF_CAP_MIN = 60
/** Al llegar a este número de intentos el evento se queda FAILED y nadie lo vuelve a tomar (lo usa el job de reintentos). */
export const MAX_EVENT_ATTEMPTS = 10
const MAX_ERROR_CHARS = 2000
/** Una conexión aún PENDING (webhooks suscritos, falta activarla) se reintenta pronto y a ritmo fijo: no se pierde la reserva. */
const PENDING_RETRY_MS = 60e3

/**
 * Procesa un evento entrante ya guardado (spec §6): el adaptador del proveedor lo traduce a un evento canónico y aquí se
 * enruta a la ingesta que toca. Deja el evento en:
 *
 * - `PROCESSED`: se ingirió (o la ingesta lo vio como duplicado).
 * - `IGNORED`: el adaptador no lo entiende (con su motivo) o la conexión está `PAUSED`/`REVOKED` (un estudio en pausa
 *   no recibe reservas).
 * - `FAILED`: la ingesta (o el propio adaptador) truena ⇒ `attemptCount + 1` y otro intento en 2^n minutos (tope 60),
 *   hasta `MAX_EVENT_ATTEMPTS`. Igual una cancelación de una reserva que aún no tenemos (`NOT_FOUND`): la reserva puede
 *   estar esperando su reintento, y si la cancelación se diera por procesada, la reserva entraría después y dejaría un
 *   lugar fantasma. Con la conexión todavía `PENDING` (llegó una reserva entre suscribir los webhooks y
 *   activar) también FAILED, sin ingerir, con otro intento fijo en 1 minuto (cuenta para el tope). Si el payload trae
 *   otra sucursal que la de la conexión, FAILED sin reintento (`nextAttemptAt: null`): repetirlo no lo va a arreglar.
 *
 * Un FAILED sin `nextAttemptAt` (sucursal ajena o intentos agotados) es terminal: no se vuelve a tocar.
 *
 * Nunca rechaza la promesa: el webhook lo llama sin esperar y el job de reintentos lo llama en lote.
 */
export async function processInboundEvent(eventId: string, now: Date = new Date()): Promise<void> {
  let ev
  try {
    ev = await prisma.aggregatorInboundEvent.findUnique({
      where: { id: eventId },
      select: {
        id: true,
        kind: true,
        payload: true,
        status: true,
        attemptCount: true,
        nextAttemptAt: true,
        connection: { select: { id: true, venueId: true, provider: true, externalPlaceId: true, confirmMode: true, status: true } },
      },
    })
  } catch (err) {
    logger.error(`[PASES] evento ${eventId}: no se pudo leer (${safeError(err)})`)
    return
  }
  if (!ev || ev.status === 'PROCESSED' || ev.status === 'IGNORED') return
  if (ev.status === 'FAILED' && (ev.nextAttemptAt === null || ev.attemptCount >= MAX_EVENT_ATTEMPTS)) return
  const conn = ev.connection

  try {
    if (conn.status === 'PENDING') {
      await markFailed(ev, 'conexión PENDING: se reintenta', PENDING_RETRY_MS, now)
      return
    }
    if (conn.status !== 'ACTIVE') {
      await markEvent(ev.id, { status: 'IGNORED', error: `conexión ${conn.status}`, processedAt: now, nextAttemptAt: null })
      logger.info(`[PASES] evento ${ev.id} ignorado: conexión ${conn.status}`)
      return
    }

    const parsed = adapterFor(conn.provider).parseWebhook(ev.kind, ev.payload)
    if (parsed.kind === 'IGNORED') {
      await markEvent(ev.id, { status: 'IGNORED', error: parsed.reason.slice(0, MAX_ERROR_CHARS), processedAt: now, nextAttemptAt: null })
      logger.info(`[PASES] evento ${ev.id} ignorado: ${parsed.reason}`)
      return
    }

    // Seguridad: la URL con secreto ya identificó la conexión; un payload de otra sucursal no se ingiere.
    if (conn.externalPlaceId && parsed.placeId && parsed.placeId !== conn.externalPlaceId) {
      await markEvent(ev.id, {
        status: 'FAILED',
        error: `sucursal ${parsed.placeId} ≠ ${conn.externalPlaceId}`.slice(0, MAX_ERROR_CHARS),
        processedAt: now,
        nextAttemptAt: null,
      })
      logger.error(`[PASES] evento ${ev.id}: la sucursal del payload no es la de la conexión ${conn.id}`)
      return
    }

    if (parsed.kind === 'BOOKING_REQUESTED') await ingestBookingRequested(conn, parsed, now)
    else if (parsed.kind === 'BOOKING_CANCELLED') {
      if ((await ingestBookingCancelled(conn, parsed, now)) === 'NOT_FOUND') {
        await markFailed(ev, 'cancelación de una reserva que aún no tenemos: se reintenta', backoffMs(ev.attemptCount), now)
        return
      }
    } else if (parsed.kind === 'CHECKIN_CREATED') await ingestCheckin(conn, parsed, now)
    await markEvent(ev.id, { status: 'PROCESSED', processedAt: now, error: null, nextAttemptAt: null })
  } catch (err) {
    await markFailed(ev, safeError(err), backoffMs(ev.attemptCount), now)
  }
}

/** Espera antes del siguiente intento: 2^n minutos (n = intentos tras éste), tope `BACKOFF_CAP_MIN`. */
const backoffMs = (attemptCount: number): number => Math.min(2 ** (attemptCount + 1), BACKOFF_CAP_MIN) * 60e3

/**
 * Deja el evento FAILED con un intento más y su próxima vuelta en `delayMs`; al agotar `MAX_EVENT_ATTEMPTS` queda sin
 * próxima vuelta y se avisa una sola vez como error. Nunca lanza: un fallo al escribir sólo se loguea.
 */
async function markFailed(ev: { id: string; attemptCount: number }, error: string, delayMs: number, now: Date): Promise<void> {
  const attempts = ev.attemptCount + 1
  const exhausted = attempts >= MAX_EVENT_ATTEMPTS
  try {
    await markEvent(ev.id, {
      status: 'FAILED',
      attemptCount: attempts,
      error,
      nextAttemptAt: exhausted ? null : new Date(now.getTime() + delayMs),
    })
  } catch (markErr) {
    logger.error(`[PASES] evento ${ev.id}: no se pudo marcar el fallo (${safeError(markErr)})`)
    return
  }
  if (exhausted) logger.error(`[PASES] evento ${ev.id} agotó sus ${MAX_EVENT_ATTEMPTS} intentos: ${error}`)
  else logger.warn(`[PASES] evento ${ev.id} falló (intento ${attempts}, siguiente en ${Math.round(delayMs / 60e3)} min): ${error}`)
}

function markEvent(id: string, data: Prisma.AggregatorInboundEventUpdateInput) {
  return prisma.aggregatorInboundEvent.update({ where: { id }, data })
}

/**
 * Texto del error para guardar y loguear, sin datos personales: los errores de Prisma pueden traer valores o los
 * argumentos completos de la consulta (correo, teléfono del socio), así que de ellos sólo se guarda el código y el campo.
 */
function safeError(err: unknown): string {
  let text: string
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    const target = (err.meta as { target?: unknown } | undefined)?.target
    text = `Prisma ${err.code}${target ? ` (${String(target)})` : ''}`
  } else if (
    err instanceof Prisma.PrismaClientValidationError ||
    err instanceof Prisma.PrismaClientUnknownRequestError ||
    err instanceof Prisma.PrismaClientRustPanicError ||
    err instanceof Prisma.PrismaClientInitializationError
  ) {
    text = `Prisma ${err.name}`
  } else {
    text = String((err as Error)?.message ?? err)
  }
  return text.slice(0, MAX_ERROR_CHARS)
}
