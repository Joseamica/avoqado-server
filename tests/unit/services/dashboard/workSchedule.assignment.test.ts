/**
 * Turnos rotativos (fase 1 "como Sesame"): precedencia ÚNICA
 *   excepción manual → asignación PUBLICADA → horario fijo → nada
 * (decisión con Codex, 27-ago). La asignación es una capa MÁS, no un reemplazo: agregar turnos no
 * migra a nadie — quien sigue con jornada fija no ve nada nuevo.
 */
import { resolveExpectedDay } from '@/services/dashboard/workSchedule.service'

const weekly = {
  monday: { enabled: true, ranges: [{ open: '09:00', close: '18:00' }] },
  tuesday: { enabled: true, ranges: [{ open: '09:00', close: '18:00' }] },
  wednesday: { enabled: true, ranges: [{ open: '09:00', close: '18:00' }] },
  thursday: { enabled: true, ranges: [{ open: '09:00', close: '18:00' }] },
  friday: { enabled: true, ranges: [{ open: '09:00', close: '18:00' }] },
  saturday: { enabled: false, ranges: [] },
  sunday: { enabled: false, ranges: [] },
}
const cierre = { startTime: '11:00', endTime: '19:00', status: 'PUBLISHED' as const }

describe('resolveExpectedDay · asignación de turno rotativo', () => {
  it('🔴 una asignación PUBLICADA gana sobre la jornada fija', () => {
    expect(resolveExpectedDay(weekly, [], '2026-08-20', cierre)).toEqual({ start: '11:00', end: '19:00', isDayOff: false })
  })
  it('🔴 la excepción manual (vacaciones) sigue ganando sobre la asignación', () => {
    const vac = [{ startDate: '2026-08-17', endDate: '2026-08-24', kind: 'OFF' as const, type: 'VACATION' }]
    expect(resolveExpectedDay(weekly, vac, '2026-08-20', cierre)).toEqual(
      expect.objectContaining({ isDayOff: true, absenceType: 'VACATION' }),
    )
  })
  it('un borrador (DRAFT) NO cuenta: se cae al horario fijo', () => {
    expect(resolveExpectedDay(weekly, [], '2026-08-20', { ...cierre, status: 'DRAFT' })).toEqual({
      start: '09:00',
      end: '18:00',
      isDayOff: false,
    })
  })
  it('sin asignación todo sigue igual que hoy', () => {
    expect(resolveExpectedDay(weekly, [], '2026-08-20', null)).toEqual({ start: '09:00', end: '18:00', isDayOff: false })
    expect(resolveExpectedDay(weekly, [], '2026-08-22', undefined)).toEqual(expect.objectContaining({ isDayOff: true }))
  })
  it('una asignación en un día que la jornada fija marca como descanso SÍ se espera (rotó al sábado)', () => {
    expect(resolveExpectedDay(weekly, [], '2026-08-22', cierre)).toEqual({ start: '11:00', end: '19:00', isDayOff: false })
  })
  it('sin jornada fija, la asignación basta', () => {
    expect(resolveExpectedDay(null, [], '2026-08-20', cierre)).toEqual({ start: '11:00', end: '19:00', isDayOff: false })
  })
})
