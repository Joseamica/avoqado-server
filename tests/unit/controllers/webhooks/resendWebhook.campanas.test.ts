/**
 * El webhook de Resend lo comparten DOS carriles: el Marketing de superadmin (Avoqado → los
 * venues), que ya estaba, y las campañas de un negocio a SUS clientes.
 *
 * Estas pruebas fijan las cosas que no pueden romperse al haberlos juntado:
 *
 *  1. El carril de superadmin se comporta EXACTAMENTE igual que antes.
 *  2. 🔴 Un fallo procesando un rebote nuestro devuelve **500**, no 200. El 200-siempre del
 *     resto de la función existe para que Resend no reintente eventos que no nos interesan;
 *     pero tragarse un rebote deja ese correo muerto sin suprimir y lo seguimos intentando,
 *     quemando la reputación del subdominio que comparten todos los negocios.
 *  3. 🔴 La verificación de firma depende de `RESEND_WEBHOOK_SECRET`, y esta suite CONTROLA esa
 *     variable en cada prueba. Sin eso el archivo pasaba solo y fallaba 4/4 en `pre-deploy`
 *     (2026-09-04): otra suite del mismo worker importaba `config/env.ts`, cuyo `dotenv.config()`
 *     carga el `.env` real en el `process.env` compartido del worker, y el controlador capturaba
 *     el secreto en una constante de módulo al importar. Un test que no fija su entorno hereda
 *     el de quien corrió antes.
 */
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))
jest.mock('@/services/superadmin/marketing.superadmin.service', () => ({ handleResendWebhook: jest.fn() }))
jest.mock('@/services/marketing/campaignWebhook.service', () => ({ procesarAvisoDeResend: jest.fn() }))

import { Webhook } from 'svix'
import { handleResendWebhook as handler, resendWebhookHealthCheck } from '@/controllers/webhooks/resend.webhook.controller'
import * as superadmin from '@/services/superadmin/marketing.superadmin.service'
import { procesarAvisoDeResend } from '@/services/marketing/campaignWebhook.service'

const superadminHandler = superadmin.handleResendWebhook as unknown as jest.Mock
const propio = procesarAvisoDeResend as unknown as jest.Mock

// Secreto con el formato real de Svix: prefijo `whsec_` + bytes en base64.
const TEST_SECRET = 'whsec_' + Buffer.from('avoqado-test-secret-1234567890ab').toString('base64')
const OTHER_SECRET = 'whsec_' + Buffer.from('otro-secreto-que-no-es-el-bueno!').toString('base64')

const originalSecret = process.env.RESEND_WEBHOOK_SECRET

function armar() {
  const payload = JSON.stringify({ type: 'email.bounced', data: { email_id: 'r1', to: ['a@b.mx'] } })
  const req: any = { body: Buffer.from(payload), headers: {} }
  const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() }
  return { req, res, next: jest.fn(), payload }
}

/** Cabeceras firmadas como las mandaría Svix: mismo cuerpo, mismo instante, el secreto que se indique. */
function signedHeaders(payload: string, secret = TEST_SECRET) {
  const msgId = 'msg_test_1'
  const timestamp = new Date()
  const signature = new Webhook(secret).sign(msgId, timestamp, payload)
  return {
    'svix-id': msgId,
    'svix-timestamp': String(Math.floor(timestamp.getTime() / 1000)),
    'svix-signature': signature,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  // Por default NO hay secreto: es el estado que asumen las pruebas de los dos carriles.
  // Cada prueba que necesite verificación de firma lo pone explícitamente.
  delete process.env.RESEND_WEBHOOK_SECRET
})

afterAll(() => {
  // Devolver el process.env del worker como estaba: otras suites del mismo worker lo comparten.
  if (originalSecret === undefined) delete process.env.RESEND_WEBHOOK_SECRET
  else process.env.RESEND_WEBHOOK_SECRET = originalSecret
})

