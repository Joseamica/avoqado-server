import { Prisma } from '@prisma/client'
import { BadRequestError, ConflictError } from '@/errors/AppError'
import { lockAppointmentVenue, resolveStaffAssignment, shouldAutoAssign } from '@/services/dashboard/appointmentStaffAssignment.service'
import { countAppointmentOccupancy, effectiveAppointmentPacing } from '@/services/dashboard/reservationAvailability.service'
import { getReservationSettings, isStaffAware } from '@/services/dashboard/reservationSettings.service'
import { checkExternalBusyBlock } from '@/services/reservation/external-busy-block.service'
import {
  assertLegacyAppointmentDurationFloor,
  normalizeBookedProductIds,
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
