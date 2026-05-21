/**
 * Google Calendar event body builder (Phase 2 — push).
 *
 * Translates an Avoqado Reservation or ClassSession into a Google Calendar
 * `events.insert` / `events.patch` payload, respecting the venue's privacy
 * detail level setting.
 *
 * Detail levels (spec §13):
 *   • MINIMAL — opaque title "Reserva Avoqado"; description = dashboard URL
 *               only; no guest/service PII. Use for fully shared calendars.
 *   • SERVICE — title includes the service name only ("Reserva: Corte de
 *               cabello"). Description adds party size + dashboard URL.
 *   • FULL    — title includes service + guest name; description adds party
 *               size, internal notes, special requests. **Default per user
 *               lock-in (2026-05-16).**
 *
 * Identity contract: every event carries `extendedProperties.private`:
 *   • `avoqadoOrigin: 'avoqado'`              — pull engine uses this to skip
 *                                               our own pushed events.
 *   • `avoqadoReservationId` or `avoqadoClassSessionId` — push engine searches
 *                                               by this for idempotency.
 *   • `avoqadoVenueId`                        — diagnostic + cross-venue audit.
 *
 * Time fields: Reservation/ClassSession `startsAt`/`endsAt` are real UTC in
 * Prisma (verified in `.claude/rules/critical-warnings.md`). We emit
 * `dateTime` in ISO 8601 UTC. Google renders in the viewer's local timezone.
 */
import type { Prisma } from '@prisma/client'
import type { calendar_v3 } from 'googleapis'

export type EventDetailLevel = 'MINIMAL' | 'SERVICE' | 'FULL'

/**
 * Prisma payload shape required to build a reservation event body. Build the
 * include in the caller with the same fields and the resulting type satisfies
 * this constraint.
 */
export type ReservationWithRelations = Prisma.ReservationGetPayload<{
  include: {
    customer: true
    product: true
    venue: true
  }
}>

export type ClassSessionWithRelations = Prisma.ClassSessionGetPayload<{
  include: {
    product: true
    venue: true
    reservations: { include: { customer: true } }
  }
}>

export interface EventBodyForReservationArgs {
  reservation: ReservationWithRelations
  detailLevel: EventDetailLevel
  /** e.g. `https://dashboardv2.avoqado.io` (no trailing slash). */
  dashboardUrl: string
}

export interface EventBodyForClassSessionArgs {
  classSession: ClassSessionWithRelations
  detailLevel: EventDetailLevel
  dashboardUrl: string
  /** Mirrors `ReservationSettings.googleCalendarClassRosterInDescription`. */
  includeRosterInDescription: boolean
}

// ============================================================
// Helpers
// ============================================================

const SERVICE_FALLBACK = 'Servicio'
const GUEST_FALLBACK = 'Cliente'

/** Concatenate first + last name, falling back to the reservation guestName,
 * and ultimately to a generic "Cliente" label so the title never collapses
 * to "Reserva: Corte — " with a trailing dash. */
function resolveGuestName(reservation: ReservationWithRelations): string {
  const customer = reservation.customer
  if (customer) {
    const first = (customer.firstName ?? '').trim()
    const last = (customer.lastName ?? '').trim()
    const full = `${first} ${last}`.trim()
    if (full.length > 0) return full
    if (customer.email) return customer.email
    if (customer.phone) return customer.phone
  }
  if (reservation.guestName && reservation.guestName.trim().length > 0) {
    return reservation.guestName.trim()
  }
  return GUEST_FALLBACK
}

function resolveServiceName(product: ReservationWithRelations['product'] | ClassSessionWithRelations['product']): string {
  if (product && typeof product.name === 'string' && product.name.trim().length > 0) {
    return product.name.trim()
  }
  return SERVICE_FALLBACK
}

/** Defensive fallback: a venue without a slug shouldn't exist in production,
 * but if it does we still want a non-broken URL. */
function buildReservationUrl(dashboardUrl: string, venueSlug: string | null | undefined, reservationId: string): string {
  const base = dashboardUrl.replace(/\/+$/, '')
  const slug = venueSlug ?? 'unknown'
  return `${base}/venues/${slug}/reservations/${reservationId}`
}

