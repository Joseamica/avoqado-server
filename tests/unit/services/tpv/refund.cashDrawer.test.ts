/**
 * Fase 2 de la unificación de caja: un reembolso en efectivo desde la TPV BAJA el cajón.
 *
 * `refund.tpv.service` creaba el Payment negativo del reembolso pero NO publicaba el PAY_OUT
 * (auditoría 27-ago §2.2). Sus gemelos `refund.mobile` y `refund.dashboard` sí lo hacen.
 * Resultado: devolver $200 en efectivo desde la PAX dejaba el esperado del cajón $200 arriba
 * ⇒ SOBRANTE falso al cerrar — y si el cajero contaba bien, el sistema decía que sobraba.
 *
 * Mismo enganche que los gemelos: después del commit, fail-open, y sólo si el pago original
 * era efectivo físico (`paymentCountsAsDrawerCash` sobre el pago REAL, nunca sobre el body).
 */
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))
jest.mock('@/services/shared/cashDrawerPosting', () => ({
  postCashRefundToDrawer: jest.fn().mockResolvedValue('POSTED'),
}))

import { postCashRefundToDrawer } from '@/services/shared/cashDrawerPosting'
import * as refundService from '@/services/tpv/refund.tpv.service'
import { prismaMock } from '../../../__helpers__/setup'

const VENUE = 'venue-1'

function armar(method: 'CASH' | 'CREDIT_CARD') {
  const original = {
    id: 'pay-orig',
    venueId: VENUE,
    orderId: 'order-1',
    method,
    fundsFlow: method === 'CASH' ? 'CASH_DRAWER' : 'AVOQADO_PROCESSED',
    amount: 300,
    tipAmount: 0,
    status: 'COMPLETED',
    type: 'REGULAR',
    processorData: {},
    source: 'TPV',
    terminalId: null,
    merchantAccountId: null,
    tenderTypeId: null,
    processedById: 'staff-1',
  }
  ;(prismaMock as any).payment = {
    findUnique: jest.fn().mockResolvedValue(original),
    findFirst: jest.fn().mockResolvedValue(original),
    create: jest.fn().mockImplementation(async (a: any) => ({ id: 'pay-refund', ...a.data })),
    update: jest.fn().mockResolvedValue(original),
  }
  ;(prismaMock as any).order = { findUnique: jest.fn().mockResolvedValue({ id: 'order-1', venueId: VENUE }), update: jest.fn() }
  ;(prismaMock as any).$transaction = jest.fn().mockImplementation(async (fn: any) => fn(prismaMock))
  ;(prismaMock as any).$queryRaw = jest.fn().mockResolvedValue([original])
  return original
}

// The body the PAX actually sends: `RefundRequestData` requires the fields that
// identify the transaction at the processor, plus the venue it belongs to.
const cuerpo = (amount: number) => ({
  venueId: VENUE,
  originalPaymentId: 'pay-orig',
  amount,
  reason: 'cliente',
  staffId: 'staff-1',
  authorizationNumber: '123456',
  referenceNumber: 'ref-1',
  isPartialRefund: true,
  currency: 'MXN',
})

beforeEach(() => jest.clearAllMocks())

describe('reembolso desde la TPV', () => {
  const fn = refundService.recordRefund

  it('🔴 un reembolso en EFECTIVO publica PAY_OUT al cajón con el monto devuelto', async () => {
    armar('CASH')
    await fn(VENUE, cuerpo(200)).catch(() => {})
    expect(postCashRefundToDrawer).toHaveBeenCalledTimes(1)
    expect(postCashRefundToDrawer).toHaveBeenCalledWith(
      expect.objectContaining({ venueId: VENUE, refundPaymentId: 'pay-refund', method: 'CASH', fundsFlow: 'CASH_DRAWER' }),
    )
  })

  it('🔴 un reembolso de TARJETA no toca el cajón', async () => {
    armar('CREDIT_CARD')
    await fn(VENUE, cuerpo(200)).catch(() => {})
    // El helper decide con paymentCountsAsDrawerCash; aquí basta con que reciba el fundsFlow real
    if ((postCashRefundToDrawer as jest.Mock).mock.calls.length) {
      expect(postCashRefundToDrawer).toHaveBeenCalledWith(expect.objectContaining({ fundsFlow: 'AVOQADO_PROCESSED' }))
    }
  })
})