describe('webhook de Resend — los dos carriles', () => {
  it('si superadmin lo maneja, el nuestro NI SE LLAMA', async () => {
    superadminHandler.mockResolvedValue({ handled: true, reason: 'suyo' })
    const { req, res, next } = armar()

    await handler(req, res, next)

    expect(propio).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(200)
  })

  it('si superadmin NO lo reconoce, se intenta el de campañas a clientes', async () => {
    superadminHandler.mockResolvedValue({ handled: false, reason: 'Not a marketing campaign delivery' })
    propio.mockResolvedValue({ manejado: true, motivo: 'Rebote permanente: suprimido.' })
    const { req, res, next } = armar()

    await handler(req, res, next)

    expect(propio).toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ handled: true }))
  })

  it('si no es de nadie, contesta 200 como siempre (Resend no debe reintentar)', async () => {
    superadminHandler.mockResolvedValue({ handled: false, reason: 'no es suyo' })
    propio.mockResolvedValue({ manejado: false, motivo: 'tampoco es nuestro' })
    const { req, res, next } = armar()

    await handler(req, res, next)

    expect(res.status).toHaveBeenCalledWith(200)
  })

  it('🔴 si FALLA procesando un rebote nuestro, contesta 500 para que Resend reintente', async () => {
    superadminHandler.mockResolvedValue({ handled: false, reason: 'no es suyo' })
    propio.mockRejectedValue(new Error('se cayó la base'))
    const { req, res, next } = armar()

    await handler(req, res, next)

    // Con 200 el rebote se perdería para siempre y ese correo muerto se seguiría intentando.
    expect(res.status).toHaveBeenCalledWith(500)
  })
})

describe('webhook de Resend — verificación de firma (svix)', () => {
  it('con secreto configurado y sin cabeceras svix contesta 400 y no llega a ningún carril', async () => {
    // El secreto aparece DESPUÉS de importar el controlador. Si éste lo capturara en una
    // constante de módulo (como hacía), aquí lo vería vacío, se saltaría la verificación y
    // contestaría 200: es exactamente el defecto que hacía depender el resultado del orden
    // en que corren las suites.
    process.env.RESEND_WEBHOOK_SECRET = TEST_SECRET
    const { req, res, next } = armar()

    await handler(req, res, next)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(superadminHandler).not.toHaveBeenCalled()
    expect(propio).not.toHaveBeenCalled()
  })

  it('con secreto configurado y firma inválida contesta 400 y no llega a ningún carril', async () => {
    process.env.RESEND_WEBHOOK_SECRET = TEST_SECRET
    const { req, res, next, payload } = armar()
    // Cabeceras bien formadas, pero firmadas con OTRO secreto.
    req.headers = signedHeaders(payload, OTHER_SECRET)

    await handler(req, res, next)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Invalid webhook signature' }))
    expect(superadminHandler).not.toHaveBeenCalled()
    expect(propio).not.toHaveBeenCalled()
  })

  it('con secreto configurado y firma válida pasa a los carriles como siempre', async () => {
    // La contraparte de las dos anteriores: sin ésta, una verificación que rechazara TODO
    // también las pasaría.
    process.env.RESEND_WEBHOOK_SECRET = TEST_SECRET
    superadminHandler.mockResolvedValue({ handled: true, reason: 'suyo' })
    const { req, res, next, payload } = armar()
    req.headers = signedHeaders(payload)

    await handler(req, res, next)

    expect(superadminHandler).toHaveBeenCalledWith(expect.objectContaining({ type: 'email.bounced' }))
    expect(res.status).toHaveBeenCalledWith(200)
  })

  it('el health check reporta configured según el entorno ACTUAL, no el del momento de importar', () => {
    const { req, res } = armar()

    resendWebhookHealthCheck(req, res)
    expect(res.json).toHaveBeenLastCalledWith(expect.objectContaining({ configured: false }))

    process.env.RESEND_WEBHOOK_SECRET = TEST_SECRET
    resendWebhookHealthCheck(req, res)
    expect(res.json).toHaveBeenLastCalledWith(expect.objectContaining({ configured: true }))
  })
})
