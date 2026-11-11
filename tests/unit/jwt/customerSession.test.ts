import jwt from 'jsonwebtoken'
import {
  generateAccessToken,
  verifyAccessToken,
  generateCustomerSession,
  verifyCustomerSession,
  generateCustomerToken,
  verifyCustomerToken,
  generateOrderingCustomerToken,
  verifyOrderingCustomerToken,
  generateConsumerToken,
  verifyConsumerToken,
} from '@/jwt.service'

const SECRET = process.env.ACCESS_TOKEN_SECRET!
const NOW = 1_800_000_000
const payload = {
  sub: 'cliente',
  venueId: 'negocio',
  v: 3,
  contactos: [{ tipo: 'EMAIL' as const, valor: 'ana@ejemplo.mx', metodo: 'EMAIL_CODE' as const, probadoEn: NOW - 100 }],
}
beforeEach(() => jest.useFakeTimers().setSystemTime(NOW * 1000))
afterEach(() => jest.useRealTimers())
const sign = (overrides: Record<string, unknown> = {}, options: jwt.SignOptions = {}) =>
  jwt.sign({ ...payload, type: 'customer_session', ...overrides }, SECRET, { algorithm: 'HS256', expiresIn: '30d', ...options })

it('emite HS256/30 días sólo con campos propios, sin arrastrar iat/exp', () => {
  const token = generateCustomerSession({ ...payload, iat: 1, exp: 2 } as any)
  expect(jwt.decode(token, { complete: true })?.header.alg).toBe('HS256')
  expect(verifyCustomerSession(token)).toEqual({ ...payload, type: 'customer_session', iat: NOW, exp: NOW + 2_592_000 })
})
it('acepta contactos vacíos deliberados', () => {
  expect(verifyCustomerSession(generateCustomerSession({ ...payload, contactos: [] })).contactos).toEqual([])
})
it.each([
  { sub: '' },
  { sub: 4 },
  { venueId: '' },
  { venueId: [] },
  { type: 'customer' },
  { v: undefined },
  { v: -1 },
  { v: 0.5 },
  { contactos: null },
  { contactos: {} },
  { contactos: [null] },
  { contactos: [{ ...payload.contactos[0], tipo: 'SMS' }] },
  { contactos: [{ ...payload.contactos[0], metodo: 'PASSWORD' }] },
  { contactos: [{ ...payload.contactos[0], valor: '' }] },
  { contactos: [{ ...payload.contactos[0], probadoEn: 'ayer' }] },
  { contactos: [{ ...payload.contactos[0], probadoEn: -1 }] },
])('rechaza forma firmada inválida %p', bad => {
  expect(() => verifyCustomerSession(sign(bad))).toThrow(jwt.JsonWebTokenError)
})
it('rechaza firma/algoritmo/expiración incorrectos', () => {
  expect(() => verifyCustomerSession(jwt.sign({ ...payload, type: 'customer_session' }, 'otra-clave'))).toThrow()
  expect(() => verifyCustomerSession(sign({}, { algorithm: 'HS384' }))).toThrow()
  expect(() => verifyCustomerSession(sign({}, { expiresIn: -1 }))).toThrow(jwt.TokenExpiredError)
})
it('la sesión requiere iat y exp, nunca acepta una sin expiración', () => {
  expect(() => verifyCustomerSession(jwt.sign({ ...payload, type: 'customer_session' }, SECRET, { noTimestamp: true }))).toThrow()
  expect(() => verifyCustomerSession(sign({}, { noTimestamp: true }))).toThrow()
})
it('regresión: verificadores anteriores conservan sus tipos y no aceptan la sesión', () => {
  const session = generateCustomerSession(payload)
  for (const verify of [verifyCustomerToken, verifyOrderingCustomerToken, verifyConsumerToken]) expect(() => verify(session)).toThrow()
  expect(verifyCustomerToken(generateCustomerToken('c', 'v')).type).toBe('customer')
  expect(verifyOrderingCustomerToken(generateOrderingCustomerToken('c', 'v', '+525543453965')).verifiedPhone).toBe('+525543453965')
  expect(verifyConsumerToken(generateConsumerToken('consumer')).sub).toBe('consumer')
})

it('fronteras staff/consumer: una sesión nunca entra a la API de staff ni al revés', () => {
  const session = generateCustomerSession(payload)
  expect(() => verifyAccessToken(session)).toThrow(jwt.JsonWebTokenError)
  const staff = generateAccessToken('staff', 'org', 'venue', 'OWNER')
  expect(verifyAccessToken(staff).sub).toBe('staff')
  expect(() => verifyCustomerSession(staff)).toThrow(jwt.JsonWebTokenError)
  expect(() => verifyCustomerSession(generateConsumerToken('consumer'))).toThrow(jwt.JsonWebTokenError)
})
