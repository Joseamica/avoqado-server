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
 *   • SERVICE — title includes the service name(s) only ("Reserva: Corte de
 *               cabello"). Description adds party size, duration, the full
 *               service list, extras WITH PRICE, and the estimated total —
 *               **product decision 2026-07-22: SERVICE now shows money.** It
 *               still hides WHO the guest is: no name, phone, or internal
 *               notes — that stays FULL-only.
 *   • FULL    — everything SERVICE has, plus guest identity: name, phone,
 *               special requests, internal notes. **Default per user
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
import { Prisma } from '@prisma/client'
import type { calendar_v3 } from 'googleapis'
import type { ResolvedService } from '@/services/reservation/reservation-services.resolver'

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
    modifiers: true
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
  /** Servicios YA resueltos, en orden de reserva. `productIds` es un String[]
   * escalar, así que Prisma no puede incluirlo — lo resuelve el caller con
   * `resolveServices()`. El builder se mantiene puro y sin acceso a DB. */
  services: ResolvedService[]
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

/** Un modificador ya elegido en la reserva. Campos denormalizados en
 * `ReservationModifier` (`price Decimal @db.Decimal(10,2)`, `quantity Int`),
 * así que no hace falta join con `Modifier`. */
export type EventModifier = { name: string | null; quantity: number; price: Prisma.Decimal }

/**
 * "3 h 10 min" — legible para el dueño de un salón mirando su celular.
 * Devuelve `null` en 0/null para que el caller OMITA la línea en vez de
 * imprimir "Duración: 0 min".
 */
export function formatDuration(minutes: number | null | undefined): string | null {
  if (!minutes || minutes <= 0) return null
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h === 0) return `${m} min`
  if (m === 0) return `${h} h`
  return `${h} h ${m} min`
}

/**
 * Pesos mexicanos en UNIDADES MAYORES, 1:1 — nunca centavos
 * (`.claude/rules/critical-warnings.md`). Devuelve `null` en 0/null para que el
 * caller omita la línea.
 */
