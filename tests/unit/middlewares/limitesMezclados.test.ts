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
    const { limiteIntentosDeCodigo, limiteIntentosDeCodigoEnAlta } = cargarComoEnProduccion()
    const app = express()
    app.use(express.json())
    // Mismo cableado que las rutas reales (ver la prueba de código fuente de abajo).
    app.post('/onboarding/verify-email', limiteIntentosDeCodigo, (_q, s) => s.status(400).json({ ok: false }))
    app.post('/public/alta/verificar', limiteIntentosDeCodigoEnAlta, (_q, s) => s.status(400).json({ ok: false }))

    const cuerpo = { email: 'Mezclado@Example.com' }
    for (let i = 0; i < 3; i++) expect((await request(app).post('/onboarding/verify-email').send(cuerpo)).status).toBe(400)
    for (let i = 0; i < 2; i++) expect((await request(app).post('/public/alta/verificar').send(cuerpo)).status).toBe(400)
    const sexto = await request(app).post('/public/alta/verificar').send(cuerpo)
    expect(sexto.status).toBe(429)
    expect(sexto.body).toEqual({
      success: false,
      code: 'DEMASIADOS_INTENTOS',
      message: 'Hiciste demasiados intentos. Espera unos minutos y pide un código nuevo.',
    })
    // /onboarding/verify-email conserva su respuesta de hoy: texto plano.
    const onb = await request(app).post('/onboarding/verify-email').send(cuerpo)
    expect(onb.status).toBe(429)
    expect(onb.text).toBe('Too many verification attempts. Please try again later.')
    // Otro correo no se ve afectado.
    expect((await request(app).post('/public/alta/verificar').send({ email: 'otra@example.com' })).status).toBe(400)
  })

  it('las rutas REALES usan esas mismas instancias, con la compuerta primero', () => {
    const fuente = (f: string) => fs.readFileSync(path.join(__dirname, '../../../src', f), 'utf8')
    expect(fuente('routes/onboarding.routes.ts')).toMatch(/router\.post\('\/verify-email', limiteIntentosDeCodigo,/)
    const publicas = fuente('routes/public.routes.ts')
    expect(publicas).toMatch(/router\.post\('\/alta\/verificar', soloConAltaConCodigo, limiteIntentosDeCodigoEnAlta, validateRequest\(altaVerificarSchema\), verificarAlta\)/)
    expect(publicas).toMatch(/router\.post\('\/alta\/reenviar', soloConAltaConCodigo, limiteEnviosDeCodigoEnContacto, validateRequest\(altaReenviarSchema\), reenviarAlta\)/)
  })

  it('con el interruptor APAGADO las dos rutas responden 404 sin consumir el limitador; prendido, pasan', async () => {
    const { limiteIntentosDeCodigoEnAlta, limiteEnviosDeCodigoEnContacto } = cargarComoEnProduccion()
    const { soloConAltaConCodigo } = require('@/config/altaLandingConCodigo') as typeof import('@/config/altaLandingConCodigo')
    const app = express()
    app.use(express.json())
    // Mismo orden que las rutas reales: compuerta, limitador, controlador.
    app.post('/public/alta/verificar', soloConAltaConCodigo, limiteIntentosDeCodigoEnAlta, (_q, s) => s.status(400).json({ ok: false }))
    app.post('/public/alta/reenviar', soloConAltaConCodigo, limiteEnviosDeCodigoEnContacto, (_q, s) => s.json({ success: true }))
    const original = process.env.ALTA_LANDING_CON_CODIGO
    const cuerpo = { email: 'apagado@example.com' }
    try {
      process.env.ALTA_LANDING_CON_CODIGO = 'false'
      for (let i = 0; i < 8; i++) expect((await request(app).post('/public/alta/verificar').send(cuerpo)).status).toBe(404)
      for (let i = 0; i < 5; i++) expect((await request(app).post('/public/alta/reenviar').send(cuerpo)).status).toBe(404)
      process.env.ALTA_LANDING_CON_CODIGO = 'true'
      // Nada se gastó mientras estuvo apagado: los 5 intentos y los 3 envíos completos siguen disponibles.
      for (let i = 0; i < 5; i++) expect((await request(app).post('/public/alta/verificar').send(cuerpo)).status).toBe(400)
      for (let i = 0; i < 3; i++) expect((await request(app).post('/public/alta/reenviar').send(cuerpo)).status).toBe(200)
    } finally {
      if (original === undefined) delete process.env.ALTA_LANDING_CON_CODIGO
      else process.env.ALTA_LANDING_CON_CODIGO = original
    }
  })
})
