import { Prisma, ReservationStatus } from '@prisma/client'
import { formatInTimeZone } from 'date-fns-tz'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { NotFoundError } from '@/errors/AppError'
import { withSerializableRetry } from '@/utils/serializableRetry'
import { logAction } from '@/services/dashboard/activity-log.service'
import { generateConfirmationCode } from '@/services/dashboard/reservation.dashboard.service'
import { LockedClassSession, lockClassSession, sumOccupiedSeats, sumPassSeats } from '@/services/reservation/classBooking.service'
import { resolvePassCap } from './capacityRules'
import { resolvePassCustomer } from './customerIdentity.service'
import { enqueuePassOutbox } from './outbox.service'
import { CanonicalEvent, DenyReason, Provider } from './types'

type BookingEv = Extract<CanonicalEvent, { kind: 'BOOKING_REQUESTED' }>
type Conn = { id: string; venueId: string; provider: Provider }
export type BookingIngestionResult = { decision: 'ACCEPTED' | 'DENIED' | 'DUPLICATE'; reservationId?: string; reason?: DenyReason }

/** Lo que sale de la transacción: el resultado más el id de la fila para el rastro (que se escribe ya fuera). */
type Outcome =
  | { decision: 'ACCEPTED'; reservationId: string }
  | { decision: 'DENIED'; reason: DenyReason; bookingId: string }
  | { decision: 'DUPLICATE'; reservationId?: string }

/** Tope de reglas de lugares que se leen por clase: son pocas por negocio (default + semanales + de sesión). */
const MAX_CAPACITY_RULES = 200

/**
 * Reserva nueva de un socio de pase (spec §6-§7): bajo el candado de la sesión decide si cabe y, si cabe, crea la
 * Reservation CONFIRMED de 1 lugar por el canal THIRD_PARTY (sin créditos ni orden). Si no cabe, deja el rechazo con su
 * motivo. En los dos casos encola la respuesta al proveedor; al aceptar, también la nueva cuenta de lugares.
 *
 * Nunca vende el último lugar dos veces: la suma de ocupados se hace bajo el FOR UPDATE de la sesión y en SERIALIZABLE,
 * igual que el widget. Un mismo `externalBookingId` sólo se decide una vez (se revisa otra vez bajo el candado, por si
 * otra copia del mismo evento ganó mientras ésta esperaba).
 *
 * Errores de base (incluido un P2002 que `resolvePassCustomer` deje escapar) se propagan: el procesador los reintenta.
 */
export async function ingestBookingRequested(conn: Conn, ev: BookingEv, now: Date): Promise<BookingIngestionResult> {
  const existing = await findExistingBooking(prisma, conn, ev)
  if (existing) return { decision: 'DUPLICATE', reservationId: existing.reservationId ?? undefined }

  const link = await prisma.aggregatorSessionLink.findFirst({
    where: { connectionId: conn.id, externalOccurrenceId: ev.externalOccurrenceId },
    select: { classSessionId: true },
  })

  let outcome: Outcome
  if (!link) {
    logger.warn(`[PASES] reserva ${ev.externalBookingId} para una ocurrencia desconocida ${ev.externalOccurrenceId}`)
    outcome = await withSerializableRetry(async tx => {
      const again = await findExistingBooking(tx, conn, ev)
      if (again) return { decision: 'DUPLICATE' as const, reservationId: again.reservationId ?? undefined }
      return denyTx(tx, conn, ev, null, 'OTHER')
    })
  } else {
    outcome = await withSerializableRetry(tx => decideTx(tx, conn, ev, link.classSessionId, now))
  }

  return finish(conn, ev, outcome)
}

