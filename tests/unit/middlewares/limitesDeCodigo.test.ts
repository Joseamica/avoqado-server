/**
 * Límites del alta con código (Task 2 del plan «Alta desde la landing con código de 6 dígitos»).
 *
 * 🔴 Detrás del proxy de la landing todos los visitantes llegan con la MISMA IP. Con `writeLimit`
 * (5/min por IP) el sexto prospecto del minuto recibía 429 aunque fuera otra persona: el límite de
 * `/contact` tiene que contar por CORREO (Codex r3 #4 y #11).
 */
import fs from 'fs'
import path from 'path'
import express from 'express'
import request from 'supertest'
import rateLimit from 'express-rate-limit'
import { ipDelCliente } from '@/utils/clientIp'

import {
  limiteContactoPorCorreo,
  limiteContactoPorIp,
  limiteEnviosDeCodigo,
  limiteEnviosDeCodigoEnContacto,
  limiteIntentosDeCodigo,
} from '@/middlewares/limitesDeCodigo'

const IP_DEL_PROXY = '198.51.100.20'

function appCon(...limitadores: express.RequestHandler[]) {
  const app = express()
  app.use(express.json())
  app.post('/contact', ...limitadores, (_req, res) => res.status(200).json({ ok: true }))
  return app
}

const enviar = (app: express.Express, email: string) => request(app).post('/contact').set('CF-Connecting-IP', IP_DEL_PROXY).send({ email })

describe('límite de /contact: cuenta por correo, no por IP', () => {
  it('6 correos distintos en un minuto desde la MISMA IP pasan todos', async () => {
    const app = appCon(limiteContactoPorCorreo)
    for (let i = 1; i <= 6; i++) {
      expect((await enviar(app, `prospecto${i}@ejemplo.mx`)).status).toBe(200)
    }
  })

  it('control: el writeLimit de hoy (por IP) SÍ le daba 429 al sexto correo distinto', async () => {
    const porIp = rateLimit({ windowMs: 60_000, max: 5, keyGenerator: req => ipDelCliente(req) || 'desconocida' })
    const app = appCon(porIp)
    for (let i = 1; i <= 5; i++) expect((await enviar(app, `prospecto${i}@ejemplo.mx`)).status).toBe(200)
    expect((await enviar(app, 'prospecto6@ejemplo.mx')).status).toBe(429)
  })

  it('el mismo correo (sin importar mayúsculas ni espacios) sigue topado en 5 por minuto', async () => {
    const app = appCon(limiteContactoPorCorreo)
    for (let i = 0; i < 5; i++) expect((await enviar(app, 'repetido@ejemplo.mx')).status).toBe(200)
    expect((await enviar(app, '  REPETIDO@ejemplo.mx ')).status).toBe(429)
    // Otro correo, misma IP: no se ve afectado.
    expect((await enviar(app, 'otro@ejemplo.mx')).status).toBe(200)
  })

  it('la cadena completa de /contact deja pasar 6 correos distintos', async () => {
    const app = appCon(limiteContactoPorIp, limiteContactoPorCorreo, limiteEnviosDeCodigoEnContacto)
    for (let i = 1; i <= 6; i++) {
      expect((await enviar(app, `encadenado${i}@ejemplo.mx`)).status).toBe(200)
    }
  })
})

