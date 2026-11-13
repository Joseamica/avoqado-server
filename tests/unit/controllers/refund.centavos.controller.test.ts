jest.mock('@/services/dashboard/refund.dashboard.service', () => ({ issueRefund: jest.fn() }))
jest.mock('@/services/mobile/refund.mobile.service', () => ({ createRefund: jest.fn() }))
jest.mock('@/services/tpv/refund.tpv.service', () => ({ recordRefund: jest.fn() }))
jest.mock('@/services/storeCredit/storeCreditTender', () => ({
  ...jest.requireActual('@/services/storeCredit/storeCreditTender'),
  storeCreditAvailable: () => true,
}))

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

  it('«Sólo saldo a favor»: el panel manda la regla al servicio, para que corra con el cobro bloqueado', async () => {
    const res = response()

    await dashboardController.issueRefund(request({ amount: 100, reason: 'RETURNED_GOODS' }), res, jest.fn())

    expect(dashboardIssueRefund).toHaveBeenCalledWith(expect.objectContaining({ reglasBajoCandado: expect.any(Function) }))
    const { reglasBajoCandado } = dashboardIssueRefund.mock.calls[0][0]
    const tx = { venueSettings: { findUnique: jest.fn().mockResolvedValue({ storeCreditOnly: true }) } }
    await expect(reglasBajoCandado(tx, { original: { tenderSystemKind: null } })).rejects.toMatchObject({ code: 'STORE_CREDIT_ONLY' })
    expect(tx.venueSettings.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { venueId: 'venue-1' } }))
  })

  it('🔴 Codex r1 #2: un motivo fuera del catálogo no se cuela: 400 antes del servicio', async () => {
    for (const reason of ['RETURNED_GOODS ', 'returned_goods', 'lo que sea']) {
      const res = response()
      await dashboardController.issueRefund(request({ amount: 100, reason }), res, jest.fn())
      expect(res.status).toHaveBeenCalledWith(400)
    }
    expect(dashboardIssueRefund).not.toHaveBeenCalled()
  })

  it('D1: el panel pasa su llave al servicio, que reconoce el reembolso repetido', async () => {
    const res = response()

    await dashboardController.issueRefund(
      request({ amount: 100, reason: 'RETURNED_GOODS', idempotencyKey: 'panel-reembolso-1234' }),
      res,
      jest.fn(),
    )

    expect(dashboardIssueRefund).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: 'panel-reembolso-1234' }))
  })

  it('D1: sin llave sigue como siempre (undefined, nunca null ni texto vacío)', async () => {
    for (const idempotencyKey of [undefined, null]) {
      jest.clearAllMocks()
      dashboardIssueRefund.mockResolvedValue({ refundId: 'refund-1' })
      await dashboardController.issueRefund(request({ amount: 100, reason: 'RETURNED_GOODS', idempotencyKey }), response(), jest.fn())
      expect(dashboardIssueRefund.mock.calls[0][0].idempotencyKey).toBeUndefined()
    }
  })

  it('D1: una llave que no es texto es 400 antes del servicio', async () => {
    const res = response()

    await dashboardController.issueRefund(request({ amount: 100, reason: 'RETURNED_GOODS', idempotencyKey: 12345678 }), res, jest.fn())

    expect(res.status).toHaveBeenCalledWith(400)
    expect(dashboardIssueRefund).not.toHaveBeenCalled()
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
