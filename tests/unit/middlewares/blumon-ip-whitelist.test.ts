/**
 * D1, paso 2 (29-oct-2026): el guardia de avisos de Blumon TPV decide con la IP del PORTERO (`ipDelCliente`:
 * `CF-Connecting-IP`, que Cloudflare no deja inventar, o `req.ip`), nunca con el primer eslabón de X-Forwarded-For, que
 * lo escribe quien llama. El paso 1 sólo observaba; del 22 al 29-oct los 12 avisos reales coincidieron
 * (`docs/audit/2026-10-21-limites-por-ip/registro-d1-paso2-produccion.txt` del workspace).
 *
 * Cada petición trae el X-Forwarded-For que el proxy de Render le entrega a la app: lo que mandó quien llama, más el
 * eslabón de Cloudflare y el del borde al final (Cloudflare y Render AGREGAN, no reemplazan).
 */
import express from 'express'
import request from 'supertest'
import logger from '@/config/logger'
import { blumonIPWhitelist } from '@/middlewares/blumon-ip-whitelist.middleware'

const BLUMON = '3.132.184.158'
const BORDE = '172.69.164.176'

function app() {
  const a = express()
  a.set('trust proxy', 1)
  a.post('/webhooks/blumon/tpv', blumonIPWhitelist, (_req, res) => {
    res.sendStatus(200)
  })
  return a
}

const rechazos = () =>
  (logger.warn as jest.Mock).mock.calls.filter(([mensaje]) => String(mensaje).includes('REJECTED')).map(([, datos]) => datos)

beforeEach(() => jest.clearAllMocks())

describe('guardia de avisos de Blumon TPV — decide con la IP del portero', () => {
  it('el aviso real de Blumon pasa', async () => {
    const res = await request(app())
      .post('/webhooks/blumon/tpv')
      .set('CF-Connecting-IP', BLUMON)
      .set('X-Forwarded-For', `${BLUMON}, ${BORDE}`)
    expect(res.status).toBe(200)
    expect(rechazos()).toEqual([])
  })

  it('🔴 un X-Forwarded-For inventado con la IP de Blumon ya NO pasa, y queda anotado lo que dijo', async () => {
    const intruso = '189.203.10.55'
    const res = await request(app())
      .post('/webhooks/blumon/tpv')
      .set('CF-Connecting-IP', intruso)
      .set('X-Forwarded-For', `${BLUMON}, ${intruso}, ${BORDE}`)
    expect(res.status).toBe(403)
    expect(res.body).toEqual({ success: false, error: 'Forbidden', message: 'IP not authorized' })
    expect(rechazos()).toEqual([expect.objectContaining({ clientIP: intruso, xForwardedFor: `${BLUMON}, ${intruso}, ${BORDE}` })])
  })

  it('quien no es Blumon se rechaza con 403', async () => {
    const ajeno = '189.203.10.55'
    const res = await request(app())
      .post('/webhooks/blumon/tpv')
      .set('CF-Connecting-IP', ajeno)
      .set('X-Forwarded-For', `${ajeno}, ${BORDE}`)
    expect(res.status).toBe(403)
  })

  it('🔴 sin la cabecera de Cloudflare manda la IP que vio el proxy (req.ip), nunca el primer eslabón', async () => {
    const res = await request(app()).post('/webhooks/blumon/tpv').set('X-Forwarded-For', `${BLUMON}, 198.51.100.50`)
    expect(res.status).toBe(403)
    expect(rechazos()).toEqual([expect.objectContaining({ clientIP: '198.51.100.50' })])
  })

  it('la IP del portero en formato IPv6 mapeado (::ffff:) también se reconoce', async () => {
    const res = await request(app())
      .post('/webhooks/blumon/tpv')
      .set('CF-Connecting-IP', `::ffff:${BLUMON}`)
      .set('X-Forwarded-For', `${BLUMON}, ${BORDE}`)
    expect(res.status).toBe(200)
  })
})
