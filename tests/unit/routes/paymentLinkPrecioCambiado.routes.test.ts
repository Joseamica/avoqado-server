// Task 5 — ruta pública de cada camino: un expectedTotal distinto llega al servicio (el validador no lo borra),
// responde 409 PAYMENT_LINK_PRICE_CHANGED con el desglose y NO se llama al proveedor.
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
jest.mock('@/services/venueSalesGuard', () => ({ __esModule: true, assertVenueSalesEnabled: jest.fn() }))
jest.mock('@/services/superadmin/platformSettings.service', () => ({ getVatRateBps: jest.fn().mockResolvedValue(1600) }))
jest.mock('@/services/mercado-pago/connection.service', () => ({
  loadCredentials: jest.fn().mockResolvedValue({ accessToken: 'fixture', publicKey: 'pk', mpUserId: 1, expiresAt: new Date('2099-01-01') }),
}))
const createStripePi = jest.fn()
jest.mock('stripe', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ paymentIntents: { create: createStripePi } })),
}))
const providerCreateCheckout = jest.fn()
const providerTokenize = jest.fn()
jest.mock('@/services/payments/provider-registry', () => ({
  getProvider: () => ({ createCheckoutSession: providerCreateCheckout, tokenizeCard: providerTokenize }),
}))
import routes from '@/routes/public.routes'
import { prismaMock } from '../../__helpers__/setup'
import { Decimal } from '@prisma/client/runtime/library'

let visitor = 0
const app = express()
app.use(express.json())
app.use('/api/v1/public', routes)

const tarjeta = { pan: '4242424242424242', cvv: '123', expMonth: '12', expYear: '2030', holderName: 'Ana' }
const CAMINOS = [
  ['Stripe inline', 'payment-intent', 'STRIPE_CONNECT', {}],
  ['Stripe hosted', 'stripe-checkout', 'STRIPE_CONNECT', {}],
  ['Blumon', 'checkout', 'BLUMON', tarjeta],
  ['MercadoPago', 'mp-payment-intent', 'MERCADO_PAGO', {}],
] as const

describe.each(CAMINOS)('%s: POST /payment-links/:shortCode/%s', (_n, ruta, code, extra) => {
  beforeEach(() => {
    createStripePi.mockReset()
    providerCreateCheckout.mockReset()
    providerTokenize.mockReset()
    prismaMock.venue.findUnique.mockResolvedValue({ timezone: 'America/Mexico_City' } as any)
    prismaMock.paymentLink.findUnique.mockResolvedValue({
      id: 'cplink00000000000000000001',
      shortCode: 'abc12345',
      venueId: 'cvenue0000000000000000001',
      purpose: 'PAYMENT',
      title: 'Clase',
      amountType: 'FIXED',
      amount: new Decimal(1000),
      currency: 'MXN',
      isReusable: true,
      expiresAt: null,
      status: 'ACTIVE',
      paymentCount: 0,
      customFields: null,
      tippingConfig: null,
      discount: { v: 1, origen: 'MANUAL', discountId: null, type: 'PERCENTAGE', value: 15, name: 'Buen Fin' },
      items: [],
      ecommerceMerchant: {
        id: 'cmerch0000000000000000001',
        provider: { code },
        chargesEnabled: true,
        platformFeeBps: 100,
        providerCredentials: { connectAccountId: 'acct_fixture' },
      },
    } as any)
  })

  it('expectedTotal distinto → 409 con código y desglose, sin llamar al proveedor', async () => {
    const res = await request(app)
      .post(`/api/v1/public/payment-links/abc12345/${ruta}`)
      .set('CF-Connecting-IP', `198.51.100.${++visitor}`)
      .send({ ...extra, expectedTotal: 1000 })
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({
      success: false,
      error: 'El precio de esta liga cambió',
      code: 'PAYMENT_LINK_PRICE_CHANGED',
      details: { desglose: { base: 1000, descuento: 150, neto: 850, aplica: true } },
    })
    expect(createStripePi).not.toHaveBeenCalled()
    expect(providerCreateCheckout).not.toHaveBeenCalled()
    expect(providerTokenize).not.toHaveBeenCalled()
    expect(prismaMock.checkoutSession.create).not.toHaveBeenCalled()
  })
})
