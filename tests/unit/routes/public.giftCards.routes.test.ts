/**
 * 1b S6: el ENRUTADO de la página pública del regalo, con el módulo `public.routes.ts` real y el límite real (sin mockear
 * express-rate-limit). El servicio va mockeado.
 *  - B-S6 1: el límite propio se declara antes que `porVisitante` (un `const` posterior): el módulo tiene que CARGAR.
 *  - 60 por minuto por visitante; los `OPTIONS` no cuentan.
 *  - K-2: CORS propio (sólo la página del regalo y sus vistas previas), nunca el comodín `*` del router público.
 *  - S-11: un token mal formado no es 400; lo contesta el servicio con `{ disponible: false }`.
 *  - S6 m2: un token con un `%` suelto revienta al CASAR la ruta (Express 4 lanza `URIError` con el token en el mensaje, antes
 *    del CORS, del límite y del controller); lo contesta el manejador de la ruta y el global no se entera.
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

import logger from '@/config/logger'
import routes, { ORIGENES_DE_LA_PAGINA_DEL_REGALO } from '@/routes/public.routes'
import { GiftCardError } from '@/services/giftCards/giftCardErrors'

const TOKEN = 'Xk3pQ9vLmN2rT8wYz5aB7cD1eF4gH6jK0sU'
const RUTA = `/api/v1/public/gift-cards/${TOKEN}`

const app = express()
app.use(express.json())
app.use('/api/v1/public', routes)
/** El manejador global, como el de `app.ts`: escribe `err.message` con `logger.error` (ahí se filtraba el token, S6 m2). */
const manejadorGlobal = jest.fn((err: any, _req: any, res: any, _next: any) => {
  logger.error(`Unexpected Error: ${err.message}`, { name: err.name, message: err.message })
  res.status(err.statusCode ?? 500).json({ message: err.message })
})
app.use(manejadorGlobal)

/** Todo lo que recibió el logger, como texto. */
const loQueSeLogueo = () =>
  (['info', 'warn', 'error', 'debug', 'log'] as const)
    .flatMap(m => ((logger as unknown as Record<string, jest.Mock>)[m]?.mock.calls ?? []).map(c => JSON.stringify(c)))
    .join('\n')

/** Cada prueba con su visitante: el límite vive en el módulo y no se reinicia entre pruebas. */
let visitante = 0
const nuevaIp = () => `198.51.100.${++visitante}`

beforeEach(() => {
  mockPagina.mockReset().mockResolvedValue({ disponible: false })
  manejadorGlobal.mockClear()
  for (const m of ['info', 'warn', 'error', 'debug', 'log'] as const) (logger as unknown as Record<string, jest.Mock>)[m]?.mockClear?.()
})

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
  const sesentaYUno = await request(app).get(RUTA).set('CF-Connecting-IP', ip).set('Origin', 'https://pay.avoqado.io')
  expect(sesentaYUno.status).toBe(429)
  expect(sesentaYUno.body).toMatchObject({ success: false, code: 'RATE_LIMIT_EXCEEDED' })
  expect(sesentaYUno.headers['access-control-allow-origin']).toBe('https://pay.avoqado.io') // N6: CORS va ANTES del límite
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

describe('🔴 un token con un % suelto (S6 m2): Express no lo puede decodificar al casar la ruta', () => {
  const ORIGEN = 'https://pay.avoqado.io'

  it.each([`${TOKEN}%`, `${TOKEN}%E0%A4%A`])(
    'GET …/gift-cards/%s ⇒ 200 { disponible: false } exacto, sin caché ni índice, con su CORS, sin el global y sin el token en el log',
    async malo => {
      const r = await request(app).get(`/api/v1/public/gift-cards/${malo}`).set('CF-Connecting-IP', nuevaIp()).set('Origin', ORIGEN)
      expect(r.status).toBe(200)
      expect(r.body).toEqual({ success: true, data: { disponible: false } })
      expect(r.headers['cache-control']).toBe('no-store')
      expect(r.headers['x-robots-tag']).toBe('noindex')
      expect(r.headers['access-control-allow-origin']).toBe(ORIGEN)
      expect(manejadorGlobal).not.toHaveBeenCalled()
      expect(mockPagina).not.toHaveBeenCalled()
      expect(loQueSeLogueo()).not.toContain(TOKEN)
    },
  )

  it.each([undefined, 'https://evil.example'])('con Origin %s ⇒ sin Access-Control-Allow-Origin, y nunca *', async origen => {
    const peticion = request(app).get(`/api/v1/public/gift-cards/${TOKEN}%`).set('CF-Connecting-IP', nuevaIp())
    const r = await (origen ? peticion.set('Origin', origen) : peticion)
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ success: true, data: { disponible: false } })
    expect(r.headers['access-control-allow-origin']).toBeUndefined()
    expect(manejadorGlobal).not.toHaveBeenCalled()
  })

  it('el preflight de esa misma ruta lo resuelve su CORS propio (204 con el origen, sin comodín)', async () => {
    const pre = await request(app)
      .options(`/api/v1/public/gift-cards/${TOKEN}%`)
      .set('CF-Connecting-IP', nuevaIp())
      .set('Origin', ORIGEN)
      .set('Access-Control-Request-Method', 'GET')
    expect(pre.status).toBe(204)
    expect(pre.headers['access-control-allow-origin']).toBe(ORIGEN)
    expect(manejadorGlobal).not.toHaveBeenCalled()
    expect(loQueSeLogueo()).not.toContain(TOKEN)
  })

  it('el mismo error en OTRA ruta del router público sigue llegando al manejador global (no se lo traga)', async () => {
    const r = await request(app).get('/api/v1/public/receipt/abc%')
    expect(r.body).not.toEqual({ success: true, data: { disponible: false } })
    expect(manejadorGlobal).toHaveBeenCalledTimes(1)
    const [err] = manejadorGlobal.mock.calls[0]
    expect(err).toBeInstanceOf(URIError)
    expect(err.status).toBe(400)
  })

  it('un error del controller de la página (no URIError) sigue llegando al manejador global', async () => {
    mockPagina.mockRejectedValue(new GiftCardError('GIFT_CARD_KEYS_MISSING', 'Faltan las llaves.', 409))
    const r = await request(app).get(RUTA).set('CF-Connecting-IP', nuevaIp())
    expect(r.status).toBe(409)
    expect(manejadorGlobal).toHaveBeenCalledTimes(1)
    expect(manejadorGlobal.mock.calls[0][0]).toBeInstanceOf(GiftCardError)
  })
})
