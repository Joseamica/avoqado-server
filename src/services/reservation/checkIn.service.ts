/**
 * Fase 0.C — Check-in de reservas: DOS comandos.
 *
 * `checkInReservation` (PURO, dentro de una tx): cambia el estado, escribe statusLog y
 * ActivityLog en la MISMA transacción, es idempotente y NO crea ninguna orden. Es lo que
 * usa el kiosco ("Tapete 4, pasa": el check-in no vende nada).
 *
 * `checkInReservationAndOpenOrder` (wrapper): el comportamiento de COUNTER de siempre —
 * check-in puro en tx y después intenta abrir la orden TPV fuera de la tx; un fallo de la
 * orden NO revierte el check-in (se traga, se loguea y queda en ActivityLog).
 *
 * `source` NUNCA viene del cliente: se deriva de la credencial que autenticó la llamada
 * (`deriveCheckInSource`). Sólo `KIOSK` tiene ventana de horario; COUNTER/DASHBOARD/MCP no.
 *
 * Antes (reservation.dashboard.service.ts checkInReservation): sólo CONFIRMED→CHECKED_IN,
 * no idempotente, la orden se creaba en otra tx y el error se tragaba sin rastro.
 */
import { Prisma, ReservationStatus } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { ConflictError, NotFoundError, ValidationError } from '@/errors/AppError'
import { getReservationSettings } from '@/services/dashboard/reservationSettings.service'
import { RESERVATION_INCLUDE } from '@/services/dashboard/reservation.dashboard.service'
import { resolveServicesMany } from '@/services/reservation/reservation-services.resolver'
import { createOrderFromReservation } from '@/services/reservation/createOrderFromReservation'
import { withSerializableRetry } from '@/utils/serializableRetry'

/**
 * Quién hace el check-in. NO lleva organizationId: el ActivityLog se estampa con la
 * organización DEL VENUE objetivo (auditoría 5) — el tenant guard exige que
 * `venueId` pertenezca a `organizationId`, y un superadmin/MCP puede operar un venue de
 * otra organización que la de su JWT / activeOrg; derivarlo del token revertía el check-in.
 */
export type CheckInActor = { type: 'HUMAN'; staffId: string } | { type: 'SERVICE'; servicePrincipalId: string }

export type CheckInSource = 'DASHBOARD' | 'POS_ANDROID' | 'POS_IOS' | 'MCP' | 'KIOSK'

export const RESERVATION_NOT_CHECKINABLE = 'RESERVATION_NOT_CHECKINABLE' as const
export const CHECK_IN_OUTSIDE_WINDOW = 'CHECK_IN_OUTSIDE_WINDOW' as const
export const ORDER_CREATION_FAILED = 'ORDER_CREATION_FAILED' as const
export const CHECK_IN_UNDO_NOT_APPLICABLE = 'CHECK_IN_UNDO_NOT_APPLICABLE' as const
export const CHECK_IN_UNDO_HAS_PAYMENT = 'CHECK_IN_UNDO_HAS_PAYMENT' as const

/** Minutos antes de `startsAt` desde los que el kiosco admite el check-in. */
export const KIOSK_EARLY_CHECK_IN_MIN = 20

const CHECKINABLE: ReservationStatus[] = ['PENDING', 'CONFIRMED']

/**
 * `source` derivado de la credencial + el header que las apps YA mandan
 * (`x-device-platform: ANDROID | IOS`, DeviceHeadersInterceptor.kt:80). Cualquier otro valor
 * —incluido un "KIOSK" inventado— es DASHBOARD: un JWT de staff nunca produce KIOSK, así que
 * falsificar el header no compra ninguna ventana. KIOSK sólo nace de una credencial de
 * dispositivo (Fase 3); MCP lo pone su propio guard.
 */
export function deriveCheckInSource(devicePlatformHeader: unknown): 'DASHBOARD' | 'POS_ANDROID' | 'POS_IOS' {
  if (devicePlatformHeader === 'ANDROID') return 'POS_ANDROID'
  if (devicePlatformHeader === 'IOS') return 'POS_IOS'
  return 'DASHBOARD'
}

