/**
 * 1b S6: el ENRUTADO de la página pública del regalo, con el módulo `public.routes.ts` real y el límite real (sin mockear
 * express-rate-limit). El servicio va mockeado.
 *  - B-S6 1: el límite propio se declara antes que `porVisitante` (un `const` posterior): el módulo tiene que CARGAR.
 *  - 60 por minuto por visitante; los `OPTIONS` no cuentan.
 *  - K-2: CORS propio (sólo la página del regalo y sus vistas previas), nunca el comodín `*` del router público.
 *  - S-11: un token mal formado no es 400; lo contesta el servicio con `{ disponible: false }`.
 */
import express from 'express'
import request from 'supertest'

const mockProxy = () => new Proxy({}, { get: () => (_req: any, res: any) => res.json({ ok: true }) })
jest.mock('@/controllers/hybridBilling.controller', () => mockProxy())
jest.mock('@/controllers/kiosk/kioskCheckIn.controller', () => mockProxy())
jest.mock('@/controllers/public/cfdi.public.controller', () => mockProxy())
jest.mock('@/controllers/public/creditPack.public.controller', () => mockProxy())
jest.mock('@/controllers/public/customerEmail.public.controller', () => mockProxy())
jest.mock('@/controllers/public/customerPortal.public.controller', () => mockProxy())
jest.mock('@/controllers/public/featureCatalog.public.controller', () => mockProxy())
jest.mock('@/controllers/public/landing.public.controller', () => mockProxy())
jest.mock('@/controllers/public/launchOffer.public.controller', () => mockProxy())
jest.mock('@/controllers/public/otpAuth.public.controller', () => mockProxy())
jest.mock('@/controllers/public/passkit.public.controller', () => mockProxy())
jest.mock('@/controllers/public/paymentLink.public.controller', () => mockProxy())
jest.mock('@/controllers/public/privacyNotice.public.controller', () => mockProxy())
jest.mock('@/controllers/public/receipt.public.controller', () => mockProxy())
jest.mock('@/controllers/public/receiptReview.public.controller', () => mockProxy())
jest.mock('@/controllers/public/reservation.public.controller', () => mockProxy())
jest.mock('@/controllers/public/tpvOrder.public.controller', () => mockProxy())
jest.mock('@/controllers/public/unsubscribe.public.controller', () => mockProxy())
jest.mock('@/controllers/public/venueCheckout.public.controller', () => mockProxy())
jest.mock('@/controllers/public/venueChat.public.controller', () => mockProxy())
jest.mock('@/controllers/public/walletPass.public.controller', () => mockProxy())
jest.mock('@/controllers/public/walletStamps.public.controller', () => mockProxy())

const mockPagina = jest.fn()
jest.mock('@/services/giftCards/giftCardPublic.service', () => ({
  __esModule: true,
  getPaginaDelRegalo: (...args: unknown[]) => mockPagina(...args),
}))

import routes, { ORIGENES_DE_LA_PAGINA_DEL_REGALO } from '@/routes/public.routes'

const TOKEN = 'Xk3pQ9vLmN2rT8wYz5aB7cD1eF4gH6jK0sU'
const RUTA = `/api/v1/public/gift-cards/${TOKEN}`

const app = express()
app.use(express.json())
app.use('/api/v1/public', routes)
app.use((err: any, _req: any, res: any, _next: any) => res.status(err.statusCode ?? 500).json({ message: err.message }))

/** Cada prueba con su visitante: el límite vive en el módulo y no se reinicia entre pruebas. */
let visitante = 0
const nuevaIp = () => `198.51.100.${++visitante}`

beforeEach(() => mockPagina.mockReset().mockResolvedValue({ disponible: false }))

it('el módulo public.routes.ts carga sin error y exporta los orígenes de la página del regalo', () => {
  expect(routes).toBeDefined()
  expect(ORIGENES_DE_LA_PAGINA_DEL_REGALO).toEqual([
    'https://pay.avoqado.io',
    /^https:\/\/[a-z0-9-]+\.avoqado-checkout\.pages\.dev$/,
    /^https:\/\/[a-z0-9-]+\.avoqado-checkout-staging\.pages\.dev$/,
    'http://localhost:5174',
  ])
})

