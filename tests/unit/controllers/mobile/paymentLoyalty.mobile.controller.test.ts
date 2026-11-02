import fs from 'fs'
import path from 'path'
import type { NextFunction, Request, Response } from 'express'
import { NotFoundError } from '@/errors/AppError'

const mockAttach = jest.fn()
const mockAttachLatest = jest.fn()
jest.mock('@/middlewares/customerAttribution.middleware', () => ({
  customerAttributionActor: async (req: any) => ({
    staffId: req.authContext?.userId,
    canAttachAtReceipt: true,
    canAssignHistorical: false,
  }),
}))
jest.mock('@/services/mobile/order.mobile.service', () => ({
  attachCustomerToPayment: (...a: unknown[]) => mockAttach(...a),
  attachCustomerToLatestPayment: (...a: unknown[]) => mockAttachLatest(...a),
}))
const mockDescribe = jest.fn()
jest.mock('@/services/shared/loyaltyOnLateCustomer', () => ({ describeSaleStampForPayment: (...a: unknown[]) => mockDescribe(...a) }))

import { attachCustomerToLatestPayment, attachCustomerToPayment, getPaymentLoyalty } from '@/controllers/mobile/payment.mobile.controller'

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
    expect(mockAttach).toHaveBeenCalledWith('v1', 'p1', 'c1', 'staff-1', {
      actor: { staffId: 'staff-1', canAttachAtReceipt: true, canAssignHistorical: false },
    })
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
      actor: { staffId: 'quien-ligo', canAttachAtReceipt: true, canAssignHistorical: false },
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

describe('GET /mobile/venues/:venueId/payments/:paymentId/loyalty', () => {
  beforeEach(() => jest.clearAllMocks())

  it('responde { success, data } con el resultado del sello', async () => {
    const SELLO = { stampsEnabled: true, stamped: false, reason: 'PENDING', stampsEarned: 2, stampsRequired: 7, rewardReady: false }
    mockDescribe.mockResolvedValue(SELLO)
    const r = res()
    await getPaymentLoyalty({ params: { venueId: 'v1', paymentId: 'p1' } } as unknown as Request, r, next)
    expect(mockDescribe).toHaveBeenCalledWith({ venueId: 'v1', paymentId: 'p1' })
    expect(r.status).toHaveBeenCalledWith(200)
    expect(r.json).toHaveBeenCalledWith({ success: true, data: SELLO })
  })

  it('venta sin cliente: data null', async () => {
    mockDescribe.mockResolvedValue(null)
    const r = res()
    await getPaymentLoyalty({ params: { venueId: 'v1', paymentId: 'p1' } } as unknown as Request, r, next)
    expect(r.json).toHaveBeenCalledWith({ success: true, data: null })
  })

  it('pago de otro negocio: el 404 del servicio va a next', async () => {
    const n = jest.fn()
    mockDescribe.mockRejectedValue(new NotFoundError('Pago no encontrado'))
    const r = res()
    await getPaymentLoyalty({ params: { venueId: 'v1', paymentId: 'ajeno' } } as unknown as Request, r, n as NextFunction)
    expect(n).toHaveBeenCalledWith(expect.any(NotFoundError))
    expect(r.json).not.toHaveBeenCalled()
  })

  it('🔴 la ruta exige token y loyalty:read (guardia estática)', () => {
    const rutas = fs.readFileSync(path.join(__dirname, '../../../../src/routes/mobile.routes.ts'), 'utf8')
    expect(rutas).toMatch(
      /'\/venues\/:venueId\/payments\/:paymentId\/loyalty',\s*authenticateTokenMiddleware,\s*checkPermission\('loyalty:read'\),\s*paymentMobileController\.getPaymentLoyalty/,
    )
    // Es una LECTURA: va por GET (nunca un POST que la app pudiera confundir con «ligar»).
    expect(rutas).toMatch(/router\.get\(\s*'\/venues\/:venueId\/payments\/:paymentId\/loyalty'/)
  })
})
