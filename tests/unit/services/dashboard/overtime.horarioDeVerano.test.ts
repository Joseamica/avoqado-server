/**
 * P1 #8 de la auditoría de Codex — **las horas AMBIGUAS del cambio de horario**.
 *
 * En la noche en que el reloj se atrasa, una hora local ocurre DOS veces: la 01:30 con un
 * offset y la 01:30 otra vez con el siguiente. Luxon elige una en silencio, y para un turno
 * nocturno eso puede regalar o quitar 60 minutos.
 *
 * 🔴 Política DECLARADA: cuando la hora de salida es ambigua, se elige la ocurrencia que hace
 * que el turno dure lo que dice el cuadrante. Un turno de 22:00 a 01:30 dura 3 h 30 m
 * contractuales; en esa noche la segunda 01:30 es la que da 4 h 30 m de reloj, así que la
 * primera es la correcta. Adivinar el offset «por defecto» es lo que producía el error.
 *
 * ⚠️ México dejó el horario de verano en 2022, pero **Baja California lo conserva** por su
 * frontera con California — así que Tijuana y Mexicali sí tienen estas noches, dos veces al
 * año. No es hipotético: hay venues ahí.
 */
import { minutosExtraDelDia } from '@/services/dashboard/overtime'

const TIJUANA = 'America/Tijuana'

/** 2026-11-01: en Tijuana el reloj se atrasa a las 02:00 → la 01:00–02:00 ocurre dos veces. */
const NOCHE_LARGA = '2026-10-31'
/** 2026-03-08: el reloj se adelanta a las 02:00 → la 02:00–03:00 no existe. */
const NOCHE_CORTA = '2026-03-07'

describe('la noche en que el reloj se ATRASA (hora repetida)', () => {
  const turno = { date: NOCHE_LARGA, expectedStart: '22:00', expectedEnd: '01:30' }

  it('🔴 salir a su hora no genera extra, aunque la 01:30 exista dos veces', () => {
    // La PRIMERA 01:30 (offset −07) es la que hace que el turno dure sus 3 h 30 m.
    const salida = new Date('2026-11-01T08:30:00.000Z') // 01:30 −07
    expect(
      minutosExtraDelDia({
        turno,
        intervalos: [{ entrada: new Date('2026-11-01T05:00:00.000Z'), salida }],
        descansos: [],
        timezone: TIJUANA,
      }),
    ).toBe(0)
  })

  it('🔴 quedarse hasta la SEGUNDA 01:30 son 60 minutos de extra, no cero', () => {
    // Ésta es la hora que se regalaba: el reloj de pared dice lo mismo, pero se trabajó una
    // hora más.
    const salida = new Date('2026-11-01T09:30:00.000Z') // 01:30 −08, una hora después
    expect(
      minutosExtraDelDia({
        turno,
        intervalos: [{ entrada: new Date('2026-11-01T05:00:00.000Z'), salida }],
        descansos: [],
        timezone: TIJUANA,
      }),
    ).toBe(60)
  })

  it('quedarse 15 min más de la primera 01:30 son 15 minutos', () => {
    expect(
      minutosExtraDelDia({
        turno,
        intervalos: [{ entrada: new Date('2026-11-01T05:00:00.000Z'), salida: new Date('2026-11-01T08:45:00.000Z') }],
        descansos: [],
        timezone: TIJUANA,
      }),
    ).toBe(15)
  })
})

describe('la noche en que el reloj se ADELANTA (hora inexistente)', () => {
  // Turno 22:00 → 02:30, pero esa madrugada la 02:00–03:00 no existe.
  const turno = { date: NOCHE_CORTA, expectedStart: '22:00', expectedEnd: '02:30' }

  it('no revienta y no inventa horas', () => {
    // Política declarada: Luxon normaliza hacia adelante y se acepta — la hora de pared no
    // existió, así que el turno terminó cuando el reloj saltó.
    const r = minutosExtraDelDia({
      turno,
      intervalos: [{ entrada: new Date('2026-03-08T06:00:00.000Z'), salida: new Date('2026-03-08T11:00:00.000Z') }],
      descansos: [],
      timezone: TIJUANA,
    })
    expect(Number.isFinite(r)).toBe(true)
    expect(r).toBeGreaterThanOrEqual(0)
    expect(r).toBeLessThan(120)
  })
})

describe('regresión: una noche normal no cambia', () => {
  it('en México (sin horario de verano) todo sigue igual', () => {
    expect(
      minutosExtraDelDia({
        turno: { date: '2026-08-24', expectedStart: '22:00', expectedEnd: '06:00' },
        intervalos: [
          {
            entrada: new Date('2026-08-25T04:00:00.000Z'), // 22:00 México
            salida: new Date('2026-08-25T13:30:00.000Z'), // 07:30 México
          },
        ],
        descansos: [],
        timezone: 'America/Mexico_City',
      }),
    ).toBe(90)
  })

  it('un turno diurno en Tijuana fuera de la noche del cambio tampoco', () => {
    expect(
      minutosExtraDelDia({
        turno: { date: '2026-08-24', expectedStart: '09:00', expectedEnd: '17:00' },
        intervalos: [{ entrada: new Date('2026-08-24T16:00:00.000Z'), salida: new Date('2026-08-25T02:00:00.000Z') }],
        descansos: [],
        timezone: TIJUANA,
      }),
    ).toBe(120)
  })
})
