/**
 * Revisión final de la rama (17-sep, D): el 429 de los limitadores de PIN lleva `code: 'RATE_LIMIT_EXCEEDED'`.
 *
 * Antes contestaban `{ error: 'RATE_LIMIT_EXCEEDED', message, retryAfter }` SIN `code`, y los clientes que deciden por `code`
 * (la terminal con la declaración «no se presentó tarjeta», el POS con el cambio de usuario) no podían distinguir «espera 15
 * minutos» de un error cualquiera. Aditivo: `error`, `message`, `retryAfter` (segundos) y la cabecera `Retry-After` se
 * conservan tal cual, y cada limitador sigue contando en SU cubeta (no se crea ninguna nueva).
 *
 * Aquí se ejercitan los limitadores del LOGIN por PIN y del CAMBIO DE USUARIO (IP/aparato y venue); los del override de gerente
 * —la cubeta que comparte la declaración— los ejercita `tests/api-tests/tpv/no-instrument-resolution.api.test.ts` por la ruta real.
 * Límites de desarrollo (NODE_ENV=test): 100 por IP/aparato y 200 por venue, por minuto.
 */
import type { Server } from 'http'
import express, { RequestHandler } from 'express'
import request from 'supertest'
import { pinLoginRateLimiter, pinSwitchUserRateLimiter } from '../../../src/middlewares/pin-login-rate-limit.middleware'

let servidores: Server[] = []

/**
 * UN servidor por prueba, escuchando YA en 127.0.0.1: `request(app)` levantaría uno efímero POR PETICIÓN en `::` y supertest se
 * conecta por IPv4 a ese puerto — con cientos de peticiones en una máquina con otros servidores vivos, alguna cae en el proceso
 * de otro (medido el 17-sep: `Parse Error: Expected HTTP/` y un 501 ajeno). Atado a 127.0.0.1, el puerto es de esta prueba.
 */
async function app(limiters: RequestHandler[]): Promise<Server> {
  const a = express()
  // Un salto de proxy: `X-Forwarded-For` decide `req.ip` y cada petición puede venir de una IP distinta.
  a.set('trust proxy', 1)
  a.post('/v/:venueId/pin', ...limiters, (_req, res) => {
    res.json({ ok: true })
  })
  const servidor = a.listen(0, '127.0.0.1')
  servidores.push(servidor)
  // `listen` con host resuelve la dirección de forma asíncrona: hasta el evento, `address()` es null y supertest levantaría otro.
  await new Promise<void>(listo => servidor.once('listening', () => listo()))
  return servidor
}

afterEach(async () => {
  await Promise.all(servidores.map(s => new Promise<void>(listo => s.close(() => listo()))))
  servidores = []
})

/** Dispara hasta el primer 429 y lo devuelve junto con cuántas pasaron antes. */
async function hastaElPrimer429(enviar: (i: number) => request.Test, tope: number) {
  for (let i = 0; i < tope; i++) {
    const res = await enviar(i)
    if (res.status === 429) return { pasaron: i, res }
    expect(res.status).toBe(200)
  }
  throw new Error(`nunca llegó el 429 en ${tope} intentos`)
}

const cuerpoDel429 = (res: request.Response, mensaje: RegExp) => {
  expect(res.body).toEqual({
    error: 'RATE_LIMIT_EXCEEDED',
    code: 'RATE_LIMIT_EXCEEDED',
    message: expect.stringMatching(mensaje),
    retryAfter: 15 * 60,
  })
  // La cabecera estándar la pone express-rate-limit (standardHeaders): el handler no la pierde.
  expect(Number(res.headers['retry-after'])).toBeGreaterThan(0)
  expect(res.headers['ratelimit-limit']).toBeDefined()
}

describe('D · el 429 de los limitadores de PIN lleva `code` sin perder `retryAfter` ni `Retry-After`', () => {
  it('login por PIN, cubeta por IP: el 101º intento de la misma IP ⇒ 429 con code', async () => {
    const a = await app(pinLoginRateLimiter)
    const { pasaron, res } = await hastaElPrimer429(() => request(a).post('/v/venue-ip/pin').set('X-Forwarded-For', '10.1.0.1'), 150)
    expect(pasaron).toBe(100)
    cuerpoDel429(res, /inicio de sesión/)
  })

  it('login por PIN, cubeta por venue: 201 intentos desde IPs DISTINTAS ⇒ 429 del venue con code', async () => {
    const a = await app(pinLoginRateLimiter)
    const { pasaron, res } = await hastaElPrimer429(
      i =>
        request(a)
          .post('/v/venue-venue/pin')
          .set('X-Forwarded-For', `10.2.${Math.floor(i / 250)}.${i % 250}`),
      250,
    )
    expect(pasaron).toBe(200)
    cuerpoDel429(res, /Este local/)
  })

  it('cambio de usuario, cubeta por aparato: el 101º intento del mismo aparato ⇒ 429 con code', async () => {
    const a = await app(pinSwitchUserRateLimiter)
    const { pasaron, res } = await hastaElPrimer429(
      () => request(a).post('/v/venue-switch/pin').set('X-Device-Id', 'tablet-caja').set('X-Forwarded-For', '10.3.0.1'),
      150,
    )
    expect(pasaron).toBe(100)
    cuerpoDel429(res, /Espera 15 minutos o inicia sesión con tu contraseña/)
  })

  it('cambio de usuario, cubeta por venue: 201 intentos desde aparatos DISTINTOS ⇒ 429 del venue con code', async () => {
    const a = await app(pinSwitchUserRateLimiter)
    const { pasaron, res } = await hastaElPrimer429(
      i => request(a).post('/v/venue-switch-venue/pin').set('X-Device-Id', `tablet-${i}`).set('X-Forwarded-For', '10.4.0.1'),
      250,
    )
    expect(pasaron).toBe(200)
    cuerpoDel429(res, /Espera 15 minutos o inicia sesión con tu contraseña/)
  })
})
