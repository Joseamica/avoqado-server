import type { NextFunction, Request, Response } from 'express'

const mockAttach = jest.fn()
const mockAttachLatest = jest.fn()
jest.mock('@/services/mobile/order.mobile.service', () => ({
  attachCustomerToPayment: (...a: unknown[]) => mockAttach(...a),
  attachCustomerToLatestPayment: (...a: unknown[]) => mockAttachLatest(...a),
}))

import { attachCustomerToLatestPayment, attachCustomerToPayment } from '@/controllers/mobile/payment.mobile.controller'

function res() {
  const r: any = {}
  r.status = jest.fn(() => r)
  r.json = jest.fn(() => r)
  return r as Response & { status: jest.Mock; json: jest.Mock }
}
const next = jest.fn() as NextFunction

describe('payment.mobile.controller — el actor sale del token', () => {
  beforeEach(() => jest.clearAllMocks())

  it('attachCustomerToPayment pasa authContext.userId y responde data con loyalty', async () => {
    mockAttach.mockResolvedValue({ id: 'order-1', loyalty: { stamped: true } })
    const r = res()
    await attachCustomerToPayment(
      { params: { venueId: 'v1', paymentId: 'p1' }, body: { customerId: 'c1' }, authContext: { userId: 'staff-1' } } as unknown as Request,
      r,
      next,
    )
    expect(mockAttach).toHaveBeenCalledWith('v1', 'p1', 'c1', 'staff-1')
    expect(r.json).toHaveBeenCalledWith({
      success: true,
      data: { id: 'order-1', loyalty: { stamped: true } },
      message: 'Customer attached to payment successfully',
    })
  })

  it('attachCustomerToLatestPayment: staffId del body filtra; actorStaffId = authContext.userId', async () => {
    mockAttachLatest.mockResolvedValue({ id: 'order-1', loyalty: null })
    await attachCustomerToLatestPayment(
      {
        params: { venueId: 'v1' },
        body: { customerId: 'c1', amountCents: 5000, tipCents: 0, staffId: 'cobro-staff' },
        authContext: { userId: 'quien-ligo' },
      } as unknown as Request,
      res(),
      next,
    )
    expect(mockAttachLatest).toHaveBeenCalledWith('v1', {
      customerId: 'c1',
      amountCents: 5000,
      tipCents: 0,
      staffId: 'cobro-staff',
      actorStaffId: 'quien-ligo',
    })
  })

  it('regresión: un error del servicio va a next (el middleware de errores responde), nunca un 200', async () => {
    const boom = new Error('boom')
    mockAttach.mockRejectedValue(boom)
    const r = res()
    await attachCustomerToPayment(
      { params: { venueId: 'v1', paymentId: 'p1' }, body: { customerId: 'c1' }, authContext: { userId: 'staff-1' } } as unknown as Request,
      r,
      next,
    )
    expect(next).toHaveBeenCalledWith(boom)
    expect(r.json).not.toHaveBeenCalled()
  })
})
