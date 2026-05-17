/**
 * event-body.service unit tests (Phase 2 — push).
 *
 * Covers:
 *   • Title shape per detail level (MINIMAL / SERVICE / FULL)
 *   • Description privacy contract:
 *       - MINIMAL: zero PII, dashboard URL only
 *       - SERVICE: service + party size + URL (no guest name)
 *       - FULL:    service + guest + party size + notes + URL
 *   • Customer name resolution fallbacks (customer → guestName → "Cliente")
 *   • extendedProperties.private always carries avoqadoOrigin + ids
 *   • ClassSession body uses class name + roster (when enabled)
 *   • Unknown detailLevel defaults to FULL behavior
 *   • REGRESSION: same reservation in MINIMAL has zero PII
 */
import {
  buildEventBodyForClassSession,
  buildEventBodyForReservation,
  normalizeDetailLevel,
} from '@/services/google-calendar/event-body.service'

// ============================================================
// Fixtures
// ============================================================

function makeReservation(overrides: any = {}): any {
  return {
    id: 'res-1',
    venueId: 'venue-1',
    startsAt: new Date('2026-05-20T18:00:00.000Z'),
    endsAt: new Date('2026-05-20T19:00:00.000Z'),
    partySize: 2,
    status: 'CONFIRMED',
    cancelledAt: null,
    guestName: null,
    specialRequests: null,
    internalNotes: null,
    customer: {
      id: 'cust-1',
      firstName: 'Juan',
      lastName: 'Pérez',
      email: 'juan@example.com',
      phone: '+5215555555555',
    },
    product: { id: 'prod-1', name: 'Corte de cabello' },
    venue: { id: 'venue-1', slug: 'amaena' },
    ...overrides,
  }
}

function makeClassSession(overrides: any = {}): any {
  return {
    id: 'class-1',
    venueId: 'venue-1',
    startsAt: new Date('2026-05-22T15:00:00.000Z'),
    endsAt: new Date('2026-05-22T16:00:00.000Z'),
    capacity: 10,
    status: 'SCHEDULED',
    product: { id: 'prod-yoga', name: 'Yoga Vinyasa' },
    venue: { id: 'venue-1', slug: 'amaena' },
    reservations: [
      {
        id: 'res-a',
        partySize: 1,
        status: 'CONFIRMED',
        cancelledAt: null,
        guestName: null,
        customer: { firstName: 'Ana', lastName: 'García', email: null, phone: null },
      },
      {
        id: 'res-b',
        partySize: 2,
        status: 'CONFIRMED',
        cancelledAt: null,
        guestName: null,
        customer: { firstName: 'Luis', lastName: 'Hernández', email: null, phone: null },
      },
    ],
    ...overrides,
  }
}

const DASHBOARD = 'https://dashboardv2.avoqado.io'

// ============================================================
// Reservation — title
// ============================================================

describe('buildEventBodyForReservation — title', () => {
  it('MINIMAL → "Reserva Avoqado" with no PII', () => {
    const body = buildEventBodyForReservation({
      reservation: makeReservation(),
      detailLevel: 'MINIMAL',
      dashboardUrl: DASHBOARD,
    })
    expect(body.summary).toBe('Reserva Avoqado')
  })

  it('SERVICE → "Reserva: <product name>" (no guest)', () => {
    const body = buildEventBodyForReservation({
      reservation: makeReservation(),
      detailLevel: 'SERVICE',
      dashboardUrl: DASHBOARD,
    })
    expect(body.summary).toBe('Reserva: Corte de cabello')
    expect(body.summary).not.toContain('Juan')
  })

  it('FULL → "Reserva: <service> — <guest>"', () => {
    const body = buildEventBodyForReservation({
      reservation: makeReservation(),
      detailLevel: 'FULL',
      dashboardUrl: DASHBOARD,
    })
    expect(body.summary).toBe('Reserva: Corte de cabello — Juan Pérez')
  })
})

// ============================================================
// Reservation — description privacy contract
// ============================================================

