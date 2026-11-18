import { fechaHoraDelNegocio, esFechaHoraValida, horaQueNoExiste } from '@/utils/fechaHoraDelNegocio'

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

/**
 * naa485b3 (tarjeta de la nube, 16-nov): Tijuana sigue el horario de verano de EE. UU. El 14-mar-2027 el reloj salta
 * de 02:00 a 03:00, así que «02:30» no existe. Antes se convertía en silencio a otra hora (01:30 o 03:30) y la cita
 * quedaba donde nadie la pidió.
 */
describe('horaQueNoExiste', () => {
  const TIJUANA = 'America/Tijuana'

  it('detecta la hora que se salta el reloj (02:30 del 14-mar-2027 en Tijuana)', () => {
    expect(horaQueNoExiste('2027-03-14T02:30', TIJUANA)).toBe(true)
    expect(horaQueNoExiste('2027-03-14T02:00:00', TIJUANA)).toBe(true)
  })

  it('la hora de antes y la de después del salto sí existen', () => {
    expect(horaQueNoExiste('2027-03-14T01:59', TIJUANA)).toBe(false)
    expect(horaQueNoExiste('2027-03-14T03:00', TIJUANA)).toBe(false)
  })

  it('la hora que pasa dos veces en noviembre SÍ existe (no se rechaza)', () => {
    expect(horaQueNoExiste('2026-11-01T01:30', TIJUANA)).toBe(false)
  })

  it('CDMX no tiene horario de verano: nunca hay hora inexistente', () => {
    expect(horaQueNoExiste('2027-03-14T02:30', 'America/Mexico_City')).toBe(false)
    expect(horaQueNoExiste('2027-04-04T02:30', 'America/Mexico_City')).toBe(false)
  })

  it('una hora con Z o desfase es un instante: nunca «no existe»', () => {
    expect(horaQueNoExiste('2027-03-14T10:30:00.000Z', TIJUANA)).toBe(false)
    expect(horaQueNoExiste('2027-03-14T02:30:00-08:00', TIJUANA)).toBe(false)
    expect(horaQueNoExiste(new Date('2027-03-14T10:30:00.000Z'), TIJUANA)).toBe(false)
  })

  it('«24:00» no la juzga el detector (la resuelve la conversión de siempre), aunque al día siguiente salte el reloj', () => {
    expect(horaQueNoExiste('2027-03-13T24:00', 'America/Havana')).toBe(false)
    expect(horaQueNoExiste('2027-03-13T24:15', 'America/Havana')).toBe(false)
  })

  it('zona con desfase de segundos (Colombo, 1906): la hora existe', () => {
    expect(horaQueNoExiste('1906-01-01T00:10:29', 'Asia/Colombo')).toBe(false)
  })

  it('con segundos y milisegundos también', () => {
    expect(horaQueNoExiste('2027-03-14T02:30:15.250', TIJUANA)).toBe(true)
    expect(horaQueNoExiste('2027-03-14T03:30:15.250', TIJUANA)).toBe(false)
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
