/**
 * Check-ins de socios de pases (TotalPass/Wellhub) para el dashboard: lista paginada con filtros, resumen del mes, y
 * confirmar o rechazar una visita a mano. La validación con el proveedor la hace el worker de la bandeja
 * (`core/outbox.service`); aquí sólo se encola o se descarta.
 *
 * Nunca sale de aquí la URL de validación (`validationRef`: trae un token de un solo uso) ni nada de la conexión.
 */
import { Prisma } from '@prisma/client'
import { fromZonedTime } from 'date-fns-tz'
import prisma from '@/utils/prismaClient'
import { BadRequestError, ConflictError, NotFoundError } from '@/errors/AppError'
import { withSerializableRetry } from '@/utils/serializableRetry'
import { logAction } from '@/services/dashboard/activity-log.service'
import {
  CHECK_IN_UNDO_HAS_PAYMENT,
  checkInReservation,
  RESERVATION_NOT_CHECKINABLE,
  undoCheckIn,
} from '@/services/reservation/checkIn.service'
import { enqueuePassOutbox } from './core/outbox.service'

export type PassVisitStatus = 'PENDING' | 'CONFIRMED' | 'ALREADY_CONFIRMED' | 'EXPIRED' | 'REJECTED'
/**
 * Estado de la validación con el proveedor, de la ÚLTIMA fila VALIDATE_VISIT de la visita: `QUEUED` esperando al worker,
 * `IN_PROGRESS` llamando al proveedor, `RETRYING` falló y tiene otro intento programado, `FAILED` ya no se reintenta sola
 * (DEAD_LETTER o saltada: confirmar de nuevo crea otra), `DONE` terminó, `NONE` nunca se encoló.
 */
export type PassVisitValidation = 'NONE' | 'QUEUED' | 'IN_PROGRESS' | 'RETRYING' | 'FAILED' | 'DONE'
type Provider = 'TOTALPASS' | 'WELLHUB'
export type PassVisitView = {
  id: string
  provider: Provider
  status: PassVisitStatus
  memberName: string | null
  startedAt: string
  deadlineAt: string
  confirmedAt: string | null
  confirmedBy: string | null
  lastError: string | null
  reservation: { id: string; classSessionId: string | null; startsAt: string; productName: string | null } | null
  /** Campo nuevo (los clientes viejos lo ignoran). */
  validation: PassVisitValidation
  canConfirm: boolean
  canReject: boolean
}

const PAGE_MAX = 100
const PAGE_DEFAULT = 50
const PROVIDERS: Provider[] = ['TOTALPASS', 'WELLHUB']
const PROVIDER_NAME: Record<Provider, string> = { TOTALPASS: 'TotalPass', WELLHUB: 'Wellhub' }
const REJECTED_NOTE = 'Rechazada por el estudio'

const VISIT_SELECT = {
  id: true,
  provider: true,
  status: true,
  connectionId: true,
  externalUserId: true,
  startedAt: true,
  deadlineAt: true,
  confirmedAt: true,
  confirmedBy: true,
  lastError: true,
  reservationId: true,
  /** Sólo para decidir si se puede confirmar; `toViews` no lo expone. */
  connection: { select: { status: true } },
  reservation: {
    select: {
      id: true,
      classSessionId: true,
      startsAt: true,
      guestName: true,
      product: { select: { name: true } },
      customer: { select: { firstName: true, lastName: true } },
    },
  },
} satisfies Prisma.AggregatorVisitSelect
type VisitRow = Prisma.AggregatorVisitGetPayload<{ select: typeof VISIT_SELECT }>

function fullName(c: { firstName: string | null; lastName: string | null } | null | undefined): string | null {
  const n = [c?.firstName, c?.lastName].filter(Boolean).join(' ').trim()
  return n || null
}

/** `lastError` puede traer un mensaje del proveedor: se acota y nunca lleva URLs (la de validación trae un token). */
function safeError(s: string | null): string | null {
  return s ? s.replace(/https?:\/\/\S+/gi, '<url>').slice(0, 300) : null
}

