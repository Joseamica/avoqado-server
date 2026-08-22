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
import prisma from '@/utils/prismaClient'
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

/** Para esparcir en la respuesta: `{ bookingAccess }` si se pudo calcular, `{}` si no (campo omitido). */
export function withBookingAccess(access: BookingAccess | null): { bookingAccess?: BookingAccess } {
  return access ? { bookingAccess: access } : {}
}

/**
 * Compuesta: consulta plan + settings del venue. BEST-EFFORT, nunca lanza:
 *
 * - Si la consulta de plan truena → FAIL-OPEN (hasPlan=true), igual que el gate de rutas;
 *   el POST sigue siendo la autoridad.
 * - Si cualquier otra cosa truena → `null` (el controller omite el campo). Auditoría 4:
 *   este cálculo corre DESPUÉS de que login/register/OTP ya emitieron token, crearon la
 *   cuenta o consumieron el código; un 500 aquí convertía una operación exitosa en error
 *   ("ya existe" al reintentar, pedir otro código). Un dato informativo jamás invalida
 *   al emisor.
 */
export async function computeBookingAccess(venueId: string, customerId?: string | null): Promise<BookingAccess | null> {
  try {
    const [hasPlan, settings, customer] = await Promise.all([
      venueHasFeatureAccess(venueId, 'RESERVATIONS').catch((err: unknown) => {
        logger.error('[bookingAccess] plan lookup failed — failing open', { venueId, err: (err as Error)?.message })
        return true
      }),
      getReservationSettings(venueId),
      // Fase 1: el estado real del cliente. Sin customerId (respuesta anónima) o con el switch
      // apagado, sigue siendo APPROVED — el eje de aprobación simplemente no aplica.
      customerId
        ? prisma.customer.findFirst({ where: { id: customerId, venueId }, select: { approvalStatus: true } })
        : Promise.resolve(null),
    ])

    const requiresApproval =
      (settings as { publicBooking?: { requireCustomerApproval?: boolean } })?.publicBooking?.requireCustomerApproval === true

    return resolveBookingAccess({
      hasPlan,
      // Mismo default que el controller de reservas: sólo `false` explícito apaga.
      publicBookingEnabled: (settings as { publicBooking?: { enabled?: boolean } })?.publicBooking?.enabled !== false,
      approvalStatus: requiresApproval ? ((customer?.approvalStatus as BookingApprovalStatus) ?? 'APPROVED') : 'APPROVED',
    })
  } catch (err) {
    logger.error('[bookingAccess] could not be computed — omitted from the response', { venueId, err: (err as Error)?.message })
    return null
  }
}
