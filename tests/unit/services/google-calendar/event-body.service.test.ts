/**
 * event-body.service unit tests (Phase 2 — push).
 *
 * Covers:
 *   • Title shape per detail level (MINIMAL / SERVICE / FULL)
 *   • Description privacy contract:
 *       - MINIMAL: zero PII, dashboard URL only
 *       - SERVICE: service + party size + URL (no guest name) — money IS shown
 *         (extras price + total estimado; product decision 2026-07-22)
 *       - FULL:    everything SERVICE has + guest identity (name, phone, notes)
 *   • Customer name resolution fallbacks (customer → guestName → "Cliente")
 *   • extendedProperties.private always carries avoqadoOrigin + ids
 *   • ClassSession body uses class name + roster (when enabled)
 *   • Unknown detailLevel defaults to FULL behavior
 *   • REGRESSION: same reservation in MINIMAL has zero PII
 *   • Multi-servicio: nombre y duración emparejados (no arreglos paralelos
 *     desalineados), fallback cuando todos los nombres quedan en blanco
 */
import {
  buildEventBodyForClassSession,
  buildEventBodyForReservation,
  normalizeDetailLevel,
  formatDuration,
  formatMoney,
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
    // `modifiers` es requerido por ReservationWithRelations (include modifiers:true,
    // sin `?? []` en el service) — un fixture sin esta clave hace explotar el tipo,
    // a propósito: así detectamos si algún caller real deja de incluirlo.
    modifiers: [],
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
      services: [],
      detailLevel: 'MINIMAL',
      dashboardUrl: DASHBOARD,
    })
    expect(body.summary).toBe('Reserva Avoqado')
  })

  it('SERVICE → "Reserva: <product name>" (no guest)', () => {
    const body = buildEventBodyForReservation({
      reservation: makeReservation(),
      services: [],
      detailLevel: 'SERVICE',
      dashboardUrl: DASHBOARD,
    })
    expect(body.summary).toBe('Reserva: Corte de cabello')
    expect(body.summary).not.toContain('Juan')
  })

  it('FULL → "Reserva: <service> — <guest>"', () => {
    const body = buildEventBodyForReservation({
      reservation: makeReservation(),
      services: [],
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
      services: [],
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
      services: [],
      detailLevel: 'SERVICE',
      dashboardUrl: DASHBOARD,
    })
    expect(body.description).toContain('Servicios:')
    expect(body.description).toContain('• Corte de cabello')
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
      services: [],
      detailLevel: 'FULL',
      dashboardUrl: DASHBOARD,
    })
    expect(body.description).toContain('Cliente: Juan Pérez')
    expect(body.description).toContain('Servicios:')
    expect(body.description).toContain('• Corte de cabello')
    expect(body.description).toContain('Personas: 2')
    expect(body.description).toContain('Solicitudes especiales:')
    expect(body.description).toContain('sin sal')
    expect(body.description).toContain('Notas internas:')
    expect(body.description).toContain('asignar silla 4')
    expect(body.description).toContain(`${DASHBOARD}/venues/amaena/reservations/res-1`)
  })

  it('REGRESSION: la MISMA reserva en MINIMAL no filtra NADA de lo visible en FULL', () => {
    // Fixture multi-servicio COMPLETO: modificadores, teléfono, solicitudes
    // especiales y notas internas — el candado debe probar el payload más
    // rico que existe, no un fixture de un solo servicio sin dinero.
    const reservation = makeMultiServiceReservation({
      specialRequests: 'Alergia al acetona',
      internalNotes: 'Clienta frecuente, cobrar al final',
    })
    const args = { reservation, services: AMAENA_SERVICES, dashboardUrl: DASHBOARD }

    const full = buildEventBodyForReservation({ ...args, detailLevel: 'FULL' })
    const minimal = buildEventBodyForReservation({ ...args, detailLevel: 'MINIMAL' })

    // Lo que FULL sí muestra — si esto falla, el fixture dejó de ser representativo.
    expect(full.description).toContain('Hilda')
    expect(full.description).toContain('55-1234-5678')
    expect(full.description).toContain('Total estimado')
    expect(full.description).toContain('Alergia al acetona')
    expect(full.description).toContain('Extensión con polygel')

    // MINIMAL: NADA de lo anterior. Ni título ni descripción.
    // Este es EL candado de privacidad del diseño — la única defensa contra que
    // un cambio futuro mueva el `return` temprano de MINIMAL por debajo de las
    // secciones de servicios/dinero y filtre todo a un calendario público.
    const leaked = [
      'Hilda',
      '55-1234-5678',
      'Total estimado',
      '2,280',
      'Alergia al acetona',
      'Clienta frecuente',
      'Extensión con polygel',
      'Gel semipermanente',
    ]
    for (const secret of leaked) {
      expect(minimal.description).not.toContain(secret)
      expect(minimal.summary).not.toContain(secret)
    }

    expect(minimal.summary).toBe('Reserva Avoqado')
    expect(minimal.description).toBe(`${DASHBOARD}/venues/amaena/reservations/res-1`)
  })
})

