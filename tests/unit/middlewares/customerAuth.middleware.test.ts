/**
 * Customer Auth Middleware — Fase 0.B (identidad atada al venue)
 *
 * Contrato (FASE-0-fundacion-design.md v5, §0.B):
 *
 *   sin header · obligatorio                → 401 CUSTOMER_AUTH_REQUIRED
 *   sin header · optional                   → req.customerAuth = null, next()
 *   header sin "Bearer " / vacío            → 401 CUSTOMER_TOKEN_INVALID
 *   firma inválida / expirado / type≠customer → 401 CUSTOMER_TOKEN_INVALID
 *   payload.venueId ≠ venue resuelto        → 401 CUSTOMER_TOKEN_VENUE_MISMATCH
 *   Customer {id, venueId} no existe        → 401 CUSTOMER_TOKEN_INVALID  (no revelar)
 *   Customer.active = false                 → 401 CUSTOMER_INACTIVE
 *   ok                                      → req.customerAuth = { customerId, venueId }
 *
 * Regla única: cualquier Authorization PRESENTE se valida; nunca se degrada a invitado.
 * El venue llega ya resuelto en req.publicVenue (lo pone resolveVenueBySlug).
 */

import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { authenticateCustomer, authenticateCustomerOptional } from '@/middlewares/customerAuth.middleware'
import prisma from '@/utils/prismaClient'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    customer: { findFirst: jest.fn() },
  },
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

// El secreto que usa jwt.service en tests. Se lee del mismo env para que un token
// firmado aquí sea verificable por el código real — sin mockear verifyCustomerToken.
const SECRET = process.env.ACCESS_TOKEN_SECRET || 'test-access-secret'

function sign(payload: Record<string, unknown>, opts: jwt.SignOptions = {}) {
  return jwt.sign(payload, SECRET, { algorithm: 'HS256', expiresIn: '1h', ...opts })
}

function mkReq(overrides: Partial<Request> & { publicVenue?: { id: string; slug: string } } = {}): Request {
  return {
    headers: {},
    params: {},
    publicVenue: { id: 'venue_A', slug: 'estudio-a' },
    ...overrides,
  } as unknown as Request
}

function mkRes() {
  const res: Partial<Response> = {}
  res.status = jest.fn().mockReturnValue(res)
  res.json = jest.fn().mockReturnValue(res)
  return res as Response
}

const customerFindFirst = prisma.customer.findFirst as jest.Mock

beforeAll(() => {
  process.env.ACCESS_TOKEN_SECRET = SECRET
})

beforeEach(() => {
  jest.clearAllMocks()
})

describe('authenticateCustomer (obligatorio)', () => {
  it('sin header → 401 CUSTOMER_AUTH_REQUIRED', async () => {
    const req = mkReq()
    const res = mkRes()
    const next = jest.fn() as NextFunction

    await authenticateCustomer(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(401)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'CUSTOMER_AUTH_REQUIRED' }))
  })

  it('header sin "Bearer " → 401 CUSTOMER_TOKEN_INVALID, nunca invitado', async () => {
    const req = mkReq({ headers: { authorization: 'Basic abc' } } as any)
    const res = mkRes()
    const next = jest.fn() as NextFunction

    await authenticateCustomer(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'CUSTOMER_TOKEN_INVALID' }))
  })

  it('"Bearer " vacío → 401 CUSTOMER_TOKEN_INVALID', async () => {
    const req = mkReq({ headers: { authorization: 'Bearer ' } } as any)
    const res = mkRes()
    const next = jest.fn() as NextFunction

    await authenticateCustomer(req, res, next)

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'CUSTOMER_TOKEN_INVALID' }))
  })

  it('firma inválida → 401 CUSTOMER_TOKEN_INVALID', async () => {
    const bad = jwt.sign({ sub: 'c1', venueId: 'venue_A', type: 'customer' }, 'otro-secreto')
    const req = mkReq({ headers: { authorization: `Bearer ${bad}` } } as any)
    const res = mkRes()
    const next = jest.fn() as NextFunction

    await authenticateCustomer(req, res, next)

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'CUSTOMER_TOKEN_INVALID' }))
  })

  it('expirado → 401 CUSTOMER_TOKEN_INVALID', async () => {
    const expired = sign({ sub: 'c1', venueId: 'venue_A', type: 'customer' }, { expiresIn: -10 })
    const req = mkReq({ headers: { authorization: `Bearer ${expired}` } } as any)
    const res = mkRes()
    const next = jest.fn() as NextFunction

    await authenticateCustomer(req, res, next)

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'CUSTOMER_TOKEN_INVALID' }))
  })

  it('type ≠ customer (token de staff) → 401 CUSTOMER_TOKEN_INVALID', async () => {
    const staff = sign({ sub: 'staff1', venueId: 'venue_A', type: 'staff' })
    const req = mkReq({ headers: { authorization: `Bearer ${staff}` } } as any)
    const res = mkRes()
    const next = jest.fn() as NextFunction

    await authenticateCustomer(req, res, next)

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'CUSTOMER_TOKEN_INVALID' }))
  })

  it('token de venue A presentado en venue B → 401 CUSTOMER_TOKEN_VENUE_MISMATCH', async () => {
    const tokenA = sign({ sub: 'c1', venueId: 'venue_A', type: 'customer' })
    const req = mkReq({
      headers: { authorization: `Bearer ${tokenA}` },
      publicVenue: { id: 'venue_B', slug: 'estudio-b' },
    } as any)
    const res = mkRes()
    const next = jest.fn() as NextFunction

    await authenticateCustomer(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'CUSTOMER_TOKEN_VENUE_MISMATCH' }))
    // No debe ni consultar la DB: el mismatch se decide antes.
    expect(customerFindFirst).not.toHaveBeenCalled()
  })

  it('Customer no existe (token bien firmado) → 401 CUSTOMER_TOKEN_INVALID, sin revelar', async () => {
    customerFindFirst.mockResolvedValue(null)
    const token = sign({ sub: 'c_borrado', venueId: 'venue_A', type: 'customer' })
    const req = mkReq({ headers: { authorization: `Bearer ${token}` } } as any)
    const res = mkRes()
    const next = jest.fn() as NextFunction

    await authenticateCustomer(req, res, next)

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'CUSTOMER_TOKEN_INVALID' }))
    expect(customerFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'c_borrado', venueId: 'venue_A' }) }),
    )
  })

  it('Customer.active=false → 401 CUSTOMER_INACTIVE', async () => {
    customerFindFirst.mockResolvedValue({ id: 'c1', venueId: 'venue_A', active: false })
    const token = sign({ sub: 'c1', venueId: 'venue_A', type: 'customer' })
    const req = mkReq({ headers: { authorization: `Bearer ${token}` } } as any)
    const res = mkRes()
    const next = jest.fn() as NextFunction

    await authenticateCustomer(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'CUSTOMER_INACTIVE' }))
  })

  it('ok → req.customerAuth = { customerId, venueId } y next()', async () => {
    customerFindFirst.mockResolvedValue({ id: 'c1', venueId: 'venue_A', active: true })
    const token = sign({ sub: 'c1', venueId: 'venue_A', type: 'customer' })
    const req = mkReq({ headers: { authorization: `Bearer ${token}` } } as any)
    const res = mkRes()
    const next = jest.fn() as NextFunction

    await authenticateCustomer(req, res, next)

    expect(res.status).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledTimes(1)
    expect((req as any).customerAuth).toEqual({ customerId: 'c1', venueId: 'venue_A' })
  })

  it('sin req.publicVenue (ruta mal cableada) → 500, nunca deja pasar', async () => {
    const token = sign({ sub: 'c1', venueId: 'venue_A', type: 'customer' })
    const req = mkReq({ headers: { authorization: `Bearer ${token}` }, publicVenue: undefined } as any)
    const res = mkRes()
    const next = jest.fn() as NextFunction

    await authenticateCustomer(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(500)
  })
})

