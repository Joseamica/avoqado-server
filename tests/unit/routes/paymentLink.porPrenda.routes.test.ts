// Liga por prenda (Task 5) por la ruta pública REAL, con su logger: el `?t=` del navegador llega al servicio y su valor nunca
// queda escrito en `Request Start` ni en `Request End` (Codex plan-r3 #5); los 409 de la talla salen con su código.
import express from 'express'
import request from 'supertest'
jest.mock('@/controllers/hybridBilling.controller', () => new Proxy({}, { get: () => (_req: any, res: any) => res.json({ ok: true }) }))
jest.mock(
  '@/controllers/kiosk/kioskCheckIn.controller',
  () => new Proxy({}, { get: () => (_req: any, res: any) => res.json({ ok: true }) }),
)
jest.mock(
  '@/controllers/public/cfdi.public.controller',
  () => new Proxy({}, { get: () => (_req: any, res: any) => res.json({ ok: true }) }),
)
jest.mock(
  '@/controllers/public/creditPack.public.controller',
  () => new Proxy({}, { get: () => (_req: any, res: any) => res.json({ ok: true }) }),
)
jest.mock(
  '@/controllers/public/customerEmail.public.controller',
  () => new Proxy({}, { get: () => (_req: any, res: any) => res.json({ ok: true }) }),
)
jest.mock(
  '@/controllers/public/customerPortal.public.controller',
  () => new Proxy({}, { get: () => (_req: any, res: any) => res.json({ ok: true }) }),
)
jest.mock(
  '@/controllers/public/featureCatalog.public.controller',
  () => new Proxy({}, { get: () => (_req: any, res: any) => res.json({ ok: true }) }),
)
jest.mock(
  '@/controllers/public/landing.public.controller',
  () => new Proxy({}, { get: () => (_req: any, res: any) => res.json({ ok: true }) }),
)
jest.mock(
  '@/controllers/public/launchOffer.public.controller',
  () => new Proxy({}, { get: () => (_req: any, res: any) => res.json({ ok: true }) }),
)
jest.mock(
  '@/controllers/public/otpAuth.public.controller',
  () => new Proxy({}, { get: () => (_req: any, res: any) => res.json({ ok: true }) }),
)
jest.mock(
  '@/controllers/public/passkit.public.controller',
  () => new Proxy({}, { get: () => (_req: any, res: any) => res.json({ ok: true }) }),
)
jest.mock(
  '@/controllers/public/privacyNotice.public.controller',
  () => new Proxy({}, { get: () => (_req: any, res: any) => res.json({ ok: true }) }),
)
jest.mock(
  '@/controllers/public/receipt.public.controller',
  () => new Proxy({}, { get: () => (_req: any, res: any) => res.json({ ok: true }) }),
)
jest.mock(
  '@/controllers/public/receiptReview.public.controller',
  () => new Proxy({}, { get: () => (_req: any, res: any) => res.json({ ok: true }) }),
)
jest.mock(
  '@/controllers/public/reservation.public.controller',
  () => new Proxy({}, { get: () => (_req: any, res: any) => res.json({ ok: true }) }),
)
jest.mock(
  '@/controllers/public/tpvOrder.public.controller',
  () => new Proxy({}, { get: () => (_req: any, res: any) => res.json({ ok: true }) }),
)
jest.mock(
  '@/controllers/public/unsubscribe.public.controller',
  () => new Proxy({}, { get: () => (_req: any, res: any) => res.json({ ok: true }) }),
)
jest.mock(
  '@/controllers/public/venueChat.public.controller',
  () => new Proxy({}, { get: () => (_req: any, res: any) => res.json({ ok: true }) }),
)
jest.mock(
  '@/controllers/public/walletPass.public.controller',
  () => new Proxy({}, { get: () => (_req: any, res: any) => res.json({ ok: true }) }),
)
jest.mock(
  '@/controllers/public/walletStamps.public.controller',
  () => new Proxy({}, { get: () => (_req: any, res: any) => res.json({ ok: true }) }),
)
jest.mock('@/services/dashboard/venueCheckout.service', () => new Proxy({}, { get: () => jest.fn() }))
const mockGet = jest.fn()
const mockPi = jest.fn()
jest.mock('@/services/dashboard/paymentLink.service', () => ({
  getPaymentLinkByShortCode: (...a: unknown[]) => mockGet(...a),
  createStripePaymentIntentForPaymentLink: (...a: unknown[]) => mockPi(...a),
}))
import routes from '@/routes/public.routes'
import logger from '@/config/logger'
import { requestLoggerMiddleware } from '@/middlewares/requestLogger'
import { ConflictError, ForbiddenError } from '@/errors/AppError'

