/**
 * El webhook de Resend lo comparten DOS carriles: el Marketing de superadmin (Avoqado → los
 * venues), que ya estaba, y las campañas de un negocio a SUS clientes.
 *
 * Estas pruebas fijan las dos cosas que no pueden romperse al haberlos juntado:
 *
 *  1. El carril de superadmin se comporta EXACTAMENTE igual que antes.
 *  2. 🔴 Un fallo procesando un rebote nuestro devuelve **500**, no 200. El 200-siempre del
 *     resto de la función existe para que Resend no reintente eventos que no nos interesan;
 *     pero tragarse un rebote deja ese correo muerto sin suprimir y lo seguimos intentando,
 *     quemando la reputación del subdominio que comparten todos los negocios.
 */
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))
jest.mock('@/services/superadmin/marketing.superadmin.service', () => ({ handleResendWebhook: jest.fn() }))
jest.mock('@/services/marketing/campaignWebhook.service', () => ({ procesarAvisoDeResend: jest.fn() }))

import { handleResendWebhook as handler } from '@/controllers/webhooks/resend.webhook.controller'
import * as superadmin from '@/services/superadmin/marketing.superadmin.service'
import { procesarAvisoDeResend } from '@/services/marketing/campaignWebhook.service'

const superadminHandler = superadmin.handleResendWebhook as unknown as jest.Mock
const propio = procesarAvisoDeResend as unknown as jest.Mock

function armar() {
  const req: any = {
    body: Buffer.from(JSON.stringify({ type: 'email.bounced', data: { email_id: 'r1', to: ['a@b.mx'] } })),
    headers: {},
  }
  const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() }
  return { req, res, next: jest.fn() }
}

beforeEach(() => jest.clearAllMocks())

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
