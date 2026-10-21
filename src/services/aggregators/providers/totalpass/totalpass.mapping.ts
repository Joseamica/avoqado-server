import crypto from 'crypto'
import { formatInTimeZone } from 'date-fns-tz'
import { CanonicalEvent, DenyReason, PassUser } from '../../core/types'

/**
 * Traducción pura entre Avoqado y TotalPass (sin red). Contrato: docs/aggregators/totalpass-api-contract.md.
 * Fechas en la hora LOCAL del venue: TotalPass sólo recibe `timezone: 'es-MX'` y horas «hh:mm AM/PM».
 */

export const toTotalPassTime = (d: Date, tz: string): string => formatInTimeZone(d, tz, 'hh:mm a').toUpperCase()
export const toTotalPassDate = (d: Date, tz: string): string => formatInTimeZone(d, tz, 'yyyy-MM-dd')
export const toTotalPassDateTime = (d: Date, tz: string): string => `${toTotalPassDate(d, tz)} ${toTotalPassTime(d, tz)}`

const REASONS: Record<DenyReason, string> = {
  CLASS_FULL: 'class_overbooked',
  CLASS_CANCELLED: 'canceled_event',
  NOT_ELIGIBLE: 'user_not_elegible', // sic: así lo escribe TotalPass
  ALREADY_IN_CLASS: 'user_already_in_class',
  OTHER: 'denied_by_gym',
}
export const mapDenyReason = (r: DenyReason): string => REASONS[r] ?? REASONS.OTHER

/** Anti-SSRF: la URL de validación del check-in viene en el webhook (que no viene firmado). */
export function isTotalPassValidationUrl(u: string): boolean {
  try {
    const url = new URL(u)
    return url.protocol === 'https:' && (url.hostname === 'totalpass.com' || url.hostname.endsWith('.totalpass.com'))
  } catch {
    return false
  }
}

/** Plazo de TotalPass para validar un check-in cuando el webhook no trae `expires_at`. */
export const CHECKIN_GRACE_MS = 90 * 60e3

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex')
const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v)
/** Texto no vacío (acepta números: los ids de TotalPass son strings, pero no se confía en el tipo). */
const text = (v: unknown): string | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  if (typeof v === 'string' && v.trim() !== '') return v
  return null
}
const date = (v: unknown): Date | null => {
  if (typeof v !== 'string' && typeof v !== 'number') return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}
const passUser = (u: unknown): PassUser => {
  const user = isObj(u) ? u : {}
  return { name: text(user.name) ?? 'Socio TotalPass', email: text(user.email), phone: text(user.phone) }
}
/** Respaldo determinista para cuerpos sin los campos que forman la llave: nunca colapsan en la misma. */
function bodyHash(body: unknown): string {
  try {
    return sha256(JSON.stringify(body) ?? String(body))
  } catch {
    return sha256(String(body))
  }
}

export function parseBookingWebhook(body: unknown): CanonicalEvent {
  if (!isObj(body)) return { kind: 'IGNORED', reason: 'cuerpo de reserva no es un objeto' }
  const slot = isObj(body.slot) ? body.slot : {}
  const slotId = text(slot.id)
  const status = typeof slot.status === 'string' ? slot.status : ''
  if (!slotId) return { kind: 'IGNORED', reason: 'falta slot.id' }
  const placeId = isObj(body.place) ? text(body.place.place) : null

  if (status.toLowerCase() === 'active') {
    const event = isObj(body.event) ? body.event : {}
    const occurrenceId = text(event.id)
    const userCode = isObj(body.user) ? text(body.user.code) : null
    if (!occurrenceId) return { kind: 'IGNORED', reason: 'falta event.id' }
    if (!userCode) return { kind: 'IGNORED', reason: 'falta user.code' }
    return {
      kind: 'BOOKING_REQUESTED',
      externalBookingId: slotId,
      externalOccurrenceId: occurrenceId,
      externalUserId: userCode,
      externalPlanCode: text(event.plan_code),
      placeId,
      user: passUser(body.user),
      seatRef: isObj(slot.seat) ? text(slot.seat.externalReference) : null,
    }
  }
  if (/cancel/i.test(status)) return { kind: 'BOOKING_CANCELLED', externalBookingId: slotId, late: /late/i.test(status), placeId }
  return { kind: 'IGNORED', reason: `slot.status=${status || '(vacío)'}` }
}

export function parseCheckinWebhook(body: unknown): CanonicalEvent {
  if (!isObj(body)) return { kind: 'IGNORED', reason: 'cuerpo de check-in no es un objeto' }
  if (body.type !== 'CHECK_IN_CREATED') return { kind: 'IGNORED', reason: `type=${String(body.type ?? '(vacío)')}` }
  const endpoint = text(body.endpoint)
  if (!endpoint) return { kind: 'IGNORED', reason: 'falta endpoint' }
  if (!isTotalPassValidationUrl(endpoint)) return { kind: 'IGNORED', reason: 'endpoint de validación fuera de totalpass.com' }
  const checkIn = isObj(body.check_in) ? body.check_in : {}
  const startedAt = date(checkIn.started_at)
  if (!startedAt) return { kind: 'IGNORED', reason: 'check_in.started_at ausente o inválido' }
  const userCode = isObj(body.user) ? text(body.user.code) : null
  if (!userCode) return { kind: 'IGNORED', reason: 'falta user.code' }
  return {
    kind: 'CHECKIN_CREATED',
    externalCheckinId: sha256(endpoint),
    validationRef: endpoint,
    externalUserId: userCode,
    placeId: isObj(body.place) ? text(body.place.place) : null,
    startedAt,
    deadlineAt: date(checkIn.expires_at) ?? new Date(startedAt.getTime() + CHECKIN_GRACE_MS),
    user: passUser(body.user),
  }
}

/** Llave estable del webhook crudo. Nunca truena: sin los campos que la forman, cae al hash del cuerpo. */
export function totalPassDedupKey(kind: 'BOOKING' | 'CHECKIN', body: unknown): string {
  const b = isObj(body) ? body : {}
  if (kind === 'BOOKING') {
    const slot = isObj(b.slot) ? b.slot : {}
    const id = text(slot.id)
    return id ? `TOTALPASS:BOOKING:${id}:${typeof slot.status === 'string' ? slot.status : ''}` : `TOTALPASS:BOOKING:${bodyHash(body)}`
  }
  const endpoint = text(b.endpoint)
  return `TOTALPASS:CHECKIN:${endpoint ? sha256(endpoint) : bodyHash(body)}`
}