async function decideTx(tx: Prisma.TransactionClient, conn: Conn, ev: BookingEv, classSessionId: string, now: Date): Promise<Outcome> {
  let session: LockedClassSession
  try {
    session = await lockClassSession(tx, conn.venueId, classSessionId)
  } catch (e) {
    // La sesión se borró entre leer la liga y tomar el candado: no hay clase a la cual meterlo.
    if (e instanceof NotFoundError) return denyTx(tx, conn, ev, null, 'OTHER')
    throw e
  }

  const again = await findExistingBooking(tx, conn, ev)
  if (again) return { decision: 'DUPLICATE', reservationId: again.reservationId ?? undefined }

  if (session.status !== 'SCHEDULED') return denyTx(tx, conn, ev, session.id, 'CLASS_CANCELLED')
  // El estudio desligó la clase (o se está desligando): no se aceptan socios nuevos aunque la ocurrencia siga viva unos
  // segundos en el proveedor. Corre dentro de la misma transacción SERIALIZABLE que la aceptación (y que el desligue).
  const linked = await tx.aggregatorProductLink.findFirst({
    where: { connectionId: conn.id, productId: session.productId, active: true },
    select: { id: true },
  })
  if (!linked) return denyTx(tx, conn, ev, session.id, 'CLASS_CANCELLED')

  const occupied = await sumOccupiedSeats(tx, session.id)
  const passOccupied = await sumPassSeats(tx, session.id)
  const rules = await tx.aggregatorCapacityRule.findMany({
    where: { venueId: conn.venueId, OR: [{ scope: { in: ['DEFAULT', 'WEEKLY'] } }, { classSessionId: session.id }] },
    select: { scope: true, weekday: true, startMinute: true, classSessionId: true, maxSpots: true },
    // R6: entre reglas del mismo nivel gana la editada más reciente (resolvePassCap conserva la primera).
    orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
    take: MAX_CAPACITY_RULES,
  })
  const venue = await tx.venue.findUniqueOrThrow({ where: { id: conn.venueId }, select: { timezone: true } })
  const tz = venue.timezone || 'America/Mexico_City'
  const [hh, mm] = formatInTimeZone(session.startsAt, tz, 'HH:mm').split(':').map(Number)
  const cap = resolvePassCap(rules, {
    id: session.id,
    capacity: session.capacity,
    localWeekday: Number(formatInTimeZone(session.startsAt, tz, 'i')) % 7, // ISO 1=lunes … 7=domingo ⇒ 0=domingo
    localStartMinute: hh * 60 + mm,
  })
  if (occupied + 1 > session.capacity || passOccupied + 1 > cap) return denyTx(tx, conn, ev, session.id, 'CLASS_FULL')

  const { customerId } = await resolvePassCustomer(tx, {
    venueId: conn.venueId,
    provider: conn.provider,
    externalUserId: ev.externalUserId,
    user: ev.user,
  })

  // Mismo reintento de código que la reserva de clase del widget: un choque es improbable, pero se evita el P2002.
  const firstCode = generateConfirmationCode()
  const codeTaken = await tx.reservation.findUnique({
    where: { venueId_confirmationCode: { venueId: conn.venueId, confirmationCode: firstCode } },
    select: { id: true },
  })
  const reservation = await tx.reservation.create({
    data: {
      venueId: conn.venueId,
      confirmationCode: codeTaken ? generateConfirmationCode() : firstCode,
      classSessionId: session.id,
      productId: session.productId,
      startsAt: session.startsAt,
      endsAt: session.endsAt,
      // Una clase no lleva buffer post-servicio: el bloque de agenda coincide con la sesión.
      blockedEndsAt: session.endsAt,
      duration: session.duration,
      status: 'CONFIRMED',
      channel: 'THIRD_PARTY',
      customerId,
      guestName: ev.user.name,
      guestPhone: ev.user.phone,
      guestEmail: ev.user.email,
      partySize: 1,
      spotIds: [],
      confirmedAt: now,
      statusLog: [{ status: 'CONFIRMED', at: now.toISOString(), by: null, source: `PASS:${conn.provider}` }],
    },
    select: { id: true },
  })
  const booking = await tx.aggregatorBooking.create({
    data: {
      connectionId: conn.id,
      venueId: conn.venueId,
      provider: conn.provider,
      reservationId: reservation.id,
      classSessionId: session.id,
      externalBookingId: ev.externalBookingId,
      externalUserId: ev.externalUserId,
      externalPlanCode: ev.externalPlanCode,
      decision: 'ACCEPTED',
    },
    select: { id: true },
  })
  await enqueuePassOutbox(tx, {
    venueId: conn.venueId,
    connectionId: conn.id,
    operation: 'RESPOND_BOOKING',
    aggregatorBookingId: booking.id,
  })
  await enqueuePassOutbox(tx, { venueId: conn.venueId, connectionId: conn.id, operation: 'SYNC_SESSION', classSessionId: session.id })
  return { decision: 'ACCEPTED', reservationId: reservation.id }
}

