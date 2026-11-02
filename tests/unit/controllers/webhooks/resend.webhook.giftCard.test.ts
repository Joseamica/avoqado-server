/**
 * Q105 (1b S3): el webhook de Resend pasa a «No se entregó» la tarjeta cuyo correo rebotó, se suprimió o falló, ANTES de que el
 * carril de marketing lo dé por manejado (para un correo sin `CampaignDelivery` responde `handled: true`). Lo demás no cambia.
 * Firma de svix como en `resendWebhook.campanas.test.ts`: secreto de prueba fijado en cada prueba y regresado al final.
 */
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))
jest.mock('@/services/superadmin/marketing.superadmin.service', () => ({ handleResendWebhook: jest.fn() }))
jest.mock('@/services/marketing/campaignWebhook.service', () => ({ procesarAvisoDeResend: jest.fn() }))
jest.mock('@/services/giftCards/giftCardDelivery.service', () => ({
  FALLO_FINAL_DE_CORREO: jest.requireActual('@/services/giftCards/giftCardDelivery.service').FALLO_FINAL_DE_CORREO,
  marcarEntregaFallidaPorMensaje: jest.fn(),
}))

import { Webhook } from 'svix'
import { handleResendWebhook as handler } from '@/controllers/webhooks/resend.webhook.controller'
import * as superadmin from '@/services/superadmin/marketing.superadmin.service'
import { FALLO_FINAL_DE_CORREO, marcarEntregaFallidaPorMensaje } from '@/services/giftCards/giftCardDelivery.service'

const marketing = superadmin.handleResendWebhook as unknown as jest.Mock
const marcar = marcarEntregaFallidaPorMensaje as jest.Mock
const SECRETO = 'whsec_' + Buffer.from('avoqado-test-secret-1234567890ab').toString('base64')
const secretoOriginal = process.env.RESEND_WEBHOOK_SECRET

function firmado(type: string, data: Record<string, unknown> = { email_id: 're_X', to: ['ana@correo.mx'] }) {
  const payload = JSON.stringify({ type, data })
  const instante = new Date()
  const req: any = {
    body: Buffer.from(payload),
    headers: {
      'svix-id': 'msg_test_1',
      'svix-timestamp': String(Math.floor(instante.getTime() / 1000)),
      'svix-signature': new Webhook(SECRETO).sign('msg_test_1', instante, payload),
    },
  }
  const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() }
  return { req, res, next: jest.fn() }
}

beforeEach(() => {
  process.env.RESEND_WEBHOOK_SECRET = SECRETO
  marketing.mockResolvedValue({ handled: true, reason: 'Transactional reputation event logged' })
  marcar.mockResolvedValue(true)
})
afterAll(() => {
  if (secretoOriginal === undefined) delete process.env.RESEND_WEBHOOK_SECRET
  else process.env.RESEND_WEBHOOK_SECRET = secretoOriginal
})

describe('webhook de Resend — la entrega de tarjetas (Q105)', () => {
  it.each(['email.bounced', 'email.suppressed', 'email.failed'])(
    '%s ⇒ marca la tarjeta UNA vez y ANTES de marketing, que se sigue llamando',
    async tipo => {
      const { req, res, next } = firmado(tipo)

      await handler(req, res, next)

      expect(marcar).toHaveBeenCalledTimes(1)
      expect(marcar).toHaveBeenCalledWith('re_X', FALLO_FINAL_DE_CORREO[tipo])
      expect(marketing).toHaveBeenCalledTimes(1)
      expect(marcar.mock.invocationCallOrder[0]).toBeLessThan(marketing.mock.invocationCallOrder[0])
      expect(res.status).toHaveBeenCalledWith(200)
    },
  )

  it('los códigos: rebotado y suprimido ⇒ EMAIL_INVALID_ADDRESS; fallido ⇒ EMAIL_SEND_FAILED; otro tipo ⇒ ausente', () => {
    expect(FALLO_FINAL_DE_CORREO['email.bounced']).toBe('EMAIL_INVALID_ADDRESS')
    expect(FALLO_FINAL_DE_CORREO['email.suppressed']).toBe('EMAIL_INVALID_ADDRESS')
    expect(FALLO_FINAL_DE_CORREO['email.failed']).toBe('EMAIL_SEND_FAILED')
    expect(FALLO_FINAL_DE_CORREO['email.complained']).toBeUndefined()
    expect(FALLO_FINAL_DE_CORREO['toString']).toBeUndefined()
  })

  it.each(['email.complained', 'email.delivery_delayed', 'email.sent', 'email.delivered', 'email.opened', 'email.clicked'])(
    '%s ⇒ nunca toca la tarjeta',
    async tipo => {
      const { req, res, next } = firmado(tipo)

      await handler(req, res, next)

      expect(marcar).not.toHaveBeenCalled()
      expect(marketing).toHaveBeenCalledTimes(1)
    },
  )

  it('sin email_id ⇒ nunca', async () => {
    const { req, res, next } = firmado('email.bounced', { to: ['ana@correo.mx'] })

    await handler(req, res, next)

    expect(marcar).not.toHaveBeenCalled()
  })

  it('si marcar la tarjeta lanza ⇒ 500 (Resend reintenta; el CAS lo hace idempotente)', async () => {
    marcar.mockRejectedValueOnce(new Error('se cayó la base'))
    const { req, res, next } = firmado('email.bounced')

    await handler(req, res, next)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(marketing).not.toHaveBeenCalled()
  })
})
