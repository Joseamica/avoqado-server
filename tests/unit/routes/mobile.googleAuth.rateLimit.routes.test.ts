/**
 * Entrar con Google en el POS (hz:6bfcd3a1:D1): las dos rutas públicas nuevas llevan su propio tope por IP real del
 * visitante, con el `mobile.routes.ts` real y el límite real (sin mockear express-rate-limit). El controlador va mockeado.
 */
import express from 'express'
import request from 'supertest'

jest.mock(
  '@/controllers/mobile/auth.mobile.controller',
  () => new Proxy({}, { get: () => (_req: any, res: any) => res.json({ ok: true }) }),
)

import mobileRoutes from '@/routes/mobile.routes'

const app = express()
app.use(express.json())
app.use('/api/v1/mobile', mobileRoutes)

const TEXTO = 'Demasiados intentos. Espera un minuto y vuelve a intentarlo.'

it('GET /auth/google/config: 60 por minuto por IP; la 61 es 429 en español', async () => {
  const ip = '198.51.100.10'
  for (let i = 0; i < 60; i++) {
    const r = await request(app).get('/api/v1/mobile/auth/google/config').set('cf-connecting-ip', ip)
    expect(r.status).not.toBe(429)
  }
  const r = await request(app).get('/api/v1/mobile/auth/google/config').set('cf-connecting-ip', ip)
  expect(r.status).toBe(429)
  expect(r.body.message).toBe(TEXTO)
  // otra IP no comparte el cupo
  const otra = await request(app).get('/api/v1/mobile/auth/google/config').set('cf-connecting-ip', '198.51.100.11')
  expect(otra.status).not.toBe(429)
})

it('POST /auth/google: 20 por minuto por IP; la 21 es 429 en español', async () => {
  const ip = '198.51.100.20'
  for (let i = 0; i < 20; i++) {
    const r = await request(app).post('/api/v1/mobile/auth/google').set('cf-connecting-ip', ip).send({ idToken: 'x' })
    expect(r.status).not.toBe(429)
  }
  const r = await request(app).post('/api/v1/mobile/auth/google').set('cf-connecting-ip', ip).send({ idToken: 'x' })
  expect(r.status).toBe(429)
  expect(r.body.message).toBe(TEXTO)
})
