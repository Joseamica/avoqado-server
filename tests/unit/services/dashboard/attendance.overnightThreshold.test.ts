import { overnightSameDayThreshold } from '@/services/dashboard/attendance.dashboard.service'
describe('overnightSameDayThreshold (Codex P2: turnos nocturnos que empiezan antes del mediodía)', () => {
  it('22:00 → 12:00 (la regla de siempre)', () => expect(overnightSameDayThreshold('22:00')).toBe('12:00'))
  it('10:00 → 08:00: la entrada puntual de las 10:00 ya cuenta', () => expect(overnightSameDayThreshold('10:00')).toBe('08:00'))
  it('01:30 → 00:00, nunca negativo', () => expect(overnightSameDayThreshold('01:30')).toBe('00:00'))
})
