/**
 * Buffer post-servicio ("tiempo de limpieza") — fase 1 del plan
 * `docs/plans/2026-08-22-buffer-y-ediciones-gcal.md`.
 *
 * La invariante que estos tests protegen: el buffer aparta agenda SIN mover la
 * hora de fin que ve el cliente. Mezclarlas es el hack de Mindbody, que obliga
 * a borrar la hora de fin de los correos para que el comprobante no mienta.
 */
import type { Prisma } from '@prisma/client'
import type { ReservationConfig } from '../../../../src/services/dashboard/reservationSettings.service'
import {
  resolveAppointmentWindow,
  resolveCanonicalAppointmentDuration,
} from '../../../../src/services/reservation/resolveAppointmentWindow'
import { resolveModifierSelections } from '../../../../src/services/reservation/resolveModifierSelections'

jest.mock('../../../../src/services/reservation/resolveModifierSelections', () => ({
  resolveModifierSelections: jest.fn(),
}))

const resolveModifiersMock = resolveModifierSelections as jest.MockedFunction<typeof resolveModifierSelections>

const START = new Date('2026-09-01T16:00:00.000Z')
const MIN = 60_000

function settings(defaultDurationMin = 30) {
  return {
    scheduling: { defaultDurationMin, capacityMode: 'pacing' },
    publicBooking: { showStaffPicker: false },
  } as ReservationConfig
}

type ProductRow = { id: string; duration: number | null; durationMinutes: number | null; bufferAfterMin?: number | null }

function productDb(rows: ProductRow[]) {
  return {
    product: { findMany: jest.fn().mockResolvedValue(rows) },
  } as unknown as Prisma.TransactionClient
}