async function denyTx(
  tx: Prisma.TransactionClient,
  conn: Conn,
  ev: BookingEv,
  classSessionId: string | null,
  reason: DenyReason,
): Promise<Outcome> {
  const booking = await tx.aggregatorBooking.create({
    data: {
      connectionId: conn.id,
      venueId: conn.venueId,
      provider: conn.provider,
      reservationId: null,
      classSessionId,
      externalBookingId: ev.externalBookingId,
      externalUserId: ev.externalUserId,
      externalPlanCode: ev.externalPlanCode,
      decision: 'DENIED',
      denyReason: reason,
    },
    select: { id: true },
  })
  await enqueuePassOutbox(tx, {
    venueId: conn.venueId,
    connectionId: conn.id,
    operation: 'RESPOND_BOOKING',
    aggregatorBookingId: booking.id,
  })
  return { decision: 'DENIED', reason, bookingId: booking.id }
}

function findExistingBooking(db: Prisma.TransactionClient, conn: Conn, ev: BookingEv) {
  return db.aggregatorBooking.findUnique({
    where: { provider_externalBookingId: { provider: conn.provider, externalBookingId: ev.externalBookingId } },
    select: { id: true, decision: true, reservationId: true },
  })
}

/** Rastro y log ya con la transacción resuelta (nunca dentro). Sin datos personales del socio: sólo ids. */
function finish(conn: Conn, ev: BookingEv, outcome: Outcome): BookingIngestionResult {
  if (outcome.decision === 'DUPLICATE') {
    logger.info(`[PASES] reserva ${ev.externalBookingId} ya decidida; se ignora la copia`)
    return outcome
  }
  if (outcome.decision === 'ACCEPTED') {
    logger.info(`[PASES] reserva aceptada ${ev.externalBookingId} → ${outcome.reservationId}`)
    passTrail(conn, 'PASS_BOOKING_ACCEPTED', 'Reservation', outcome.reservationId, { externalBookingId: ev.externalBookingId })
    return { decision: 'ACCEPTED', reservationId: outcome.reservationId }
  }
  logger.info(`[PASES] reserva rechazada ${ev.externalBookingId}: ${outcome.reason}`)
  passTrail(conn, 'PASS_BOOKING_DENIED', 'AggregatorBooking', outcome.bookingId, {
    externalBookingId: ev.externalBookingId,
    reason: outcome.reason,
  })
  return { decision: 'DENIED', reason: outcome.reason }
}

/**
 * Rastro de un evento de pase en ActivityLog: sin actor humano (`staffId: null`) y sin datos personales del socio, sólo
 * el proveedor y los ids externos. Se llama ya fuera de la transacción; `logAction` nunca lanza.
 */
function passTrail(
  conn: Conn,
  action: 'PASS_BOOKING_ACCEPTED' | 'PASS_BOOKING_DENIED' | 'PASS_BOOKING_CANCELLED',
  entity: 'Reservation' | 'AggregatorBooking',
  entityId: string,
  data: Record<string, string | boolean>,
): void {
  void logAction({ staffId: null, venueId: conn.venueId, action, entity, entityId, data: { provider: conn.provider, ...data } })
}

