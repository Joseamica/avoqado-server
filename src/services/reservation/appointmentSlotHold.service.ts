import { Prisma } from '@prisma/client'
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz'
import { BadRequestError, ConflictError, NotFoundError } from '@/errors/AppError'
import {
  assertStaffEligibleForPersistedProducts,
  lockAppointmentVenue,
  resolveStaffAssignment,
  shouldAutoAssign,
} from '@/services/dashboard/appointmentStaffAssignment.service'
import { countAppointmentOccupancy, effectiveAppointmentPacing } from '@/services/dashboard/reservationAvailability.service'
import {
  getReservationSettings,
  isStaffAware,
  type OperatingHours,
  type ReservationConfig,
} from '@/services/dashboard/reservationSettings.service'
import { checkExternalBusyBlock } from '@/services/reservation/external-busy-block.service'
import {
  assertLegacyAppointmentDurationFloor,
  normalizeBookedProductIds,
  reservationBookedProductIds,
  resolveAppointmentWindow,
  resolveCanonicalAppointmentDuration,
} from '@/services/reservation/resolveAppointmentWindow'
import { resolveModifierSelections, type ModifierSelectionInput } from '@/services/reservation/resolveModifierSelections'
import { enforceBookingWindow } from '@/services/reservation/bookingWindow.service'
import { withSerializableRetry } from '@/utils/serializableRetry'
import prisma from '@/utils/prismaClient'

export const SLOT_HOLD_TTL_MS = 10 * 60 * 1000

export interface MintNormalAppointmentHoldInput {
  venueId: string
  startsAt: Date
  endsAt: Date
  productIds: string[]
  partySize?: number
  fingerprint?: string | null
  staffId?: string
  modifierSelections?: ModifierSelectionInput[]
  windowSemantics?: 'base'
}

export interface MintedNormalAppointmentHold {
  id: string
  expiresAt: Date
  staffId: string | null
}

interface LockedNormalAppointmentHold {
  id: string
  venueId: string
  startsAt: Date
  endsAt: Date
  productIds: string[]
  classSessionId: string | null
  staffId: string | null
  heldForReservationId: string | null
  windowSemantics: string | null
  expiresAt: Date
}

export interface LockedRescheduleReservation {
  id: string
  venueId: string
  startsAt: Date
  endsAt: Date
  duration: number
  productId: string | null
  productIds: string[]
  tableId: string | null
  assignedStaffId: string | null
  partySize: number
  classSessionId: string | null
  status: string
}

interface LockedRescheduleAppointmentHold extends LockedNormalAppointmentHold {
  partySize: number
}

export interface MintRescheduleAppointmentHoldInput {
  venueId: string
  reservationId: string
  requestedStartsAt: Date
  requestedEndsAt?: Date
  clock?: () => Date
}

function invalidHold(): ConflictError {
  return new ConflictError('Tu reserva temporal ya no es válida. Selecciona el horario de nuevo.')
}

function appointmentWindowChanged(): ConflictError {
  return new ConflictError('La duración del servicio cambió. Selecciona el horario nuevamente.', 'APPOINTMENT_WINDOW_CHANGED')
}

function sameDate(left: Date, right: Date): boolean {
  return left instanceof Date && right instanceof Date && left.getTime() === right.getTime()
}

function sameOrderedStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime())
}

function fixedReservationEndsAt(reservation: LockedRescheduleReservation, startsAt: Date): Date {
  if (!Number.isInteger(reservation.duration) || reservation.duration < 1 || reservation.duration > 1_440) throw invalidHold()
  return new Date(startsAt.getTime() + reservation.duration * 60_000)
}

