import express from 'express'
import request from 'supertest'
import { prismaMock } from '@tests/__helpers__/setup'
import { ConflictError, UnauthorizedError } from '@/errors/AppError'
import { generateCustomerToken } from '@/jwt.service'

// R23: el limitador real se prueba aparte (onlineOrdering.public.rateLimit.test.ts); aquí sólo estorbaría.
jest.mock('express-rate-limit', () => ({
  __esModule: true,
  default: () => (_req: any, _res: any, next: any) => next(),
  rateLimit: () => (_req: any, _res: any, next: any) => next(),
}))
jest.mock('@/middlewares/resolveOperationalVenueBySlug.middleware', () => ({
  __esModule: true,
  resolveOperationalVenueBySlug: (req: any, _res: any, next: any) => {
    req.publicVenue = { id: 'v1', slug: req.params.venueSlug }
    next()
  },
}))
jest.mock('@/middlewares/resolveVenueBySlug.middleware', () => ({
  __esModule: true,
  resolveVenueBySlug: (req: any, _res: any, next: any) => {
    req.publicVenue = { id: 'v1', slug: req.params.venueSlug }
    next()
  },
}))
jest.mock('@/middlewares/requirePublicVenueFeatureStrict.middleware', () => ({
  __esModule: true,
  requirePublicVenueFeatureStrict: () => (_req: any, _res: any, next: any) => next(),
}))
jest.mock('@/middlewares/customerAuth.middleware', () => {
  const real = jest.requireActual('@/middlewares/customerAuth.middleware')
  return {
    __esModule: true,
    // El resto del módulo es el REAL: si la ruta montara `authenticateCustomerOptional`, un token general pasaría (H1).
    ...real,
    authenticateOrderingCustomerOptional: (req: any, res: any, next: any) => {
      // Con `Authorization` corre el middleware REAL de pedidos; sin ella, la cabecera de prueba simula su sesión.
      if (req.headers.authorization) return real.authenticateOrderingCustomerOptional(req, res, next)
      req.customerAuth = req.headers['x-test-customer'] ? { customerId: 'cust1', venueId: 'v1', verifiedPhone: '+525543453965' } : null
      next()
    },
  }
})
jest.mock('@/services/online-ordering/presence.service', () => ({ __esModule: true, getAcceptingStatus: jest.fn() }))
jest.mock('@/services/online-ordering/menu.service', () => ({ __esModule: true, getPublicMenu: jest.fn() }))
jest.mock('@/services/online-ordering/quote.service', () => ({
  __esModule: true,
  quoteCart: jest.fn(),
  toPublicQuote: jest.fn((q: any) => q),
}))
jest.mock('@/services/online-ordering/order.service', () => ({
  __esModule: true,
  createOnlineOrder: jest.fn(),
  getTrackingByToken: jest.fn(),
}))
jest.mock('@/services/online-ordering/transitions.service', () => ({ __esModule: true, cancelOnlineOrderByCustomer: jest.fn() }))

import router from '@/routes/public/onlineOrdering.public.routes'
import { createOnlineOrder, getTrackingByToken } from '@/services/online-ordering/order.service'
import { cancelOnlineOrderByCustomer } from '@/services/online-ordering/transitions.service'
import { getPublicMenu } from '@/services/online-ordering/menu.service'

const app = express()
app.use(express.json())
app.use('/venues/:venueSlug/ordering', router)

const KEY = 'k'.repeat(32)
const body = {
  items: [{ productId: 'p1', quantity: 2, modifiers: [{ modifierId: 'm1' }] }],
  paymentMode: 'PAY_AT_PICKUP',
  expectedTotal: '206.00',
  customer: { name: 'María G.', phone: '55 4345 3965' },
}
const post = (o: { key?: string | null; customer?: boolean; auth?: string; payload?: object } = {}) => {
  let r = request(app).post('/venues/flautas/ordering/orders')
  if (o.key !== null) r = r.set('Idempotency-Key', o.key ?? KEY)
  if (o.customer) r = r.set('x-test-customer', '1')
  if (o.auth) r = r.set('Authorization', o.auth)
  return r.send(o.payload ?? body)
}