it('responde lo del servicio con no-store y noindex; un token mal formado NO es 400', async () => {
  const ok = await request(app).get(RUTA).set('CF-Connecting-IP', nuevaIp())
  expect(ok.status).toBe(200)
  expect(ok.body).toEqual({ success: true, data: { disponible: false } })
  expect(ok.headers['cache-control']).toBe('no-store')
  expect(ok.headers['x-robots-tag']).toBe('noindex')
  expect(mockPagina).toHaveBeenCalledWith(TOKEN)

  for (const malo of ['abc', 'x'.repeat(200)]) {
    const r = await request(app).get(`/api/v1/public/gift-cards/${malo}`).set('CF-Connecting-IP', nuevaIp())
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ success: true, data: { disponible: false } })
  }
})

it('60 GET seguidos desde una IP pasan y el 61.º es 429; otra IP tiene su propio tope', async () => {
  const ip = nuevaIp()
  for (let i = 0; i < 60; i++) expect((await request(app).get(RUTA).set('CF-Connecting-IP', ip)).status).toBe(200)
  const sesentaYUno = await request(app).get(RUTA).set('CF-Connecting-IP', ip)
  expect(sesentaYUno.status).toBe(429)
  expect(sesentaYUno.body).toMatchObject({ success: false, code: 'RATE_LIMIT_EXCEEDED' })
  expect(mockPagina).toHaveBeenCalledTimes(60)
  expect((await request(app).get(RUTA).set('CF-Connecting-IP', nuevaIp())).status).toBe(200)
})

it('100 OPTIONS seguidos no cuentan para el límite: ninguno es 429 y el GET siguiente pasa', async () => {
  const ip = nuevaIp()
  for (let i = 0; i < 100; i++) {
    const r = await request(app)
      .options(RUTA)
      .set('CF-Connecting-IP', ip)
      .set('Origin', 'https://pay.avoqado.io')
      .set('Access-Control-Request-Method', 'GET')
    expect(r.status).not.toBe(429)
    expect(r.status).toBe(204)
  }
  expect(mockPagina).not.toHaveBeenCalled()
  expect((await request(app).get(RUTA).set('CF-Connecting-IP', ip)).status).toBe(200)
})

describe('CORS propio (K-2)', () => {
  it.each([
    'https://pay.avoqado.io',
    'https://abc.avoqado-checkout.pages.dev',
    'https://feat-tarjetas.avoqado-checkout-staging.pages.dev',
    'http://localhost:5174',
  ])('Origin %s ⇒ Access-Control-Allow-Origin igual al origen, en el GET y en el preflight', async origen => {
    const get = await request(app).get(RUTA).set('CF-Connecting-IP', nuevaIp()).set('Origin', origen)
    expect(get.status).toBe(200)
    expect(get.headers['access-control-allow-origin']).toBe(origen)

    const pre = await request(app)
      .options(RUTA)
      .set('CF-Connecting-IP', nuevaIp())
      .set('Origin', origen)
      .set('Access-Control-Request-Method', 'GET')
    expect(pre.status).toBe(204)
    expect(pre.headers['access-control-allow-origin']).toBe(origen)
    expect(pre.headers['access-control-allow-methods']).toBe('GET,OPTIONS')
    expect(pre.headers['access-control-allow-credentials']).toBeUndefined()
  })

  it.each([
    'https://evil.example',
    'https://x.avoqado-checkout.pages.dev.evil.example',
    'https://avoqado-checkout.pages.dev.evil.example',
    'https://x.avoqado-checkout-attacker.pages.dev',
    'http://abc.avoqado-checkout.pages.dev',
    'https://pay.avoqado.io.evil.example',
  ])('Origin %s ⇒ sin Access-Control-Allow-Origin (y nunca *), en el GET y en el preflight', async origen => {
    const get = await request(app).get(RUTA).set('CF-Connecting-IP', nuevaIp()).set('Origin', origen)
    expect(get.headers['access-control-allow-origin']).toBeUndefined()

    const pre = await request(app)
      .options(RUTA)
      .set('CF-Connecting-IP', nuevaIp())
      .set('Origin', origen)
      .set('Access-Control-Request-Method', 'GET')
    expect(pre.headers['access-control-allow-origin']).toBeUndefined()
    expect(mockPagina).toHaveBeenCalledTimes(1)
  })

  it('el resto del router público conserva su comodín (no se cambió para nadie más)', async () => {
    const r = await request(app).get('/api/v1/public/receipt/abc').set('Origin', 'https://evil.example')
    expect(r.headers['access-control-allow-origin']).toBe('*')
  })
})
