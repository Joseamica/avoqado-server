/**
 * Boleto de alta: la credencial de 5 minutos que el SERVIDOR le da a la landing al verificar el código,
 * y que el DASHBOARD canjea por una sesión. Debe morir a los 5 min, no dejarse alterar y no servir como sesión.
 */
import jwt from 'jsonwebtoken'
import { AuthenticationError } from '@/errors/AppError'
import { firmarBoletoDeAlta, leerBoletoDeAlta } from '@/services/onboarding/boletoDeAlta'

beforeAll(() => {
  process.env.ACCESS_TOKEN_SECRET = 'secreto-de-prueba-del-boleto'
})
afterEach(() => jest.useRealTimers())

describe('boleto de alta', () => {
  it('firma y lee: devuelve staffId, correo y el instante de emisión', () => {
    const antes = Date.now()
    const lectura = leerBoletoDeAlta(firmarBoletoDeAlta('staff-1', 'ana@example.com'))
    expect(lectura.staffId).toBe('staff-1')
    expect(lectura.email).toBe('ana@example.com')
    expect(lectura.emitidoMs).toBeGreaterThanOrEqual(antes)
  })

  it('vence a los 5 minutos', () => {
    jest.useFakeTimers({ now: new Date('2026-10-23T12:00:00Z') })
    const boleto = firmarBoletoDeAlta('staff-1', 'ana@example.com')
    jest.setSystemTime(new Date('2026-10-23T12:04:30Z'))
    expect(() => leerBoletoDeAlta(boleto)).not.toThrow()
    jest.setSystemTime(new Date('2026-10-23T12:05:30Z'))
    expect(() => leerBoletoDeAlta(boleto)).toThrow(AuthenticationError)
  })

  it('rechaza un boleto alterado', () => {
    const [h, p, s] = firmarBoletoDeAlta('staff-1', 'ana@example.com').split('.')
    const otro = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), sub: 'staff-2' })).toString('base64url')
    expect(() => leerBoletoDeAlta(`${h}.${otro}.${s}`)).toThrow(AuthenticationError)
    expect(() => leerBoletoDeAlta('basura')).toThrow(AuthenticationError)
  })

  it('rechaza uno firmado con la llave de las sesiones', () => {
    const deSesion = jwt.sign({ sub: 'staff-1', email: 'ana@example.com', proposito: 'avoqado:boleto-de-alta' }, process.env.ACCESS_TOKEN_SECRET!, {
      algorithm: 'HS256',
      expiresIn: '5m',
    })
    expect(() => leerBoletoDeAlta(deSesion)).toThrow(AuthenticationError)
  })

  it('rechaza uno con otro propósito (aunque tenga la llave derivada)', () => {
    // Un enlace de cambio de correo se firma con OTRA llave derivada: tampoco debe servir.
    const crypto = require('crypto') as typeof import('crypto')
    const llaveAjena = crypto.createHmac('sha256', process.env.ACCESS_TOKEN_SECRET!).update('avoqado:cambio-de-correo').digest('hex')
    const ajeno = jwt.sign({ sub: 'staff-1', email: 'ana@example.com', proposito: 'avoqado:cambio-de-correo' }, llaveAjena, { algorithm: 'HS256', expiresIn: '5m' })
    expect(() => leerBoletoDeAlta(ajeno)).toThrow(AuthenticationError)
  })
})
