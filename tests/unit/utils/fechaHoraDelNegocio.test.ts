import { fechaHoraDelNegocio, esFechaHoraValida } from '@/utils/fechaHoraDelNegocio'

/**
 * Reagendar desde el DASHBOARD mandaba la hora de un `<input type="datetime-local">`
 * sin zona ("2026-11-12T15:00"). El SERVIDOR la leía en la zona del proceso (UTC en
 * Render) y la cita quedaba 6 h antes en México. Una hora SIN zona es hora del negocio.
 */
describe('fechaHoraDelNegocio', () => {
  const CDMX = 'America/Mexico_City'

  it('lee una hora sin zona como hora del negocio (15:00 en CDMX = 21:00Z)', () => {
    expect(fechaHoraDelNegocio('2026-11-12T15:00', CDMX).toISOString()).toBe('2026-11-12T21:00:00.000Z')
  })

  it('acepta segundos y milisegundos sin zona', () => {
    expect(fechaHoraDelNegocio('2026-11-12T15:00:30', CDMX).toISOString()).toBe('2026-11-12T21:00:30.000Z')
    expect(fechaHoraDelNegocio('2026-11-12T15:00:30.250', CDMX).toISOString()).toBe('2026-11-12T21:00:30.250Z')
  })

  it('respeta la zona del negocio, no una fija (Cancún = UTC-5)', () => {
    expect(fechaHoraDelNegocio('2026-11-12T15:00', 'America/Cancun').toISOString()).toBe('2026-11-12T20:00:00.000Z')
  })

  it('no toca una hora que ya trae Z (ANDROID e iOS mandan el instante en UTC)', () => {
    expect(fechaHoraDelNegocio('2026-11-12T21:00:00.000Z', CDMX).toISOString()).toBe('2026-11-12T21:00:00.000Z')
  })

  it('no toca una hora con desfase explícito', () => {
    expect(fechaHoraDelNegocio('2026-11-12T15:00:00-06:00', CDMX).toISOString()).toBe('2026-11-12T21:00:00.000Z')
    expect(fechaHoraDelNegocio('2026-11-12T15:00:00+0000', CDMX).toISOString()).toBe('2026-11-12T15:00:00.000Z')
  })

  it('un Date pasa tal cual', () => {
    const d = new Date('2026-11-12T21:00:00.000Z')
    expect(fechaHoraDelNegocio(d, CDMX)).toBe(d)
  })

  it('no depende de la zona del proceso', () => {
    const antes = process.env.TZ
    try {
      process.env.TZ = 'Asia/Tokyo'
      expect(fechaHoraDelNegocio('2026-11-12T15:00', CDMX).toISOString()).toBe('2026-11-12T21:00:00.000Z')
    } finally {
      process.env.TZ = antes
    }
  })
})

describe('esFechaHoraValida', () => {
  it('acepta horas con y sin zona y un Date válido', () => {
    expect(esFechaHoraValida('2026-11-12T15:00')).toBe(true)
    expect(esFechaHoraValida('2026-11-12T21:00:00.000Z')).toBe(true)
    expect(esFechaHoraValida(new Date('2026-11-12T21:00:00.000Z'))).toBe(true)
  })

  it('rechaza basura y un Date inválido', () => {
    expect(esFechaHoraValida('mañana')).toBe(false)
    expect(esFechaHoraValida('2026-13-45T99:00')).toBe(false)
    expect(esFechaHoraValida(new Date('x'))).toBe(false)
  })
})
