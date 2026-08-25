import type { Prisma, PrismaClient } from '@prisma/client'
import { BadRequestError, ConflictError } from '@/errors/AppError'
import type { ReservationConfig } from '@/services/dashboard/reservationSettings.service'
import { isStaffAware } from '@/services/reservation/reservationStaffMode'
import {
  resolveModifierSelections,
  type ModifierSelectionInput,
  type ResolvedModifierRow,
} from '@/services/reservation/resolveModifierSelections'

const MAX_BOOKED_PRODUCTS = 20
const MAX_FINAL_DURATION_MIN = 1_440
const BASE_WINDOW_TOLERANCE_MS = 60_000
/** Tope del buffer post-servicio. Cuatro horas ya es un turno completo. */
const MAX_BUFFER_AFTER_MIN = 240

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
  modifierRows: ResolvedModifierRow[]
  modifierPriceDelta: Prisma.Decimal
  /** Buffer post-servicio aplicado (0 = sin buffer). */
  bufferAfterMin: number
  /**
   * Fin del BLOQUE DE AGENDA = `finalEndsAt` + `bufferAfterMin`.
   *
   * Es lo que persiste `Reservation.blockedEndsAt` y lo único que deben
   * consultar disponibilidad y detección de solapamientos. `finalEndsAt` sigue
   * siendo la hora del CLIENTE: no las intercambies.
   */
  blockedEndsAt: Date
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

function inconsistentPersistedProducts(): ConflictError {
  return new ConflictError(
    'Los servicios guardados en la reservación ya no son consistentes. Selecciona el horario nuevamente.',
    'APPOINTMENT_WINDOW_CHANGED',
  )
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

  const productIds = stableDedupe(splitProductIds(reservation.productIds))
  if (productIds.length === 0 || productIds.length > MAX_BOOKED_PRODUCTS || reservation.productId !== productIds[0]) {
    throw inconsistentPersistedProducts()
  }
  return productIds
}

/**
 * Normaliza el buffer guardado en el catálogo a un entero usable.
 *
 * Fail-safe deliberado: un valor corrupto (negativo, fraccionario, absurdo)
 * degrada a 0 o al tope, NUNCA lanza. Un dato malo en un producto no puede
 * impedirle vender una cita a un salón — el mismo criterio que la impresión
 * offline, donde el "fail-safe" de no imprimir era peor que imprimir con datos
 * viejos.
 */
function sanitizeBufferAfterMin(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return 0
  return Math.min(value, MAX_BUFFER_AFTER_MIN)
}

/**
 * El buffer post-servicio que aplica a un conjunto de servicios, sin exigir que
 * la ventana completa se resuelva. Lo usan los caminos de escritura que ya
 * calcularon su `endsAt` por otra vía (dashboard legacy, reprogramaciones).
 *
 * Filtra por `APPOINTMENTS_SERVICE`, así que una reserva de CLASE devuelve 0
 * naturalmente: el buffer es un concepto de citas de servicio.
 */
export async function resolveBufferAfterMin(db: ReservationDbClient, args: { venueId: string; productIds: string[] }): Promise<number> {
  const productIds = stableDedupe(args.productIds.map(id => id.trim()).filter(Boolean))
  if (productIds.length === 0 || productIds.length > MAX_BOOKED_PRODUCTS) return 0

  const products = await db.product.findMany({
    where: { id: { in: productIds }, venueId: args.venueId, type: 'APPOINTMENTS_SERVICE' },
    select: { bufferAfterMin: true },
  })

  let bufferAfterMin = 0
  for (const product of products) {
    bufferAfterMin = Math.max(bufferAfterMin, sanitizeBufferAfterMin(product.bufferAfterMin))
  }
  return bufferAfterMin
}

/** `endsAt` + buffer. Único lugar donde se compone el fin de bloque. */
export function applyBufferToEndsAt(endsAt: Date, bufferAfterMin: number): Date {
  return bufferAfterMin > 0 ? new Date(endsAt.getTime() + bufferAfterMin * 60_000) : endsAt
}