/**
 * Ventana del kiosco: `startsAt − 20min ≤ now < startsAt + noShowGraceMin`. Estricto `<`
 * arriba porque el job de no-show marca con `deadline <= now` (reservation-auto-no-show.job.ts):
 * en el instante exacto gana el no-show, no el check-in. `noShowGraceMin = 0` cierra en
 * `startsAt` exacto.
 */
export function evaluateKioskWindow(input: { startsAt: Date; now: Date; noShowGraceMin: number }): boolean {
  const open = input.startsAt.getTime() - KIOSK_EARLY_CHECK_IN_MIN * 60_000
  const close = input.startsAt.getTime() + input.noShowGraceMin * 60_000
  const t = input.now.getTime()
  return open <= t && t < close
}

export function decideCheckIn(status: ReservationStatus | string): 'TRANSITION' | 'ALREADY' | 'NOT_CHECKINABLE' {
  if (status === 'CHECKED_IN') return 'ALREADY'
  if ((CHECKINABLE as string[]).includes(status)) return 'TRANSITION'
  return 'NOT_CHECKINABLE'
}

type StatusLogEntry = { status: string; at: string; by: string | null; source?: string; reason?: string }

function actorLabel(actor: CheckInActor): string {
  return actor.type === 'HUMAN' ? actor.staffId : `service:${actor.servicePrincipalId}`
}

/** Campos de ActivityLog que satisfacen `ActivityLog_actor_identity_check` para cada actor. */
function activityActorFields(actor: CheckInActor, organizationId: string) {
  return actor.type === 'HUMAN'
    ? {
        actorType: 'HUMAN' as const,
        organizationId,
        staffId: actor.staffId,
        actorStaffId: actor.staffId, // la constraint EXIGE actorStaffId = staffId
        servicePrincipalId: null,
      }
    : {
        actorType: 'SERVICE' as const,
        organizationId,
        staffId: null,
        actorStaffId: null,
        servicePrincipalId: actor.servicePrincipalId,
      }
}

/** La organización DEL VENUE — la única que el tenant guard de ActivityLog acepta. */
async function venueOrganizationId(client: Prisma.TransactionClient | typeof prisma, venueId: string): Promise<string> {
  const venue = await client.venue.findUniqueOrThrow({ where: { id: venueId }, select: { organizationId: true } })
  return venue.organizationId
}

export interface CheckInCommand {
  reservationId: string
  venueId: string
  actor: CheckInActor
  source: CheckInSource
  now: Date
}

export interface CheckInResult<R = any> {
  outcome: 'CHECKED_IN' | 'ALREADY_CHECKED_IN'
  reservation: R
  services: Array<{ id: string; name: string; price: Prisma.Decimal | null; duration: number | null }>
}

/**
 * Check-in PURO. Debe correr dentro de una transacción (el caller la abre): el CAS sobre el
 * estado, el statusLog y el ActivityLog son todo-o-nada. Nunca crea orden.
 *
 *   PENDING | CONFIRMED → CHECKED_IN
 *   CHECKED_IN          → mismo resultado, sin escribir (idempotente)
 *   NO_SHOW | CANCELLED | COMPLETED → 409 RESERVATION_NOT_CHECKINABLE
 *   KIOSK fuera de ventana → 422 CHECK_IN_OUTSIDE_WINDOW (antes de escribir)
 */