const VALIDATION_OF: Record<string, PassVisitValidation> = {
  PENDING: 'QUEUED',
  IN_PROGRESS: 'IN_PROGRESS',
  FAILED: 'RETRYING',
  DEAD_LETTER: 'FAILED',
  SKIPPED: 'FAILED',
  DONE: 'DONE',
}
const validationKey = (r: { connectionId: string; id: string }) => `VALIDATE_VISIT:${r.connectionId}:${r.id}`

/** Estado de la última fila VALIDATE_VISIT de cada visita, en UNA consulta (la llave repite la de `enqueuePassOutbox`). */
async function latestValidations(venueId: string, rows: VisitRow[]): Promise<Map<string, PassVisitValidation>> {
  if (rows.length === 0) return new Map()
  const latest = await prisma.$queryRaw<{ coalesceKey: string; status: string }[]>`
    SELECT DISTINCT ON ("coalesceKey") "coalesceKey", status::text AS status
    FROM "AggregatorOutbox"
    WHERE "venueId" = ${venueId} AND "coalesceKey" IN (${Prisma.join(rows.map(validationKey))})
    ORDER BY "coalesceKey", "createdAt" DESC, id DESC
  `
  return new Map(latest.map(l => [l.coalesceKey, VALIDATION_OF[l.status] ?? 'NONE']))
}

async function toViews(venueId: string, rows: VisitRow[], now: Date): Promise<PassVisitView[]> {
  // Sin reserva (llegó sin reservar): el nombre sale de la identidad del socio ligada a un cliente, en UNA consulta.
  const orphans = rows.filter(r => !r.reservation).map(r => ({ provider: r.provider, externalUserId: r.externalUserId }))
  const identities = orphans.length
    ? await prisma.customerExternalIdentity.findMany({
        where: { venueId, OR: orphans },
        select: { provider: true, externalUserId: true, customer: { select: { firstName: true, lastName: true } } },
        take: orphans.length,
      })
    : []
  const nameOf = new Map(identities.map(i => [`${i.provider}:${i.externalUserId}`, fullName(i.customer)]))
  const validationOf = await latestValidations(venueId, rows)
  return rows.map(r => {
    const open = r.status === 'PENDING' && r.deadlineAt.getTime() > now.getTime()
    return {
      id: r.id,
      provider: r.provider as Provider,
      status: r.status as PassVisitStatus,
      memberName: r.reservation
        ? (fullName(r.reservation.customer) ?? r.reservation.guestName ?? null)
        : (nameOf.get(`${r.provider}:${r.externalUserId}`) ?? null),
      startedAt: r.startedAt.toISOString(),
      deadlineAt: r.deadlineAt.toISOString(),
      confirmedAt: r.confirmedAt ? r.confirmedAt.toISOString() : null,
      // Sólo una visita confirmada tiene quién la confirmó (vencer o rechazar no lo limpia).
      confirmedBy: r.status === 'CONFIRMED' || r.status === 'ALREADY_CONFIRMED' ? r.confirmedBy : null,
      lastError: safeError(r.lastError),
      reservation: r.reservation
        ? {
            id: r.reservation.id,
            classSessionId: r.reservation.classSessionId,
            startsAt: r.reservation.startsAt.toISOString(),
            productName: r.reservation.product?.name ?? null,
          }
        : null,
      validation: validationOf.get(validationKey(r)) ?? 'NONE',
      // También con la validación FAILED: confirmar de nuevo encola otra fila.
      canConfirm: open,
      canReject: open,
    }
  })
}