// ============================================================
// Reservation — customer fallbacks
// ============================================================

describe('buildEventBodyForReservation — customer fallbacks', () => {
  it('FULL title falls back to guestName when customer is null', () => {
    const body = buildEventBodyForReservation({
      reservation: makeReservation({ customer: null, guestName: 'María López' }),
      services: [],
      detailLevel: 'FULL',
      dashboardUrl: DASHBOARD,
    })
    expect(body.summary).toBe('Reserva: Corte de cabello — María López')
  })

  it('FULL title falls back to "Cliente" when customer is null and guestName is null/empty', () => {
    const body = buildEventBodyForReservation({
      reservation: makeReservation({ customer: null, guestName: null }),
      services: [],
      detailLevel: 'FULL',
      dashboardUrl: DASHBOARD,
    })
    expect(body.summary).toBe('Reserva: Corte de cabello — Cliente')
  })

  // Regresión (hallazgo /full-testing 2026-07-22): una reserva de guest/walk-in
  // (sin customer vinculado) mostraba el NOMBRE via guestName pero NUNCA el
  // teléfono — el teléfono solo se leía de customer.phone. Los mocks no lo vieron
  // porque siempre poblaban customer.phone. Para un salón, las clientas que
  // reservan por teléfono/WhatsApp son guests; el dueño necesita ese teléfono.
  it('FULL muestra el teléfono del GUEST (guestPhone) cuando no hay customer', () => {
    const body = buildEventBodyForReservation({
      reservation: makeReservation({ customer: null, guestName: 'María López', guestPhone: '55-9999-8888' }),
      services: [],
      detailLevel: 'FULL',
      dashboardUrl: DASHBOARD,
    })
    expect(body.description).toContain('Cliente: María López')
    expect(body.description).toContain('Teléfono: 55-9999-8888')
  })

  it('FULL prefiere el teléfono del customer sobre el guestPhone cuando ambos existen', () => {
    const body = buildEventBodyForReservation({
      reservation: makeReservation({ guestPhone: '55-0000-0000' }), // customer base trae +5215555555555
      services: [],
      detailLevel: 'FULL',
      dashboardUrl: DASHBOARD,
    })
    expect(body.description).toContain('Teléfono: +5215555555555')
    expect(body.description).not.toContain('55-0000-0000')
  })

  // El guestPhone es tan sensible como customer.phone: debe seguir el MISMO gate
  // FULL. Este candado impide que el fix del teléfono del guest abra una fuga.
  it('SERVICE nunca muestra el teléfono del guest — sigue el gate de identidad', () => {
    const body = buildEventBodyForReservation({
      reservation: makeReservation({ customer: null, guestName: 'María López', guestPhone: '55-9999-8888' }),
      services: [],
      detailLevel: 'SERVICE',
      dashboardUrl: DASHBOARD,
    })
    expect(body.description).not.toContain('55-9999-8888')
    expect(body.description).not.toContain('Teléfono')
    expect(body.description).not.toContain('María López')
  })

  it('falls back to "Servicio" when product is null', () => {
    const body = buildEventBodyForReservation({
      reservation: makeReservation({ product: null }),
      services: [],
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
      services: [],
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
        services: [],
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
      services: [],
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
      services: [],
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

// ============================================================
// Formatting helpers
// ============================================================

describe('formatDuration', () => {
  it('menos de una hora → solo minutos', () => {
    expect(formatDuration(45)).toBe('45 min')
  })

  it('horas exactas → sin minutos colgando', () => {
    expect(formatDuration(120)).toBe('2 h')
  })

  it('horas y minutos', () => {
    expect(formatDuration(190)).toBe('3 h 10 min')
  })

  it('null / 0 → null para que el caller omita la línea', () => {
    expect(formatDuration(null)).toBeNull()
    expect(formatDuration(0)).toBeNull()
  })
})

describe('formatMoney', () => {
  it('formatea pesos mexicanos en unidades mayores (NUNCA centavos)', () => {
    expect(formatMoney(1900)).toBe('$1,900.00')
  })

  it('respeta los centavos', () => {
    expect(formatMoney(300.5)).toBe('$300.50')
  })

  it('null / 0 → null para que el caller omita la línea', () => {
    expect(formatMoney(null)).toBeNull()
    expect(formatMoney(0)).toBeNull()
  })
})

// ============================================================
// Multi-servicio (Task 4 — el corazón del fix de sobreagenda)
// ============================================================

// La cita real de Amaena (RES-PY45XU, 2026-07-20) que dispara este trabajo:
// 4 servicios + 1 modificador. `duration` (190) ya incluye el tiempo del
// modificador — ver spec §4.4, NO recalcular sumando servicios.
const AMAENA_SERVICES = [
  { id: 'p1', name: 'Extensión con polygel', price: 680, duration: 75 },
  { id: 'p2', name: 'Francés manos', price: 100, duration: 25 },
  { id: 'p3', name: 'Retiro de Geles Blandos con Extensión', price: 200, duration: 20 },
  { id: 'p4', name: 'Manicure + Pedicure Spa + Gel', price: 1000, duration: 70 },
] as any

const AMAENA_MODIFIERS = [{ name: 'Gel semipermanente', quantity: 1, price: 300 }] as any

function makeMultiServiceReservation(overrides: any = {}): any {
  return makeReservation({
    duration: 190,
    productIds: ['p1', 'p2', 'p3', 'p4'],
    modifiers: AMAENA_MODIFIERS,
    customer: { id: 'c1', firstName: 'Hilda', lastName: '', email: null, phone: '55-1234-5678' },
    ...overrides,
  })
}

describe('buildEventBodyForReservation — multi-servicio', () => {
  it('FULL lista los 4 servicios EN ORDEN DE RESERVA', () => {
    const body = buildEventBodyForReservation({
      reservation: makeMultiServiceReservation(),
      services: AMAENA_SERVICES,
      detailLevel: 'FULL',
      dashboardUrl: DASHBOARD,
    })

    expect(body.description).toContain('• Extensión con polygel (75 min)')
    expect(body.description).toContain('• Francés manos (25 min)')
    expect(body.description).toContain('• Retiro de Geles Blandos con Extensión (20 min)')
    expect(body.description).toContain('• Manicure + Pedicure Spa + Gel (70 min)')

    const d = body.description as string
    expect(d.indexOf('Extensión con polygel')).toBeLessThan(d.indexOf('Francés manos'))
  })

  it('FULL pone TODOS los servicios en el título (decisión D3 del spec)', () => {
    const body = buildEventBodyForReservation({
      reservation: makeMultiServiceReservation(),
      services: AMAENA_SERVICES,
      detailLevel: 'FULL',
      dashboardUrl: DASHBOARD,
    })

    expect(body.summary).toBe(
      'Reserva: Extensión con polygel + Francés manos + Retiro de Geles Blandos con Extensión + Manicure + Pedicure Spa + Gel — Hilda',
    )
  })

  it('FULL imprime extras con cantidad y precio', () => {
    const body = buildEventBodyForReservation({
      reservation: makeMultiServiceReservation(),
      services: AMAENA_SERVICES,
      detailLevel: 'FULL',
      dashboardUrl: DASHBOARD,
    })

    expect(body.description).toContain('Extras:')
    expect(body.description).toContain('• Gel semipermanente ×1  +$300.00')
  })

  it('FULL imprime la duración de reservation.duration, NO la suma de servicios', () => {
    const body = buildEventBodyForReservation({
      reservation: makeMultiServiceReservation(),
      services: AMAENA_SERVICES,
      detailLevel: 'FULL',
      dashboardUrl: DASHBOARD,
    })

    // 190 = 3 h 10 min. La suma de servicios daría 190 también, pero la fuente
    // autoritativa es reservation.duration porque YA incluye el modificador.
    expect(body.description).toContain('Duración: 3 h 10 min')
  })

  it('FULL imprime el total estimado = servicios + modificadores × cantidad', () => {
    const body = buildEventBodyForReservation({
      reservation: makeMultiServiceReservation(),
      services: AMAENA_SERVICES,
      detailLevel: 'FULL',
      dashboardUrl: DASHBOARD,
    })

    // 680 + 100 + 200 + 1000 + (300 × 1) = 2280
    expect(body.description).toContain('Total estimado: $2,280.00')
  })

  it('FULL imprime el teléfono del cliente', () => {
    const body = buildEventBodyForReservation({
      reservation: makeMultiServiceReservation(),
      services: AMAENA_SERVICES,
      detailLevel: 'FULL',
      dashboardUrl: DASHBOARD,
    })

    expect(body.description).toContain('Teléfono: 55-1234-5678')
  })

  // 🔴 D6 (founder 2026-07-22): SERVICE SÍ muestra dinero. Lo que oculta es la
  // IDENTIDAD de la clienta. Contrato: "qué se vendió y cuánto vale, no a quién".
  it('REGRESSION: SERVICE oculta la IDENTIDAD pero sí muestra servicios y dinero', () => {
    const reservation = makeMultiServiceReservation({
      specialRequests: 'Alergia al acetona',
      internalNotes: 'Cobrar al final',
    })
    const body = buildEventBodyForReservation({
      reservation,
      services: AMAENA_SERVICES,
      detailLevel: 'SERVICE',
      dashboardUrl: DASHBOARD,
    })

    // Identidad: NADA, ni en descripción ni en título.
    for (const secret of ['Hilda', '55-1234-5678', 'Cliente:', 'Teléfono:', 'Alergia al acetona', 'Cobrar al final']) {
      expect(body.description).not.toContain(secret)
      expect(body.summary).not.toContain(secret)
    }

    // Servicios, duración y dinero: SÍ (D6).
    expect(body.description).toContain('• Extensión con polygel (75 min)')
    expect(body.description).toContain('Duración: 3 h 10 min')
    expect(body.description).toContain('Extras:')
    expect(body.description).toContain('• Gel semipermanente ×1  +$300.00')
    expect(body.description).toContain('Total estimado: $2,280.00')
  })

  it('omite "(N min)" cuando el servicio no tiene duración — nunca imprime null', () => {
    const body = buildEventBodyForReservation({
      reservation: makeMultiServiceReservation(),
      services: [{ id: 'p1', name: 'Sin duración', price: 500, duration: null }] as any,
      detailLevel: 'FULL',
      dashboardUrl: DASHBOARD,
    })

    expect(body.description).toContain('• Sin duración')
    expect(body.description).not.toContain('null')
  })

  it('DEFECTO: nombre filtrado por blanco no desalinea las duraciones de los servicios siguientes', () => {
    // Reproducción exacta del reporte: [blanco(75min), 'Francés manos'(25min),
    // 'Pedicure Spa'(70min)]. El bug viejo indexaba `services[i]` original
    // contra el arreglo de nombres YA filtrado, así que imprimía
    // "Francés manos (75 min)" / "Pedicure Spa (25 min)" y perdía los 70 min.
    const body = buildEventBodyForReservation({
      reservation: makeMultiServiceReservation(),
      services: [
        { id: 'blank', name: '   ', price: 0, duration: 75 },
        { id: 'p2', name: 'Francés manos', price: 100, duration: 25 },
        { id: 'p3', name: 'Pedicure Spa', price: 200, duration: 70 },
      ] as any,
      detailLevel: 'FULL',
      dashboardUrl: DASHBOARD,
    })

    expect(body.description).toContain('• Francés manos (25 min)')
    expect(body.description).toContain('• Pedicure Spa (70 min)')
    expect(body.description).not.toContain('Francés manos (75 min)')
    expect(body.description).not.toContain('Pedicure Spa (25 min)')
  })

  it('DEFECTO: título y sección Servicios no colapsan cuando el único servicio tiene nombre en blanco', () => {
    const body = buildEventBodyForReservation({
      reservation: makeMultiServiceReservation(),
      services: [{ id: 'blank', name: '   ', price: 0, duration: 75 }] as any,
      detailLevel: 'FULL',
      dashboardUrl: DASHBOARD,
    })

    // Cae al product líder ("Corte de cabello" en el fixture base), NUNCA a un
    // título vacío tipo "Reserva:  — Hilda" con doble espacio y guión colgante.
    expect(body.summary).toBe('Reserva: Corte de cabello — Hilda')
    expect(body.description).toContain('Servicios:')
    expect(body.description).toContain('• Corte de cabello')
  })

  it('omite la sección Extras cuando no hay modificadores', () => {
    const body = buildEventBodyForReservation({
      reservation: makeMultiServiceReservation({ modifiers: [] }),
      services: AMAENA_SERVICES,
      detailLevel: 'FULL',
      dashboardUrl: DASHBOARD,
    })

    expect(body.description).not.toContain('Extras:')
  })

  it('un solo servicio usa la MISMA forma de lista (sin rama especial)', () => {
    const body = buildEventBodyForReservation({
      reservation: makeMultiServiceReservation({ productIds: ['p1'], modifiers: [] }),
      services: [AMAENA_SERVICES[0]],
      detailLevel: 'FULL',
      dashboardUrl: DASHBOARD,
    })

    expect(body.description).toContain('• Extensión con polygel (75 min)')
    expect(body.summary).toBe('Reserva: Extensión con polygel — Hilda')
  })

  it('omite la línea de teléfono cuando el cliente no tiene', () => {
    const body = buildEventBodyForReservation({
      reservation: makeMultiServiceReservation({
        customer: { id: 'c1', firstName: 'Hilda', lastName: '', email: null, phone: null },
      }),
      services: AMAENA_SERVICES,
      detailLevel: 'FULL',
      dashboardUrl: DASHBOARD,
    })

    expect(body.description).not.toContain('Teléfono:')
  })

  it('REGRESSION: un servicio con nombre en blanco NO suma al total impreso', () => {
    // Bug original: un servicio con nombre = "   " (espacios) se filtro de la
    // lista impresa pero su precio se sumaba igual en el total. Ahora el total
    // debe usar la misma lista filtrada.
    const body = buildEventBodyForReservation({
      reservation: makeMultiServiceReservation(),
      services: [
        { id: 'blank', name: '   ', price: 500, duration: 30 }, // $500, nombre vacío tras trim
        { id: 'p1', name: 'Extensión con polygel', price: 680, duration: 75 },
      ] as any,
      detailLevel: 'FULL',
      dashboardUrl: DASHBOARD,
    })

    // El bloque "Servicios:" debe omitir el nombre en blanco
    expect(body.description).toContain('• Extensión con polygel (75 min)')
    expect(body.description).not.toContain('• $') // no debe haber un bullet point de servicio vacío
    // El total debe incluir solo el servicio con nombre ($680 + $300 del modificador = $980)
    // NO $500 + $680 + $300 = $1480
    expect(body.description).toContain('Total estimado: $980.00')
    expect(body.description).not.toContain('$1,480')
    expect(body.description).not.toContain('$1480')
  })
})
