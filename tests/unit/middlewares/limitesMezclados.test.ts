/**
 * Alta con código, Tarea 4: el presupuesto de intentos de un correo es UNO solo entre
 * `/onboarding/verify-email` y `/public/alta/verificar` (la MISMA instancia del limitador).
 * 3 intentos en una + 3 en la otra con el mismo correo => el sexto da 429.
 */
import fs from 'fs'
import path from 'path'
import express from 'express'
import request from 'supertest'

type Limites = typeof import('@/middlewares/limitesDeCodigo')

/** Módulo FRESCO (contadores en cero) como se carga en producción: el tope (5) se decide al importar. */
function cargarComoEnProduccion(): Limites {
  const original = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  let modulo!: Limites
  try {
    jest.isolateModules(() => {
      modulo = require('@/middlewares/limitesDeCodigo')
    })
  } finally {
    process.env.NODE_ENV = original
  }
  return modulo
}

describe('límites mezclados entre onboarding y alta con código', () => {
  it('3 en /onboarding/verify-email + 3 en /public/alta/verificar con el mismo correo: el sexto da 429', async () => {
    const { limiteIntentosDeCodigo } = cargarComoEnProduccion()
    const app = express()
    app.use(express.json())
    // Mismo cableado que las rutas reales (ver la prueba de código fuente de abajo).
    app.post('/onboarding/verify-email', limiteIntentosDeCodigo, (_q, s) => s.status(400).json({ ok: false }))
    app.post('/public/alta/verificar', limiteIntentosDeCodigo, (_q, s) => s.status(400).json({ ok: false }))

    const cuerpo = { email: 'Mezclado@Example.com' }
    for (let i = 0; i < 3; i++) expect((await request(app).post('/onboarding/verify-email').send(cuerpo)).status).toBe(400)
    for (let i = 0; i < 2; i++) expect((await request(app).post('/public/alta/verificar').send(cuerpo)).status).toBe(400)
    expect((await request(app).post('/public/alta/verificar').send(cuerpo)).status).toBe(429)
    // Otro correo no se ve afectado.
    expect((await request(app).post('/public/alta/verificar').send({ email: 'otra@example.com' })).status).toBe(400)
  })

  it('las rutas REALES usan esas mismas instancias, detrás del interruptor (404 sin gastar ningún límite)', () => {
    const fuente = (f: string) => fs.readFileSync(path.join(__dirname, '../../../src', f), 'utf8')
    expect(fuente('routes/onboarding.routes.ts')).toMatch(/router\.post\('\/verify-email', limiteIntentosDeCodigo,/)
    const publicas = fuente('routes/public.routes.ts')
    expect(publicas).toMatch(/router\.post\('\/alta\/verificar', soloConAltaConCodigo, limiteIntentosDeCodigo, validateRequest\(altaVerificarSchema\), verificarAlta\)/)
    expect(publicas).toMatch(/router\.post\('\/alta\/reenviar', soloConAltaConCodigo, limiteEnviosDeCodigoEnContacto, validateRequest\(altaReenviarSchema\), reenviarAlta\)/)
    expect(publicas).toMatch(/altaLandingConCodigo\(\) \? next\(\) : next\(new NotFoundError\(\)\)/)
  })
})
