import type { Request, Response } from 'express'
import { prismaMock } from '@tests/__helpers__/setup'

const mockVerify = jest.fn()
jest.mock('@/services/public/otpAuth.public.service', () => ({ verifyOtp: (...a: unknown[]) => mockVerify(...a), requestOtp: jest.fn() }))
jest.mock('@/services/public/bookingAccess.service', () => ({
  computeBookingAccess: jest.fn(async () => ({ allowed: true })),
  withBookingAccess: (b: unknown) => ({ bookingAccess: b }),
}))

import { verifyOtp } from '@/controllers/public/otpAuth.public.controller'

describe('POST /public/venues/:venueSlug/auth/otp/verify — firstName', () => {
  it('pasa firstName al servicio (validateRequest lo deja pasar porque el schema lo declara)', async () => {
    prismaMock.venue.findFirst.mockResolvedValue({ id: 'v1' } as any)
    mockVerify.mockResolvedValue({ token: 't', approvalStatus: 'APPROVED', customer: { id: 'c1' } })
    const res = { json: jest.fn() } as unknown as Response
    const next = jest.fn()
    await verifyOtp(
      { params: { venueSlug: 'cafe' }, body: { phone: '5543453965', code: '123456', firstName: 'Dany' } } as unknown as Request,
      res,
      next,
    )
    expect(next).not.toHaveBeenCalled()
    expect(mockVerify).toHaveBeenCalledWith({
      venueId: 'v1',
      channel: 'whatsapp',
      destination: '5543453965',
      code: '123456',
      firstName: 'Dany',
    })
  })
})
