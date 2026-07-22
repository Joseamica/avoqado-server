import type { Prisma, PrismaClient } from '@prisma/client'
import { BadRequestError, ConflictError } from '@/errors/AppError'
import { isStaffAware, type ReservationConfig } from '@/services/dashboard/reservationSettings.service'
import { resolveModifierSelections, type ModifierSelectionInput } from '@/services/reservation/resolveModifierSelections'

const MAX_BOOKED_PRODUCTS = 20
const MAX_FINAL_DURATION_MIN = 1_440
const BASE_WINDOW_TOLERANCE_MS = 60_000

type ReservationDbClient = PrismaClient | Prisma.TransactionClient

export type WindowSemantics = 'base'

export interface NormalizedBookedProducts {
  productIds: string[]
  leadProductId: string | undefined
  productIdsWasProvided: boolean
}

export interface ResolvedAppointmentWindow {
  startsAt: Date
  baseEndsAt: Date
  finalEndsAt: Date
  canonicalBaseDurationMin: number
  modifierDurationDelta: number
  finalDurationMin: number
  productIds: string[]
}

export interface BookedProductInput {
  productId?: string
  productIds?: string | string[]
}

export interface CanonicalAppointmentDurationArgs {
  venueId: string
  productIds: string[]
  settings: ReservationConfig
}

export interface ResolveAppointmentWindowInput extends CanonicalAppointmentDurationArgs {
  startsAt: Date
  baseEndsAt: Date
  modifierSelections: ModifierSelectionInput[]
}

export interface LegacyAppointmentDurationFloorArgs extends CanonicalAppointmentDurationArgs {
  rawDurationMin: number
}

function splitProductIds(value: string | string[] | undefined): string[] {
  if (value === undefined) return []
  return (Array.isArray(value) ? value : [value])
    .flatMap(part => part.split(','))
    .map(part => part.trim())
    .filter(Boolean)
}

function stableDedupe(values: string[]): string[] {
  return [...new Set(values)]
}

function appointmentWindowChanged(expectedBaseDurationMin: number, startsAt?: Date): ConflictError {
  return new ConflictError('La duración del servicio cambió. Selecciona el horario nuevamente.', 'APPOINTMENT_WINDOW_CHANGED', {
    expectedBaseDurationMin,
    ...(startsAt && {
      expectedBaseEndsAt: new Date(startsAt.getTime() + expectedBaseDurationMin * 60_000).toISOString(),
    }),
  })
}

export function normalizeBookedProductIds(input: BookedProductInput): NormalizedBookedProducts {
  const productIdsWasProvided = input.productIds !== undefined
  const selected = productIdsWasProvided ? input.productIds : input.productId ? [input.productId] : []
  const productIds = stableDedupe(splitProductIds(selected))
  const normalizedScalarProductId = input.productId?.trim()

  if (input.productId !== undefined && productIdsWasProvided && normalizedScalarProductId !== productIds[0]) {
    throw new BadRequestError('productId debe coincidir con el primer elemento de productIds')
  }
  if (productIds.length > MAX_BOOKED_PRODUCTS) {
    throw new BadRequestError(`No se pueden reservar más de ${MAX_BOOKED_PRODUCTS} servicios a la vez`)
  }

  return {
    productIds,
    leadProductId: productIds[0],
    productIdsWasProvided,
  }
}

export function reservationBookedProductIds(reservation: { productId: string | null; productIds: string[] }): string[] {
  if (reservation.productIds.length === 0) {
    return reservation.productId ? [reservation.productId] : []
  }
  if (reservation.productId !== reservation.productIds[0]) {
    throw new ConflictError(
      'Los servicios guardados en la reservación ya no son consistentes. Selecciona el horario nuevamente.',
      'APPOINTMENT_WINDOW_CHANGED',
    )
  }
  return [...reservation.productIds]
}