function targetFitsVenueGrid(startsAt: Date, endsAt: Date, settings: ReservationConfig, timezone: string): boolean {
  try {
    const intervalMin = settings.scheduling.slotIntervalMin
    if (!Number.isInteger(intervalMin) || intervalMin < 1 || !validDate(startsAt) || !validDate(endsAt) || endsAt <= startsAt) {
      return false
    }

    const localDate = formatInTimeZone(startsAt, timezone, 'yyyy-MM-dd')
    const dayKey = formatInTimeZone(startsAt, timezone, 'EEEE').toLowerCase() as keyof OperatingHours
    const day = settings.operatingHours[dayKey]
    if (!day?.enabled || !Array.isArray(day.ranges)) return false

    const intervalMs = intervalMin * 60_000
    return day.ranges.some(range => {
      const rangeStartsAt = fromZonedTime(`${localDate}T${range.open}:00`, timezone)
      const rangeEndsAt = fromZonedTime(`${localDate}T${range.close}:00`, timezone)
      const offsetMs = startsAt.getTime() - rangeStartsAt.getTime()
      return offsetMs >= 0 && offsetMs % intervalMs === 0 && endsAt.getTime() <= rangeEndsAt.getTime()
    })
  } catch {
    return false
  }
}

export function assertReschedulePolicy(
  reservation: Pick<LockedRescheduleReservation, 'status' | 'startsAt'>,
  settings: ReservationConfig,
  checkedAt: Date,
): void {
  if (!validDate(reservation.startsAt) || !validDate(checkedAt)) {
    throw new BadRequestError('La ventana de la cita es inválida')
  }
  if (!settings.cancellation.allowCustomerReschedule) {
    throw new BadRequestError('Este negocio no permite cambiar horarios en línea. Contacta al negocio directamente.')
  }
  if (reservation.status !== 'CONFIRMED' && reservation.status !== 'PENDING') {
    throw new BadRequestError('Esta reservación ya no se puede cambiar.')
  }
  const minHours = settings.cancellation.minHoursBeforeStart
  if (minHours !== null && (reservation.startsAt.getTime() - checkedAt.getTime()) / 3_600_000 < minHours) {
    throw new BadRequestError(`No puedes cambiar el horario con menos de ${minHours} horas de anticipación.`)
  }
}

export async function lockReservationForReschedule(
  tx: Prisma.TransactionClient,
  args: { venueId: string; reservationId: string },
): Promise<LockedRescheduleReservation> {
  const rows = await tx.$queryRaw<LockedRescheduleReservation[]>`
    SELECT id, "venueId", "startsAt", "endsAt", duration, "productId", "productIds", "tableId",
           "assignedStaffId", "partySize", "classSessionId", status
    FROM "Reservation"
    WHERE id = ${args.reservationId} AND "venueId" = ${args.venueId}
    FOR UPDATE
  `
  const reservation = rows[0]
  if (!reservation) throw new NotFoundError('Reservacion no encontrada')
  return reservation
}

export async function lockTaggedRescheduleSiblings(
  tx: Prisma.TransactionClient,
  args: { venueId: string; reservationId: string },
): Promise<LockedRescheduleAppointmentHold[]> {
  return tx.$queryRaw<LockedRescheduleAppointmentHold[]>`
    SELECT id, "venueId", "startsAt", "endsAt", "productIds", "classSessionId",
           "staffId", "heldForReservationId", "windowSemantics", "partySize", "expiresAt"
    FROM "SlotHold"
    WHERE "venueId" = ${args.venueId} AND "heldForReservationId" = ${args.reservationId}
    ORDER BY id
    FOR UPDATE
  `
}

function assertHoldInterval(input: MintNormalAppointmentHoldInput): void {
  const startsAtMs = input.startsAt.getTime()
  const endsAtMs = input.endsAt.getTime()
  if (!Number.isFinite(startsAtMs) || !Number.isFinite(endsAtMs) || endsAtMs <= startsAtMs) {
    throw new BadRequestError('La ventana de la cita es inválida')
  }
  const durationMin = (endsAtMs - startsAtMs) / 60_000
  const min = input.windowSemantics === 'base' ? 1 : 5
  const max = input.windowSemantics === 'base' ? 1_440 : 480
  if (durationMin < min || durationMin > max) {
    throw new BadRequestError(`La duración de la reserva temporal debe estar entre ${min} y ${max} minutos`)
  }
}