export function formatMoney(amount: number | null | undefined): string | null {
  if (!amount || amount <= 0) return null
  return `$${amount.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

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

/** Teléfono para el evento FULL: prefiere el del customer vinculado y cae al
 * `guestPhone` de una reserva sin cuenta (walk-in / teléfono / WhatsApp).
 * Simétrico a resolveGuestName — antes solo leía customer.phone, así que las
 * reservas de guest mostraban el nombre pero nunca el teléfono. Devuelve null
 * para omitir la línea. Solo se invoca dentro del gate FULL: el teléfono del
 * guest es tan sensible como el del customer y nunca aparece en SERVICE/MINIMAL. */
function resolveGuestPhone(reservation: ReservationWithRelations): string | null {
  const phone = reservation.customer?.phone ?? reservation.guestPhone
  return phone && phone.trim().length > 0 ? phone.trim() : null
}

function resolveServiceName(product: ReservationWithRelations['product'] | ClassSessionWithRelations['product']): string {
  if (product && typeof product.name === 'string' && product.name.trim().length > 0) {
    return product.name.trim()
  }
  return SERVICE_FALLBACK
}

/** Nombre + duración + precio de un servicio, ya emparejados — evita el bug de
 * desalineación de arreglos paralelos (nombre filtrado, duración/precio no). */
export type NamedService = { name: string; duration: number | null; price: Prisma.Decimal | null }

/** Servicios en orden de reserva, nombre, duración y precio SIEMPRE emparejados.
 * Cae al `product` líder (duración `null`, precio `null`, ya que esa fila legacy no trae
 * duración ni precio por servicio) en filas legacy, y al genérico si no queda ningún
 * nombre usable — incluyendo el caso en que `services` no está vacío pero
 * TODOS sus nombres quedan en blanco tras el trim (antes eso colapsaba el
 * título a "Reserva:  — Hilda" y dejaba "Servicios:" vacío). */
function resolveNamedServices(reservation: ReservationWithRelations, services: ResolvedService[]): NamedService[] {
  const named = services.map(s => ({ name: s.name.trim(), duration: s.duration, price: s.price ?? null })).filter(s => s.name.length > 0)
  if (named.length > 0) return named
  return [{ name: resolveServiceName(reservation.product), duration: null, price: null }]
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
  const { reservation, services, detailLevel, dashboardUrl } = args
  const namedServices = resolveNamedServices(reservation, services)
  const guestName = resolveGuestName(reservation)
  const reservationUrl = buildReservationUrl(dashboardUrl, reservation.venue.slug, reservation.id)

  // D3 del spec: TODOS los servicios en el título. Google lo trunca en vista de
  // mes, y el founder eligió esto con ese tradeoff a la vista. Decisión cerrada.
  const serviceTitle = namedServices.map(s => s.name).join(' + ')

  let summary: string
  switch (detailLevel) {
    case 'MINIMAL':
      summary = 'Reserva Avoqado'
      break
    case 'SERVICE':
      summary = `Reserva: ${serviceTitle}`
      break
    case 'FULL':
    default:
      summary = `Reserva: ${serviceTitle} — ${guestName}`
      break
  }

  const description = buildReservationDescription({ reservation, services, detailLevel, reservationUrl, guestName })

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
  services: ResolvedService[]
  detailLevel: EventDetailLevel
  reservationUrl: string
  guestName: string
}

function buildReservationDescription(args: ReservationDescriptionArgs): string {
  const { reservation, services, detailLevel, reservationUrl, guestName } = args

  // MINIMAL contract: zero PII, zero branding. Only the dashboard URL — staff
  // with dashboard access can click through; anyone else seeing the calendar
  // (e.g., on a shared-with-public calendar) sees nothing identifiable.
  // The Calendly-style "manage in Avoqado" prompt belongs to SERVICE/FULL,
  // where some surface text is already present.
  if (detailLevel === 'MINIMAL') {
    return reservationUrl
  }

  const isFull = detailLevel === 'FULL'
  // `modifiers` está tipado vía ReservationWithRelations (include modifiers:true) —
  // SIN `?? []` a propósito. Si un caller deja de incluir `modifiers` en su query
  // de Prisma, queremos que el tipo falle en compilación. El arreglo correcto es
  // añadir `modifiers: true` al `include` de Prisma en el llamador. NO ensanchar el
  // cast con `as unknown as` — eso es lo que el compilador sugiere para TS2352 y
  // es precisamente lo que DESACTIVA el candado de tipo, dejando `modifiers` como
  // `undefined` en runtime y reventando dentro de un cron de producción.
  const modifiers = reservation.modifiers as EventModifier[]
  const namedServices = resolveNamedServices(reservation, services)
  const lines: string[] = []

  if (isFull) {
    lines.push(`Cliente: ${guestName}`)
    const phone = resolveGuestPhone(reservation)
    if (phone) {
      lines.push(`Teléfono: ${phone}`)
    }
  }
  lines.push(`Personas: ${reservation.partySize}`)

  // Duración: reservation.duration es la fuente AUTORITATIVA — ya incluye el
  // tiempo de los modificadores (spec §4.4). No recalcular sumando servicios.
  const duration = formatDuration(reservation.duration)
  if (duration) {
    lines.push(`Duración: ${duration}`)
  }

  lines.push('')
  lines.push('Servicios:')
  for (const svc of namedServices) {
    const suffix = svc.duration && svc.duration > 0 ? ` (${svc.duration} min)` : ''
    lines.push(`• ${svc.name}${suffix}`)
  }

  if (modifiers.length > 0) {
    lines.push('')
    lines.push('Extras:')
    for (const m of modifiers) {
      const label = m.name?.trim() || 'Extra'
      const qty = m.quantity ?? 1
      // Precio visible en SERVICE y FULL (cambio de producto 2026-07-22): SERVICE
      // ahora muestra dinero, pero sigue ocultando quién es la clienta. La
      // conversión a number ocurre aquí mismo, justo antes de formatMoney (nunca
      // antes, para no arrastrar redondeo de punto flotante por la lógica).
      const price = formatMoney(new Prisma.Decimal(m.price).times(qty).toNumber())
      lines.push(price ? `• ${label} ×${qty}  +${price}` : `• ${label} ×${qty}`)
    }
  }

  // Total estimado visible en SERVICE y FULL — mismo cambio de producto. Solo el
  // gate de identidad (Cliente/Teléfono/notas) se queda exclusivo a FULL.
  // Usar `namedServices` para que el total sea consistente con lo que se imprime
  // (servicios con nombre vacío están filtrados de namedServices y NO deben sumar).
  const servicesTotal = namedServices.reduce((sum, s) => (s.price != null ? sum.plus(s.price) : sum), new Prisma.Decimal(0))
  const totalWithModifiers = modifiers.reduce((sum, m) => sum.plus(new Prisma.Decimal(m.price).times(m.quantity ?? 1)), servicesTotal)
  const total = formatMoney(totalWithModifiers.toNumber())
  if (total) {
    lines.push('')
    lines.push(`Total estimado: ${total}`)
  }

  if (isFull) {
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
