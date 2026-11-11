import type { Request, Response } from 'express'
import jwt from 'jsonwebtoken'
import {
  authenticateCustomer,
  authenticateCustomerOptional,
  authenticateOrderingCustomerOptional,
  authenticateCustomerParaCambioDeNumero,
  activarReservasSiFalta,
} from '@/middlewares/customerAuth.middleware'
import prisma from '@/utils/prismaClient'
import { getCorsConfig } from '@/config/corsOptions'

jest.mock('@/utils/prismaClient', () => ({ __esModule: true, default: { customer: { findFirst: jest.fn() }, $transaction: jest.fn() } }))
const SECRET = process.env.ACCESS_TOKEN_SECRET!
const NOW = 1_800_000_000
const PHONE = '+525543453965'
const contactos = [
  { tipo: 'PHONE', valor: PHONE, metodo: 'WHATSAPP', probadoEn: NOW - 100_000 },
  { tipo: 'EMAIL', valor: 'Ana@ejemplo.mx', metodo: 'GOOGLE', probadoEn: NOW - 100_000 },
]
const sign = (extra: Record<string, unknown> = {}) =>
  jwt.sign({ sub: 'c1', venueId: 'v1', type: 'customer_session', v: 2, contactos, iat: NOW, ...extra }, SECRET, {
    algorithm: 'HS256',
    expiresIn: '30d',
  })
const reqFor = (token?: string) =>
  ({ headers: token === undefined ? {} : { authorization: `Bearer ${token}` }, publicVenue: { id: 'v1' } }) as unknown as Request
const resFor = () => {
  const r: any = {}
  r.status = jest.fn(() => r)
  r.json = jest.fn(() => r)
  r.setHeader = jest.fn(() => r)
  return r as Response
}
const customer = {
  id: 'c1',
  venueId: 'v1',
  active: true,
  versionDeSesion: 2,
  phone: PHONE,
  email: 'ana@ejemplo.mx',
  accountActivatedAt: new Date(0),
}

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(NOW * 1000)
  ;(prisma.customer.findFirst as jest.Mock).mockResolvedValue({ ...customer })
})
afterEach(() => jest.useRealTimers())

it.each([authenticateCustomer, authenticateOrderingCustomerOptional, authenticateCustomerParaCambioDeNumero])(
  'sesión nueva entra a cada uso por su wrapper real',
  async middleware => {
    const req = reqFor(sign())
    const res = resFor()
    const next = jest.fn()
    await middleware(req, res, next)
    expect(next).toHaveBeenCalledTimes(1)
    expect((req as any).customerAuth).toMatchObject({ customerId: 'c1', venueId: 'v1', tipo: 'SESION', contactos, verifiedPhone: PHONE })
    expect(res.setHeader).not.toHaveBeenCalled()
  },
)

it.each([
  ['vacíos', [], { phone: '+525511112222', email: 'no-probado@ejemplo.mx' }, undefined],
  ['PHONE', [contactos[0]], { email: 'no-probado@ejemplo.mx' }, PHONE],
  ['EMAIL', [contactos[1]], { phone: '+525511112222' }, undefined],
] as const)('sesión con contactos %s autentica los tres usos; no prueba campos ajenos', async (_name, probados, data, phone) => {
  ;(prisma.customer.findFirst as jest.Mock).mockResolvedValue({ ...customer, ...data })
  for (const middleware of [authenticateCustomer, authenticateOrderingCustomerOptional, authenticateCustomerParaCambioDeNumero]) {
    const req = reqFor(sign({ contactos: probados }))
    const next = jest.fn()
    await middleware(req, resFor(), next)
    expect(next).toHaveBeenCalledTimes(1)
    expect((req as any).customerAuth).toMatchObject({ tipo: 'SESION', contactos: probados })
    expect((req as any).customerAuth.verifiedPhone).toBe(phone)
  }
})

it.each([
  ['versión anterior', { v: 1 }, {}],
  ['teléfono cambiado', {}, { phone: '+525511112222' }],
  ['correo cambiado', {}, { email: 'otra@ejemplo.mx' }],
  ['correo borrado', {}, { email: null }],
  ['teléfono borrado', {}, { phone: null }],
] as const)('%s rechaza con 401 sin renovar ni degradar', async (_name, claims, data) => {
  ;(prisma.customer.findFirst as jest.Mock).mockResolvedValue({ ...customer, ...data })
  for (const middleware of [authenticateCustomer, authenticateOrderingCustomerOptional, authenticateCustomerParaCambioDeNumero]) {
    const req = reqFor(sign({ iat: NOW - 100_000, ...claims }))
    const res = resFor()
    const next = jest.fn()
    await middleware(req, res, next)
    expect(res.status).toHaveBeenCalledWith(401)
    expect(res.json).toHaveBeenCalledWith({ code: 'CUSTOMER_TOKEN_INVALID', message: 'Token inválido o expirado' })
    expect(next).not.toHaveBeenCalled()
    expect(res.setHeader).not.toHaveBeenCalled()
  }
})

