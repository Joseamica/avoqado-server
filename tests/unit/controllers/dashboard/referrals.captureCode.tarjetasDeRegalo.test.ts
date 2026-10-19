/**
 * Tarjetas de regalo (R1, B6 r1): el POS captura el referido DESPUÉS del cobro. Si esa venta es de tarjetas, la captura se rechaza con
 * `GIFT_CARD_SALE`; el controlador lo responde como las demás razones de negocio (400 + texto en español), nunca como un 500.
 */
jest.mock('@/services/referrals/referralCapture.service', () => ({
  ...jest.requireActual('@/services/referrals/referralCapture.service'),
  captureReferral: jest.fn(),
}))

import { captureReferral } from '@/services/referrals/referralCapture.service'
import { captureCode } from '@/controllers/dashboard/referrals/referrals.controller'

it('🔴 GIFT_CARD_SALE ⇒ 400 con el motivo y el texto que el POS muestra tal cual', async () => {
  ;(captureReferral as jest.Mock).mockRejectedValue(new Error('GIFT_CARD_SALE'))
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() }
  const next = jest.fn()

  await captureCode({ params: { venueId: 'v1' }, body: { intendedOrderId: 'order_gc' } } as any, res as any, next)

  expect(next).not.toHaveBeenCalled()
  expect(res.status).toHaveBeenCalledWith(400)
  expect(res.json).toHaveBeenCalledWith({
    valid: false,
    reason: 'GIFT_CARD_SALE',
    message: 'El referido se registra en la primera compra; la venta de una tarjeta de regalo no cuenta.',
  })
})