/** Lista paginada (tope 100, por defecto 50), más reciente primero; filtros y total en la base. */
export async function listPassVisits(
  venueId: string,
  q: { status?: PassVisitStatus; provider?: Provider; from?: Date; to?: Date; limit?: number; offset?: number },
  now: Date = new Date(),
): Promise<{ items: PassVisitView[]; total: number; hasMore: boolean; nextOffset: number | null }> {
  const pageSize = Number.isFinite(q.limit) ? Math.min(PAGE_MAX, Math.max(1, Math.floor(q.limit as number))) : PAGE_DEFAULT
  const skip = Number.isFinite(q.offset) ? Math.max(0, Math.floor(q.offset as number)) : 0
  const where: Prisma.AggregatorVisitWhereInput = {
    venueId,
    ...(q.status ? { status: q.status } : {}),
    ...(q.provider ? { provider: q.provider } : {}),
    ...(q.from || q.to ? { startedAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lt: q.to } : {}) } } : {}),
  }
  const [rows, total] = await Promise.all([
    prisma.aggregatorVisit.findMany({
      where,
      select: VISIT_SELECT,
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      skip,
      take: pageSize,
    }),
    prisma.aggregatorVisit.count({ where }),
  ])
  const hasMore = skip + rows.length < total
  return { items: await toViews(venueId, rows, now), total, hasMore, nextOffset: hasMore ? skip + rows.length : null }
}

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/

/** Conteo del mes LOCAL del venue por proveedor y estado, más las cancelaciones tardías de reservas de pase. */
export async function summarizePassVisits(
  venueId: string,
  month: string,
  tz: string,
): Promise<
  Array<{
    provider: Provider
    confirmed: number
    alreadyConfirmed: number
    expired: number
    rejected: number
    pending: number
    lateCancellations: number
  }>