describe('authenticateCustomerOptional', () => {
  it('sin header → req.customerAuth = null y next() (invitado)', async () => {
    const req = mkReq()
    const res = mkRes()
    const next = jest.fn() as NextFunction

    await authenticateCustomerOptional(req, res, next)

    expect(res.status).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledTimes(1)
    expect((req as any).customerAuth).toBeNull()
  })

  it('header PRESENTE pero vacío ("") → 401 CUSTOMER_TOKEN_INVALID, NO degrada a invitado', async () => {
    // Un cliente que manda `Authorization: ` vacío está mal configurado; no es un invitado.
    const req = mkReq({ headers: { authorization: '' } } as any)
    const res = mkRes()
    const next = jest.fn() as NextFunction

    await authenticateCustomerOptional(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'CUSTOMER_TOKEN_INVALID' }))
  })

  it('header PRESENTE pero inválido → 401, NO degrada a invitado', async () => {
    const req = mkReq({ headers: { authorization: 'Bearer basura' } } as any)
    const res = mkRes()
    const next = jest.fn() as NextFunction

    await authenticateCustomerOptional(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'CUSTOMER_TOKEN_INVALID' }))
  })

  it('token de otro venue → 401 CUSTOMER_TOKEN_VENUE_MISMATCH, NO degrada a invitado', async () => {
    const tokenA = sign({ sub: 'c1', venueId: 'venue_A', type: 'customer' })
    const req = mkReq({
      headers: { authorization: `Bearer ${tokenA}` },
      publicVenue: { id: 'venue_B', slug: 'estudio-b' },
    } as any)
    const res = mkRes()
    const next = jest.fn() as NextFunction

    await authenticateCustomerOptional(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'CUSTOMER_TOKEN_VENUE_MISMATCH' }))
  })

  it('token válido → req.customerAuth poblado y next()', async () => {
    customerFindFirst.mockResolvedValue({ id: 'c1', venueId: 'venue_A', active: true })
    const token = sign({ sub: 'c1', venueId: 'venue_A', type: 'customer' })
    const req = mkReq({ headers: { authorization: `Bearer ${token}` } } as any)
    const res = mkRes()
    const next = jest.fn() as NextFunction

    await authenticateCustomerOptional(req, res, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect((req as any).customerAuth).toEqual({ customerId: 'c1', venueId: 'venue_A' })
  })
})

describe('regresión — comportamiento anterior que NO debe volver', () => {
  it('el middleware obligatorio ya no responde con {message} sin code', async () => {
    const req = mkReq()
    const res = mkRes()
    await authenticateCustomer(req, res, jest.fn() as NextFunction)
    const body = (res.json as jest.Mock).mock.calls[0][0]
    expect(body.code).toBeDefined()
    expect(typeof body.message).toBe('string')
  })
})
