/**
 * Fase 0.B — `bookingAccess`: "¿este cliente puede crear una reserva en este venue?"
 *
 * El widget y el kiosco pintan el estado al iniciar sesión (login, register, otp/verify,
 * portal) en vez de descubrirlo por un 403 al final del flujo. COMPONE tres cosas, en este
 * orden, y `blockedBy` es el PRIMERO que falla:
 *
 *   1. PLAN — el venue tiene RESERVATIONS (PRO). Misma fuente que el gate de rutas
 *      (`checkPublicVenueFeature('RESERVATIONS')`).
 *   2. PUBLIC_BOOKING_OFF — `reservationSettings.publicBooking.enabled`.
 *   3. APPROVAL — el cliente está aprobado. Fase 0: siempre APPROVED; Fase 1 lo llena
 *      desde el Customer (PENDING / REJECTED).
 *
 * No va en `getVenueInfo` (anónimo): es una respuesta sobre UN cliente autenticado.
 */
import logger from '@/config/logger'
import { venueHasFeatureAccess } from '@/services/access/basePlan.service'
import { getReservationSettings } from '@/services/dashboard/reservationSettings.service'

export type BookingApprovalStatus = 'APPROVED' | 'PENDING' | 'REJECTED'
export type BookingBlockedBy = 'PLAN' | 'PUBLIC_BOOKING_OFF' | 'APPROVAL'

export type BookingAccess = {
  status: BookingApprovalStatus
  canCreateReservation: boolean
  blockedBy?: BookingBlockedBy
}

/** Pura: compone los tres ejes en orden. Probada sola. */
export function resolveBookingAccess(input: {
  hasPlan: boolean
  publicBookingEnabled: boolean
  approvalStatus: BookingApprovalStatus
}): BookingAccess {
  const blockedBy: BookingBlockedBy | undefined = !input.hasPlan
    ? 'PLAN'
    : !input.publicBookingEnabled
      ? 'PUBLIC_BOOKING_OFF'
      : input.approvalStatus !== 'APPROVED'
        ? 'APPROVAL'
        : undefined

  return blockedBy
    ? { status: input.approvalStatus, canCreateReservation: false, blockedBy }
    : { status: input.approvalStatus, canCreateReservation: true }
}

/**
 * Compuesta: consulta plan + settings del venue. Si la consulta de plan truena, hace
 * FAIL-OPEN (hasPlan=true) igual que el gate de rutas — el cliente no se queda sin
 * reservar por un tropiezo de nuestra DB; el gate real decide en el POST.
 */
export async function computeBookingAccess(venueId: string): Promise<BookingAccess> {
  const [hasPlan, settings] = await Promise.all([
    venueHasFeatureAccess(venueId, 'RESERVATIONS').catch((err: unknown) => {
      logger.error('[bookingAccess] plan lookup failed — failing open', { venueId, err: (err as Error)?.message })
      return true
    }),
    getReservationSettings(venueId),
  ])

  return resolveBookingAccess({
    hasPlan,
    // Mismo default que el controller de reservas: sólo `false` explícito apaga.
    publicBookingEnabled: (settings as { publicBooking?: { enabled?: boolean } })?.publicBooking?.enabled !== false,
    approvalStatus: 'APPROVED', // Fase 0. Fase 1: desde el Customer.
  })
}