> {
  const m = MONTH_RE.exec(month)
  if (!m) throw new BadRequestError('El mes va como AAAA-MM.')
  const [y, mo] = [Number(m[1]), Number(m[2])]
  const next = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`
  const gte = fromZonedTime(`${month}-01T00:00:00`, tz)
  const lt = fromZonedTime(`${next}-01T00:00:00`, tz)
  const groups = await prisma.aggregatorVisit.groupBy({
    by: ['provider', 'status'],
    where: { venueId, startedAt: { gte, lt } },
    _count: { _all: true },
  })
  const out = []
  for (const provider of PROVIDERS) {
    const n = (status: PassVisitStatus) => groups.find(g => g.provider === provider && g.status === status)?._count._all ?? 0
    const lateCancellations = await prisma.activityLog.count({
      where: {
        venueId,
        action: 'PASS_BOOKING_CANCELLED',
        createdAt: { gte, lt },
        AND: [{ data: { path: ['provider'], equals: provider } }, { data: { path: ['late'], equals: true } }],
      },
    })
    out.push({
      provider,
      confirmed: n('CONFIRMED'),
      alreadyConfirmed: n('ALREADY_CONFIRMED'),
      expired: n('EXPIRED'),
      rejected: n('REJECTED'),
      pending: n('PENDING'),
      lateCancellations,
    })
  }
  return out
}

async function loadVisit(venueId: string, visitId: string): Promise<VisitRow> {
  const row = await prisma.aggregatorVisit.findFirst({ where: { id: visitId, venueId }, select: VISIT_SELECT })
  if (!row) throw new NotFoundError('Check-in no encontrado')
  return row
}

/**
 * El estudio confirma que el socio llegó: si tiene reserva, se le hace el check-in (actor humano, desde el dashboard), y se
 * encola la validación con el proveedor. Idempotente: una visita que ya no está PENDING se devuelve como está, y la
 * bandeja junta una segunda confirmación con la primera.
 */
export async function confirmPassVisit(venueId: string, visitId: string, staffId: string, now: Date = new Date()): Promise<PassVisitView> {
  const v = await loadVisit(venueId, visitId)
  if (v.status !== 'PENDING') return (await toViews(venueId, [v], now))[0]
  if (v.deadlineAt.getTime() <= now.getTime()) {
    throw new ConflictError('El plazo para confirmar este check-in ya venció; el proveedor no pagará esta visita.', 'PASS_VISIT_EXPIRED')
  }
  // Con la conexión pausada o revocada el worker saltaría la validación sin avisar y la visita vencería sola.
  if (v.connection.status !== 'ACTIVE') {
    throw new ConflictError(
      `La conexión con ${PROVIDER_NAME[v.provider as Provider]} no está activa: no se puede confirmar ahora. Revisa la conexión en Configuración › Integraciones › Pases.`,
      'PASS_CONNECTION_NOT_ACTIVE',
    )
  }
  const confirmed = await withSerializableRetry(async tx => {
    const before = await tx.aggregatorVisit.findUnique({ where: { id: v.id }, select: { confirmedBy: true } })
    // Quién confirmó: el estudio (el worker lo conserva al validar, aunque la conexión sea AUTO). Con candado de estado: si
    // la visita se resolvió entre la lectura y aquí (rechazo, plazo, worker), no se toca la reserva ni se encola nada.
    const mine = await tx.aggregatorVisit.updateMany({
      where: { id: v.id, venueId, status: 'PENDING' },
      data: { confirmedBy: 'VENUE' },
    })
    if (mine.count === 0) return false
    if (v.reservationId) {
      try {
        await checkInReservation(tx, {
          reservationId: v.reservationId,
          venueId,
          actor: { type: 'HUMAN', staffId },
          source: 'DASHBOARD',
          now,
        })
      } catch (e: any) {
        // La reserva cambió (cancelada, no-show): el socio sí llegó y el estudio lo confirma; se valida la visita igual.
        if (!(e instanceof ConflictError && e.code === RESERVATION_NOT_CHECKINABLE)) throw e
      }
    }
    // Coalescente: si el gancho del check-in ya la encoló, esto sólo la adelanta; si ya se está validando, no hace nada.
    const queued = await enqueuePassOutbox(tx, {
      venueId,
      connectionId: v.connectionId,
      operation: 'VALIDATE_VISIT',
      aggregatorVisitId: v.id,
    })
    // Sólo la solicitud efectiva deja rastro: la primera del estudio, o la que encoló trabajo nuevo (tras una validación que
    // ya no se reintenta). Un reintento del POST no repite la bitácora.
    return before?.confirmedBy !== 'VENUE' || queued === 'CREATED'
  })
  if (confirmed) {
    void logAction({
      staffId,
      venueId,
      action: 'PASS_VISIT_CONFIRMED',
      entity: 'AggregatorVisit',
      entityId: v.id,
      data: { provider: v.provider },
    })
  }
  return (await toViews(venueId, [await loadVisit(venueId, visitId)], now))[0]
}

/**
 * El estudio dice que el socio NO vino: la visita pasa a REJECTED y su validación encolada se descarta, en la misma
 * transacción. No compite con una validación en curso (409) ni rechaza una visita vencida (409). Si su reserva ya estaba
 * CHECKED_IN (confirmó por error, o modo AUTO), se deshace el check-in ahí mismo: la reserva es la fuente de asistencia.
 */
export async function rejectPassVisit(venueId: string, visitId: string, staffId: string, now: Date = new Date()): Promise<PassVisitView> {
  const original = await loadVisit(venueId, visitId)
  // SERIALIZABLE: el reclamo del worker actualiza la misma fila de la bandeja; si compite con este rechazo, uno se reintenta
  // y ve lo del otro (validación en curso ⇒ 409; validación aún encolada ⇒ se descarta con el rechazo).
  // El «sí rechacé» lo DEVUELVE la transacción: un intento que rechazó y no pudo hacer COMMIT (40001) no cuenta.
  const rejected = await withSerializableRetry(async tx => {
    // Candados en el orden de todos los caminos que tocan visita y reserva (visita → reserva; el cambio a AUTO igual):
    // quien llegue segundo espera y, si el otro escribió, SERIALIZABLE reintenta y ya ve lo del otro.
    await tx.$queryRaw`SELECT id FROM "AggregatorVisit" WHERE id = ${visitId} AND "venueId" = ${venueId} FOR UPDATE`
    const v = await tx.aggregatorVisit.findFirst({
      where: { id: visitId, venueId },
      select: { id: true, status: true, deadlineAt: true, connectionId: true, reservationId: true },
    })
    if (!v || v.status !== 'PENDING') return false
    if (v.deadlineAt.getTime() <= now.getTime())
      throw new ConflictError('Este check-in ya venció; no hace falta rechazarlo.', 'PASS_VISIT_EXPIRED')
    const key = `VALIDATE_VISIT:${v.connectionId}:${v.id}`
    const inFlight = await tx.aggregatorOutbox.findFirst({
      where: { coalesceKey: key, status: 'IN_PROGRESS', leaseUntil: { gt: now } },
      select: { id: true },
    })
    if (inFlight) {
      throw new ConflictError(
        'Este check-in se está confirmando con el proveedor en este momento; espera un minuto y vuelve a intentar.',
        'PASS_VISIT_VALIDATING',
      )
    }
    // El estado de la reserva se lee BAJO su candado: un check-in (POS, kiosco, AUTO) que se confirmó mientras corría el
    // rechazo ya se ve aquí (o hace reintentar), y no se omite el undo por una lectura vieja.
    const [reservation] = v.reservationId
      ? await tx.$queryRaw<{ status: string }[]>`SELECT status::text AS status FROM "Reservation" WHERE id = ${v.reservationId} FOR UPDATE`
      : []
    // Si el check-in no se puede deshacer (p. ej. ya hay un cobro), no se rechaza nada: la transacción se deshace entera.
    if (v.reservationId && reservation?.status === 'CHECKED_IN') {
      try {
        await undoCheckIn(tx, {
          reservationId: v.reservationId,
          venueId,
          actor: { type: 'HUMAN', staffId },
          source: 'DASHBOARD',
          now,
          reason: 'Visita de pase rechazada',
        })
      } catch (e: any) {
        if (!(e instanceof ConflictError)) throw e
        throw new ConflictError(
          e.code === CHECK_IN_UNDO_HAS_PAYMENT
            ? 'La reserva de este socio ya tiene un cobro registrado: reembolsa ese cobro y después rechaza el check-in.'
            : 'La reserva de este socio cambió mientras se rechazaba el check-in: recarga la página y vuelve a intentar.',
          'PASS_VISIT_CHECK_IN_NOT_UNDONE',
        )
      }
    }
    await tx.aggregatorOutbox.updateMany({
      where: { coalesceKey: key, status: { in: ['PENDING', 'FAILED'] } },
      data: { status: 'SKIPPED', lastError: REJECTED_NOTE, processedAt: now },
    })
    const r = await tx.aggregatorVisit.updateMany({
      where: { id: v.id, venueId, status: 'PENDING' },
      data: { status: 'REJECTED', lastError: REJECTED_NOTE },
    })
    return r.count > 0
  })
  if (rejected) {
    void logAction({
      staffId,
      venueId,
      action: 'PASS_VISIT_REJECTED',
      entity: 'AggregatorVisit',
      entityId: original.id,
      data: { provider: original.provider },
    })
  }
  return (await toViews(venueId, [await loadVisit(venueId, visitId)], now))[0]
}

/** Medianoche UTC de un 'AAAA-MM-DD' que exista en el calendario; '2030-02-30' no se recorre al 2 de marzo: es un 400. */
function calendarDay(day: string): Date {
  const d = new Date(`${day}T00:00:00Z`)
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== day) throw new BadRequestError('La fecha va como AAAA-MM-DD.')
  return d
}

/** Días LOCALES del venue ('AAAA-MM-DD'); `to` es inclusivo ⇒ el límite es la medianoche local del día siguiente. */
export function localDayRange(from: string | undefined, to: string | undefined, tz: string): { from?: Date; to?: Date } {
  const out: { from?: Date; to?: Date } = {}
  if (from) {
    calendarDay(from)
    out.from = fromZonedTime(`${from}T00:00:00`, tz)
  }
  if (to) {
    const d = calendarDay(to)
    d.setUTCDate(d.getUTCDate() + 1)
    out.to = fromZonedTime(`${d.toISOString().slice(0, 10)}T00:00:00`, tz)
  }
  return out
}