export async function mintNormalAppointmentHold(input: MintNormalAppointmentHoldInput): Promise<MintedNormalAppointmentHold> {
  assertHoldInterval(input)
  const { productIds } = normalizeBookedProductIds({ productIds: input.productIds })

  return withSerializableRetry(async tx => {
    const settings = await getReservationSettings(input.venueId, tx)
    let heldEndsAt: Date

    if (input.windowSemantics === 'base') {
      const resolved = await resolveAppointmentWindow(tx, {
        venueId: input.venueId,
        productIds,
        startsAt: input.startsAt,
        baseEndsAt: input.endsAt,
        modifierSelections: input.modifierSelections ?? [],
        settings,
      })
      heldEndsAt = resolved.finalEndsAt
    } else {
      await resolveCanonicalAppointmentDuration(tx, {
        venueId: input.venueId,
        productIds,
        settings,
      })
      await assertLegacyAppointmentDurationFloor(tx, {
        venueId: input.venueId,
        productIds,
        rawDurationMin: (input.endsAt.getTime() - input.startsAt.getTime()) / 60_000,
        settings,
      })
      await resolveModifierSelections(tx, productIds, input.modifierSelections ?? [])
      heldEndsAt = input.endsAt
    }

    await lockAppointmentVenue(tx, input.venueId)
    const checkedAt = new Date()
    if (!settings.publicBooking.enabled) {
      throw new BadRequestError('Las reservaciones en linea no estan habilitadas')
    }
    enforceBookingWindow(input.startsAt, settings.scheduling, checkedAt)

    if (input.staffId && settings.publicBooking.showStaffPicker !== true) {
      throw new BadRequestError('La selección de profesionista no está habilitada para este negocio')
    }

    let effectiveStaffId: string | null = null
    if (input.staffId || shouldAutoAssign(true, settings)) {
      effectiveStaffId = await resolveStaffAssignment(tx, {
        venueId: input.venueId,
        productIds,
        startsAt: input.startsAt,
        endsAt: heldEndsAt,
        checkedAt,
        settings,
        requestedStaffId: input.staffId,
      })
    }

    const externalBlock = await checkExternalBusyBlock(tx, {
      venueId: input.venueId,
      staffId: effectiveStaffId,
      startsAt: input.startsAt,
      endsAt: heldEndsAt,
    })
    if (externalBlock) {
      throw new ConflictError('Este horario fue bloqueado por un evento de calendario externo')
    }

    const globalLimit = isStaffAware(settings)
      ? (settings.scheduling.pacingMaxPerSlot ?? null)
      : effectiveAppointmentPacing(settings.scheduling.pacingMaxPerSlot)
    if (globalLimit !== null) {
      const { reservations, holds } = await countAppointmentOccupancy(tx, {
        venueId: input.venueId,
        startsAt: input.startsAt,
        endsAt: heldEndsAt,
        checkedAt,
      })
      if (reservations + holds >= globalLimit) {
        throw new ConflictError('Este horario ya no está disponible. Por favor elige otro horario.')
      }
    }

    const expiresAt = new Date(checkedAt.getTime() + SLOT_HOLD_TTL_MS)
    return tx.slotHold.create({
      data: {
        venueId: input.venueId,
        startsAt: input.startsAt,
        endsAt: heldEndsAt,
        productIds,
        classSessionId: null,
        staffId: effectiveStaffId,
        heldForReservationId: null,
        windowSemantics: input.windowSemantics ?? null,
        partySize: Math.max(1, input.partySize ?? 1),
        expiresAt,
        fingerprint: input.fingerprint ?? null,
      },
      select: { id: true, expiresAt: true, staffId: true },
    })
  })
}

