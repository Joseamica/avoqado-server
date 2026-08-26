/**
 * Excepciones del cuadrante — el ganador no depende del orden en que lleguen.
 * Auditoría Codex de la fase 2 del checador (2026-08-26), P2-6.
 */
import { resolveExpectedDay } from '@/services/dashboard/workSchedule.service'

const weekly = { wednesday: { enabled: true, ranges: [{ open: '09:00', close: '18:00' }] } }
const OFF = { startDate: '2026-08-26', endDate: '2026-08-26', kind: 'OFF' as const }
const HOURS = { startDate: '2026-08-26', endDate: '2026-08-26', kind: 'HOURS' as const, startTime: '14:00', endTime: '20:00' }

describe('resolveExpectedDay — desempate', () => {
  it('misma duración, OFF y HOURS: gana OFF sin importar el orden de entrada', () => {
    expect(resolveExpectedDay(weekly, [OFF, HOURS], '2026-08-26')).toEqual({ start: null, end: null, isDayOff: true })
    expect(resolveExpectedDay(weekly, [HOURS, OFF], '2026-08-26')).toEqual({ start: null, end: null, isDayOff: true })
  })

  it('dos HOURS de igual duración: gana la que empieza más tarde (la más reciente), en ambos órdenes', () => {
    const older = { startDate: '2026-08-24', endDate: '2026-08-28', kind: 'HOURS' as const, startTime: '08:00', endTime: '12:00' }
    const newer = { startDate: '2026-08-26', endDate: '2026-08-30', kind: 'HOURS' as const, startTime: '14:00', endTime: '20:00' }
    expect(resolveExpectedDay(weekly, [older, newer], '2026-08-27').start).toBe('14:00')
    expect(resolveExpectedDay(weekly, [newer, older], '2026-08-27').start).toBe('14:00')
  })

  it('regresión: la MÁS CORTA sigue ganando sobre la larga (día suelto dentro de vacaciones)', () => {
    const vacation = { startDate: '2026-08-20', endDate: '2026-08-30', kind: 'OFF' as const }
    const cover = { startDate: '2026-08-26', endDate: '2026-08-26', kind: 'HOURS' as const, startTime: '10:00', endTime: '14:00' }
    expect(resolveExpectedDay(weekly, [vacation, cover], '2026-08-26')).toEqual({ start: '10:00', end: '14:00', isDayOff: false })
  })
})
