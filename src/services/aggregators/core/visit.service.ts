import { Prisma, ReservationStatus } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { utcTs } from '@/utils/sqlDates'
import logger from '@/config/logger'
import { ConflictError } from '@/errors/AppError'
import { withSerializableRetry } from '@/utils/serializableRetry'
import { checkInReservation, RESERVATION_NOT_CHECKINABLE } from '@/services/reservation/checkIn.service'
import { resolvePassCustomer } from './customerIdentity.service'
import { enqueuePassOutbox } from './outbox.service'
import { CanonicalEvent, Provider } from './types'

type CheckinEv = Extract<CanonicalEvent, { kind: 'CHECKIN_CREATED' }>
type Conn = { id: string; venueId: string; provider: Provider; confirmMode: 'AUTO' | 'ON_VENUE_CHECKIN' }
export type CheckinIngestionResult = { visitId: string; duplicate: boolean; queuedValidation: boolean }

/** El check-in del socio cae hasta 60 min antes del inicio de su clase… */
const BEFORE_MS = 60 * 60e3
/** …o hasta 30 min después de que empezó. */
const AFTER_MS = 30 * 60e3
/** Estados de reserva a los que se puede ligar un check-in (los demás ya nunca pasarán a CHECKED_IN). */
const LINKABLE_STATUSES: ReservationStatus[] = ['PENDING', 'CONFIRMED', 'CHECKED_IN']

/**
 * Llegada de un socio de pase (spec D2): crea el `AggregatorVisit` con su plazo y lo liga a la reserva de ese mismo
 * socio en una clase del venue que empiece entre 30 min antes y 60 min después del check-in.
 *
 * - `AUTO`: se encola la validación y la reserva ligada pasa a `CHECKED_IN` (actor SERVICE, `source: 'PASS'`), para
 *   que el pago a coaches por asistencia vea al socio. Sin reserva (gimnasio libre) se valida igual.
 * - `ON_VENUE_CHECKIN`: se encola sólo si la reserva YA está `CHECKED_IN` (el kiosco llegó antes que el webhook); si no,
 *   espera al gancho `onVenueCheckIn`. Sin reserva, la visita queda `PENDING` para que la recepción la confirme.
 *
 * Un mismo check-in sólo se registra una vez (`provider + externalCheckinId`). Errores de base se propagan: el
 * procesador reintenta el evento y el reintento ya lo ve como duplicado o lo crea.
 */
export async function ingestCheckin(conn: Conn, ev: CheckinEv, now: Date): Promise<CheckinIngestionResult> {
  const dup = await prisma.aggregatorVisit.findUnique({
    where: { provider_externalCheckinId: { provider: conn.provider, externalCheckinId: ev.externalCheckinId } },
    select: { id: true },
  })
  if (dup) return { visitId: dup.id, duplicate: true, queuedValidation: false }

  const result = await withSerializableRetry(async tx => {
    const booking = await tx.aggregatorBooking.findFirst({
      where: {
        connectionId: conn.id,
        externalUserId: ev.externalUserId,
        decision: 'ACCEPTED',
        reservation: {
          venueId: conn.venueId,
          status: { in: LINKABLE_STATUSES },
          startsAt: { gte: new Date(ev.startedAt.getTime() - AFTER_MS), lte: new Date(ev.startedAt.getTime() + BEFORE_MS) },
        },
      },
      orderBy: { createdAt: 'desc' },
      select: { reservationId: true },
    })

    // Candado de la reserva ANTES de crear la visita y decidir: el kiosco hace su check-in en una tx READ COMMITTED que
    // no ve esta visita aún sin confirmar. Sin candado, «leí CONFIRMED → el kiosco confirma y su gancho no encuentra
    // visita → creo la visita sin encolar» dejaba la visita PENDING hasta vencer (cobro perdido). Con el FOR UPDATE: si
    // el kiosco confirmó antes, aquí se ve CHECKED_IN (o un 40001 que se reintenta y lo ve); si este candado va
    // primero, el CAS del kiosco espera y su gancho, ya con esta visita confirmada, la encola.
    let reservationId: string | null = null
    let reservationStatus: string | null = null
    if (booking?.reservationId) {
      const locked = await tx.$queryRaw<{ id: string; status: string }[]>`
        SELECT id, status::text AS status FROM "Reservation" WHERE id = ${booking.reservationId} FOR UPDATE
      `
      // Una reserva cancelada, no-show o completada no se liga: el socio queda como visita sin reserva (en `AUTO` se
      // valida igual; en `ON_VENUE_CHECKIN` la confirma la recepción) en vez de amarrarse a algo que nunca será CHECKED_IN.
      if (locked[0] && LINKABLE_STATUSES.includes(locked[0].status as ReservationStatus)) {
        reservationId = locked[0].id
        reservationStatus = locked[0].status
      }
    }

    // El socio queda identificado con el usuario que trae su check-in (mismo helper que la reserva): uno que llega sin
    // reservar, ni identidad previa, aparece en la lista con su nombre y no como un «sin nombre» indistinguible.
    await resolvePassCustomer(tx, {
      venueId: conn.venueId,
      provider: conn.provider,
      externalUserId: ev.externalUserId,
      user: ev.user,
    })

    const visit = await tx.aggregatorVisit.create({
      data: {
        connectionId: conn.id,
        venueId: conn.venueId,
        provider: conn.provider,
        externalUserId: ev.externalUserId,
        externalCheckinId: ev.externalCheckinId,
        validationRef: ev.validationRef,
        reservationId,
        startedAt: ev.startedAt,
        deadlineAt: ev.deadlineAt,
        status: 'PENDING',
      },
      select: { id: true },
    })

    let queue: boolean
    if (conn.confirmMode === 'AUTO') {
      queue = true
      // La reserva ya está bajo el candado de arriba: se usa su estado sin volver a bloquearla.
      if (reservationId)
        await checkInIfAdmits(tx, { id: visit.id, venueId: conn.venueId, provider: conn.provider, reservationId }, reservationStatus, now)
    } else {
      // Kiosco antes que webhook: si el estudio ya registró la asistencia, se valida ya.
      queue = reservationStatus === 'CHECKED_IN'
    }
    if (queue) {
      await enqueuePassOutbox(tx, {
        venueId: conn.venueId,
        connectionId: conn.id,
        operation: 'VALIDATE_VISIT',
        aggregatorVisitId: visit.id,
      })
    }
    return { visitId: visit.id, reservationId, queue }
  })

  logger.info(
    `[PASES] check-in ${ev.externalCheckinId} visita=${result.visitId} reserva=${result.reservationId ?? '—'} modo=${conn.confirmMode} encolada=${result.queue}`,
  )
  return { visitId: result.visitId, duplicate: false, queuedValidation: result.queue }
}

