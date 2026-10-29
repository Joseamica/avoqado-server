const mockResolve = jest.fn()
jest.mock('@/services/dashboard/paymentLink.service', () => ({
  getPaymentLinkByShortCode: (...a: unknown[]) => mockResolve(...a),
}))
const mockLogger = { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() }
jest.mock('@/config/logger', () => ({ __esModule: true, default: mockLogger }))

import { resolvePaymentLink } from '@/controllers/public/paymentLink.public.controller'
import { BadRequestError, NotFoundError } from '@/errors/AppError'

const res = () => {
  const r: any = {}
  r.status = jest.fn().mockReturnValue(r)
  r.json = jest.fn().mockReturnValue(r)
  return r
}

const RESUMEN = {
  title: 'Clase muestra',
  paidAt: '2026-10-27T00:21:18.330Z',
  amount: 1000,
  currency: 'MXN',
  payment: { cardBrand: 'VISA', last4: '4242', receiptUrl: 'https://pay.stripe.com/receipts/abc' },
}

beforeEach(() => jest.clearAllMocks())

it('liga ya cobrada: el 400 de siempre más el código y el resumen para dibujar «Pagada»', async () => {
  mockResolve.mockRejectedValue(new BadRequestError('Esta liga de pago ya fue utilizada', 'PAYMENT_LINK_ALREADY_PAID', RESUMEN))
  const r = res()
  await resolvePaymentLink({ params: { shortCode: 'abc12345' } } as any, r)
  expect(r.status).toHaveBeenCalledWith(400)
  expect(r.json).toHaveBeenCalledWith({
    success: false,
    error: 'Esta liga de pago ya fue utilizada',
    code: 'PAYMENT_LINK_ALREADY_PAID',
    details: RESUMEN,
  })
})

it('el aviso del registro no copia el resumen (lleva la liga del recibo) y ya no es nivel error', async () => {
  mockResolve.mockRejectedValue(new BadRequestError('Esta liga de pago ya fue utilizada', 'PAYMENT_LINK_ALREADY_PAID', RESUMEN))
  await resolvePaymentLink({ params: { shortCode: 'abc12345' } } as any, res())
  expect(mockLogger.error).not.toHaveBeenCalled()
  expect(mockLogger.warn).toHaveBeenCalledTimes(1)
  expect(JSON.stringify(mockLogger.warn.mock.calls[0])).not.toContain('receipts')
})

it('regresión: otro 400 o un 404 siguen igual, sin código ni detalle', async () => {
  mockResolve.mockRejectedValue(new BadRequestError('Esta liga de pago ha expirado', 'OTRO_CODIGO', { secreto: 1 }))
  const r = res()
  await resolvePaymentLink({ params: { shortCode: 'abc12345' } } as any, r)
  expect(r.json).toHaveBeenCalledWith({ success: false, error: 'Esta liga de pago ha expirado' })

  mockResolve.mockRejectedValue(new NotFoundError('Liga de pago no encontrada'))
  const r2 = res()
  await resolvePaymentLink({ params: { shortCode: 'nope' } } as any, r2)
  expect(r2.status).toHaveBeenCalledWith(404)
  expect(r2.json).toHaveBeenCalledWith({ success: false, error: 'Liga de pago no encontrada' })
})

it('un fallo inesperado (500) sigue como error con su detalle', async () => {
  mockResolve.mockRejectedValue(new Error('boom'))
  const r = res()
  await resolvePaymentLink({ params: { shortCode: 'abc12345' } } as any, r)
  expect(r.status).toHaveBeenCalledWith(500)
  expect(mockLogger.error).toHaveBeenCalledTimes(1)
})
