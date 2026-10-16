import type { NextFunction, Request, Response } from 'express'
import { generateCustomerToken, generateOrderingCustomerToken } from '@/jwt.service'
import { authenticateCustomer, authenticateOrderingCustomerOptional } from '@/middlewares/customerAuth.middleware'
import prisma from '@/utils/prismaClient'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { customer: { findFirst: jest.fn() } },
}))
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

const PHONE = '+525543453965'
const mkReq = (token?: string) =>
  ({
    headers: token ? { authorization: `Bearer ${token}` } : {},
    params: {},
    publicVenue: { id: 'venue_A', slug: 'estudio-a' },
  }) as unknown as Request
const mkRes = () => {
  const r: any = {}
  r.status = jest.fn(() => r)
  r.json = jest.fn(() => r)
  return r as Response
}

beforeEach(() => {
  ;(prisma.customer.findFirst as jest.Mock).mockResolvedValue({ id: 'c1', venueId: 'venue_A', active: true })
})

describe('middleware de pedidos (H1)', () => {
  it('el token de pedidos expone el teléfono verificado en req.customerAuth', async () => {
    const req = mkReq(generateOrderingCustomerToken('c1', 'venue_A', PHONE))
    const next = jest.fn() as NextFunction
    await authenticateOrderingCustomerOptional(req, mkRes(), next)
    expect(next).toHaveBeenCalledTimes(1)
    expect((req as any).customerAuth).toEqual({ customerId: 'c1', venueId: 'venue_A', verifiedPhone: PHONE })
  })

  it('🔴 un token de cliente general en la ruta de pedidos es 401 CUSTOMER_TOKEN_INVALID', async () => {
    const res = mkRes()
    const next = jest.fn()
    await authenticateOrderingCustomerOptional(mkReq(generateCustomerToken('c1', 'venue_A')), res, next)
    expect(res.status).toHaveBeenCalledWith(401)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'CUSTOMER_TOKEN_INVALID' }))
    expect(next).not.toHaveBeenCalled()
  })

  it('sin cabecera sigue como invitado (el servicio responde 401 PHONE_VERIFICATION_REQUIRED)', async () => {
    const req = mkReq()
    const next = jest.fn()
    await authenticateOrderingCustomerOptional(req, mkRes(), next)
    expect(next).toHaveBeenCalledTimes(1)
    expect((req as any).customerAuth).toBeNull()
  })

  it('🔴 el token de pedidos en una ruta de reservas (authenticateCustomer) es 401: no se salta la aprobación', async () => {
    const res = mkRes()
    const next = jest.fn()
    await authenticateCustomer(mkReq(generateOrderingCustomerToken('c1', 'venue_A', PHONE)), res, next)
    expect(res.status).toHaveBeenCalledWith(401)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'CUSTOMER_TOKEN_INVALID' }))
    expect(next).not.toHaveBeenCalled()
  })
})
