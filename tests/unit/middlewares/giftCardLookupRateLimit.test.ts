/**
 * Límite de consultas de tarjetas de regalo por código (spec §6): por aparato y por IP, en memoria, con un 429 que el POS
 * muestra tal cual. Se prueba con la fábrica y topes chicos; las rutas usan los topes de producción.
 * Nota 1 del coordinador (A8 «oráculo de códigos»): cobrar con saldo responde 404 a un código que no existe, así que lleva
 * su propio límite que cuenta SÓLO los fallos (≥ 400): un cobro que sale bien nunca gasta el tope.
 */
import express from 'express'
import request from 'supertest'
import logger from '@/config/logger'
import {
  crearLimitadoresDeConsulta,
  giftCardLookupRateLimiters,
  giftCardPayFailureRateLimiters,
  giftCardRevealRateLimiters,
} from '@/middlewares/gift-card-lookup-rate-limit.middleware'

function app(maxPorAparato: number, maxPorIp: number) {
  const a = express()
  a.get('/venues/:venueId/gift-cards/lookup', ...crearLimitadoresDeConsulta(maxPorAparato, maxPorIp), (_req, res) => res.json({ ok: true }))
  return a
}
const CONSULTA = '/venues/v1/gift-cards/lookup'
const RECHAZO = {
  success: false,
  code: 'GIFT_CARD_LOOKUP_RATE_LIMITED',
  message: 'Demasiadas consultas de tarjetas de regalo seguidas. Espera un minuto y vuelve a intentar.',
  retryAfter: 60,
}

describe('límite de consultas de tarjetas de regalo', () => {
  it('el mismo aparato se frena al pasar su tope, con código y texto para el POS', async () => {
    const a = app(2, 100)
    for (let i = 0; i < 2; i++) expect((await request(a).get(CONSULTA).set('X-Device-Id', 'caja-1')).status).toBe(200)
    const r = await request(a).get(CONSULTA).set('X-Device-Id', 'caja-1')
    expect(r.status).toBe(429)
    expect(r.body).toEqual(RECHAZO)
  })

  it('otra caja del mismo WiFi sigue consultando (el tope por IP es más holgado)', async () => {
    const a = app(2, 100)
    for (let i = 0; i < 3; i++) await request(a).get(CONSULTA).set('X-Device-Id', 'caja-1')
    expect((await request(a).get(CONSULTA).set('X-Device-Id', 'caja-2')).status).toBe(200)
  })

  it('el tope por IP frena aunque cambie el aparato', async () => {
    const a = app(100, 3)
    for (let i = 0; i < 3; i++) expect((await request(a).get(CONSULTA).set('X-Device-Id', `caja-${i}`)).status).toBe(200)
    expect((await request(a).get(CONSULTA).set('X-Device-Id', 'caja-9')).status).toBe(429)
  })

  it('las rutas montan los dos limitadores (IP y aparato)', () => {
    expect(giftCardLookupRateLimiters).toHaveLength(2)
  })
})

describe('límite de intentos FALLIDOS al cobrar con saldo (nota 1: el oráculo de códigos)', () => {
  const COBRO = '/venues/v1/orders/o1/pay-gift-card'
  /** El manejador responde lo que pida `?status=`: 200 = cobro hecho; 404 = código que no existe. */
  function appDeCobro(maxPorAparato: number, maxPorIp: number) {
    const a = express()
    a.post(
      '/venues/:venueId/orders/:orderId/pay-gift-card',
      ...crearLimitadoresDeConsulta(maxPorAparato, maxPorIp, { soloFallos: true, prefijo: 'gift-card-pay' }),
      (req, res) => res.status(Number(req.query.status)).json({ ok: true }),
    )
    return a
  }

  it('N cobros que salen bien no gastan el tope', async () => {
    const a = appDeCobro(2, 100)
    for (let i = 0; i < 5; i++) expect((await request(a).post(`${COBRO}?status=200`).set('X-Device-Id', 'caja-1')).status).toBe(200)
  })

  it('N fallos (404) sí lo gastan: el siguiente intento es 429 con el código para el POS, aunque ya traiga un código bueno', async () => {
    const a = appDeCobro(2, 100)
    for (let i = 0; i < 2; i++) expect((await request(a).post(`${COBRO}?status=404`).set('X-Device-Id', 'caja-1')).status).toBe(404)
    const r = await request(a).post(`${COBRO}?status=200`).set('X-Device-Id', 'caja-1')
    expect(r.status).toBe(429)
    // ⭐ (C3 menor 1): lo ve la cajera al COBRAR: habla de intentos de cobro, no de consultas. El `code` es el mismo.
    expect(r.body).toEqual({
      ...RECHAZO,
      message: 'Demasiados intentos de cobro con tarjeta de regalo seguidos. Espera un minuto y vuelve a intentar.',
    })
  })

  it('⭐ (C3 menor 1) la línea del log dice qué limitador frenó (`limiter`): la del cobro no se confunde con la de la consulta', async () => {
    const aviso = jest.spyOn(logger, 'warn').mockImplementation(() => logger)
    const cobro = appDeCobro(1, 100)
    await request(cobro).post(`${COBRO}?status=404`).set('X-Device-Id', 'caja-1')
    await request(cobro).post(`${COBRO}?status=404`).set('X-Device-Id', 'caja-1')
    const consulta = app(1, 100)
    await request(consulta).get(CONSULTA).set('X-Device-Id', 'caja-1')
    await request(consulta).get(CONSULTA).set('X-Device-Id', 'caja-1')
    const llamadas = aviso.mock.calls as unknown as Array<[string, { limiter?: string }]>
    const lineas = llamadas.map(([texto, datos]) => [texto, datos.limiter])
    expect(lineas).toEqual([
      ['🚨 Límite de intentos de cobro con tarjeta de regalo excedido', 'gift-card-pay'],
      ['🚨 Límite de consultas de tarjetas de regalo excedido', 'gift-card-lookup'],
    ])
    aviso.mockRestore()
  })

  it('el fallo se cuenta con la llave del cobro, no con la de la consulta (el prefijo va al inicio de las dos llaves)', async () => {
    const [porIp, porAparato] = crearLimitadoresDeConsulta(5, 100, { soloFallos: true, prefijo: 'gift-card-pay' })
    const a = express()
    a.post('/venues/:venueId/orders/:orderId/pay-gift-card', porIp, porAparato, (_req, res) => res.status(404).json({ ok: false }))
    await request(a).post(COBRO).set('X-Device-Id', 'caja-1')
    expect((await porAparato.getKey('gift-card-pay:device:v1:caja-1'))?.totalHits).toBe(1)
    expect(await porAparato.getKey('gift-card-lookup:device:v1:caja-1')).toBeUndefined()
  })

  it('las rutas montan los dos limitadores de fallos (IP y aparato), distintos de los de consulta', () => {
    expect(giftCardPayFailureRateLimiters).toHaveLength(2)
    expect(giftCardPayFailureRateLimiters.some(l => giftCardLookupRateLimiters.includes(l))).toBe(false)
  })
})

