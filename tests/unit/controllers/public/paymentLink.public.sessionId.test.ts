const mockCreate = jest.fn()
const mockComplete = jest.fn()
jest.mock('@/services/dashboard/paymentLink.service', () => ({
  createCheckoutSession: (...a: unknown[]) => mockCreate(...a),
  completeCharge: (...a: unknown[]) => mockComplete(...a),
}))

import { createCheckout, completeCharge } from '@/controllers/public/paymentLink.public.controller'
import { ConflictError, PaymentOutcomeUnknownError } from '@/errors/AppError'

const res = () => {
  const r: any = {}
  r.status = jest.fn().mockReturnValue(r)
  r.json = jest.fn().mockReturnValue(r)
  return r
}

it('🔴 liga con un cobro en vuelo: el 409 lo dice con un código, sin el identificador de OTRO pagador', async () => {
  mockCreate.mockRejectedValue(new ConflictError('Hay un pago en proceso…', 'PAYMENT_IN_FLIGHT'))
  const r = res()
  await createCheckout({ params: { shortCode: 'abc' }, body: {} } as any, r)
  expect(r.status).toHaveBeenCalledWith(409)
  const body = r.json.mock.calls[0][0]
  expect(body).toMatchObject({ success: false, code: 'PAYMENT_IN_FLIGHT' })
  expect(body).not.toHaveProperty('sessionId')
})

it('🔴 resultado desconocido al cobrar: el 502 devuelve la sesión que quedó retenida', async () => {
  mockComplete.mockRejectedValue(new PaymentOutcomeUnknownError())
  const r = res()
  await completeCharge({ params: { shortCode: 'abc' }, body: { sessionId: 'cs_pl_s1' } } as any, r)
  expect(r.status).toHaveBeenCalledWith(502)
  expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'PAYMENT_OUTCOME_UNKNOWN', sessionId: 'cs_pl_s1' }))
})

it('regresión: un error común sigue igual (sin campos nuevos que no apliquen)', async () => {
  mockComplete.mockRejectedValue(new Error('boom'))
  const r = res()
  await completeCharge({ params: { shortCode: 'abc' }, body: { sessionId: 'cs_pl_s1' } } as any, r)
  expect(r.json).toHaveBeenCalledWith({ success: false, error: 'boom' })
})
