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

import { limiteContactoPorCorreo, limiteEnviosDeCodigo, limiteIntentosDeCodigo } from '@/middlewares/limitesDeCodigo'

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

  it('encadenado con limiteEnviosDeCodigo, 6 correos distintos tampoco se estorban', async () => {
    const app = appCon(limiteContactoPorCorreo, limiteEnviosDeCodigo)
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

  it('/contact cuenta por correo y encadena limiteEnviosDeCodigo; writeLimit compartido no cambia', () => {
    const rutas = fuente('routes/public.routes.ts')
    expect(rutas).toMatch(/router\.post\('\/contact', limiteContactoPorCorreo, limiteEnviosDeCodigo, validateRequest\(contactSchema\)/)
    expect(rutas).toMatch(/const writeLimit = rateLimit\(\{ windowMs: 60_000, max: 5, keyGenerator: porVisitante,/)
  })

  it('exporta los tres limitadores como middlewares', () => {
    for (const limite of [limiteContactoPorCorreo, limiteEnviosDeCodigo, limiteIntentosDeCodigo]) {
      expect(typeof limite).toBe('function')
    }
  })
})