/** 1b S4 (A28, S-5): la ventana, el `code` y el texto de cada limitador; mostrar códigos tiene el suyo. */
describe('opciones del limitador (1b S4)', () => {
  const conOpciones = (opciones: Parameters<typeof crearLimitadoresDeConsulta>[2]) => {
    const a = express()
    a.get('/venues/:venueId/gift-cards/lookup', ...crearLimitadoresDeConsulta(1, 100, opciones), (_req, res) => res.json({ ok: true }))
    return a
  }
  const segundo = async (a: express.Express) => {
    await request(a).get(CONSULTA).set('X-Device-Id', 'caja-1')
    return request(a).get(CONSULTA).set('X-Device-Id', 'caja-1')
  }

  it('con ventanaMs: 600_000 el 429 dice retryAfter: 600', async () => {
    expect((await segundo(conOpciones({ ventanaMs: 600_000 }))).body.retryAfter).toBe(600)
  })

  it('sin ventanaMs sigue siendo 60, como hoy', async () => {
    expect((await segundo(conOpciones({}))).body.retryAfter).toBe(60)
  })

  it('code y mensaje propios sustituyen a los de la consulta', async () => {
    const r = await segundo(conOpciones({ code: 'GIFT_CARD_PHONE_RATE_LIMITED', mensaje: 'Espera unos minutos.' }))
    expect(r.status).toBe(429)
    expect(r.body).toMatchObject({ code: 'GIFT_CARD_PHONE_RATE_LIMITED', message: 'Espera unos minutos.' })
  })

  it('mostrar códigos: dos limitadores propios (no los de consultar ni cobrar)', () => {
    expect(giftCardRevealRateLimiters).toHaveLength(2)
    expect(giftCardRevealRateLimiters.some(l => giftCardLookupRateLimiters.includes(l) || giftCardPayFailureRateLimiters.includes(l))).toBe(
      false,
    )
  })

  it('S-5 en producción: 10 por minuto por aparato; el 11.º ⇒ 429 con el code de la consulta y su texto', async () => {
    const antes = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    let deProduccion: typeof giftCardRevealRateLimiters = []
    jest.isolateModules(() => {
      deProduccion = require('@/middlewares/gift-card-lookup-rate-limit.middleware').giftCardRevealRateLimiters
    })
    process.env.NODE_ENV = antes
    const a = express()
    a.get('/venues/:venueId/gift-cards/lookup', ...deProduccion, (_req, res) => res.json({ ok: true }))
    for (let i = 0; i < 10; i++) expect((await request(a).get(CONSULTA).set('X-Device-Id', 'caja-revela')).status).toBe(200)
    const r = await request(a).get(CONSULTA).set('X-Device-Id', 'caja-revela')
    expect(r.status).toBe(429)
    expect(r.body).toEqual({
      success: false,
      code: 'GIFT_CARD_LOOKUP_RATE_LIMITED',
      message: 'Demasiadas veces seguidas mostrando códigos. Espera un minuto.',
      retryAfter: 60,
    })
  })
})
