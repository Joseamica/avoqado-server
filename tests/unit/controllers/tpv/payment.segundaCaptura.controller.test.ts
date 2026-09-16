/**
 * Codex R1 (P2) del checkpoint 1: una POSIBLE SEGUNDA CAPTURA es evidencia, no una venta — tampoco en un REPLAY HTTP.
 *
 * El registrador devuelve la marca transitoria `possibleSecondCapture` sólo la primera vez; el retorno idempotente
 * (mismo `idempotencyKey`) trae el Payment PENDING con su `processorData.reconciliation`, sin la marca. Si el controlador
 * decidiera sólo por la marca, ese replay crearía una SaleVerification para dinero que NO es una venta. Se decide por lo
 * DURABLE.
 */
import * as controller from '@/controllers/tpv/payment.tpv.controller'
import * as paymentTpvService from '@/services/tpv/payment.tpv.service'
import * as saleVerificationService from '@/services/tpv/sale-verification.service'

jest.mock('@/services/tpv/payment.tpv.service')
jest.mock('@/services/tpv/sale-verification.service')
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { saleVerification: { findUnique: jest.fn().mockResolvedValue(null) } },
}))
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

const recordFastPaymentMock = paymentTpvService.recordFastPayment as jest.Mock
const recordOrderPaymentMock = paymentTpvService.recordOrderPayment as jest.Mock
const createPendingMock = saleVerificationService.createPendingSaleVerification as jest.Mock

const req = (extra: Record<string, unknown> = {}) =>
  ({
    params: { venueId: 'venue-1', orderId: 'order-1' },
    body: { amount: 10_000, tip: 0, method: 'CREDIT_CARD', serialNumbers: ['8952000000000000001'], idempotencyKey: 'intento-1' },
    authContext: { orgId: 'org-1', userId: 'staff-1', terminalSerialNumber: 'AVQD-N86TEST' },
    header: jest.fn(),
    ...extra,
  }) as any
const res = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() }) as any

const segundaCapturaDurable = {
  id: 'pay-evidencia',
  status: 'PENDING',
  processorData: { reconciliation: { kind: 'POSSIBLE_SECOND_CAPTURE', requestId: 'req-1', winnerPaymentId: 'pay-ganador' } },
}
const ventaNormal = { id: 'pay-venta', status: 'COMPLETED', processorData: {} }

beforeEach(() => {
  jest.clearAllMocks()
  createPendingMock.mockResolvedValue({ id: 'sv-1' })
})

describe.each([
  ['venta rápida', recordFastPaymentMock, (r: any, s: any) => controller.recordFastPayment(r, s, jest.fn())],
  ['cobro sobre una orden', recordOrderPaymentMock, (r: any, s: any) => controller.recordPayment(r, s, jest.fn())],
])('%s · la SaleVerification sólo nace para una venta de verdad', (_nombre, servicio, invocar) => {
  it('REPLAY de una segunda captura (Payment PENDING con reconciliation, SIN la marca transitoria): no se crea verificación', async () => {
    servicio.mockResolvedValue(segundaCapturaDurable)
    const r = res()
    await invocar(req(), r)
    expect(createPendingMock).not.toHaveBeenCalled()
    expect(r.status).toHaveBeenCalledWith(201)
  })

  it('primera respuesta de una segunda captura (con la marca transitoria): tampoco', async () => {
    servicio.mockResolvedValue({ ...segundaCapturaDurable, possibleSecondCapture: { requestId: 'req-1', winnerPaymentId: 'pay-ganador' } })
    await invocar(req(), res())
    expect(createPendingMock).not.toHaveBeenCalled()
  })

  it('una venta COMPLETED con seriales SÍ crea la verificación pendiente (regresión: el candado no se pasa de largo)', async () => {
    servicio.mockResolvedValue(ventaNormal)
    await invocar(req(), res())
    expect(createPendingMock).toHaveBeenCalledTimes(1)
    expect(createPendingMock.mock.calls[0][0]).toMatchObject({ venueId: 'venue-1', paymentId: 'pay-venta', staffId: 'staff-1' })
  })

  it('un Payment PENDING sin marcador de conciliación no es segunda captura: se trata como venta (no se inventa la evidencia)', async () => {
    servicio.mockResolvedValue({ id: 'pay-pendiente', status: 'PENDING', processorData: { reconciliation: { kind: 'OTRA_COSA' } } })
    await invocar(req(), res())
    expect(createPendingMock).toHaveBeenCalledTimes(1)
  })
})