it('formato mexicano equivalente y correo normalizado siguen válidos', async () => {
  ;(prisma.customer.findFirst as jest.Mock).mockResolvedValue({ ...customer, phone: '+5215543453965', email: ' ANA@EJEMPLO.MX ' })
  for (const middleware of [authenticateCustomer, authenticateOrderingCustomerOptional, authenticateCustomerParaCambioDeNumero]) {
    const next = jest.fn()
    await middleware(reqFor(sign()), resFor(), next)
    expect(next).toHaveBeenCalledTimes(1)
  }
})

it.each([0, 86_399, 86_400, 86_401])('renueva sólo con edad estricta > 86400: %s', async age => {
  const res = resFor()
  const next = jest.fn()
  const old = sign({ iat: NOW - age })
  await authenticateCustomer(reqFor(old), res, next)
  expect(next).toHaveBeenCalledTimes(1)
  if (age <= 86_400) return expect(res.setHeader).not.toHaveBeenCalled()
  expect(res.setHeader).toHaveBeenCalledWith('x-customer-session', expect.any(String))
  const renewed = (res.setHeader as jest.Mock).mock.calls[0][1]
  expect(renewed).not.toBe(old)
  expect(jwt.verify(renewed, SECRET, { algorithms: ['HS256'] })).toEqual({
    sub: 'c1',
    venueId: 'v1',
    type: 'customer_session',
    v: 2,
    contactos,
    iat: NOW,
    exp: NOW + 2_592_000,
  })
})

it.each(['customer', 'customer_ordering'])('legacy %s cuenta como v0 aunque intente firmar v alta, nunca se renueva', async type => {
  const token = sign({ type, v: 99, verifiedPhone: PHONE, iat: NOW - 100_000 })
  const middleware = type === 'customer' ? authenticateCustomer : authenticateOrderingCustomerOptional
  const res = resFor()
  await middleware(reqFor(token), res, jest.fn())
  expect(res.status).toHaveBeenCalledWith(401)
  ;(prisma.customer.findFirst as jest.Mock).mockResolvedValue({ ...customer, versionDeSesion: 0 })
  const next = jest.fn()
  const accepted = resFor()
  await middleware(reqFor(token), accepted, next)
  expect(next).toHaveBeenCalledTimes(1)
  expect(accepted.setHeader).not.toHaveBeenCalled()
})

it.each(['', 'Basic x', 'Bearer ', 'Bearer inválido'])('presente inválido %s nunca es invitado', async authorization => {
  const req = reqFor()
  req.headers.authorization = authorization
  const next = jest.fn()
  const res = resFor()
  await authenticateCustomerOptional(req, res, next)
  expect(res.status).toHaveBeenCalledWith(401)
  expect(next).not.toHaveBeenCalled()
})

it('otro venue rechaza ANTES de consultar Customer', async () => {
  ;(prisma.customer.findFirst as jest.Mock).mockClear()
  const res = resFor()
  await authenticateCustomer(reqFor(sign({ venueId: 'otro' })), res, jest.fn())
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'CUSTOMER_TOKEN_VENUE_MISMATCH' }))
  expect(prisma.customer.findFirst).not.toHaveBeenCalled()
})

it.each(['development', 'staging', 'production'] as const)('CORS global %s expone renovación', env => {
  expect(getCorsConfig(env).exposedHeaders).toContain('x-customer-session')
})

it('invitado y legacy no abren activación de reservas', async () => {
  for (const auth of [null, { tipo: 'RESERVAS_DE_HOY' }, { tipo: 'PEDIDOS_DE_HOY' }, { tipo: 'SESION', accountActivatedAt: new Date() }]) {
    const req = reqFor()
    ;(req as any).customerAuth = auth
    const next = jest.fn()
    await activarReservasSiFalta(req, resFor(), next)
    expect(next).toHaveBeenCalledTimes(1)
  }
  expect(prisma.$transaction).not.toHaveBeenCalled()
})

