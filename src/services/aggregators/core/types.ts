/**
 * Tipos canónicos del conector de pases (TotalPass, Wellhub).
 * El núcleo trabaja sólo con estos tipos; cada proveedor los traduce en su adaptador.
 */

export type Provider = 'TOTALPASS' | 'WELLHUB'
/** Nombre del proveedor en los textos que ve el estudio (el núcleo no los nombra; los toma de aquí). */
export const PROVIDER_LABEL: Record<Provider, string> = { TOTALPASS: 'TotalPass', WELLHUB: 'Wellhub' }
export type ConnectionCtx = {
  id: string
  venueId: string
  provider: Provider
  externalPlaceId: string | null
  credential: string | null
  config: Record<string, unknown>
}

export type CanonicalEvent =
  | {
      kind: 'BOOKING_REQUESTED'
      externalBookingId: string
      externalOccurrenceId: string
      externalUserId: string
      externalPlanCode: string | null
      placeId: string | null
      user: PassUser
      seatRef: string | null
    }
  | { kind: 'BOOKING_CANCELLED'; externalBookingId: string; late: boolean; placeId: string | null }
  | {
      kind: 'CHECKIN_CREATED'
      externalCheckinId: string
      validationRef: string
      externalUserId: string
      placeId: string | null
      startedAt: Date
      deadlineAt: Date
      user: PassUser
    }
  | { kind: 'IGNORED'; reason: string }
export type PassUser = { name: string; email: string | null; phone: string | null }

export type SessionPublication = {
  classSessionId: string
  title: string
  coachName: string
  durationMin: number
  startsAt: Date
  timezone: string
  spots: number
  externalPlanId: string
  bookingClosesAt: Date | null
  cancelUntil: Date | null
}
export type DenyReason = 'CLASS_FULL' | 'CLASS_CANCELLED' | 'NOT_ELIGIBLE' | 'ALREADY_IN_CLASS' | 'OTHER'
export type ActionResult = { ok: true; data?: Record<string, unknown> } | { ok: false; retryable: boolean; code: string; message: string }

export interface PassAdapter {
  provider: Provider
  /** Kinds de webhook que este proveedor manda (rutas /booking y /checkin). */
  parseWebhook(kind: 'BOOKING' | 'CHECKIN', body: unknown): CanonicalEvent
  /** Llave estable para dedupe del evento crudo. */
  dedupKey(kind: 'BOOKING' | 'CHECKIN', body: unknown): string
  publishSession(
    c: ConnectionCtx,
    p: SessionPublication,
    prev: { externalOccurrenceId: string | null; publishedStartsAt: Date | null },
  ): Promise<ActionResult & { externalOccurrenceId?: string }>
  updateSpots(c: ConnectionCtx, externalOccurrenceId: string, spots: number): Promise<ActionResult>
  /** Edita en la ocurrencia viva lo que el proveedor deja cambiar sin cancelar reservas (título, coach, duración, cierre
   *  de reservas). La hora no: eso es `publishSession` con la ocurrencia anterior. */
  updateSessionDetails(c: ConnectionCtx, externalOccurrenceId: string, p: SessionPublication): Promise<ActionResult>
  unpublishSession(c: ConnectionCtx, externalOccurrenceId: string): Promise<ActionResult>
  respondBooking(
    c: ConnectionCtx,
    externalBookingId: string,
    decision: { accept: true } | { accept: false; reason: DenyReason },
  ): Promise<ActionResult>
  /** El estudio canceló la reserva desde Avoqado: se da de baja en el proveedor (que le avisa al socio). Ya cancelada o
   *  inexistente allá cuenta como hecho. */
  cancelBooking(c: ConnectionCtx, externalBookingId: string): Promise<ActionResult>
  validateVisit(c: ConnectionCtx, validationRef: string): Promise<ActionResult & { alreadyValidated?: boolean; expired?: boolean }>
  /** Sólo autentica e identifica la sucursal de la llave, sin tocar nada allá (se llama ANTES de `setup`, para no
   *  quitarle los webhooks a otro negocio que ya tenga esa sucursal conectada). */
  identify(c: ConnectionCtx): Promise<ActionResult & { externalPlaceId?: string; externalPlaceName?: string }>
  /** Se llama al conectar: suscribir webhooks y activar confirmación de reservas. */
  setup(
    c: ConnectionCtx,
    urls: { booking: string; checkin: string },
  ): Promise<ActionResult & { externalPlaceId?: string; externalPlaceName?: string }>
}