function buildClassSessionUrl(dashboardUrl: string, venueSlug: string | null | undefined, classSessionId: string): string {
  const base = dashboardUrl.replace(/\/+$/, '')
  const slug = venueSlug ?? 'unknown'
  return `${base}/venues/${slug}/classes/${classSessionId}`
}

/** Normalise an unknown / malformed value coming from the DB. `String` column
 * lets stale data slip through; safe-default to FULL per user lock-in. */
export function normalizeDetailLevel(raw: string | null | undefined): EventDetailLevel {
  if (raw === 'MINIMAL' || raw === 'SERVICE' || raw === 'FULL') return raw
  return 'FULL'
}

// ============================================================
// Reservation body
// ============================================================

export function buildEventBodyForReservation(args: EventBodyForReservationArgs): calendar_v3.Schema$Event {
  const { reservation, detailLevel, dashboardUrl } = args
  const serviceName = resolveServiceName(reservation.product)
  const guestName = resolveGuestName(reservation)
  const reservationUrl = buildReservationUrl(dashboardUrl, reservation.venue.slug, reservation.id)

  let summary: string
  switch (detailLevel) {
    case 'MINIMAL':
      summary = 'Reserva Avoqado'
      break
    case 'SERVICE':
      summary = `Reserva: ${serviceName}`
      break
    case 'FULL':
    default:
      summary = `Reserva: ${serviceName} — ${guestName}`
      break
  }

  const description = buildReservationDescription({ reservation, detailLevel, reservationUrl, guestName, serviceName })

  return {
    summary,
    description,
    location: buildVenueLocation(reservation.venue),
    start: { dateTime: reservation.startsAt.toISOString() },
    end: { dateTime: reservation.endsAt.toISOString() },
    transparency: 'opaque',
    // colorId '10' = Basil (green) in Google's palette. Matches Avoqado brand
    // and visually separates Avoqado-pushed events from unrelated calendar
    // entries when the owner glances at their week view.
    colorId: '10',
    // Override the calendar's default reminders so the venue owner gets a
    // reliable heads-up regardless of personal Google Calendar settings.
    // Two layers: a day-before email so they can plan the day, and a 30-min
    // popup so they're not caught off guard right before the reservation.
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'email', minutes: 1440 },
        { method: 'popup', minutes: 30 },
      ],
    },
    extendedProperties: {
      private: {
        avoqadoOrigin: 'avoqado',
        avoqadoReservationId: reservation.id,
        avoqadoVenueId: reservation.venueId,
      },
    },
  }
}

/**
 * Build a human-readable location string from venue address fields. Returns
 * `undefined` when the venue has no usable address — Google Calendar's
 * `location` field is optional and we'd rather omit it than emit something
 * useless like "undefined, undefined, MX".
 *
 * Output format: "{name} — {address}, {city}, {state}, {country}"
 * Falls back gracefully when intermediate fields are missing.
 */
function buildVenueLocation(venue: {
  name: string
  address: string | null
  city: string | null
  state: string | null
  country: string | null
}): string | undefined {
  const parts = [venue.address, venue.city, venue.state, venue.country].filter((p): p is string => !!p && p.trim().length > 0)
  if (parts.length === 0) return undefined
  return `${venue.name} — ${parts.join(', ')}`
}

interface ReservationDescriptionArgs {
  reservation: ReservationWithRelations
  detailLevel: EventDetailLevel
  reservationUrl: string
  guestName: string
  serviceName: string
}

