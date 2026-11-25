import { firmarCotizacion, verificarCotizacion, VIGENCIA_DE_LA_COTIZACION_MS, type CotizacionFirmable } from '@/services/billing/comprobanteDeCotizacion'
import { signPlatformUnsubscribeToken } from '@/utils/platformUnsubscribeToken'

const c: CotizacionFirmable = {
  versionNumber: 2,
  tier: 'PRO',
  interval: 'monthly',
  firstChargeCents: 0,
  trialEndsAt: new Date('2026-12-25T06:00:00Z'),
  alcance: 'org:o1',
}
const T0 = new Date('2026-11-25T12:00:00Z')
const despues = (ms: number) => new Date(T0.getTime() + ms)
const cambiar = (s: string, i: number) => s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1)

describe('comprobante de cotización', () => {
  it('ida y vuelta conserva todos los campos y la hora de emisión', () => {
    expect(verificarCotizacion(firmarCotizacion(c, T0), 'org:o1', T0)).toEqual({ ...c, issuedAt: T0 })
    const sinPrueba = { ...c, trialEndsAt: null }
    expect(verificarCotizacion(firmarCotizacion(sinPrueba, T0), 'org:o1', T0).trialEndsAt).toBeNull()
  })

  it('un solo carácter cambiado en el cuerpo o en la firma → 400 QUOTE_INVALID', () => {
    const t = firmarCotizacion(c, T0)
    const punto = t.indexOf('.')
    for (const mala of [cambiar(t, 3), cambiar(t, punto + 3), t.slice(0, -1), 'x'.repeat(2049), '', 'sin-punto']) {
      expect(() => verificarCotizacion(mala, 'org:o1', T0)).toThrow(expect.objectContaining({ statusCode: 400, code: 'QUOTE_INVALID' }))
    }
    expect(() => verificarCotizacion(undefined, 'org:o1', T0)).toThrow(expect.objectContaining({ code: 'QUOTE_INVALID' }))
  })

  it('otro alcance → 400 QUOTE_INVALID', () => {
    expect(() => verificarCotizacion(firmarCotizacion(c, T0), 'venue:o1', T0)).toThrow(
      expect.objectContaining({ statusCode: 400, code: 'QUOTE_INVALID' }),
    )
  })

  it('a las 23:59:59 vale; a las 24:00:00 → 409 QUOTE_EXPIRED', () => {
    const t = firmarCotizacion(c, T0)
    expect(() => verificarCotizacion(t, 'org:o1', despues(VIGENCIA_DE_LA_COTIZACION_MS - 1000))).not.toThrow()
    expect(() => verificarCotizacion(t, 'org:o1', despues(VIGENCIA_DE_LA_COTIZACION_MS))).toThrow(
      expect.objectContaining({ statusCode: 409, code: 'QUOTE_EXPIRED' }),
    )
  })

  it('emitido 6 min en el futuro → 400 QUOTE_INVALID; 4 min, vale', () => {
    expect(() => verificarCotizacion(firmarCotizacion(c, despues(6 * 60_000)), 'org:o1', T0)).toThrow(
      expect.objectContaining({ statusCode: 400, code: 'QUOTE_INVALID' }),
    )
    expect(() => verificarCotizacion(firmarCotizacion(c, despues(4 * 60_000)), 'org:o1', T0)).not.toThrow()
  })

  it('un token de baja de correo (platformUnsubscribeToken) no vale aquí', () => {
    expect(() => verificarCotizacion(signPlatformUnsubscribeToken('a@example.com'), 'org:o1', T0)).toThrow(
      expect.objectContaining({ code: 'QUOTE_INVALID' }),
    )
  })
})