export async function checkInReservation(tx: Prisma.TransactionClient, cmd: CheckInCommand): Promise<CheckInResult> {
  const current = await tx.reservation.findFirst({ where: { id: cmd.reservationId, venueId: cmd.venueId } })
  if (!current) throw new NotFoundError('Reservacion no encontrada')

  const decision = decideCheckIn(current.status)
  if (decision === 'NOT_CHECKINABLE') {
    throw new ConflictError(`La reservacion esta en estado ${current.status} y ya no admite check-in`, RESERVATION_NOT_CHECKINABLE)
  }
  if (decision === 'ALREADY') {
    return finish(tx, cmd, 'ALREADY_CHECKED_IN')
  }

  if (cmd.source === 'KIOSK') {
    const settings = await getReservationSettings(cmd.venueId, tx)
    const noShowGraceMin = settings.scheduling.noShowGraceMin
    if (!evaluateKioskWindow({ startsAt: current.startsAt, now: cmd.now, noShowGraceMin })) {
      throw new ValidationError(
        'El check-in solo esta disponible desde 20 minutos antes de tu clase hasta su inicio',
        CHECK_IN_OUTSIDE_WINDOW,
        {
          startsAt: current.startsAt,
          now: cmd.now,
          noShowGraceMin,
        },
      )
    }
  }

  const entries = Array.isArray(current.statusLog) ? (current.statusLog as StatusLogEntry[]) : []
  const statusLog: StatusLogEntry[] = [
    ...entries,
    { status: 'CHECKED_IN', at: cmd.now.toISOString(), by: actorLabel(cmd.actor), source: cmd.source },
  ]

  // CAS: sólo gana quien encuentre la fila todavía en PENDING/CONFIRMED. Carrera con otro
  // check-in o con el job de no-show ⇒ exactamente un ganador; el perdedor relee y decide.
  const cas = await tx.reservation.updateMany({
    where: { id: cmd.reservationId, venueId: cmd.venueId, status: { in: CHECKINABLE } },
    data: { status: 'CHECKED_IN', checkedInAt: cmd.now, statusLog: statusLog as unknown as Prisma.InputJsonValue },
  })
  if (cas.count === 0) {
    const reread = await tx.reservation.findUniqueOrThrow({ where: { id: cmd.reservationId }, select: { status: true } })
    if (reread.status === 'CHECKED_IN') return finish(tx, cmd, 'ALREADY_CHECKED_IN')
    throw new ConflictError(`La reservacion cambio a ${reread.status} y ya no admite check-in`, RESERVATION_NOT_CHECKINABLE)
  }

  // ActivityLog DENTRO de la tx: si falla, el check-in se revierte (sin rastro no hay check-in).
  const organizationId = await venueOrganizationId(tx, cmd.venueId)
  await tx.activityLog.create({
    data: {
      ...activityActorFields(cmd.actor, organizationId),
      venueId: cmd.venueId,
      action: 'RESERVATION_CHECKED_IN',
      entity: 'Reservation',
      entityId: cmd.reservationId,
      data: { status: 'CHECKED_IN', confirmationCode: current.confirmationCode, source: cmd.source },
    },
  })

  logger.info(`✅ [CHECK_IN] ${current.confirmationCode} ${current.status} → CHECKED_IN source=${cmd.source} by=${actorLabel(cmd.actor)}`)
  return finish(tx, cmd, 'CHECKED_IN')
}

async function finish(tx: Prisma.TransactionClient, cmd: CheckInCommand, outcome: CheckInResult['outcome']): Promise<CheckInResult> {
  const reservation = await tx.reservation.findUniqueOrThrow({ where: { id: cmd.reservationId }, include: RESERVATION_INCLUDE })
  // Con la MISMA tx (auditoría 5): `attachServices` usaba el cliente global — otra conexión
  // abierta mientras la transacción sigue viva, fuera del snapshot y capaz de atascar el pool.
  const [withServices] = await resolveServicesMany([reservation], tx)
  const { services, ...rest } = withServices as any
  return { outcome, reservation: rest, services: services ?? [] }
}

export interface CheckInAndOpenOrderResponse {
  [key: string]: unknown
  services: CheckInResult['services']
  orderId: string | null
  orderCreated: boolean
  orderError?: typeof ORDER_CREATION_FAILED
}

/**
 * COUNTER: check-in puro y después la orden TPV, FUERA de la tx. Respuesta PLANA (Android
 * espera los campos en la raíz, Reservation.kt:6).
 *
 *   orden nueva              → orderId, orderCreated:true
 *   orden viva preexistente  → orderId (la existente), orderCreated:false
 *   perdedor de carrera P2002→ orderId (la del ganador, releída fuera de tx), orderCreated:false
 *   creación falló           → orderId:null, orderCreated:false, orderError:'ORDER_CREATION_FAILED'
 *
 * Una orden preexistente NO es un error (se retira ORDER_ALREADY_EXISTS). El fallo de la orden
 * se traga (como hoy) pero deja rastro: logger.error + ActivityLog ORDER_FROM_RESERVATION_FAILED.
 */
