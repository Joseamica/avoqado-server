/**
 * El cuadrante laboral y la resolución de "qué se esperaba de esta persona ESE día".
 *
 * La parte delicada es el orden de precedencia: una excepción puntual (vacaciones, un día
 * con otro horario) tiene que ganarle al cuadrante semanal. Si gana el semanal, alguien de
 * vacaciones aparece como falta todos los días.
 */
import { resolveExpectedDay } from '@/services/dashboard/workSchedule.service'

const weekly = {
  monday: { enabled: true, ranges: [{ open: '09:00', close: '18:00' }] },
  tuesday: { enabled: true, ranges: [{ open: '09:00', close: '18:00' }] },
  wednesday: { enabled: true, ranges: [{ open: '09:00', close: '18:00' }] },
  thursday: { enabled: true, ranges: [{ open: '09:00', close: '18:00' }] },
  friday: { enabled: true, ranges: [{ open: '10:00', close: '15:00' }] },
  saturday: { enabled: false, ranges: [] },
  sunday: { enabled: false, ranges: [] },
}

// 2026-08-20 = jueves · 2026-08-21 = viernes · 2026-08-22 = sábado
describe('resolveExpectedDay', () => {
  it('toma el horario del día de la semana que toca', () => {
    expect(resolveExpectedDay(weekly, [], '2026-08-20')).toEqual({ start: '09:00', end: '18:00', isDayOff: false })
  })

  it('cada día puede tener su propio horario', () => {
    expect(resolveExpectedDay(weekly, [], '2026-08-21')).toEqual({ start: '10:00', end: '15:00', isDayOff: false })
  })

  it('un día apagado en el cuadrante es descanso', () => {
    expect(resolveExpectedDay(weekly, [], '2026-08-22')).toEqual({ start: null, end: null, isDayOff: true })
  })

  it('sin cuadrante no hay nada que esperar', () => {
    expect(resolveExpectedDay(null, [], '2026-08-20')).toEqual({ start: null, end: null, isDayOff: false })
  })

  it('🔴 una excepción de descanso GANA sobre el cuadrante semanal', () => {
    // Sin esto, alguien de vacaciones aparece como falta todos los días.
    const vacaciones = [{ startDate: '2026-08-17', endDate: '2026-08-24', kind: 'OFF' as const }]
    expect(resolveExpectedDay(weekly, vacaciones, '2026-08-20')).toEqual({ start: null, end: null, isDayOff: true })
  })

  it('una excepción de horario GANA sobre el cuadrante semanal', () => {
    const ese = [{ startDate: '2026-08-20', endDate: '2026-08-20', kind: 'HOURS' as const, startTime: '13:00', endTime: '21:00' }]
    expect(resolveExpectedDay(weekly, ese, '2026-08-20')).toEqual({ start: '13:00', end: '21:00', isDayOff: false })
  })

  it('la excepción sólo aplica dentro de su rango de fechas', () => {
    const vacaciones = [{ startDate: '2026-08-17', endDate: '2026-08-19', kind: 'OFF' as const }]
    expect(resolveExpectedDay(weekly, vacaciones, '2026-08-20')).toEqual({ start: '09:00', end: '18:00', isDayOff: false })
  })

  it('los bordes del rango están INCLUIDOS', () => {
    const off = [{ startDate: '2026-08-20', endDate: '2026-08-20', kind: 'OFF' as const }]
    expect(resolveExpectedDay(weekly, off, '2026-08-20').isDayOff).toBe(true)
  })

  it('una excepción puede dar trabajo en un día que el cuadrante marcaba libre', () => {
    // Sábado normalmente cerrado, pero ese sábado sí entra.
    const ese = [{ startDate: '2026-08-22', endDate: '2026-08-22', kind: 'HOURS' as const, startTime: '11:00', endTime: '15:00' }]
    expect(resolveExpectedDay(weekly, ese, '2026-08-22')).toEqual({ start: '11:00', end: '15:00', isDayOff: false })
  })

  it('entre varias excepciones que se solapan, gana la más específica (la más corta)', () => {
    // Vacaciones de una semana, pero un día de ellas viene a cubrir un turno.
    const exceptions = [
      { startDate: '2026-08-17', endDate: '2026-08-24', kind: 'OFF' as const },
      { startDate: '2026-08-20', endDate: '2026-08-20', kind: 'HOURS' as const, startTime: '16:00', endTime: '20:00' },
    ]
    expect(resolveExpectedDay(weekly, exceptions, '2026-08-20')).toEqual({ start: '16:00', end: '20:00', isDayOff: false })
  })

  it('un día habilitado pero sin rangos es descanso, no un horario vacío', () => {
    const raro = { ...weekly, thursday: { enabled: true, ranges: [] } }
    expect(resolveExpectedDay(raro, [], '2026-08-20')).toEqual({ start: null, end: null, isDayOff: true })
  })

  it('toma el primer y el último rango del día: entra en el primero, sale en el último', () => {
    // Turno partido: 9-14 y 16-20. Se espera entrada 9:00 y salida 20:00.
    const partido = { ...weekly, thursday: { enabled: true, ranges: [{ open: '09:00', close: '14:00' }, { open: '16:00', close: '20:00' }] } }
    expect(resolveExpectedDay(partido, [], '2026-08-20')).toEqual({ start: '09:00', end: '20:00', isDayOff: false })
  })
})
