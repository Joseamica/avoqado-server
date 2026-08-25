jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { venue: { findFirst: jest.fn(async () => ({ id: 'venue-1', name: 'V', slug: 'v' })) } },
}))
jest.mock('@/services/public/customerPortal.public.service', () => ({
  __esModule: true,
  registerCustomer: jest.fn(async () => ({ token: 't', customer: { id: 'c1' } })),
  loginCustomer: jest.fn(async () => ({ token: 't', customer: { id: 'c1' } })),
  getCustomerPortal: jest.fn(async () => ({
    customer: { id: 'c1' },
    credits: { purchases: [] },
    reservations: { upcoming: [], past: [] },
  })),
  updateProfile: jest.fn(),
}))
jest.mock('@/services/public/otpAuth.public.service', () => ({
  __esModule: true,
  requestOtp: jest.fn(),
  verifyOtp: jest.fn(async () => ({ token: 't', customer: { id: 'c1' } })),
}))
jest.mock('@/services/public/bookingAccess.service', () => ({
  __esModule: true,
  computeBookingAccess: jest.fn(async () => ({ status: 'APPROVED', canCreateReservation: false, blockedBy: 'PLAN' })),
  withBookingAccess: jest.requireActual('@/services/public/bookingAccess.service').withBookingAccess,
}))

import * as portalController from '@/controllers/public/customerPortal.public.controller'
import * as otpController from '@/controllers/public/otpAuth.public.controller'
import { computeBookingAccess } from '@/services/public/bookingAccess.service'

/**
 * Fase 0.B — las CUATRO respuestas autenticadas llevan `bookingAccess` (login, register,
 * otp/verify, GET portal), calculado para el venue del slug. `getVenueInfo` (anónimo) no.
 */
function mkRes() {
  const res: any = { statusCode: 200 }
  res.status = jest.fn((c: number) => {
    res.statusCode = c
    return res
  })
  res.json = jest.fn((b: unknown) => {
    res.body = b
    return res
  })
  return res
}

const EXPECTED = { status: 'APPROVED', canCreateReservation: false, blockedBy: 'PLAN' }

describe('bookingAccess en las 4 respuestas autenticadas', () => {
  beforeEach(() => jest.clearAllMocks())

  it('POST login → { token, customer, bookingAccess }', async () => {
    const res = mkRes()
    await portalController.login({ params: { venueSlug: 'v' }, body: { email: 'a@b.com', password: 'x' } } as any, res, jest.fn())
    expect(res.body).toEqual(expect.objectContaining({ token: 't', bookingAccess: EXPECTED }))
    // Fase 1: se pasa el customerId para leer su estado de aprobación real.
    expect(computeBookingAccess).toHaveBeenCalledWith('venue-1', 'c1')
  })

  it('POST register → 201 { token, customer, bookingAccess }', async () => {
    const res = mkRes()
    await portalController.register(
      { params: { venueSlug: 'v' }, body: { email: 'a@b.com', password: 'Secreto123' } } as any,
      res,
      jest.fn(),
    )
    expect(res.statusCode).toBe(201)
    expect(res.body).toEqual(expect.objectContaining({ token: 't', bookingAccess: EXPECTED }))
  })

  it('POST otp/verify → { token, customer, bookingAccess }', async () => {
    const res = mkRes()
    await otpController.verifyOtp({ params: { venueSlug: 'v' }, body: { phone: '+525511111111', code: '123456' } } as any, res, jest.fn())
    expect(res.body).toEqual(expect.objectContaining({ token: 't', bookingAccess: EXPECTED }))
  })

  it('GET portal → { customer, credits, reservations, bookingAccess } para el venue del token', async () => {
    const res = mkRes()
    await portalController.getPortal({ customerAuth: { customerId: 'c1', venueId: 'venue-1' } } as any, res, jest.fn())
    expect(res.body).toEqual(expect.objectContaining({ bookingAccess: EXPECTED }))
    // Fase 1: se pasa el customerId para leer su estado de aprobación real.
    expect(computeBookingAccess).toHaveBeenCalledWith('venue-1', 'c1')
  })

  it('🔴 si bookingAccess no se pudo calcular (null) → login responde 200 SIN el campo; el token ya emitido nunca se pierde (auditoría 4)', async () => {
    ;(computeBookingAccess as jest.Mock).mockResolvedValueOnce(null)
    const res = mkRes()
    await portalController.login({ params: { venueSlug: 'v' }, body: { email: 'a@b.com', password: 'x' } } as any, res, jest.fn())
    expect(res.statusCode).toBe(200)
    expect(res.body.token).toBe('t')
    expect('bookingAccess' in res.body).toBe(false)
  })

  it('si el servicio de auth falla, NO se consulta bookingAccess (el error manda)', async () => {
    const { loginCustomer } = jest.requireMock('@/services/public/customerPortal.public.service')
    ;(loginCustomer as jest.Mock).mockRejectedValueOnce(Object.assign(new Error('nope'), { statusCode: 401 }))
    const next = jest.fn()
    await portalController.login({ params: { venueSlug: 'v' }, body: { email: 'a@b.com', password: 'x' } } as any, mkRes(), next)
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }))
    expect(computeBookingAccess).not.toHaveBeenCalled()
  })
})
