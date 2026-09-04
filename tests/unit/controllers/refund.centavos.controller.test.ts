jest.mock('@/services/dashboard/refund.dashboard.service', () => ({ issueRefund: jest.fn() }))
jest.mock('@/services/mobile/refund.mobile.service', () => ({ createRefund: jest.fn() }))
jest.mock('@/services/tpv/refund.tpv.service', () => ({ recordRefund: jest.fn() }))

import * as dashboardController from '@/controllers/dashboard/refund.dashboard.controller'
import * as mobileController from '@/controllers/mobile/refund.mobile.controller'
import * as tpvController from '@/controllers/tpv/refund.tpv.controller'
import * as dashboardService from '@/services/dashboard/refund.dashboard.service'
import * as mobileService from '@/services/mobile/refund.mobile.service'
import * as tpvService from '@/services/tpv/refund.tpv.service'

const dashboardIssueRefund = dashboardService.issueRefund as jest.Mock
const mobileCreateRefund = mobileService.createRefund as jest.Mock
const tpvRecordRefund = tpvService.recordRefund as jest.Mock

function response() {
  const res: any = {}
  res.status = jest.fn(() => res)
  res.json = jest.fn(() => res)
  return res
}

function request(body: Record<string, unknown>) {
  return {
    params: { venueId: 'venue-1', paymentId: 'payment-1' },
    body,
    authContext: { userId: 'staff-1', orgId: 'org-1' },
    header: jest.fn(),
  } as any
}

describe('controladores de refund — centavos enteros seguros', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    dashboardIssueRefund.mockResolvedValue({ refundId: 'refund-1' })
    mobileCreateRefund.mockResolvedValue({ refundId: 'refund-1' })
    tpvRecordRefund.mockResolvedValue({ id: 'refund-1' })
  })

  it('dashboard rechaza amount fraccionario con 400 antes del servicio', async () => {
    const res = response()

    await dashboardController.issueRefund(request({ amount: 0.5, reason: 'RETURNED_GOODS' }), res, jest.fn())

    expect(res.status).toHaveBeenCalledWith(400)
    expect(dashboardIssueRefund).not.toHaveBeenCalled()
  })

  it('mobile asociado rechaza tipRefundCents fraccionario con 400 antes del servicio', async () => {
    const res = response()

    await mobileController.issueAssociatedRefund(request({ amount: 1000, tipRefundCents: 0.5, reason: 'RETURNED_GOODS' }), res, jest.fn())

    expect(res.status).toHaveBeenCalledWith(400)
    expect(dashboardIssueRefund).not.toHaveBeenCalled()
  })

  it.each([Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY, Number.NaN])(
    'TPV rechaza amount=%p inseguro/no finito con 400 antes del servicio',
    async amount => {
      const res = response()

      await tpvController.recordRefund(request({ amount }), res, jest.fn())

      expect(res.status).toHaveBeenCalledWith(400)
      expect(tpvRecordRefund).not.toHaveBeenCalled()
    },
  )

  it('mobile no asociado rechaza amount no finito con 400 antes del servicio', async () => {
    const res = response()

    await mobileController.createRefund(request({ amount: Number.POSITIVE_INFINITY, reason: 'x', method: 'CASH' }), res, jest.fn())

    expect(res.status).toHaveBeenCalledWith(400)
    expect(mobileCreateRefund).not.toHaveBeenCalled()
  })
})
