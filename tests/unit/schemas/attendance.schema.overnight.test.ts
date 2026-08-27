/**
 * Turnos NOCTURNOS en el cuadrante semanal (decisión del founder, 2026-08-26: "dale").
 *
 * El evaluador ya entendía 22:00–06:00; el schema los rechazaba porque exigía open < close.
 * Regla nueva: un rango puede cruzar la medianoche SOLO si es el último del día (corre hacia
 * el día siguiente); empezar y terminar a la misma hora sigue sin ser un turno.
 */
import { ReplaceWorkScheduleSchema } from '@/schemas/dashboard/attendance.schema'

const params = { venueId: 'ckz0000000000000000000001', staffVenueId: 'ckz0000000000000000000002' }
const off = { enabled: false, ranges: [] as { open: string; close: string }[] }
const week = (wednesday: { open: string; close: string }[]) => ({
  monday: off,
  tuesday: off,
  wednesday: { enabled: true, ranges: wednesday },
  thursday: off,
  friday: off,
  saturday: off,
  sunday: off,
})
const parse = (ranges: { open: string; close: string }[]) =>
  ReplaceWorkScheduleSchema.safeParse({ params, body: { weekly: week(ranges), exceptions: [] } })

describe('cuadrante semanal — turnos que cruzan la medianoche', () => {
  it('22:00–06:00 como único rango del día: VÁLIDO', () => {
    expect(parse([{ open: '22:00', close: '06:00' }]).success).toBe(true)
  })

  it('turno partido con cierre nocturno (14:00–18:00 y 22:00–06:00): VÁLIDO', () => {
    expect(
      parse([
        { open: '14:00', close: '18:00' },
        { open: '22:00', close: '06:00' },
      ]).success,
    ).toBe(true)
  })

  it('el rango nocturno NO puede ir en medio: corre hacia el día siguiente y taparía al que sigue', () => {
    const r = parse([
      { open: '22:00', close: '06:00' },
      { open: '09:00', close: '14:00' },
    ])
    expect(r.success).toBe(false)
    expect(JSON.stringify(r.success ? null : r.error.issues)).toMatch(/medianoche/)
  })

  it('empezar y terminar a la misma hora sigue sin ser un turno', () => {
    const r = parse([{ open: '09:00', close: '09:00' }])
    expect(r.success).toBe(false)
  })

  it('regresión: el desorden y el traslape diurnos se siguen rechazando', () => {
    expect(
      parse([
        { open: '16:00', close: '20:00' },
        { open: '09:00', close: '14:00' },
      ]).success,
    ).toBe(false)
    expect(
      parse([
        { open: '09:00', close: '14:00' },
        { open: '13:00', close: '18:00' },
      ]).success,
    ).toBe(false)
  })

  it('regresión: una excepción HOURS nocturna (22:00–06:00) ya pasaba y sigue pasando', () => {
    const r = ReplaceWorkScheduleSchema.safeParse({
      params,
      body: {
        weekly: week([{ open: '09:00', close: '18:00' }]),
        exceptions: [{ startDate: '2026-08-27', endDate: '2026-08-27', kind: 'HOURS', startTime: '22:00', endTime: '06:00' }],
      },
    })
    expect(r.success).toBe(true)
  })
})