describe('los limitadores del código viven en un solo módulo', () => {
  const fuente = (archivo: string) => fs.readFileSync(path.join(__dirname, '../../../src', archivo), 'utf8')

  it('onboarding.routes.ts usa las MISMAS instancias (no copias) para verify-email y resend-verification', () => {
    const rutas = fuente('routes/onboarding.routes.ts')
    expect(rutas).toMatch(/from '\.\.\/middlewares\/limitesDeCodigo'/)
    expect(rutas).toMatch(/router\.post\('\/verify-email', limiteIntentosDeCodigo,/)
    expect(rutas).toMatch(/router\.post\('\/resend-verification', limiteEnviosDeCodigo,/)
    expect(rutas).not.toMatch(/const (verificationRateLimiter|resendRateLimiter)\b/)
  })

  it('/contact encadena techo por IP, tope por correo y envíos de código; writeLimit compartido no cambia', () => {
    const rutas = fuente('routes/public.routes.ts')
    expect(rutas).toMatch(
      /router\.post\(\s*'\/contact',\s*limiteContactoPorIp,\s*limiteContactoPorCorreo,\s*limiteEnviosDeCodigoEnContacto,\s*validateRequest\(contactSchema\),\s*submitContact,?\s*\)/,
    )
    expect(rutas).toMatch(/const writeLimit = rateLimit\(\{ windowMs: 60_000, max: 5, keyGenerator: porVisitante,/)
  })

  it('exporta los limitadores como middlewares', () => {
    for (const limite of [
      limiteContactoPorCorreo,
      limiteContactoPorIp,
      limiteEnviosDeCodigo,
      limiteEnviosDeCodigoEnContacto,
      limiteIntentosDeCodigo,
    ]) {
      expect(typeof limite).toBe('function')
    }
  })
})

describe('/contact y el presupuesto de envíos de código (producción: 3 por correo por hora)', () => {
  type Limites = typeof import('@/middlewares/limitesDeCodigo')
  const interruptorOriginal = process.env.ALTA_LANDING_CON_CODIGO
  const entornoOriginal = process.env.NODE_ENV

  /** Módulo FRESCO (contadores en cero) como se carga en producción: el tope se decide al importar. */
  function cargarComoEnProduccion(): Limites {
    process.env.NODE_ENV = 'production'
    let modulo!: Limites
    try {
      jest.isolateModules(() => {
        modulo = require('@/middlewares/limitesDeCodigo')
      })
    } finally {
      process.env.NODE_ENV = entornoOriginal
    }
    return modulo
  }

  /** /contact (con su cadena real) + /resend-verification (sólo el limitador de onboarding). */
  function appDeProduccion() {
    const limites = cargarComoEnProduccion()
    const llegaron = { contacto: 0 }
    const app = express()
    app.use(express.json())
    app.post(
      '/contact',
      limites.limiteContactoPorIp,
      limites.limiteContactoPorCorreo,
      limites.limiteEnviosDeCodigoEnContacto,
      (_req, res) => {
        llegaron.contacto++
        res.status(200).json({ ok: true })
      },
    )
    app.post('/resend-verification', limites.limiteEnviosDeCodigo, (_req, res) => res.status(200).json({ ok: true }))
    return { app, llegaron }
  }

  afterEach(() => {
    if (interruptorOriginal === undefined) delete process.env.ALTA_LANDING_CON_CODIGO
    else process.env.ALTA_LANDING_CON_CODIGO = interruptorOriginal
  })

  it('interruptor APAGADO: 4 envíos del mismo correo en una hora llegan los 4 al controlador (no se gasta el presupuesto)', async () => {
    delete process.env.ALTA_LANDING_CON_CODIGO
    const { app, llegaron } = appDeProduccion()

    for (let i = 1; i <= 4; i++) expect((await enviar(app, 'sin-codigo@ejemplo.mx')).status).toBe(200)

    expect(llegaron.contacto).toBe(4)
    // Y como /contact no contó, el reenvío de onboarding de ese correo sigue con su presupuesto completo.
    for (let i = 1; i <= 3; i++) {
      expect(
        (await request(app).post('/resend-verification').set('CF-Connecting-IP', IP_DEL_PROXY).send({ email: 'sin-codigo@ejemplo.mx' }))
          .status,
      ).toBe(200)
    }
  })

  it('interruptor PRENDIDO: el 4.º envío recibe 429 en JSON y en español, y no llega al controlador', async () => {
    process.env.ALTA_LANDING_CON_CODIGO = 'true'
    const { app, llegaron } = appDeProduccion()

    for (let i = 1; i <= 3; i++) expect((await enviar(app, 'con-codigo@ejemplo.mx')).status).toBe(200)
    const cuarto = await enviar(app, 'con-codigo@ejemplo.mx')

    expect(cuarto.status).toBe(429)
    expect(cuarto.headers['content-type']).toMatch(/application\/json/)
    expect(cuarto.body).toEqual({
      success: false,
      code: 'DEMASIADOS_ENVIOS',
      message: 'Ya te mandamos varios códigos. Espera unos minutos y revisa tu correo.',
    })
    expect(llegaron.contacto).toBe(3)
    // Otro correo no se ve afectado.
    expect((await enviar(app, 'otra-persona@ejemplo.mx')).status).toBe(200)
  })

  it('interruptor PRENDIDO: el contador es UNO solo con /resend-verification, y onboarding sigue contestando texto plano', async () => {
    process.env.ALTA_LANDING_CON_CODIGO = 'true'
    const { app } = appDeProduccion()

    for (let i = 1; i <= 2; i++) expect((await enviar(app, 'compartido@ejemplo.mx')).status).toBe(200)
    const reenvio = () =>
      request(app).post('/resend-verification').set('CF-Connecting-IP', IP_DEL_PROXY).send({ email: 'compartido@ejemplo.mx' })
    expect((await reenvio()).status).toBe(200) // 3.º del presupuesto compartido
    const topado = await reenvio()

    expect(topado.status).toBe(429)
    expect(topado.headers['content-type']).toMatch(/text\/html|text\/plain/)
    expect(topado.text).toBe('Too many resend requests. Please try again later.')
    // Y desde /contact el mismo correo ya está topado, con el JSON en español.
    const desdeContacto = await enviar(app, 'compartido@ejemplo.mx')
    expect(desdeContacto.status).toBe(429)
    expect(desdeContacto.body.code).toBe('DEMASIADOS_ENVIOS')
  })

  it('techo por IP: la petición 120 del minuto pasa y la 121 (con correos distintos) recibe 429 en JSON y en español', async () => {
    delete process.env.ALTA_LANDING_CON_CODIGO
    const { app, llegaron } = appDeProduccion()

    // Correos distintos: ni el tope por correo (5/min) ni el de envíos estorban; sólo el techo por IP.
    for (let i = 1; i <= 120; i++) expect((await enviar(app, `visitante${i}@ejemplo.mx`)).status).toBe(200)
    expect(llegaron.contacto).toBe(120)

    const siguiente = await enviar(app, 'visitante121@ejemplo.mx')
    expect(siguiente.status).toBe(429)
    expect(siguiente.headers['content-type']).toMatch(/application\/json/)
    expect(siguiente.body).toEqual({
      success: false,
      code: 'DEMASIADAS_SOLICITUDES',
      message: 'Demasiadas solicitudes desde tu red. Intenta de nuevo en un minuto.',
    })
    expect(llegaron.contacto).toBe(120)

    // Otra IP real tiene su propia cubeta.
    const otraIp = await request(app).post('/contact').set('CF-Connecting-IP', '203.0.113.9').send({ email: 'otra-ip@ejemplo.mx' })
    expect(otraIp.status).toBe(200)
  })
})
