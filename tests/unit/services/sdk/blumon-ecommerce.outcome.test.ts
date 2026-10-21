/**
 * 🔴 Auditoría 2026-09-30: todo HTTP < 500 de Blumon se tomaba como rechazo definitivo. Un 408, 409 o 429 no dice que
 * el cargo NO pasó, y Blumon no recibe ningún identificador del pedido: marcarlo FAILED abría un segundo cargo real.
 */
import { getBlumonEcommerceService } from '@/services/sdk/blumon-ecommerce.service'
import { BadRequestError, PaymentOutcomeUnknownError } from '@/errors/AppError'

const ORIGINAL_MOCK_FLAG = process.env.USE_BLUMON_MOCK

function httpError(status?: number) {
  const error: any = new Error(status ? `Request failed with status code ${status}` : 'socket hang up')
  if (status) error.response = { status, data: { message: 'x' } }
  return error
}

function serviceRejecting(error: unknown) {
  const service: any = getBlumonEcommerceService(true)
  service.client = { post: jest.fn().mockRejectedValue(error) }
  return service
}

const REQUEST = { accessToken: 'at', amount: 100, currency: '484', cardToken: 'tok_1', cvv: '123', orderId: 'cs_1' } as any

beforeEach(() => {
  delete process.env.USE_BLUMON_MOCK
})
afterAll(() => {
  if (ORIGINAL_MOCK_FLAG === undefined) delete process.env.USE_BLUMON_MOCK
  else process.env.USE_BLUMON_MOCK = ORIGINAL_MOCK_FLAG
})

it.each([408, 409, 429])('🔴 un HTTP %s es resultado DESCONOCIDO, no rechazo', async status => {
  await expect(serviceRejecting(httpError(status)).authorizePayment(REQUEST)).rejects.toBeInstanceOf(PaymentOutcomeUnknownError)
})

it.each([
  ['sin respuesta (corte de red)', undefined],
  ['un 503 del gateway', 503],
])('regresión: %s sigue siendo DESCONOCIDO', async (_label, status) => {
  await expect(serviceRejecting(httpError(status)).authorizePayment(REQUEST)).rejects.toBeInstanceOf(PaymentOutcomeUnknownError)
})

it.each([400, 401, 402, 422])('regresión: un HTTP %s sigue siendo rechazo definitivo', async status => {
  await expect(serviceRejecting(httpError(status)).authorizePayment(REQUEST)).rejects.toBeInstanceOf(BadRequestError)
})
