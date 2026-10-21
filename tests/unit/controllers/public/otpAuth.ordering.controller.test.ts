jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { venue: { findFirst: jest.fn(async () => ({ id: 'venue-1' })) } },
}))
jest.mock('@/services/public/otpAuth.public.service', () => ({
  __esModule: true,
  requestOtp: jest.fn(),
  verifyOtp: jest.fn(async () => ({ token: 't', approvalStatus: 'PENDING', customer: { id: 'c1' } })),
}))
jest.mock('@/services/public/bookingAccess.service', () => ({
  __esModule: true,
  computeBookingAccess: jest.fn(async () => ({ status: 'PENDING', canCreateReservation: false, blockedBy: 'APPROVAL' })),
  withBookingAccess: jest.requireActual('@/services/public/bookingAccess.service').withBookingAccess,
}))

import * as otpController from '@/controllers/public/otpAuth.public.controller'
import * as otpService from '@/services/public/otpAuth.public.service'
import { computeBookingAccess } from '@/services/public/bookingAccess.service'

function mkRes() {
  const res: any = {}
  res.status = jest.fn(() => res)
  res.json = jest.fn((b: unknown) => {
    res.body = b
    return res
  })
  return res
}

const BODY = { phone: '+525511111111', code: '123456' }

describe('POST otp/verify: forma de la respuesta con y sin purpose ORDERING (H1)', () => {
  it('🔴 con purpose ORDERING responde SÓLO { token, customer }: ni approvalStatus ni bookingAccess', async () => {
    const res = mkRes()
    await otpController.verifyOtp({ params: { venueSlug: 'v' }, body: { ...BODY, purpose: 'ORDERING' } } as any, res, jest.fn())
    expect(otpService.verifyOtp).toHaveBeenCalledWith({
      venueId: 'venue-1',
      channel: 'whatsapp',
      destination: BODY.phone,
      code: BODY.code,
      purpose: 'ORDERING',
    })
    expect(res.body).toEqual({ token: 't', customer: { id: 'c1' } })
    expect(computeBookingAccess).not.toHaveBeenCalled()
  })

  it('sin purpose la respuesta no cambia: { token, approvalStatus, customer, bookingAccess }', async () => {
    const res = mkRes()
    await otpController.verifyOtp({ params: { venueSlug: 'v' }, body: BODY } as any, res, jest.fn())
    expect(otpService.verifyOtp).toHaveBeenCalledWith({ venueId: 'venue-1', channel: 'whatsapp', destination: BODY.phone, code: BODY.code })
    expect(res.body).toEqual({
      token: 't',
      approvalStatus: 'PENDING',
      customer: { id: 'c1' },
      bookingAccess: { status: 'PENDING', canCreateReservation: false, blockedBy: 'APPROVAL' },
    })
  })
})