describe('buildEventBodyForReservation — description privacy contract', () => {
  it('MINIMAL description is ONLY the dashboard URL (no guest name, no service name, no party size)', () => {
    const body = buildEventBodyForReservation({
      reservation: makeReservation({
        specialRequests: 'Alergia a frutos secos',
        internalNotes: 'Cliente VIP',
      }),
      detailLevel: 'MINIMAL',
      dashboardUrl: DASHBOARD,
    })
    expect(body.description).toBe(`${DASHBOARD}/venues/amaena/reservations/res-1`)
    expect(body.description).not.toMatch(/Juan/)
    expect(body.description).not.toMatch(/Corte/)
    expect(body.description).not.toMatch(/Alergia/)
    expect(body.description).not.toMatch(/VIP/)
    expect(body.description).not.toMatch(/Personas/)
  })

  it('SERVICE description includes service + party size + URL, but NOT guest name and NOT notes', () => {
    const body = buildEventBodyForReservation({
      reservation: makeReservation({ specialRequests: 'sin sal', internalNotes: 'asignar silla 4' }),
      detailLevel: 'SERVICE',
      dashboardUrl: DASHBOARD,
    })
    expect(body.description).toContain('Servicio: Corte de cabello')
    expect(body.description).toContain('Personas: 2')
    expect(body.description).toContain(`${DASHBOARD}/venues/amaena/reservations/res-1`)
    expect(body.description).not.toMatch(/Juan/)
    expect(body.description).not.toMatch(/sin sal/)
    expect(body.description).not.toMatch(/silla 4/)
  })

  it('FULL description includes guest, service, party size, special requests, internal notes, URL', () => {
    const body = buildEventBodyForReservation({
      reservation: makeReservation({
        specialRequests: 'sin sal',
        internalNotes: 'asignar silla 4',
      }),
      detailLevel: 'FULL',
      dashboardUrl: DASHBOARD,
    })
    expect(body.description).toContain('Cliente: Juan Pérez')
    expect(body.description).toContain('Servicio: Corte de cabello')
    expect(body.description).toContain('Personas: 2')
    expect(body.description).toContain('Solicitudes especiales:')
    expect(body.description).toContain('sin sal')
    expect(body.description).toContain('Notas internas:')
    expect(body.description).toContain('asignar silla 4')
    expect(body.description).toContain(`${DASHBOARD}/venues/amaena/reservations/res-1`)
  })

  it('REGRESSION: same reservation rendered MINIMAL strips ALL PII visible in FULL', () => {
    const reservation = makeReservation({
      specialRequests: 'sin sal',
      internalNotes: 'asignar silla 4',
    })
    const fullBody = buildEventBodyForReservation({ reservation, detailLevel: 'FULL', dashboardUrl: DASHBOARD })
    const minimalBody = buildEventBodyForReservation({ reservation, detailLevel: 'MINIMAL', dashboardUrl: DASHBOARD })

    // FULL leaks PII (intentionally — user lock-in)
    expect(fullBody.summary).toMatch(/Juan/)
    // MINIMAL must NOT
    expect(minimalBody.summary).not.toMatch(/Juan/)
    expect(minimalBody.summary).not.toMatch(/Corte/)
    expect(minimalBody.description).not.toMatch(/Juan|Corte|sal|silla/)
  })
})

// ============================================================
// Reservation — customer fallbacks
// ============================================================

describe('buildEventBodyForReservation — customer fallbacks', () => {
  it('FULL title falls back to guestName when customer is null', () => {
    const body = buildEventBodyForReservation({
      reservation: makeReservation({ customer: null, guestName: 'María López' }),
      detailLevel: 'FULL',
      dashboardUrl: DASHBOARD,
    })
    expect(body.summary).toBe('Reserva: Corte de cabello — María López')
  })

  it('FULL title falls back to "Cliente" when customer is null and guestName is null/empty', () => {
    const body = buildEventBodyForReservation({
      reservation: makeReservation({ customer: null, guestName: null }),
      detailLevel: 'FULL',
      dashboardUrl: DASHBOARD,
    })
    expect(body.summary).toBe('Reserva: Corte de cabello — Cliente')
  })

  it('falls back to "Servicio" when product is null', () => {
    const body = buildEventBodyForReservation({
      reservation: makeReservation({ product: null }),
      detailLevel: 'SERVICE',
      dashboardUrl: DASHBOARD,
    })
    expect(body.summary).toBe('Reserva: Servicio')
  })

  it('falls back to customer.email then phone when name parts are empty', () => {
    const body = buildEventBodyForReservation({
      reservation: makeReservation({
        customer: { firstName: '', lastName: '', email: 'cust@test.com', phone: '+52555' },
      }),
      detailLevel: 'FULL',
      dashboardUrl: DASHBOARD,
    })
    expect(body.summary).toBe('Reserva: Corte de cabello — cust@test.com')
  })
})

// ============================================================
// Reservation — identity contract + times
// ============================================================

describe('buildEventBodyForReservation — identity + times', () => {
  it('always stamps extendedProperties.private with avoqadoOrigin + ids regardless of detail level', () => {
    for (const lvl of ['MINIMAL', 'SERVICE', 'FULL'] as const) {
      const body = buildEventBodyForReservation({
        reservation: makeReservation(),
        detailLevel: lvl,
        dashboardUrl: DASHBOARD,
      })
      expect(body.extendedProperties?.private?.avoqadoOrigin).toBe('avoqado')
      expect(body.extendedProperties?.private?.avoqadoReservationId).toBe('res-1')
      expect(body.extendedProperties?.private?.avoqadoVenueId).toBe('venue-1')
    }
  })

  it('uses ISO 8601 UTC for start/end and marks event as opaque', () => {
    const body = buildEventBodyForReservation({
      reservation: makeReservation(),
      detailLevel: 'FULL',
      dashboardUrl: DASHBOARD,
    })
    expect(body.start?.dateTime).toBe('2026-05-20T18:00:00.000Z')
    expect(body.end?.dateTime).toBe('2026-05-20T19:00:00.000Z')
    expect(body.transparency).toBe('opaque')
  })

  it('trims trailing slash on dashboardUrl when building the link', () => {
    const body = buildEventBodyForReservation({
      reservation: makeReservation(),
      detailLevel: 'FULL',
      dashboardUrl: 'https://dashboardv2.avoqado.io/',
    })
    expect(body.description).toContain('https://dashboardv2.avoqado.io/venues/amaena/reservations/res-1')
    expect(body.description).not.toContain('//venues')
  })
})