type CancelEv = Extract<CanonicalEvent, { kind: 'BOOKING_CANCELLED' }>
type CancelResult = 'CANCELLED' | 'NOT_FOUND' | 'ALREADY'

/** Sólo una reserva que todavía no empieza a usarse se cancela: quien ya llegó, terminó o faltó se queda como está. */
const CANCELLABLE_STATUSES: ReservationStatus[] = ['PENDING', 'CONFIRMED']

/**
 * La cancelación de una reserva de pase: CAS de la Reservation desde PENDING/CONFIRMED, la fila del proveedor queda
 * CANCELLED y se encola la nueva cuenta de lugares de la clase. La usan el socio que cancela en el proveedor y el
 * reemplazo de una ocurrencia (la clase cambió de hora).
 */
async function cancelPassReservationTx(
  tx: Prisma.TransactionClient,
  conn: Conn,
  booking: { id: string; reservationId: string; classSessionId: string | null },
  now: Date,
  why: { cancelledBy: 'CUSTOMER' | 'SYSTEM'; reason: string; note: string },
): Promise<'CANCELLED' | 'ALREADY'> {
  const r = await tx.reservation.findFirst({
    where: { id: booking.reservationId, venueId: conn.venueId },
    select: { id: true, status: true, statusLog: true },
  })
  if (!r || !CANCELLABLE_STATUSES.includes(r.status)) return 'ALREADY'

  const log = Array.isArray(r.statusLog) ? (r.statusLog as Prisma.JsonArray) : []
  const cas = await tx.reservation.updateMany({
    where: { id: r.id, status: { in: CANCELLABLE_STATUSES } },
    data: {
      status: 'CANCELLED',
      cancelledAt: now,
      cancelledBy: why.cancelledBy,
      cancellationReason: why.reason,
      statusLog: [...log, { status: 'CANCELLED', at: now.toISOString(), by: null, source: `PASS:${conn.provider}`, note: why.note }],
    },
  })
  if (cas.count === 0) return 'ALREADY'

  await tx.aggregatorBooking.update({ where: { id: booking.id }, data: { decision: 'CANCELLED' } })
  if (booking.classSessionId) {
    await enqueuePassOutbox(tx, {
      venueId: conn.venueId,
      connectionId: conn.id,
      operation: 'SYNC_SESSION',
      classSessionId: booking.classSessionId,
    })
  }
  return 'CANCELLED'
}

/** Tope por reemplazo: una clase no tiene más socios de pase que esto. */
const REPLACED_BOOKINGS_TAKE = 500

/**
 * El proveedor no deja mover una clase de hora (TotalPass): la ocurrencia vieja se borró — el proveedor ya canceló a sus
 * socios y les avisó — y se publicó otra. Aquí esas reservas quedaban vivas como fantasmas, ocupando lugares. Se cancelan
 * con el mismo CAS que la cancelación del socio (decisión del founder del 3-oct, opción A: es lo que TotalPass permite y lo
 * que hace buq; con Wellhub, como Mindbody, el adaptador mueve la ocurrencia y esto no se llama).
 *
 * Sólo las aceptadas ANTES del reemplazo (`createdAt < replacedAt`): las de la ocurrencia nueva no se tocan. Quien ya hizo
 * check-in o faltó se queda como está. Devuelve cuántas canceló; cada una deja rastro con `cause: CLASS_RESCHEDULED`, que
 * es lo que el estudio ve para saber a quién avisar.
 */
