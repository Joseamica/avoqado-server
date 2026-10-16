/**
 * Límite de consultas de tarjetas de regalo por código (spec §6): por aparato y por IP, en memoria, con un 429 que el POS
 * muestra tal cual. Se prueba con la fábrica y topes chicos; las rutas usan los topes de producción.
 * Nota 1 del coordinador (A8 «oráculo de códigos»): cobrar con saldo responde 404 a un código que no existe, así que lleva
 * su propio límite que cuenta SÓLO los fallos (≥ 400): un cobro que sale bien nunca gasta el tope.
 */
import express from 'express'
import request from 'supertest'
import {
  crearLimitadoresDeConsulta,
  giftCardLookupRateLimiters,
  giftCardPayFailureRateLimiters,
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
    expect(r.body).toEqual(RECHAZO)
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