it.each([
  ['customer', authenticateCustomer, true, 'RESERVAS_DE_HOY'],
  ['customer', authenticateOrderingCustomerOptional, false, 'CUSTOMER_TOKEN_INVALID'],
  ['customer', authenticateCustomerParaCambioDeNumero, false, 'CUSTOMER_REAUTH_REQUIRED'],
  ['customer_ordering', authenticateCustomer, false, 'CUSTOMER_TOKEN_INVALID'],
  ['customer_ordering', authenticateOrderingCustomerOptional, true, 'PEDIDOS_DE_HOY'],
  ['customer_ordering', authenticateCustomerParaCambioDeNumero, true, 'PEDIDOS_DE_HOY'],
] as const)('legacy %s x uso conserva su frontera', async (type, middleware, allowed, expected) => {
  ;(prisma.customer.findFirst as jest.Mock).mockResolvedValue({ ...customer, versionDeSesion: 0 })
  const req = reqFor(sign({ type, verifiedPhone: PHONE }))
  const res = resFor()
  const next = jest.fn()
  await middleware(req, res, next)
  if (allowed) {
    expect(next).toHaveBeenCalledTimes(1)
    expect((req as any).customerAuth).toMatchObject({ tipo: expected, contactos: [] })
  } else {
    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(401)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: expected }))
  }
})
it.each([
  ['malformado', 'basura', 'CUSTOMER_TOKEN_INVALID'],
  ['vencido', sign({ type: 'customer', iat: NOW - 3_000_000 }), 'CUSTOMER_TOKEN_INVALID'],
  ['otro negocio', sign({ type: 'customer', venueId: 'otro' }), 'CUSTOMER_TOKEN_VENUE_MISMATCH'],
] as const)('CAMBIO no confunde %s con reautenticación', async (_name, token, code) => {
  const res = resFor()
  await authenticateCustomerParaCambioDeNumero(reqFor(token), res, jest.fn())
  expect(res.status).toHaveBeenCalledWith(401)
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code }))
})
it.each([
  ['RESERVAS', 'customer', authenticateCustomer, 'RESERVAS_DE_HOY'],
  ['PEDIDOS', 'customer_ordering', authenticateOrderingCustomerOptional, 'PEDIDOS_DE_HOY'],
  ['CAMBIO_DE_NUMERO', 'customer_ordering', authenticateCustomerParaCambioDeNumero, 'PEDIDOS_DE_HOY'],
] as const)('legacy en %s sin iat/exp conserva su contexto sin fabricar fecha de prueba', async (_uso, type, middleware, tipo) => {
  ;(prisma.customer.findFirst as jest.Mock).mockResolvedValue({ ...customer, versionDeSesion: 0 })
  const token = jwt.sign({ sub: 'c1', venueId: 'v1', type, ...(type === 'customer_ordering' ? { verifiedPhone: PHONE } : {}) }, SECRET, {
    noTimestamp: true,
  })
  const req = reqFor(token)
  const res = resFor()
  const next = jest.fn()
  await middleware(req, res, next)
  expect(next).toHaveBeenCalledTimes(1)
  expect((req as any).customerAuth).toMatchObject({ tipo, contactos: [] })
  expect((req as any).customerAuth.verifiedPhone).toBe(type === 'customer_ordering' ? PHONE : undefined)
  expect(res.setHeader).not.toHaveBeenCalled()
})

it.each(['customer', 'customer_ordering'])('CAMBIO corta legacy %s revocado antes de considerar reautenticación', async type => {
  const res = resFor()
  const next = jest.fn()
  await authenticateCustomerParaCambioDeNumero(reqFor(sign({ type, v: 99, verifiedPhone: PHONE })), res, next)
  expect(res.status).toHaveBeenCalledWith(401)
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'CUSTOMER_TOKEN_INVALID' }))
  expect(next).not.toHaveBeenCalled()
  expect(res.setHeader).not.toHaveBeenCalled()
})

it('cabecera presente con forma no textual tampoco degrada ni responde error interno', async () => {
  const req = reqFor()
  req.headers.authorization = ['Bearer x', 'Bearer y'] as any
  const res = resFor()
  const next = jest.fn()
  await authenticateOrderingCustomerOptional(req, res, next)
  expect(res.status).toHaveBeenCalledWith(401)
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'CUSTOMER_TOKEN_INVALID' }))
  expect(next).not.toHaveBeenCalled()
})

it.each([
  ['formato mexicano equivalente', '+5215543453965', true],
  ['teléfono cambiado', '+525511112222', false],
  ['teléfono borrado', null, false],
] as const)('ordering legacy: %s en cada uso permitido', async (_name, phone, accepted) => {
  ;(prisma.customer.findFirst as jest.Mock).mockResolvedValue({ ...customer, versionDeSesion: 0, phone })
  for (const middleware of [authenticateOrderingCustomerOptional, authenticateCustomerParaCambioDeNumero]) {
    const req = reqFor(sign({ type: 'customer_ordering', verifiedPhone: PHONE }))
    const res = resFor()
    const next = jest.fn()
    await middleware(req, res, next)
    if (accepted) {
      expect(next).toHaveBeenCalledTimes(1)
      expect((req as any).customerAuth).toMatchObject({ tipo: 'PEDIDOS_DE_HOY', contactos: [], verifiedPhone: PHONE })
    } else {
      expect(next).not.toHaveBeenCalled()
      expect(res.status).toHaveBeenCalledWith(401)
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'CUSTOMER_TOKEN_INVALID' }))
    }
    expect(res.setHeader).not.toHaveBeenCalled()
  }
})