// ============================================================
// ClassSession body
// ============================================================

describe('buildEventBodyForClassSession', () => {
  it('FULL title uses class name (no roster) — "Clase: Yoga Vinyasa"', () => {
    const body = buildEventBodyForClassSession({
      classSession: makeClassSession(),
      detailLevel: 'FULL',
      dashboardUrl: DASHBOARD,
      includeRosterInDescription: true,
    })
    expect(body.summary).toBe('Clase: Yoga Vinyasa')
  })

  it('MINIMAL → "Clase Avoqado" + URL-only description (no roster, no names)', () => {
    const body = buildEventBodyForClassSession({
      classSession: makeClassSession(),
      detailLevel: 'MINIMAL',
      dashboardUrl: DASHBOARD,
      includeRosterInDescription: true,
    })
    expect(body.summary).toBe('Clase Avoqado')
    expect(body.description).toBe(`${DASHBOARD}/venues/amaena/classes/class-1`)
    expect(body.description).not.toMatch(/Ana|Luis|Yoga/)
  })

  it('FULL with roster enabled lists each active attendee with their party size', () => {
    const body = buildEventBodyForClassSession({
      classSession: makeClassSession(),
      detailLevel: 'FULL',
      dashboardUrl: DASHBOARD,
      includeRosterInDescription: true,
    })
    expect(body.description).toContain('Cupo: 3/10') // 1 + 2
    expect(body.description).toContain('Asistentes:')
    expect(body.description).toContain('• Ana García')
    expect(body.description).toContain('• Luis Hernández (2)')
  })

  it('FULL with roster DISABLED hides the attendee list but keeps the cupo line', () => {
    const body = buildEventBodyForClassSession({
      classSession: makeClassSession(),
      detailLevel: 'FULL',
      dashboardUrl: DASHBOARD,
      includeRosterInDescription: false,
    })
    expect(body.description).toContain('Cupo: 3/10')
    expect(body.description).not.toMatch(/Asistentes:/)
    expect(body.description).not.toMatch(/Ana/)
  })

  it('SERVICE never lists attendee names even when roster is enabled', () => {
    const body = buildEventBodyForClassSession({
      classSession: makeClassSession(),
      detailLevel: 'SERVICE',
      dashboardUrl: DASHBOARD,
      includeRosterInDescription: true,
    })
    expect(body.description).toContain('Cupo: 3/10')
    expect(body.description).not.toMatch(/Asistentes:/)
    expect(body.description).not.toMatch(/Ana|Luis/)
  })

  it('skips cancelled reservations from the roster count', () => {
    const cs = makeClassSession()
    cs.reservations.push({
      id: 'res-c',
      partySize: 3,
      status: 'CANCELLED',
      cancelledAt: new Date(),
      guestName: null,
      customer: { firstName: 'Pedro', lastName: 'Sánchez' },
    })
    const body = buildEventBodyForClassSession({
      classSession: cs,
      detailLevel: 'FULL',
      dashboardUrl: DASHBOARD,
      includeRosterInDescription: true,
    })
    // 1 + 2 (cancelled 3 excluded)
    expect(body.description).toContain('Cupo: 3/10')
    expect(body.description).not.toMatch(/Pedro/)
  })

  it('stamps extendedProperties.private with avoqadoClassSessionId (NOT avoqadoReservationId)', () => {
    const body = buildEventBodyForClassSession({
      classSession: makeClassSession(),
      detailLevel: 'FULL',
      dashboardUrl: DASHBOARD,
      includeRosterInDescription: true,
    })
    expect(body.extendedProperties?.private?.avoqadoOrigin).toBe('avoqado')
    expect(body.extendedProperties?.private?.avoqadoClassSessionId).toBe('class-1')
    expect(body.extendedProperties?.private?.avoqadoVenueId).toBe('venue-1')
    expect((body.extendedProperties?.private as any)?.avoqadoReservationId).toBeUndefined()
  })
})

// ============================================================
// normalizeDetailLevel
// ============================================================

describe('normalizeDetailLevel', () => {
  it('passes through valid values', () => {
    expect(normalizeDetailLevel('MINIMAL')).toBe('MINIMAL')
    expect(normalizeDetailLevel('SERVICE')).toBe('SERVICE')
    expect(normalizeDetailLevel('FULL')).toBe('FULL')
  })

  it('defaults unknown / null / undefined to FULL (user lock-in 2026-05-16)', () => {
    expect(normalizeDetailLevel(null)).toBe('FULL')
    expect(normalizeDetailLevel(undefined)).toBe('FULL')
    expect(normalizeDetailLevel('')).toBe('FULL')
    expect(normalizeDetailLevel('minimal')).toBe('FULL') // case-sensitive on purpose
    expect(normalizeDetailLevel('SOMETHING_ELSE')).toBe('FULL')
  })
})