export async function mintRescheduleAppointmentHold(input: MintRescheduleAppointmentHoldInput): Promise<MintedNormalAppointmentHold> {
  if (!validDate(input.requestedStartsAt) || (input.requestedEndsAt !== undefined && !validDate(input.requestedEndsAt))) {
    throw new BadRequestError('Fechas inválidas')
  }

  return withSerializableRetry(async tx => {
    const settings = await getReservationSettings(input.venueId, tx)
    await lockAppointmentVenue(tx, input.venueId)
    const reservation = await lockReservationForReschedule(tx, {
      venueId: input.venueId,
      reservationId: input.reservationId,
    })
    await lockTaggedRescheduleSiblings(tx, {
      venueId: input.venueId,
      reservationId: reservation.id,
    })
    const venue = await tx.venue.findUnique({
      where: { id: input.venueId },
      select: { timezone: true },
    })
    if (!venue) throw new NotFoundError('Negocio no encontrado')
    const checkedAt = (input.clock ?? (() => new Date()))()

    if (reservation.classSessionId !== null) {
      throw new BadRequestError('Las clases se reagendan eligiendo otra sesión; no requieren reservar el horario.')
    }
    assertReschedulePolicy(reservation, settings, checkedAt)
    const productIds = reservationBookedProductIds(reservation)
    const derivedEndsAt = fixedReservationEndsAt(reservation, input.requestedStartsAt)
    if (input.requestedEndsAt && Math.abs(input.requestedEndsAt.getTime() - derivedEndsAt.getTime()) > 60_000) {
      throw new BadRequestError('La duración del horario no coincide con el servicio.')
    }
    if (input.requestedStartsAt.getTime() < checkedAt.getTime()) {
      throw new ConflictError('Ese horario ya pasó, elige otro.')
    }
    if (!targetFitsVenueGrid(input.requestedStartsAt, derivedEndsAt, settings, venue.timezone)) {
      throw new ConflictError('Ese horario ya no está disponible, elige otro.')
    }

    await tx.slotHold.deleteMany({
      where: { venueId: input.venueId, heldForReservationId: reservation.id },
    })

    enforceBookingWindow(input.requestedStartsAt, settings.scheduling, checkedAt)
    if (isStaffAware(settings) && reservation.assignedStaffId === null) {
      throw new ConflictError('El profesionista de esta cita ya no está disponible. Contacta al negocio.')
    }
    if (reservation.assignedStaffId) {
      await assertStaffEligibleForPersistedProducts(tx, {
        venueId: input.venueId,
        staffId: reservation.assignedStaffId,
        productIds,
        startsAt: input.requestedStartsAt,
        endsAt: derivedEndsAt,
        checkedAt,
        settings,
        excludeReservationId: reservation.id,
      })
    } else {
      const venueBlock = await checkExternalBusyBlock(tx, {
        venueId: input.venueId,
        staffId: null,
        startsAt: input.requestedStartsAt,
        endsAt: derivedEndsAt,
      })
      if (venueBlock) {
        throw new ConflictError('Este horario fue bloqueado por un evento de calendario externo')
      }
    }

    const globalLimit = isStaffAware(settings)
      ? (settings.scheduling.pacingMaxPerSlot ?? null)
      : effectiveAppointmentPacing(settings.scheduling.pacingMaxPerSlot)
    if (globalLimit !== null) {
      const { reservations, holds } = await countAppointmentOccupancy(tx, {
        venueId: input.venueId,
        startsAt: input.requestedStartsAt,
        endsAt: derivedEndsAt,
        checkedAt,
        excludeReservationId: reservation.id,
      })
      if (reservations + holds >= globalLimit) {
        throw new ConflictError('Este horario ya no está disponible. Por favor elige otro horario.')
      }
    }

    const expiresAt = new Date(checkedAt.getTime() + SLOT_HOLD_TTL_MS)
    return tx.slotHold.create({
      data: {
        venueId: reservation.venueId,
        startsAt: input.requestedStartsAt,
        endsAt: derivedEndsAt,
        productIds,
        classSessionId: null,
        staffId: reservation.assignedStaffId,
        heldForReservationId: reservation.id,
        windowSemantics: null,
        partySize: reservation.partySize,
        expiresAt,
        fingerprint: null,
      },
      select: { id: true, expiresAt: true, staffId: true },
    })
  })
}

/** Tenant/live preflight only. Exact authorization is repeated under row lock. */
export async function fastFailLiveHold(args: { venueId: string; holdId: string; checkedAt?: Date }): Promise<{ id: string }> {
  const hold = await prisma.slotHold.findFirst({
    where: { id: args.holdId, venueId: args.venueId },
    select: { id: true, expiresAt: true },
  })
  const checkedAt = args.checkedAt ?? new Date()
  if (!hold || hold.expiresAt.getTime() <= checkedAt.getTime()) throw invalidHold()
  return { id: hold.id }
}

