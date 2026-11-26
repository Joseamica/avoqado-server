/**
 * D27 (25-nov): el límite del vencimiento de puntos. Es por CALENDARIO en la zona del negocio (actividad el día d ⇒ vence al empezar el
 * día d + N) y no depende de la zona del proceso: producción corre en UTC.
 */
import { limiteDeVencimiento } from '../../../../src/services/loyalty/vencimientoDePuntos'

describe('limiteDeVencimiento', () => {
  const CDMX = 'America/Mexico_City'

  it('365 días: el 26-nov-2027 a las 03:00 de CDMX vence quien no tiene actividad desde antes del 27-nov-2026 (el 26-nov-2026 cumple hoy)', () => {
    // 03:00 CDMX = 09:00 UTC; el día local ya es el 26.
    const limite = limiteDeVencimiento(new Date('2027-11-26T09:00:00.000Z'), CDMX, 365)
    expect(limite.toISOString()).toBe('2026-11-27T06:00:00.000Z')
  })

  it('1 día: vence lo de ayer al empezar hoy', () => {
    expect(limiteDeVencimiento(new Date('2026-12-02T15:00:00.000Z'), CDMX, 1).toISOString()).toBe('2026-12-02T06:00:00.000Z')
  })

  it('a las 23:30 de CDMX (05:30 UTC del día siguiente) el día local sigue siendo el de ayer', () => {
    const limite = limiteDeVencimiento(new Date('2026-12-03T05:30:00.000Z'), CDMX, 1)
    expect(limite.toISOString()).toBe('2026-12-02T06:00:00.000Z')
  })

  it('cruza fin de mes y de año por calendario', () => {
    expect(limiteDeVencimiento(new Date('2027-01-01T12:00:00.000Z'), CDMX, 30).toISOString()).toBe('2026-12-03T06:00:00.000Z')
  })

  it('otra zona (Tijuana, con horario de verano): el inicio del día de esa zona', () => {
    // 15-jul-2027 en Tijuana (UTC−7 en verano); 10 días ⇒ desde el 6-jul local, 07:00 UTC.
    expect(limiteDeVencimiento(new Date('2027-07-15T20:00:00.000Z'), 'America/Tijuana', 10).toISOString()).toBe('2027-07-06T07:00:00.000Z')
  })

  it('no depende de la zona del proceso', () => {
    const original = process.env.TZ
    try {
      const resultados = ['UTC', 'America/Mexico_City', 'Asia/Tokyo'].map(tz => {
        process.env.TZ = tz
        return limiteDeVencimiento(new Date('2027-11-26T09:00:00.000Z'), CDMX, 365).toISOString()
      })
      expect(new Set(resultados).size).toBe(1)
    } finally {
      process.env.TZ = original
    }
  })

  it('un día que empieza a la 01:00 (America/Santiago, 6-sep-2026): el límite es su primer instante real, no las 23:00 de la víspera', () => {
    // 1 día ⇒ límite = inicio del día local de hoy. Ese domingo los relojes saltan de 23:59:59 a 01:00 (UTC−4 → UTC−3) ⇒ 04:00 UTC.
    expect(limiteDeVencimiento(new Date('2026-09-06T15:00:00.000Z'), 'America/Santiago', 1).toISOString()).toBe('2026-09-06T04:00:00.000Z')
  })

  it('días absurdos (el esquema acepta 2,147,483,647) se toman como cien años en vez de tronar', () => {
    const limite = limiteDeVencimiento(new Date('2026-11-25T18:00:00.000Z'), CDMX, 2_147_483_647)
    expect(limite.getUTCFullYear()).toBe(1926)
  })

  it('rechaza días que no son enteros positivos', () => {
    expect(() => limiteDeVencimiento(new Date(), CDMX, 0)).toThrow()
    expect(() => limiteDeVencimiento(new Date(), CDMX, 1.5)).toThrow()
  })
})