type AutoVisit = { id: string; venueId: string; connectionId: string; provider: string; reservationId: string | null }

/**
 * Lo que el modo AUTO hace con una visita: registra la asistencia de su reserva (si todavía admite check-in, actor SERVICE,
 * fuente PASS — el pago a coaches la ve) y encola la validación al proveedor. La usa el cambio de modo a AUTO (las visitas
 * que esperaban a la recepción pasan a confirmarse solas); la ingesta del check-in hace lo mismo con la reserva que ya
 * tiene bloqueada.
 *
 * Primero RECLAMA la visita (sigue PENDING y en plazo) con un update condicionado: eso toma su candado ANTES que el de la
 * reserva, el mismo orden que el rechazo. Si la recepción la rechazó (o venció) desde que se leyó la lista, no se toca la
 * reserva ni se encola nada. Devuelve si la reclamó.
 */
export async function autoConfirmVisit(tx: Prisma.TransactionClient, v: AutoVisit, now: Date): Promise<boolean> {
  const claimed = await tx.aggregatorVisit.updateMany({
    where: { id: v.id, status: 'PENDING', deadlineAt: { gt: now } },
    data: { updatedAt: now },
  })
  if (claimed.count === 0) {
    logger.info(`[PASES] visita ${v.id}: ya no estaba pendiente al pasar a AUTO; no se toca su reserva`)
    return false
  }
  if (v.reservationId) {
    const locked = await tx.$queryRaw<{ status: string }[]>`
      SELECT status::text AS status FROM "Reservation" WHERE id = ${v.reservationId} FOR UPDATE
    `
    await checkInIfAdmits(tx, { ...v, reservationId: v.reservationId }, locked[0]?.status ?? null, now)
  }
  await enqueuePassOutbox(tx, { venueId: v.venueId, connectionId: v.connectionId, operation: 'VALIDATE_VISIT', aggregatorVisitId: v.id })
  return true
}

/** Check-in de la reserva de una visita AUTO si su estado (leído bajo candado) todavía lo admite. */
async function checkInIfAdmits(
  tx: Prisma.TransactionClient,
  v: { id: string; venueId: string; provider: string; reservationId: string },
  status: string | null,
  now: Date,
): Promise<void> {
  if (status !== 'PENDING' && status !== 'CONFIRMED') return
  try {
    await checkInReservation(tx, {
      reservationId: v.reservationId,
      venueId: v.venueId,
      actor: { type: 'SERVICE', servicePrincipalId: `aggregator:${v.provider}` },
      source: 'PASS',
      now,
    })
  } catch (e) {
    // La reserva cambió entre la lectura y el check-in (no-show, cancelada): el CAS no escribió nada, así que la
    // transacción sigue sana. El socio sí llegó: la visita se guarda y se valida igual, como cuando ya no admitía.
    if (!(e instanceof ConflictError && e.code === RESERVATION_NOT_CHECKINABLE)) throw e
    logger.warn(`[PASES] visita ${v.id}: la reserva ${v.reservationId} ya no admite check-in; se valida la visita`)
  }
}