function buildReservationDescription(args: ReservationDescriptionArgs): string {
  const { reservation, detailLevel, reservationUrl, guestName, serviceName } = args

  // MINIMAL contract: zero PII. Only the dashboard URL — staff with dashboard
  // access can click through; anyone else seeing the calendar sees nothing.
  if (detailLevel === 'MINIMAL') {
    const lines: string[] = []
    lines.push('Para gestionar esta reservación, abre Avoqado:')
    lines.push(reservationUrl)
    lines.push('')
    lines.push('— Powered by Avoqado')
    return lines.join('\n')
  }

  const lines: string[] = []

  if (detailLevel === 'FULL') {
    lines.push(`Cliente: ${guestName}`)
  }
  lines.push(`Servicio: ${serviceName}`)
  lines.push(`Personas: ${reservation.partySize}`)

  if (detailLevel === 'FULL') {
    if (reservation.specialRequests && reservation.specialRequests.trim().length > 0) {
      lines.push('')
      lines.push('Solicitudes especiales:')
      lines.push(reservation.specialRequests.trim())
    }
    if (reservation.internalNotes && reservation.internalNotes.trim().length > 0) {
      lines.push('')
      lines.push('Notas internas:')
      lines.push(reservation.internalNotes.trim())
    }
  }

  lines.push('')
  lines.push('¿Necesitas gestionar esta reservación?')
  lines.push('Ver detalles, editar o cancelar en Avoqado:')
  lines.push(reservationUrl)
  lines.push('')
  lines.push('— Powered by Avoqado')

  return lines.join('\n')
}

// ============================================================
// ClassSession body
// ============================================================

export function buildEventBodyForClassSession(args: EventBodyForClassSessionArgs): calendar_v3.Schema$Event {
  const { classSession, detailLevel, dashboardUrl, includeRosterInDescription } = args
  const className = resolveServiceName(classSession.product)
  const classUrl = buildClassSessionUrl(dashboardUrl, classSession.venue.slug, classSession.id)

  let summary: string
  switch (detailLevel) {
    case 'MINIMAL':
      summary = 'Clase Avoqado'
      break
    case 'SERVICE':
      summary = `Clase: ${className}`
      break
    case 'FULL':
    default:
      summary = `Clase: ${className}`
      break
  }

  const description = buildClassSessionDescription({
    classSession,
    detailLevel,
    classUrl,
    className,
    includeRosterInDescription,
  })

  return {
    summary,
    description,
    location: buildVenueLocation(classSession.venue),
    start: { dateTime: classSession.startsAt.toISOString() },
    end: { dateTime: classSession.endsAt.toISOString() },
    transparency: 'opaque',
    colorId: '10',
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'email', minutes: 1440 },
        { method: 'popup', minutes: 30 },
      ],
    },
    extendedProperties: {
      private: {
        avoqadoOrigin: 'avoqado',
        avoqadoClassSessionId: classSession.id,
        avoqadoVenueId: classSession.venueId,
      },
    },
  }
}

interface ClassSessionDescriptionArgs {
  classSession: ClassSessionWithRelations
  detailLevel: EventDetailLevel
  classUrl: string
  className: string
  includeRosterInDescription: boolean
}

function buildClassSessionDescription(args: ClassSessionDescriptionArgs): string {
  const { classSession, detailLevel, classUrl, className, includeRosterInDescription } = args

  if (detailLevel === 'MINIMAL') {
    return classUrl
  }

  // Active reservations only — cancelled bookings shouldn't pollute the roster
  // count or the attendee list.
  const activeReservations = (classSession.reservations ?? []).filter(r => r.status !== 'CANCELLED' && r.cancelledAt === null)
  const attendeeCount = activeReservations.reduce((sum, r) => sum + (r.partySize ?? 1), 0)

  const lines: string[] = []
  lines.push(`Clase: ${className}`)
  lines.push(`Cupo: ${attendeeCount}/${classSession.capacity}`)

  if (includeRosterInDescription) {
    if (detailLevel === 'FULL' && activeReservations.length > 0) {
      lines.push('')
      lines.push('Asistentes:')
      for (const r of activeReservations) {
        const name = resolveGuestName(r as ReservationWithRelations)
        const size = r.partySize ?? 1
        lines.push(size > 1 ? `• ${name} (${size})` : `• ${name}`)
      }
    } else if (detailLevel === 'SERVICE') {
      // SERVICE keeps the count visible but never names. Already shown via
      // "Cupo: N/M" above — no extra line needed.
    }
  }

  lines.push('')
  lines.push(classUrl)

  return lines.join('\n')
}