const TOKEN = 'tok_SECRETO_abcdefghij'
let visitor = 0
const app = express()
app.use('/api/v1/public', requestLoggerMiddleware, express.json(), routes)
const ip = () => `198.51.100.${++visitor}`

/** Todo lo que el logger recibió (mensaje y campos), como texto. */
const loQueSeEscribio = () =>
  JSON.stringify([
    ...(logger.info as jest.Mock).mock.calls,
    ...(logger.log as jest.Mock).mock.calls,
    ...(logger.warn as jest.Mock).mock.calls,
  ])

beforeEach(() => {
  mockGet.mockReset().mockResolvedValue({ id: 'pl1' })
  mockPi.mockReset().mockResolvedValue({ paymentIntentId: 'pi_1' })
})

it('GET con ?t= pasa el token al servicio y su valor no aparece en Request Start ni Request End', async () => {
  const res = await request(app).get(`/api/v1/public/payment-links/abc12345?t=${TOKEN}`).set('CF-Connecting-IP', ip())
  expect(res.status).toBe(200)
  expect(mockGet).toHaveBeenCalledWith('abc12345', TOKEN)
  await new Promise(resolve => setImmediate(resolve))
  const escrito = loQueSeEscribio()
  expect(escrito).toContain('Request Start: GET /api/v1/public/payment-links/abc12345?t=')
  expect(escrito).toContain('Request End: GET /api/v1/public/payment-links/abc12345?t=')
  expect(escrito).not.toContain(TOKEN)
})

it('GET sin ?t= sigue igual', async () => {
  await request(app).get('/api/v1/public/payment-links/abc12345').set('CF-Connecting-IP', ip()).expect(200)
  expect(mockGet).toHaveBeenCalledWith('abc12345', undefined)
})

it('GET con un ?t= mal formado → 400 sin llegar al servicio', async () => {
  const res = await request(app).get('/api/v1/public/payment-links/abc12345?t=corto').set('CF-Connecting-IP', ip())
  expect(res.status).toBe(400)
  expect(mockGet).not.toHaveBeenCalled()
})

it('POST payment-intent: productId y browserToken pasan el validador', async () => {
  const body = { productId: 'cm00000000000000000000009', browserToken: TOKEN, tipAmount: 10 }
  await request(app).post('/api/v1/public/payment-links/abc12345/payment-intent').set('CF-Connecting-IP', ip()).send(body).expect(201)
  expect(mockPi).toHaveBeenCalledWith('abc12345', expect.objectContaining(body))
})

it('POST payment-intent: un productId que no es cuid → 400', async () => {
  await request(app)
    .post('/api/v1/public/payment-links/abc12345/payment-intent')
    .set('CF-Connecting-IP', ip())
    .send({ productId: 'x', browserToken: TOKEN })
    .expect(400)
  expect(mockPi).not.toHaveBeenCalled()
})

it.each([
  [new ConflictError('Esa talla se agotó', 'PAYMENT_LINK_VARIANT_SOLD_OUT'), 409],
  [new ConflictError('Esa talla ya no está disponible', 'PAYMENT_LINK_VARIANT_UNAVAILABLE'), 409],
  [new ForbiddenError('Esta liga no está disponible por ahora', 'PAYMENT_LINK_VARIANT_UNAVAILABLE'), 403],
  [new ConflictError('Tu pago se está procesando', 'PAYMENT_LINK_PAYMENT_IN_PROGRESS'), 409],
])('POST payment-intent: %p sale con su código para que la página reaccione', async (error, status) => {
  mockPi.mockRejectedValue(error)
  const res = await request(app).post('/api/v1/public/payment-links/abc12345/payment-intent').set('CF-Connecting-IP', ip()).send({})
  expect(res.status).toBe(status)
  expect(res.body).toEqual({ success: false, error: error.message, code: (error as any).code })
})

it('regresión: un error sin código de talla sale igual que antes (sin code)', async () => {
  mockPi.mockRejectedValue(new ConflictError('otra cosa', 'OTRO_CODIGO'))
  const res = await request(app).post('/api/v1/public/payment-links/abc12345/payment-intent').set('CF-Connecting-IP', ip()).send({})
  expect(res.body).toEqual({ success: false, error: 'otra cosa' })
})
