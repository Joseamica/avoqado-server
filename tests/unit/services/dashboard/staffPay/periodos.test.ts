import { periodoQueContiene, diaCivilSiguiente, venuePeriodRange, fechaComoDbDate, dbDateComoFecha, hoyLocal } from '@/services/dashboard/staffPay/periodos'

describe('periodos — feature nueva', () => {
  it('mensual: contiene todo el mes, fin inclusivo', () => {
    expect(periodoQueContiene('2026-10-31', 'MONTHLY')).toEqual({ start: '2026-10-01', end: '2026-10-31' })
    expect(periodoQueContiene('2028-02-10', 'MONTHLY')).toEqual({ start: '2028-02-01', end: '2028-02-29' })
  })
  it('quincenal: 1-15 y 16-fin', () => {
    expect(periodoQueContiene('2026-10-15', 'SEMIMONTHLY')).toEqual({ start: '2026-10-01', end: '2026-10-15' })
    expect(periodoQueContiene('2026-10-16', 'SEMIMONTHLY')).toEqual({ start: '2026-10-16', end: '2026-10-31' })
  })
  it('día civil siguiente cruza mes y año', () => {
    expect(diaCivilSiguiente('2026-10-31')).toBe('2026-11-01')
    expect(diaCivilSiguiente('2026-12-31')).toBe('2027-01-01')
  })
  it('rango en CDMX: [inicio local, día siguiente local)', () => {
    const r = venuePeriodRange({ start: '2026-10-01', end: '2026-10-31' }, 'America/Mexico_City')
    expect(r.from.toISOString()).toBe('2026-10-01T06:00:00.000Z')
    expect(r.to.toISOString()).toBe('2026-11-01T06:00:00.000Z')
  })
  it('fecha de vigencia ida y vuelta sin corrimiento', () => {
    expect(dbDateComoFecha(fechaComoDbDate('2026-10-16'))).toBe('2026-10-16')
  })
  it('hoy local usa la zona del venue, no la del servidor', () => {
    expect(hoyLocal('America/Mexico_City', new Date('2026-11-01T05:30:00.000Z'))).toBe('2026-10-31')
  })
})

describe('periodos — regresión', () => {
  it('rechaza fechas mal formadas o inexistentes', () => {
    expect(() => periodoQueContiene('2026-02-30', 'MONTHLY')).toThrow('Fecha inválida')
    expect(() => periodoQueContiene('2026/10/01', 'MONTHLY')).toThrow('Fecha inválida')
  })
})
