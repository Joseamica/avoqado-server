/**
 * Regresión del contrato TPV → controlador → servicio para el desglose de propina.
 *
 * La terminal manda `tipRefundCents: 0` cuando el operador elige conservar la propina
 * del personal. El controlador arma el objeto del servicio campo por campo, así que omitir
 * esta llave cambia silenciosamente la operación a reparto proporcional.
 */
import * as controller from '@/controllers/tpv/refund.tpv.controller'
import * as refundTpvService from '@/services/tpv/refund.tpv.service'

jest.mock('@/services/tpv/refund.tpv.service')
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

const recordRefundMock = refundTpvService.recordRefund as jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
  recordRefundMock.mockResolvedValue({ id: 'refund-1' })
})

it('preserva tipRefundCents=0 al entregar el reembolso al servicio', async () => {
  const req = {
    params: { venueId: 'venue-1' },
    body: {
      originalPaymentId: 'payment-1',
      amount: 10_000,
      reason: 'CUSTOMER_REQUEST',
      tipRefundCents: 0,
    },
    authContext: { orgId: 'org-1', userId: 'staff-1' },
    header: jest.fn(),
  } as any
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as any

  await controller.recordRefund(req, res, jest.fn())

  expect(recordRefundMock.mock.calls[0][1].tipRefundCents).toBe(0)
})
