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

const mockLinkPay = jest.fn()
const mockVenuePay = jest.fn()
jest.mock('@/services/dashboard/paymentLink.service', () => ({
  executeMercadoPagoPaymentForPaymentLink: (...args: unknown[]) => mockLinkPay(...args),
}))
jest.mock('@/services/dashboard/venueCheckout.service', () => ({
  executeMercadoPagoPaymentForVenue: (...args: unknown[]) => mockVenuePay(...args),
}))
import routes from '@/routes/public.routes'

let visitor = 0
const app = express()
app.use(express.json())
app.use('/api/v1/public', routes)
app.use((err: any, _req: any, res: any, _next: any) => res.status(err.statusCode ?? 500).json({ message: err.message }))
const valid = {
  sessionId: 'cs-1',
  paymentMethodId: 'visa',
  token: 'card-token',
  installments: 1,
  payer: { email: 'buyer@example.com', firstName: 'Ana' },
}
beforeEach(() => {
  mockLinkPay.mockReset().mockResolvedValue({ paymentId: 99, status: 'pending' })
  mockVenuePay.mockReset().mockResolvedValue({ paymentId: 99, status: 'pending' })
})

for (const [name, url, service, source] of [
  ['liga', '/api/v1/public/payment-links/link1/mp-pay', mockLinkPay, 'link1'],
  ['venue', '/api/v1/public/venues/venue1/checkout/mp-pay', mockVenuePay, 'venue1'],
] as const) {
  describe(`middleware mp-pay ${name}`, () => {
    it.each(['oxxo', 'clabe'])('envía %s sin token al servicio', async paymentMethodId => {
      const { sessionId, ...payInput } = { ...valid, token: undefined }
      const response = await request(app)
        .post(url)
        .set('CF-Connecting-IP', `192.0.2.${++visitor}`)
        .send({ sessionId, ...payInput, paymentMethodId })
      expect(response.status).toBe(201)
      expect(service).toHaveBeenCalledWith(source, sessionId, { ...payInput, paymentMethodId })
    })
    it('conserva tarjeta válida', async () => {
      expect((await request(app).post(url).set('CF-Connecting-IP', `192.0.2.${++visitor}`).send(valid)).status).toBe(201)
      const { sessionId, ...payInput } = valid
      expect(service).toHaveBeenCalledWith(source, sessionId, payInput)
    })
    it.each([
      { token: undefined },
      { token: '' },
      { token: undefined, paymentMethodId: 'OXXO' },
      { token: undefined, paymentMethodId: 'arbitrario' },
      { sessionId: '' },
      { installments: 0 },
      { payer: { email: 'invalid' } },
    ])('rechaza %j antes del servicio', async invalid => {
      const response = await request(app)
        .post(url)
        .set('CF-Connecting-IP', `192.0.2.${++visitor}`)
        .send({ ...valid, ...invalid })
      expect(response.status).toBe(400)
      expect(response.body.message ?? response.body.error).toContain('Error de validación')
      expect(service).not.toHaveBeenCalled()
    })
  })
}