export async function checkInReservationAndOpenOrder(cmd: CheckInCommand): Promise<CheckInAndOpenOrderResponse> {
  const result = await prisma.$transaction(tx => checkInReservation(tx, cmd))

  let orderId: string | null = null
  let orderCreated = false
  let orderError: typeof ORDER_CREATION_FAILED | undefined

  try {
    const created = await withSerializableRetry(tx =>
      createOrderFromReservation(tx, {
        reservationId: cmd.reservationId,
        venueId: cmd.venueId,
        createdByStaffId: cmd.actor.type === 'HUMAN' ? cmd.actor.staffId : null,
      }),
    )
    orderId = created?.orderId ?? null
    orderCreated = created?.created ?? false
  } catch (err: any) {
    // P2002 sobre el índice parcial de reservationId = perdimos la carrera contra otro
    // check-in que ya abrió la orden: releer la viva y devolverla (no es un error).
    if (err?.code === 'P2002' && String(err?.meta?.target ?? '').includes('reservationId')) {
      const alive = await prisma.order.findFirst({
        where: { reservationId: cmd.reservationId, venueId: cmd.venueId, status: { notIn: ['CANCELLED', 'DELETED'] } },
        select: { id: true },
      })
      orderId = alive?.id ?? null
      orderCreated = false
      if (!alive) {
        // Chocamos con el índice pero la orden ganadora ya no está viva (se canceló en la
        // ventana). No lo disfrazamos de "sin orden": es un fallo de creación con rastro.
        orderError = ORDER_CREATION_FAILED
        logger.error(`[CHECK_IN] P2002 on reservation ${cmd.reservationId} but no alive order found on re-read`, { source: cmd.source })
      }
    } else {
      orderError = ORDER_CREATION_FAILED
      logger.error(`[CHECK_IN] Order auto-create failed for reservation ${cmd.reservationId}: ${err?.message}`, { source: cmd.source })
      try {
        const organizationId = await venueOrganizationId(prisma, cmd.venueId)
        await prisma.activityLog.create({
          data: {
            ...activityActorFields(cmd.actor, organizationId),
            venueId: cmd.venueId,
            action: 'ORDER_FROM_RESERVATION_FAILED',
            entity: 'Reservation',
            entityId: cmd.reservationId,
            data: { source: cmd.source, error: String(err?.message ?? err) },
          },
        })
      } catch (logErr) {
        logger.error('[CHECK_IN] ORDER_FROM_RESERVATION_FAILED could not be logged', {
          reservationId: cmd.reservationId,
          err: (logErr as Error)?.message,
        })
      }
    }
  }

  return {
    ...result.reservation,
    services: result.services,
    orderId,
    orderCreated,
    ...(orderError ? { orderError } : {}),
  }
}

export interface UndoCheckInCommand {
  reservationId: string
  venueId: string
  actor: CheckInActor
  source: CheckInSource
  now: Date
  reason?: string
}

export interface UndoCheckInResult<R = any> {
  outcome: 'UNDONE' | 'ALREADY_UNDONE'
  reservation: R
}

/**
 * D16 — deshacer un check-in.
 *
 * El kiosco es autoservicio: tarde o temprano alguien toca el nombre de al lado. Sin esto,
 * `CHECKED_IN` es una puerta de un solo sentido y la clase queda con un presente que nunca
 * llegó (y, del otro lado, un no-show que sí vino).
 *
 * Vuelve al estado que la PROPIA bitácora de la reserva dice que tenía antes del check-in
 * —no a un `CONFIRMED` inventado—, porque una reserva que estaba en `PENDING` debe regresar
 * a `PENDING` o se estaría confirmando sola de rebote.
 *
 * 🔴 Se planta cuando el check-in abrió una orden y esa orden YA se cobró: revertir dejaría
 * un cobro colgando de una reserva que afirma que nadie vino. Ese caso lo resuelve un
 * reembolso, no un undo — y el error lo dice en vez de romper el cuadre en silencio.
 */