export async function cancelPassBookingsOfReplacedOccurrence(
  conn: Conn,
  classSessionId: string,
  replacedAt: Date,
  now: Date,
): Promise<number> {
  const bookings = await prisma.aggregatorBooking.findMany({
    where: { connectionId: conn.id, classSessionId, decision: 'ACCEPTED', reservationId: { not: null }, createdAt: { lt: replacedAt } },
    select: { id: true, reservationId: true, classSessionId: true, externalBookingId: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: REPLACED_BOOKINGS_TAKE,
  })
  let cancelled = 0
  for (const b of bookings) {
    const reservationId = b.reservationId as string
    const result = await withSerializableRetry(tx =>
      cancelPassReservationTx(tx, conn, { id: b.id, reservationId, classSessionId: b.classSessionId }, now, {
        cancelledBy: 'SYSTEM',
        reason: `La clase cambió de hora: ${conn.provider} no deja moverla y canceló la reserva del socio`,
        note: 'class-rescheduled',
      }),
    )
    if (result !== 'CANCELLED') continue
    cancelled++
    passTrail(conn, 'PASS_BOOKING_CANCELLED', 'Reservation', reservationId, {
      externalBookingId: b.externalBookingId,
      cause: 'CLASS_RESCHEDULED',
    })
  }
  if (cancelled > 0) {
    logger.warn(
      `[PASES] la clase ${classSessionId} cambió de hora: ${conn.provider} canceló a ${cancelled} socio(s); se cancelaron aquí también`,
    )
  }
  return cancelled
}

/**
 * El socio canceló su reserva en el proveedor (spec §6): la Reservation pasa a CANCELLED con un CAS desde
 * PENDING/CONFIRMED, la fila del proveedor queda CANCELLED y se encola la nueva cuenta de lugares de la clase.
 *
 * - `NOT_FOUND`: todavía no conocemos esa reserva (puede venir en camino: el procesador reintenta). No se toca nada.
 * - `ALREADY`: la rechazamos (nunca tendrá Reservation), o la Reservation ya no está en un estado cancelable (check-in,
 *   completada, no-show, ya cancelada), es de otro negocio, u otro proceso la cambió entre leer y escribir. Nunca se le
 *   cancela a quien ya llegó.
 *
 * Una cancelación tardía (`ev.late`) se cancela igual; sólo cambia la nota del renglón de `statusLog`.
 */
export async function ingestBookingCancelled(conn: Conn, ev: CancelEv, now: Date): Promise<CancelResult> {
  const booking = await prisma.aggregatorBooking.findUnique({
    where: { provider_externalBookingId: { provider: conn.provider, externalBookingId: ev.externalBookingId } },
    select: { id: true, reservationId: true, classSessionId: true, decision: true },
  })
  if (!booking) {
    logger.info(`[PASES] cancelación de una reserva que aún no tenemos (${ev.externalBookingId}); se reintentará`)
    return 'NOT_FOUND'
  }
  if (!booking.reservationId) {
    logger.info(`[PASES] cancelación de una reserva que rechazamos (${ev.externalBookingId}); nada que cancelar`)
    return 'ALREADY'
  }
  const reservationId = booking.reservationId

  const result = await withSerializableRetry(tx =>
    cancelPassReservationTx(tx, conn, { id: booking.id, reservationId, classSessionId: booking.classSessionId }, now, {
      cancelledBy: 'CUSTOMER', // mismo centinela que la cancelación del cliente en el widget: quien canceló es el socio
      reason: `Cancelada por el socio en ${conn.provider}`,
      note: ev.late ? 'late-cancel' : 'cancel',
    }),
  )

  if (result === 'ALREADY') {
    logger.info(`[PASES] cancelación de ${ev.externalBookingId} ignorada: la reserva ya no es cancelable`)
    return result
  }
  logger.info(`[PASES] reserva ${ev.externalBookingId} cancelada por el socio${ev.late ? ' (tarde)' : ''}`)
  passTrail(conn, 'PASS_BOOKING_CANCELLED', 'Reservation', reservationId, { externalBookingId: ev.externalBookingId, late: ev.late })
  return result
}