export async function lockAndValidateNormalAppointmentHold(
  tx: Prisma.TransactionClient,
  args: {
    venueId: string
    holdId: string
    startsAt: Date
    rawEndsAt: Date
    finalEndsAt: Date
    productIds: string[]
    requestedStaffId?: string
    requestedStaffWasProvided: boolean
    windowSemantics?: 'base'
    clock?: () => Date
  },
): Promise<{ id: string; staffId: string | null; checkedAt: Date }> {
  const rows = await tx.$queryRaw<LockedNormalAppointmentHold[]>`
    SELECT id, "venueId", "startsAt", "endsAt", "productIds", "classSessionId",
           "staffId", "heldForReservationId", "windowSemantics", "expiresAt"
    FROM "SlotHold"
    WHERE id = ${args.holdId} AND "venueId" = ${args.venueId}
    FOR UPDATE
  `
  const checkedAt = (args.clock ?? (() => new Date()))()
  const hold = rows[0]
  if (
    !hold ||
    hold.expiresAt.getTime() <= checkedAt.getTime() ||
    hold.classSessionId !== null ||
    hold.heldForReservationId !== null ||
    hold.windowSemantics !== (args.windowSemantics ?? null) ||
    !sameOrderedStrings(hold.productIds, args.productIds) ||
    !sameDate(hold.startsAt, args.startsAt)
  ) {
    throw invalidHold()
  }

  const expectedEndsAt = args.windowSemantics === 'base' ? args.finalEndsAt : args.rawEndsAt
  if (!sameDate(hold.endsAt, expectedEndsAt)) {
    if (args.windowSemantics === 'base') throw appointmentWindowChanged()
    throw invalidHold()
  }
  if (args.requestedStaffWasProvided && args.requestedStaffId !== hold.staffId) throw invalidHold()

  return { id: hold.id, staffId: hold.staffId, checkedAt }
}

export async function lockAndValidateRescheduleAppointmentHold(
  tx: Prisma.TransactionClient,
  args: {
    venueId: string
    holdId: string
    reservation: LockedRescheduleReservation
    requestedStartsAt: Date
    settings: ReservationConfig
    clock?: () => Date
  },
): Promise<{
  id: string
  checkedAt: Date
  endsAt: Date
  productIds: string[]
  staffId: string | null
}> {
  const rows = await tx.$queryRaw<LockedRescheduleAppointmentHold[]>`
    SELECT id, "venueId", "startsAt", "endsAt", "productIds", "classSessionId",
           "staffId", "heldForReservationId", "windowSemantics", "partySize", "expiresAt"
    FROM "SlotHold"
    WHERE id = ${args.holdId} AND "venueId" = ${args.venueId}
    FOR UPDATE
  `
  const checkedAt = (args.clock ?? (() => new Date()))()
  const hold = rows[0]
  let productIds: string[]
  let endsAt: Date
  try {
    assertReschedulePolicy(args.reservation, args.settings, checkedAt)
    productIds = reservationBookedProductIds(args.reservation)
    endsAt = fixedReservationEndsAt(args.reservation, args.requestedStartsAt)
  } catch {
    throw invalidHold()
  }

  if (
    !hold ||
    !validDate(args.requestedStartsAt) ||
    hold.expiresAt.getTime() <= checkedAt.getTime() ||
    args.reservation.classSessionId !== null ||
    hold.classSessionId !== null ||
    hold.windowSemantics !== null ||
    !sameDate(hold.startsAt, args.requestedStartsAt) ||
    !sameDate(hold.endsAt, endsAt) ||
    hold.partySize !== args.reservation.partySize
  ) {
    throw invalidHold()
  }

  const taggedIdentity =
    hold.heldForReservationId === args.reservation.id &&
    sameOrderedStrings(hold.productIds, productIds) &&
    hold.staffId === args.reservation.assignedStaffId
  if (!taggedIdentity) throw invalidHold()

  return {
    id: hold.id,
    checkedAt,
    endsAt,
    productIds,
    staffId: args.reservation.assignedStaffId,
  }
}