export async function resolveCanonicalAppointmentDuration(
  db: ReservationDbClient,
  args: CanonicalAppointmentDurationArgs,
): Promise<{ productIds: string[]; canonicalBaseDurationMin: number; bufferAfterMin: number }> {
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
    select: { id: true, duration: true, durationMinutes: true, bufferAfterMin: true },
  })

  if (products.length !== productIds.length) {
    throw new BadRequestError('Uno o más servicios de cita no existen en este establecimiento')
  }

  const byId = new Map(products.map(product => [product.id, product]))
  let canonicalBaseDurationMin = 0
  let bufferAfterMin = 0
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
    // UN solo buffer al final de la cita, el MAYOR de los servicios incluidos.
    // Sumarlos inflaría una cita de tres servicios hasta volverla invendible, y
    // la limpieza real ocurre una vez, al terminar la sesión completa.
    bufferAfterMin = Math.max(bufferAfterMin, sanitizeBufferAfterMin(product.bufferAfterMin))
  }

  // El buffer viaja APARTE de la duración canónica a propósito: si entrara aquí,
  // el widget mostraría una hora de fin falsa y `APPOINTMENT_WINDOW_CHANGED`
  // rechazaría ventanas correctas.
  return { productIds, canonicalBaseDurationMin, bufferAfterMin }
}

/**
 * La duración base canónica SOLO si cada id es un servicio de cita válido.
 *
 * Devuelve `null` —en vez de tirar— cuando la lista está vacía, es demasiado
 * larga, o incluye algo que no es `APPOINTMENTS_SERVICE` (una mesa, un evento,
 * un producto de otro venue). Eso deja que la DISPONIBILIDAD la consulte en el
 * camino legacy sin romper los flujos que no son de citas, que sí pasan por
 * aquí con productos de otro tipo.
 *
 * Misma semántica de relleno que `resolveCanonicalAppointmentDuration`: un
 * servicio sin duración cuenta como `defaultDurationMin`, NUNCA como cero.
 */
export async function resolveAppointmentBaseDurationIfAllAppointments(
  db: ReservationDbClient,
  args: CanonicalAppointmentDurationArgs,
): Promise<number | null> {
  const productIds = stableDedupe(args.productIds.map(id => id.trim()).filter(Boolean))
  if (productIds.length === 0 || productIds.length > MAX_BOOKED_PRODUCTS) return null

  const products = await db.product.findMany({
    where: { id: { in: productIds }, venueId: args.venueId, type: 'APPOINTMENTS_SERVICE' },
    select: { id: true, duration: true, durationMinutes: true },
  })
  if (products.length !== productIds.length) return null

  const byId = new Map(products.map(product => [product.id, product]))
  let total = 0
  for (const productId of productIds) {
    const product = byId.get(productId)
    if (!product) return null
    const duration = product.duration ?? product.durationMinutes ?? args.settings.scheduling.defaultDurationMin
    if (!Number.isInteger(duration) || duration <= 0) return null
    total += duration
  }
  return total > MAX_FINAL_DURATION_MIN ? null : total
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

  // El buffer se aplica al FINAL, sobre la ventana ya ajustada por modificadores.
  const finalEndsAt = new Date(input.startsAt.getTime() + finalDurationMin * 60_000)

  return {
    startsAt: input.startsAt,
    baseEndsAt: expectedBaseEndsAt,
    finalEndsAt,
    canonicalBaseDurationMin: canonical.canonicalBaseDurationMin,
    modifierDurationDelta: modifiers.totalDurationDelta,
    finalDurationMin,
    productIds: canonical.productIds,
    modifierRows: modifiers.persistRows,
    modifierPriceDelta: modifiers.totalDelta,
    bufferAfterMin: canonical.bufferAfterMin,
    blockedEndsAt: new Date(finalEndsAt.getTime() + canonical.bufferAfterMin * 60_000),
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