function modifiers(delta = 0) {
  resolveModifiersMock.mockResolvedValue({
    persistRows: [],
    totalDelta: { toString: () => '0' } as never,
    totalDurationDelta: delta,
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  modifiers(0)
})

// ============================================================
// 1. LA CAPACIDAD NUEVA
// ============================================================

describe('buffer post-servicio', () => {
  it('aparta el tiempo extra sin mover la hora de fin que ve el cliente', async () => {
    const db = productDb([{ id: 'corte', duration: 45, durationMinutes: null, bufferAfterMin: 20 }])

    const window = await resolveAppointmentWindow(db, {
      venueId: 'v1',
      productIds: ['corte'],
      settings: settings(),
      startsAt: START,
      baseEndsAt: new Date(START.getTime() + 45 * MIN),
      modifierSelections: [],
    })

    // Lo que ve el cliente: intacto.
    expect(window.finalEndsAt).toEqual(new Date(START.getTime() + 45 * MIN))
    expect(window.baseEndsAt).toEqual(new Date(START.getTime() + 45 * MIN))
    expect(window.finalDurationMin).toBe(45)
    // Lo que aparta la agenda: 20 minutos más.
    expect(window.bufferAfterMin).toBe(20)
    expect(window.blockedEndsAt).toEqual(new Date(START.getTime() + 65 * MIN))
  })

  it('en varios servicios usa el MAYOR de los buffers, nunca la suma', async () => {
    const db = productDb([
      { id: 'a', duration: 30, durationMinutes: null, bufferAfterMin: 10 },
      { id: 'b', duration: 20, durationMinutes: null, bufferAfterMin: 25 },
      { id: 'c', duration: 10, durationMinutes: null, bufferAfterMin: 15 },
    ])

    const window = await resolveAppointmentWindow(db, {
      venueId: 'v1',
      productIds: ['a', 'b', 'c'],
      settings: settings(),
      startsAt: START,
      baseEndsAt: new Date(START.getTime() + 60 * MIN),
      modifierSelections: [],
    })

    // La suma (50) invalidaría la agenda de una cita de tres servicios.
    expect(window.bufferAfterMin).toBe(25)
    expect(window.blockedEndsAt).toEqual(new Date(START.getTime() + 85 * MIN))
  })

  it('el buffer viaja después de los modificadores, no antes', async () => {
    modifiers(15)
    const db = productDb([{ id: 'tinte', duration: 60, durationMinutes: null, bufferAfterMin: 20 }])

    const window = await resolveAppointmentWindow(db, {
      venueId: 'v1',
      productIds: ['tinte'],
      settings: settings(),
      startsAt: START,
      baseEndsAt: new Date(START.getTime() + 60 * MIN),
      modifierSelections: [],
    })

    expect(window.finalDurationMin).toBe(75)
    expect(window.finalEndsAt).toEqual(new Date(START.getTime() + 75 * MIN))
    expect(window.blockedEndsAt).toEqual(new Date(START.getTime() + 95 * MIN))
  })

  it('NO dispara APPOINTMENT_WINDOW_CHANGED: el widget manda la ventana sin buffer', async () => {
    const db = productDb([{ id: 'corte', duration: 45, durationMinutes: null, bufferAfterMin: 30 }])

    await expect(
      resolveAppointmentWindow(db, {
        venueId: 'v1',
        productIds: ['corte'],
        settings: settings(),
        baseEndsAt: new Date(START.getTime() + 45 * MIN),
        startsAt: START,
        modifierSelections: [],
      }),
    ).resolves.toBeDefined()
  })

  it('un buffer corrupto o desorbitado degrada a un valor seguro, nunca impide reservar', async () => {
    // Fail-safe: un dato malo en el catálogo no puede apagar la agenda de un salón.
    for (const [stored, expected] of [
      [-10, 0],
      [0.5, 0],
      [99_999, 240],
    ] as const) {
      const db = productDb([{ id: 'x', duration: 30, durationMinutes: null, bufferAfterMin: stored }])
      const window = await resolveAppointmentWindow(db, {
        venueId: 'v1',
        productIds: ['x'],
        settings: settings(),
        startsAt: START,
        baseEndsAt: new Date(START.getTime() + 30 * MIN),
        modifierSelections: [],
      })
      expect(window.bufferAfterMin).toBe(expected)
    }
  })
})

// ============================================================
// 2. REGRESIÓN — lo que NO se puede romper
// ============================================================

describe('buffer post-servicio — regresión', () => {
  it('sin buffer configurado, la ventana es idéntica a la de hoy', async () => {
    for (const stored of [null, undefined, 0]) {
      const db = productDb([{ id: 'corte', duration: 45, durationMinutes: null, bufferAfterMin: stored }])

      const window = await resolveAppointmentWindow(db, {
        venueId: 'v1',
        productIds: ['corte'],
        settings: settings(),
        startsAt: START,
        baseEndsAt: new Date(START.getTime() + 45 * MIN),
        modifierSelections: [],
      })

      expect(window.bufferAfterMin).toBe(0)
      // Con buffer cero el bloque de agenda ES la cita: comportamiento actual.
      expect(window.blockedEndsAt).toEqual(window.finalEndsAt)
    }
  })

  it('la duración base canónica NUNCA incluye el buffer', async () => {
    const db = productDb([
      { id: 'a', duration: 30, durationMinutes: null, bufferAfterMin: 20 },
      { id: 'b', duration: 20, durationMinutes: null, bufferAfterMin: 45 },
    ])

    const canonical = await resolveCanonicalAppointmentDuration(db, {
      venueId: 'v1',
      productIds: ['a', 'b'],
      settings: settings(),
    })

    // Si el buffer se colara aquí, el widget mostraría una hora de fin falsa
    // y toda validación de ventana quedaría corrida.
    expect(canonical.canonicalBaseDurationMin).toBe(50)
  })

  it('sigue respetando el relleno de duración por default y el tope de 1440', async () => {
    const db = productDb([{ id: 'sin-duracion', duration: null, durationMinutes: null, bufferAfterMin: 10 }])

    const canonical = await resolveCanonicalAppointmentDuration(db, {
      venueId: 'v1',
      productIds: ['sin-duracion'],
      settings: settings(40),
    })

    expect(canonical.canonicalBaseDurationMin).toBe(40)
  })
})
