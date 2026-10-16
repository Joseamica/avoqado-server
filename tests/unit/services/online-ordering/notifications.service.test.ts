import { prismaMock } from '@tests/__helpers__/setup'
import logger from '@/config/logger'

jest.mock('@/services/email.service', () => ({ __esModule: true, default: { sendEmailWithResult: jest.fn() } }))
jest.mock('@/services/whatsapp.service', () => ({ __esModule: true, sendOrderStatusUpdateWhatsApp: jest.fn() }))

import emailService from '@/services/email.service'
import { sendOrderStatusUpdateWhatsApp } from '@/services/whatsapp.service'
import { buildOrderMessage, notifyOrderEvent } from '@/services/online-ordering/notifications.service'

const ORDER = {
  orderNumber: 'WABCD',
  customerName: 'María G.',
  customerPhone: '+525543453965',
  customerEmail: 'maria@example.com',
  venue: { name: 'Flautas Coyoacán', slug: 'flautas-coyoacan' },
  onlineOrder: {
    whatsappConsent: true,
    trackingToken: 'T'.repeat(32),
    acceptedAt: new Date('2026-10-14T18:30:00Z'),
    estimatedReadyAt: new Date('2026-10-14T18:45:00Z'),
  },
}

beforeEach(() => {
  delete process.env.ONLINE_ORDERING_WHATSAPP_ENABLED
  prismaMock.order.findUnique.mockResolvedValue(ORDER as any)
  ;(emailService.sendEmailWithResult as jest.Mock).mockResolvedValue({ ok: true, transient: false })
  ;(sendOrderStatusUpdateWhatsApp as jest.Mock).mockResolvedValue(true)
})

describe('buildOrderMessage', () => {
  it('ACCEPTED trae los minutos estimados; REJECTED y EXPIRED dicen que no se cobró nada', () => {
    expect(buildOrderMessage('ACCEPTED', { orderNumber: 'WABCD', venueName: 'Flautas', estimatedMinutes: 15 }).text).toContain(
      'aproximadamente 15 min',
    )
    expect(buildOrderMessage('REJECTED', { orderNumber: 'WABCD', venueName: 'Flautas', estimatedMinutes: null }).text).toContain(
      'No se te cobró nada',
    )
    expect(buildOrderMessage('EXPIRED', { orderNumber: 'WABCD', venueName: 'Flautas', estimatedMinutes: null }).text).toContain(
      'No se te cobró nada',
    )
    expect(buildOrderMessage('READY', { orderNumber: 'WABCD', venueName: 'Flautas', estimatedMinutes: null }).subject).toContain('listo')
  })

  it('ACCEPTED sin estimado no promete ninguna hora', () => {
    const { text } = buildOrderMessage('ACCEPTED', { orderNumber: 'WABCD', venueName: 'Flautas', estimatedMinutes: null })
    expect(text).toBe('Flautas aceptó tu pedido WABCD.')
  })
})

describe('notifyOrderEvent', () => {
  it('manda el correo con la liga de seguimiento y su llave idempotente', async () => {
    await notifyOrderEvent('ord1', 'ACCEPTED')

    expect(emailService.sendEmailWithResult).toHaveBeenCalledTimes(1)
    const mail = (emailService.sendEmailWithResult as jest.Mock).mock.calls[0][0]
    expect(mail.to).toBe('maria@example.com')
    expect(mail.html).toContain(`/flautas-coyoacan/pedido/${'T'.repeat(32)}`)
    expect(mail.idempotencyKey).toBe('online-order:ord1:ACCEPTED:EMAIL')
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('sin correo no manda correo, y sin nombre saluda sin coma suelta', async () => {
    prismaMock.order.findUnique.mockResolvedValue({ ...ORDER, customerEmail: null } as any)
    await notifyOrderEvent('ord1', 'READY')
    expect(emailService.sendEmailWithResult).not.toHaveBeenCalled()

    prismaMock.order.findUnique.mockResolvedValue({ ...ORDER, customerName: null } as any)
    await notifyOrderEvent('ord1', 'READY')
    expect((emailService.sendEmailWithResult as jest.Mock).mock.calls[0][0].html).toContain('<p>Hola,</p>')
  })

  it('WhatsApp sólo con la bandera encendida y con consentimiento', async () => {
    await notifyOrderEvent('ord1', 'READY')
    expect(sendOrderStatusUpdateWhatsApp).not.toHaveBeenCalled()

    process.env.ONLINE_ORDERING_WHATSAPP_ENABLED = 'true'
    await notifyOrderEvent('ord1', 'READY')
    expect(sendOrderStatusUpdateWhatsApp).toHaveBeenCalledWith('+525543453965', expect.objectContaining({ venueName: 'Flautas Coyoacán' }))

    prismaMock.order.findUnique.mockResolvedValue({ ...ORDER, onlineOrder: { ...ORDER.onlineOrder, whatsappConsent: false } } as any)
    ;(sendOrderStatusUpdateWhatsApp as jest.Mock).mockClear()
    await notifyOrderEvent('ord1', 'READY')
    expect(sendOrderStatusUpdateWhatsApp).not.toHaveBeenCalled()
  })

  it('NUNCA lanza: si el correo truena queda en logger.error con orderId, evento y código (R18)', async () => {
    ;(emailService.sendEmailWithResult as jest.Mock).mockRejectedValue(new Error('resend caído'))
    await expect(notifyOrderEvent('ord1', 'ACCEPTED')).resolves.toBeUndefined()
    expect(logger.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ orderId: 'ord1', event: 'ACCEPTED', channel: 'EMAIL', errorCode: 'EXCEPTION' }),
    )
  })

  it('un correo que el proveedor rechaza (ok:false) queda en logger.error con su código', async () => {
    ;(emailService.sendEmailWithResult as jest.Mock).mockResolvedValue({ ok: false, errorCode: 'validation_error', transient: false })
    await notifyOrderEvent('ord1', 'ACCEPTED')
    expect(logger.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ orderId: 'ord1', event: 'ACCEPTED', errorCode: 'validation_error' }),
    )
  })

  it('las variables de la plantilla de WhatsApp van saneadas (sin saltos de línea ni ligas)', async () => {
    process.env.ONLINE_ORDERING_WHATSAPP_ENABLED = 'true'
    prismaMock.order.findUnique.mockResolvedValue({ ...ORDER, customerName: 'Ana\nhttps://malo.example' } as any)
    await notifyOrderEvent('ord1', 'READY')
    const data = (sendOrderStatusUpdateWhatsApp as jest.Mock).mock.calls[0][1]
    expect(data.customerName).toBe('Ana [enlace]')
  })

  it('un pedido que no existe no hace nada', async () => {
    prismaMock.order.findUnique.mockResolvedValue(null)
    await expect(notifyOrderEvent('nope', 'READY')).resolves.toBeUndefined()
    expect(emailService.sendEmailWithResult).not.toHaveBeenCalled()
  })
})
