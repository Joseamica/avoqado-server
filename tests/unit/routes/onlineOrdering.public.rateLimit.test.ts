// R23: el límite REAL de crear pedidos (sin mockear express-rate-limit) y R10: el tope es por visitante Y negocio.
import express from 'express'
import request from 'supertest'

jest.mock('@/middlewares/resolveOperationalVenueBySlug.middleware', () => ({
  __esModule: true,
  resolveOperationalVenueBySlug: (req: any, _res: any, next: any) => {
    req.publicVenue = { id: `id-${req.params.venueSlug}`, slug: req.params.venueSlug }
    next()
  },
}))
jest.mock('@/middlewares/resolveVenueBySlug.middleware', () => ({
  __esModule: true,
  resolveVenueBySlug: (_req: any, _res: any, next: any) => next(),
}))
jest.mock('@/middlewares/requirePublicVenueFeatureStrict.middleware', () => ({
  __esModule: true,
  requirePublicVenueFeatureStrict: () => (_req: any, _res: any, next: any) => next(),
}))
jest.mock('@/middlewares/customerAuth.middleware', () => ({
  __esModule: true,
  authenticateOrderingCustomerOptional: (req: any, _res: any, next: any) => {
    req.customerAuth = null
    next()
  },
}))
jest.mock('@/services/online-ordering/order.service', () => ({
  __esModule: true,
  createOnlineOrder: jest.fn(async () => ({ orderId: 'ord1', replay: false })),
  getTrackingByToken: jest.fn(),
}))
jest.mock('@/services/online-ordering/presence.service', () => ({ __esModule: true, getAcceptingStatus: jest.fn() }))
jest.mock('@/services/online-ordering/menu.service', () => ({ __esModule: true, getPublicMenu: jest.fn() }))
jest.mock('@/services/online-ordering/quote.service', () => ({ __esModule: true, quoteCart: jest.fn(), toPublicQuote: jest.fn() }))
jest.mock('@/services/online-ordering/transitions.service', () => ({ __esModule: true, cancelOnlineOrderByCustomer: jest.fn() }))

import router from '@/routes/public/onlineOrdering.public.routes'

const app = express()
app.use(express.json())
app.use('/venues/:venueSlug/ordering', router)

const body = {
  items: [{ productId: 'p1', quantity: 1 }],
  paymentMode: 'PAY_AT_PICKUP',
  expectedTotal: '93.00',
  customer: { name: 'María G.', phone: '55 4345 3965' },
}
const post = (slug: string, ip = '198.51.100.10') =>
  request(app).post(`/venues/${slug}/ordering/orders`).set('CF-Connecting-IP', ip).set('Idempotency-Key', 'k'.repeat(32)).send(body)

it('el sexto pedido del mismo visitante al mismo negocio en un minuto es 429; otro negocio u otro visitante tienen su propio tope (R10)', async () => {
  for (let i = 0; i < 5; i++) expect((await post('flautas')).status).toBe(201)
  const sexto = await post('flautas')
  expect(sexto.status).toBe(429)
  // El 429 también habla el sobre JSON de la API y en español (restricción global 5).
  expect(sexto.body).toMatchObject({ success: false, code: 'RATE_LIMIT_EXCEEDED' })
  expect((await post('tacos')).status).toBe(201)
  // Otra IP REAL (la que manda Cloudflare) en el MISMO negocio tiene su propia cubeta.
  expect((await post('flautas', '203.0.113.7')).status).toBe(201)
})