export async function undoCheckIn(tx: Prisma.TransactionClient, cmd: UndoCheckInCommand): Promise<UndoCheckInResult> {
  const current = await tx.reservation.findFirst({ where: { id: cmd.reservationId, venueId: cmd.venueId } })
  if (!current) throw new NotFoundError('Reservacion no encontrada')

  // Ya deshecho (o nunca marcado): idempotente, como el propio check-in.
  if (current.status !== 'CHECKED_IN') {
    if ((CHECKINABLE as string[]).includes(current.status)) {
      const reservation = await tx.reservation.findUniqueOrThrow({ where: { id: cmd.reservationId }, include: RESERVATION_INCLUDE })
      return { outcome: 'ALREADY_UNDONE', reservation }
    }
    throw new ConflictError(
      `La reservacion esta en estado ${current.status}: deshacer el check-in ya no aplica`,
      CHECK_IN_UNDO_NOT_APPLICABLE,
    )
  }

  // 🔴 Dinero primero: si la orden del check-in ya cobró, esto no se deshace.
  const orders = await tx.order.findMany({
    where: { reservationId: cmd.reservationId, venueId: cmd.venueId },
    select: { id: true, payments: { where: { status: 'COMPLETED' }, select: { id: true } } },
  })
  const paid = orders.find(o => o.payments.length > 0)
  if (paid) {
    throw new ConflictError(
      'Esta reservacion ya tiene un cobro registrado: para revertirla hay que reembolsar, no deshacer el check-in',
      CHECK_IN_UNDO_HAS_PAYMENT,
      { orderId: paid.id },
    )
  }

  // El estado previo sale de la bitácora: la última entrada ANTES del CHECKED_IN.
  const entries = Array.isArray(current.statusLog) ? (current.statusLog as StatusLogEntry[]) : []
  const lastCheckIn = entries.map(e => e.status).lastIndexOf('CHECKED_IN')
  const previous = entries
    .slice(0, lastCheckIn >= 0 ? lastCheckIn : entries.length)
    .map(e => e.status)
    .filter(st => (CHECKINABLE as string[]).includes(st))
    .pop()
  const target = (previous ?? 'CONFIRMED') as ReservationStatus

  const statusLog: StatusLogEntry[] = [
    ...entries,
    { status: target, at: cmd.now.toISOString(), by: actorLabel(cmd.actor), source: cmd.source, reason: cmd.reason },
  ]

  // CAS: sólo gana quien todavía la encuentre en CHECKED_IN.
  const cas = await tx.reservation.updateMany({
    where: { id: cmd.reservationId, venueId: cmd.venueId, status: 'CHECKED_IN' },
    data: { status: target, checkedInAt: null, statusLog: statusLog as unknown as Prisma.InputJsonValue },
  })
  if (cas.count === 0) {
    const reread = await tx.reservation.findUniqueOrThrow({ where: { id: cmd.reservationId }, select: { status: true } })
    throw new ConflictError(`La reservacion cambio a ${reread.status} mientras se deshacia el check-in`, CHECK_IN_UNDO_NOT_APPLICABLE)
  }

  const organizationId = await venueOrganizationId(tx, cmd.venueId)
  await tx.activityLog.create({
    data: {
      ...activityActorFields(cmd.actor, organizationId),
      venueId: cmd.venueId,
      action: 'RESERVATION_CHECK_IN_UNDONE',
      entity: 'Reservation',
      entityId: cmd.reservationId,
      data: { from: 'CHECKED_IN', to: target, confirmationCode: current.confirmationCode, source: cmd.source, reason: cmd.reason ?? null },
    },
  })

  logger.info(`↩️ [CHECK_IN] ${current.confirmationCode} CHECKED_IN → ${target} (undo) source=${cmd.source} by=${actorLabel(cmd.actor)}`)

  const reservation = await tx.reservation.findUniqueOrThrow({ where: { id: cmd.reservationId }, include: RESERVATION_INCLUDE })
  return { outcome: 'UNDONE', reservation }
}