describe('API pública de pedidos en línea', () => {
  it('GET /menu responde la carta', async () => {
    ;(getPublicMenu as jest.Mock).mockResolvedValue({ generatedAt: 'x', truncated: false, categories: [] })
    const r = await request(app).get('/venues/flautas/ordering/menu')
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ success: true, data: { generatedAt: 'x', truncated: false, categories: [] } })
  })

  it('POST /orders sin Idempotency-Key es 400', async () => {
    const r = await post({ key: null })
    expect(r.status).toBe(400)
    expect(r.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED')
  })

  it('una llave de menos de 32 caracteres se rechaza (R8: una corta se adivina)', async () => {
    const r = await post({ key: 'k'.repeat(31) })
    expect(r.status).toBe(400)
    expect(r.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED')
    expect(createOnlineOrder).not.toHaveBeenCalled()
  })

  it('un carrito vacío lo rechaza Zod', async () => {
    expect((await post({ payload: { ...body, items: [] } })).status).toBe(400)
  })

  it('rechaza un carrito hostil: 51 renglones, cantidad 21 o una nota de 301 caracteres', async () => {
    const one = { productId: 'p1', quantity: 1 }
    expect((await post({ payload: { ...body, items: Array.from({ length: 51 }, () => one) } })).status).toBe(400)
    expect((await post({ payload: { ...body, items: [{ ...one, quantity: 21 }] } })).status).toBe(400)
    expect((await post({ payload: { ...body, note: 'x'.repeat(301) } })).status).toBe(400)
  })

  it('sin expectedTotal, o sin dos decimales, es 400 (R5)', async () => {
    const sinTotal: Record<string, unknown> = { ...body }
    delete sinTotal.expectedTotal
    expect((await post({ payload: sinTotal })).status).toBe(400)
    expect((await post({ payload: { ...body, expectedTotal: '206' } })).status).toBe(400)
    expect(createOnlineOrder).not.toHaveBeenCalled()
  })

  it('la identidad sale de la SESIÓN (cliente y teléfono verificado), no del cuerpo; 201 con la llave y el total esperado', async () => {
    ;(createOnlineOrder as jest.Mock).mockResolvedValue({ orderId: 'ord1', trackingToken: 'T'.repeat(32), replay: false })
    const r = await post({ customer: true })
    expect(r.status).toBe(201)
    expect(createOnlineOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        venueId: 'v1',
        idempotencyKey: KEY,
        expectedTotal: '206.00',
        customerId: 'cust1',
        verifiedPhone: '+525543453965',
        customer: expect.objectContaining({ phone: '55 4345 3965' }),
      }),
    )
  })

  it('sin sesión pasa cliente y teléfono vacíos; el 401 PHONE_VERIFICATION_REQUIRED del servicio se propaga', async () => {
    ;(createOnlineOrder as jest.Mock).mockRejectedValue(new UnauthorizedError('Verifica tu teléfono', 'PHONE_VERIFICATION_REQUIRED'))
    const r = await post()
    expect(createOnlineOrder).toHaveBeenCalledWith(expect.objectContaining({ customerId: null, verifiedPhone: null }))
    expect(r.status).toBe(401)
    expect(r.body).toMatchObject({ success: false, code: 'PHONE_VERIFICATION_REQUIRED' })
  })

  it('H1: un token de cliente GENERAL no basta para pedir: 401 y no se crea nada', async () => {
    // El cliente existe y está activo en este negocio: si la ruta montara el middleware general, este token pasaría.
    prismaMock.customer.findFirst.mockResolvedValue({ id: 'cust1', venueId: 'v1', active: true })
    const r = await post({ auth: `Bearer ${generateCustomerToken('cust1', 'v1')}` })
    expect(r.status).toBe(401)
    expect(r.body.code).toBe('CUSTOMER_TOKEN_INVALID')
    expect(createOnlineOrder).not.toHaveBeenCalled()
  })

  it('una repetición idempotente responde 200', async () => {
    ;(createOnlineOrder as jest.Mock).mockResolvedValue({ orderId: 'ord1', trackingToken: 'T'.repeat(32), replay: true })
    expect((await post({ customer: true })).status).toBe(200)
  })

  it('el precio cambió: 409 PRICE_CHANGED con la cotización nueva (R5)', async () => {
    ;(createOnlineOrder as jest.Mock).mockRejectedValue(new ConflictError('El precio cambió', 'PRICE_CHANGED', { quote: { total: 210 } }))
    const r = await post({ customer: true })
    expect(r.status).toBe(409)
    expect(r.body).toMatchObject({ success: false, code: 'PRICE_CHANGED', details: { quote: { total: 210 } } })
  })

  it('el seguimiento de OTRO venue es el MISMO 404 que un token inexistente y nunca expone el venueId', async () => {
    const url = `/venues/flautas/ordering/orders/${'T'.repeat(32)}`
    ;(getTrackingByToken as jest.Mock).mockResolvedValue({ venueId: 'OTRO', orderNumber: 'W1' })
    const ajeno = await request(app).get(url)
    ;(getTrackingByToken as jest.Mock).mockResolvedValue(null)
    const inexistente = await request(app).get(url)
    expect(ajeno.status).toBe(404)
    expect(inexistente.status).toBe(404)
    expect(ajeno.body).toEqual(inexistente.body)
    expect(JSON.stringify(ajeno.body)).not.toContain('OTRO')
  })

  it('el seguimiento propio no incluye venueId', async () => {
    ;(getTrackingByToken as jest.Mock).mockResolvedValue({ venueId: 'v1', orderNumber: 'WABCD', status: 'ACCEPTED' })
    const r = await request(app).get(`/venues/flautas/ordering/orders/${'T'.repeat(32)}`)
    expect(r.status).toBe(200)
    expect(r.body.data).toEqual({ orderNumber: 'WABCD', status: 'ACCEPTED' })
  })

  it('cancelar traduce STALE a 409 ORDER_STATE_CHANGED', async () => {
    ;(cancelOnlineOrderByCustomer as jest.Mock).mockResolvedValue({ outcome: 'STALE', status: 'ACCEPTED' })
    const r = await request(app).post(`/venues/flautas/ordering/orders/${'T'.repeat(32)}/cancel`)
    expect(r.status).toBe(409)
    expect(r.body).toMatchObject({ code: 'ORDER_STATE_CHANGED', status: 'ACCEPTED' })
  })

  it('cancelar un pedido con dinero encima es 409 ORDER_HAS_PAYMENTS (R1)', async () => {
    ;(cancelOnlineOrderByCustomer as jest.Mock).mockResolvedValue({ outcome: 'HAS_PAYMENTS' })
    const r = await request(app).post(`/venues/flautas/ordering/orders/${'T'.repeat(32)}/cancel`)
    expect(r.status).toBe(409)
    expect(r.body).toMatchObject({ code: 'ORDER_HAS_PAYMENTS' })
  })
})
