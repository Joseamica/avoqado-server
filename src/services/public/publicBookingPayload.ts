/**
 * Lista BLANCA de `reservationSettings.publicBooking` para respuestas **anónimas**.
 *
 * `GET /api/v1/public/venues/:slug/info` lo sirve el widget incrustado en el sitio de cualquier
 * negocio, sin token: lo que salga por ahí es público en internet para quien sepa el slug.
 *
 * El controlador hacía `publicBooking: settings.publicBooking`, o sea copiaba el objeto entero.
 * Con eso, CADA campo nuevo de la config quedaba publicado por el solo hecho de existir — sin que
 * nadie lo decidiera. Así se filtró `customerApprovalNotificationRoles` (qué roles del staff
 * reciben el aviso de aprobación) al agregarlo en Fase 1; verificado con una petición anónima
 * real el 2026-08-24.
 *
 * Se invierte el default: lo que no está aquí, NO sale. Ampliar la config deja de ser una
 * publicación accidental y pasa a ser una decisión explícita de una línea.
 */
export const PUBLIC_BOOKING_PUBLIC_KEYS = [
  'enabled',
  'requirePhone',
  'requireEmail',
  'requireAccount',
  /** El cliente necesita saber que el negocio aprueba a mano ANTES de llenar el formulario. */
  'requireCustomerApproval',
  'showStaffPicker',
] as const

export type PublicBookingPublicKey = (typeof PUBLIC_BOOKING_PUBLIC_KEYS)[number]

/**
 * Copia sólo las llaves permitidas. Se omiten las ausentes en vez de rellenarlas con `undefined`:
 * cada cliente ya tiene sus propios defaults, y un `undefined` explícito los pisaría.
 */
export function toPublicBookingPayload(
  publicBooking: Record<string, unknown> | null | undefined,
): Partial<Record<PublicBookingPublicKey, unknown>> {
  if (!publicBooking) return {}
  const out: Partial<Record<PublicBookingPublicKey, unknown>> = {}
  for (const key of PUBLIC_BOOKING_PUBLIC_KEYS) {
    if (key in publicBooking) out[key] = publicBooking[key]
  }
  return out
}