export async function resolveCanonicalAppointmentDuration(
  db: ReservationDbClient,
  args: CanonicalAppointmentDurationArgs,
): Promise<{ productIds: string[]; canonicalBaseDurationMin: number }> {
  const productIds = stableDedupe(args.productIds.map(id => id.trim()).filter(Boolean))
  if (productIds.length === 0 || productIds.length > MAX_BOOKED_PRODUCTS) {
    throw new BadRequestError('Selecciona entre 1 y 20 servicios de cita válidos')
  }

  const products = await db.product.findMany({
    where: {
      id: { in: productIds },
      venueId: args.venueId,
      type: 'APPOINTMENTS_SERVICE',
    },
    select: { id: true, duration: true, durationMinutes: true },
  })

  if (products.length !== productIds.length) {
    throw new BadRequestError('Uno o más servicios de cita no existen en este establecimiento')
  }

  const byId = new Map(products.map(product => [product.id, product]))
  let canonicalBaseDurationMin = 0
  for (const productId of productIds) {
    const product = byId.get(productId)
    if (!product) {
      throw new BadRequestError('Uno o más servicios de cita no existen en este establecimiento')
    }
    const duration = product.duration ?? product.durationMinutes ?? args.settings.scheduling.defaultDurationMin
    if (!Number.isInteger(duration) || duration <= 0) {
      throw new BadRequestError('Uno o más servicios tienen una duración inválida')
    }
    canonicalBaseDurationMin += duration
  }

  return { productIds, canonicalBaseDurationMin }
}

export async function resolveAppointmentWindow(
  tx: ReservationDbClient,
  input: ResolveAppointmentWindowInput,
): Promise<ResolvedAppointmentWindow> {
  if (!Number.isFinite(input.startsAt.getTime()) || !Number.isFinite(input.baseEndsAt.getTime())) {
    throw new BadRequestError('La ventana de la cita es inválida')
  }

  const canonical = await resolveCanonicalAppointmentDuration(tx, input)
  if (canonical.canonicalBaseDurationMin > MAX_FINAL_DURATION_MIN) {
    throw new BadRequestError('La duración base de la cita no puede exceder 1440 minutos')
  }
  const expectedBaseEndsAt = new Date(input.startsAt.getTime() + canonical.canonicalBaseDurationMin * 60_000)
  if (Math.abs(input.baseEndsAt.getTime() - expectedBaseEndsAt.getTime()) > BASE_WINDOW_TOLERANCE_MS) {
    throw appointmentWindowChanged(canonical.canonicalBaseDurationMin, input.startsAt)
  }

  const modifiers = await resolveModifierSelections(tx, canonical.productIds, input.modifierSelections)
  const finalDurationMin = canonical.canonicalBaseDurationMin + modifiers.totalDurationDelta
  if (!Number.isInteger(finalDurationMin) || finalDurationMin <= 0 || finalDurationMin > MAX_FINAL_DURATION_MIN) {
    throw new BadRequestError('La duración final de la cita debe estar entre 1 y 1440 minutos')
  }

  return {
    startsAt: input.startsAt,
    baseEndsAt: expectedBaseEndsAt,
    finalEndsAt: new Date(input.startsAt.getTime() + finalDurationMin * 60_000),
    canonicalBaseDurationMin: canonical.canonicalBaseDurationMin,
    modifierDurationDelta: modifiers.totalDurationDelta,
    finalDurationMin,
    productIds: canonical.productIds,
  }
}

export async function assertLegacyAppointmentDurationFloor(
  db: ReservationDbClient,
  args: LegacyAppointmentDurationFloorArgs,
): Promise<void> {
  if (!isStaffAware(args.settings)) return

  const canonical = await resolveCanonicalAppointmentDuration(db, args)
  if (args.rawDurationMin < canonical.canonicalBaseDurationMin) {
    throw appointmentWindowChanged(canonical.canonicalBaseDurationMin)
  }
}