/** Tope por corrida del barrido; lo que quede se toma en la siguiente. */
const REQUEUE_BATCH = 200

/**
 * Trabajo de validación «vivo»: esperando, en curso, fallido (con su espera) o muerto (lo decide una persona). Uno
 * `DONE` no puede dejar una visita PENDING varada, y uno `SKIPPED` (la conexión no estaba activa) hay que repetirlo.
 */
const LIVE_OUTBOX_STATUSES = ['PENDING', 'IN_PROGRESS', 'FAILED', 'DEAD_LETTER'] as const

/**
 * Red de seguridad: visitas todavía en plazo, de una conexión activa, que ya debían validarse y no tienen trabajo de
 * validación vivo. En `AUTO` les aplica `autoConfirmVisit` (asistencia + validación); en `ON_VENUE_CHECKIN`, encola su
 * validación. Debían validarse:
 * - en `AUTO`, todas (con o sin reserva): se encolaron al llegar el webhook, pero el worker pudo saltarlas (`SKIPPED`)
 *   mientras la conexión estaba pausada o reconectando (`PENDING`), y nada más las vuelve a encolar;
 * - en `ON_VENUE_CHECKIN`, las de una reserva ya `CHECKED_IN` (un check-in del kiosco sin red que sincronizó tarde,
 *   una carrera que el candado no cubra, o una validación saltada igual que arriba).
 *
 * Las que ya tienen trabajo vivo se excluyen EN la consulta (no después del tope): así un atasco de visitas ya
 * encoladas no llena la ventana y deja sin sanar a las demás, y no se re-encola uno `FAILED` (eso le pondría
 * `scheduledAt = ahora` y se saltaría su espera). La llave repite el formato de `enqueuePassOutbox`.
 */
export async function requeueCheckedInVisits(now: Date): Promise<number> {
  const liveStatuses = Prisma.join(LIVE_OUTBOX_STATUSES.map(st => Prisma.sql`${st}::"AggregatorOutboxStatus"`))
  const visits = await prisma.$queryRaw<
    { id: string; venueId: string; connectionId: string; provider: string; reservationId: string | null; confirmMode: string }[]
  >`
    SELECT v.id, v."venueId", v."connectionId", v.provider::text AS provider, v."reservationId", c."confirmMode"::text AS "confirmMode"
    FROM "AggregatorVisit" v
    JOIN "AggregatorConnection" c ON c.id = v."connectionId"
    LEFT JOIN "Reservation" r ON r.id = v."reservationId"
    WHERE v.status = 'PENDING'
      AND v."deadlineAt" > ${utcTs(now)}
      AND c.status = 'ACTIVE'
      AND (c."confirmMode" = 'AUTO' OR (c."confirmMode" = 'ON_VENUE_CHECKIN' AND r.status = 'CHECKED_IN'))
      AND NOT EXISTS (
        SELECT 1 FROM "AggregatorOutbox" o
        WHERE o."coalesceKey" = 'VALIDATE_VISIT:' || v."connectionId" || ':' || v.id
          AND o.status IN (${liveStatuses})
      )
    ORDER BY v."deadlineAt" ASC, v.id ASC
    LIMIT ${REQUEUE_BATCH}
  `
  for (const v of visits) {
    // En AUTO, lo MISMO que el cambio de modo (reclamo + asistencia + validación): una visita que se ingirió con el modo
    // viejo mientras la conexión pasaba a AUTO no estuvo en sus tandas, y sólo encolarla la validaría sin asistencia.
    await prisma.$transaction(async tx => {
      if (v.confirmMode === 'AUTO') await autoConfirmVisit(tx, v, now)
      else
        await enqueuePassOutbox(tx, {
          venueId: v.venueId,
          connectionId: v.connectionId,
          operation: 'VALIDATE_VISIT',
          aggregatorVisitId: v.id,
        })
    })
  }
  if (visits.length > 0) logger.warn(`[PASES] ${visits.length} visitas por validar no estaban encoladas; se encolaron`)
  return visits.length
}

/**
 * Mensaje de una visita vencida: reemplaza el texto operativo de la bandeja («Reintentando…»), que ya no es cierto. No culpa
 * a nadie: en ON_VENUE_CHECKIN suele vencer porque el estudio nunca la confirmó.
 */
const EXPIRED_NOTE = 'Venció sin confirmarse a tiempo.'

/** Visitas que vencieron sin validar: ese cobro del proveedor se pierde (se cuenta en el reporte). */
export async function expireVisits(now: Date): Promise<number> {
  const r = await prisma.aggregatorVisit.updateMany({
    where: { status: 'PENDING', deadlineAt: { lt: now } },
    data: { status: 'EXPIRED', lastError: EXPIRED_NOTE },
  })
  if (r.count > 0) logger.warn(`[PASES] ${r.count} visitas vencieron sin validar: esos cobros se pierden`)
  return r.count
}
