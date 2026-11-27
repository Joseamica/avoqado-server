import {
  firmarCotizacion,
  verificarCotizacion,
  VIGENCIA_DE_LA_COTIZACION_MS,
  type CotizacionFirmable,
} from '@/services/billing/comprobanteDeCotizacion'
import crypto from 'crypto'
import { ACCESS_TOKEN_SECRET } from '@/config/env'
import { signPlatformUnsubscribeToken } from '@/utils/platformUnsubscribeToken'

const c: CotizacionFirmable = {
  versionNumber: 2,
  tier: 'PRO',
  interval: 'monthly',
  firstChargeCents: 0,
  precioCents: 115884,
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

  it('ida y vuelta conserva precioCents', () => {
    expect(verificarCotizacion(firmarCotizacion(c, T0), 'org:o1', T0).precioCents).toBe(115884)
    // Aunque hoy se pague $0, el comprobante lleva el bruto del precio que se cobrará.
    expect(verificarCotizacion(firmarCotizacion({ ...c, firstChargeCents: 0, precioCents: 92684 }, T0), 'org:o1', T0).precioCents).toBe(
      92684,
    )
  })

  it('un cuerpo firmado sin precioCents (o con 0, o con 1.5) → 400 QUOTE_INVALID', () => {
    const firmar = (cuerpo: unknown) => {
      const b64 = Buffer.from(JSON.stringify(cuerpo)).toString('base64url')
      const key = crypto.createHmac('sha256', ACCESS_TOKEN_SECRET).update('avoqado-plan-quote-v1').digest()
      return `${b64}.${crypto.createHmac('sha256', key).update(b64).digest('base64url')}`
    }
    const base = { f: 1, p: 'plan-quote', n: 2, t: 'PRO', i: 'monthly', c: 0, e: null, s: T0.getTime(), a: 'org:o1' }
    for (const m of [undefined, 0, 1.5]) {
      expect(() => verificarCotizacion(firmar({ ...base, m }), 'org:o1', T0)).toThrow(
        expect.objectContaining({ statusCode: 400, code: 'QUOTE_INVALID' }),
      )
    }
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

  describe('firmarCotizacion rechaza lo que no se podría verificar (error de programación)', () => {
    it.each([
      ['fecha de emisión inválida', () => firmarCotizacion(c, new Date('x'))],
      ['fin de prueba inválido', () => firmarCotizacion({ ...c, trialEndsAt: new Date('x') }, T0)],
      ['cobro no finito', () => firmarCotizacion({ ...c, firstChargeCents: Infinity }, T0)],
      ['cobro NaN', () => firmarCotizacion({ ...c, firstChargeCents: NaN }, T0)],
      ['cobro no entero', () => firmarCotizacion({ ...c, firstChargeCents: 10.5 }, T0)],
      ['sin precio', () => firmarCotizacion({ ...c, precioCents: 0 }, T0)],
      ['precio no entero', () => firmarCotizacion({ ...c, precioCents: 1.5 }, T0)],
      ['versión no entera', () => firmarCotizacion({ ...c, versionNumber: 1.5 }, T0)],
      ['alcance vacío', () => firmarCotizacion({ ...c, alcance: '' }, T0)],
      ['resultado demasiado largo', () => firmarCotizacion({ ...c, alcance: 'org:' + 'x'.repeat(2100) }, T0)],
    ])('%s → Error simple', (_n, f) => {
      expect(f).toThrow(Error)
      expect(f).not.toThrow(expect.objectContaining({ code: expect.any(String) }))
    })
  })

  describe('forma y propósito (cuerpos firmados a mano con la llave derivada)', () => {
    const firmarA_Mano = (cuerpo: unknown) => {
      const b64 = Buffer.from(JSON.stringify(cuerpo)).toString('base64url')
      const key = crypto.createHmac('sha256', ACCESS_TOKEN_SECRET).update('avoqado-plan-quote-v1').digest()
      return `${b64}.${crypto.createHmac('sha256', key).update(b64).digest('base64url')}`
    }
    const bueno = { f: 1, p: 'plan-quote', n: 2, t: 'PRO', i: 'monthly', c: 0, m: 115884, e: null, s: T0.getTime(), a: 'org:o1' }

    it('el cuerpo bueno firmado a mano sí vale (valida el ayudante)', () => {
      expect(verificarCotizacion(firmarA_Mano(bueno), 'org:o1', T0).versionNumber).toBe(2)
    })
    it.each([
      ['propósito distinto', { ...bueno, p: 'plat-unsub' }],
      ['formato distinto', { ...bueno, f: 2 }],
      ['alcance (a) de otro tipo', { ...bueno, a: 5 }],
      ['alcance (a) distinto del pedido', { ...bueno, a: 'venue:o1' }],
      ['plan desconocido', { ...bueno, t: 'FREE' }],
      ['periodicidad desconocida', { ...bueno, i: 'weekly' }],
      ['cobro negativo', { ...bueno, c: -1 }],
      ['sin precio (m)', { ...bueno, m: undefined }],
      ['precio 0', { ...bueno, m: 0 }],
      ['precio 1.5', { ...bueno, m: 1.5 }],
      ['fin de prueba no numérico', { ...bueno, e: 'x' }],
      ['sin campo n', { ...bueno, n: undefined }],
      ['cuerpo nulo', null],
    ])('%s → 400 QUOTE_INVALID', (_n, cuerpo) => {
      expect(() => verificarCotizacion(firmarA_Mano(cuerpo), 'org:o1', T0)).toThrow(
        expect.objectContaining({ statusCode: 400, code: 'QUOTE_INVALID' }),
      )
    })
  })
})
