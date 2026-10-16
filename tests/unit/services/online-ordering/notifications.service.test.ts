import { prismaMock } from '@tests/__helpers__/setup'
import logger from '@/config/logger'

jest.mock('@/services/email.service', () => ({ __esModule: true, default: { sendEmailWithResult: jest.fn() } }))
jest.mock('@/services/whatsapp.service', () => ({ __esModule: true, sendOrderStatusUpdateWhatsApp: jest.fn() }))

import emailService from '@/services/email.service'
import { sendOrderStatusUpdateWhatsApp } from '@/services/whatsapp.service'
import { __resetStorefrontBaseWarningForTests, buildOrderMessage, notifyOrderEvent } from '@/services/online-ordering/notifications.service'

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
  delete process.env.ORDERING_STOREFRONT_BASE_URL
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

    prismaMock.order.findUnique.mockResolvedValue({ ...ORDER, customerName: '   ' } as any)
    await notifyOrderEvent('ord1', 'READY')
    expect((emailService.sendEmailWithResult as jest.Mock).mock.calls[1][0].html).toContain('<p>Hola,</p>')
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

describe('notifyOrderEvent: URL base de la tienda', () => {
  beforeEach(() => {
    __resetStorefrontBaseWarningForTests()
  })

  const sentMail = () => (emailService.sendEmailWithResult as jest.Mock).mock.calls[0][0]

  it('usa ORDERING_STOREFRONT_BASE_URL cuando está configurada, sin avisar', async () => {
    process.env.ORDERING_STOREFRONT_BASE_URL = 'https://tienda.example.com'
    await notifyOrderEvent('ord1', 'READY')
    expect(sentMail().html).toContain(`href="https://tienda.example.com/flautas-coyoacan/pedido/${'T'.repeat(32)}"`)
    expect(sentMail().text).toContain(`https://tienda.example.com/flautas-coyoacan/pedido/${'T'.repeat(32)}`)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('le quita las diagonales finales a la URL base', async () => {
    process.env.ORDERING_STOREFRONT_BASE_URL = 'https://tienda.example.com//'
    await notifyOrderEvent('ord1', 'READY')
    expect(sentMail().html).toContain(`href="https://tienda.example.com/flautas-coyoacan/pedido/`)
    expect(sentMail().html).not.toContain('.com//')
  })

  it('sin configurar usa el dominio por omisión y avisa UNA sola vez por proceso', async () => {
    await notifyOrderEvent('ord1', 'ACCEPTED')
    await notifyOrderEvent('ord1', 'READY')
    expect(sentMail().html).toContain(`href="https://pedidos.avoqado.io/flautas-coyoacan/pedido/${'T'.repeat(32)}"`)
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect((logger.warn as jest.Mock).mock.calls[0][0]).toContain('ORDERING_STOREFRONT_BASE_URL')
  })

  it.each(['', '   '])('una URL base vacía (%j) cuenta como sin configurar', async value => {
    process.env.ORDERING_STOREFRONT_BASE_URL = value
    await notifyOrderEvent('ord1', 'READY')
    expect(sentMail().html).toContain('href="https://pedidos.avoqado.io/')
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })
})

describe('notifyOrderEvent: escapado y liga codificada', () => {
  const sentMail = () => (emailService.sendEmailWithResult as jest.Mock).mock.calls[0][0]

  it('el nombre del cliente con <script> y comillas sale escapado en el HTML', async () => {
    prismaMock.order.findUnique.mockResolvedValue({ ...ORDER, customerName: '<script>alert("x")</script>' } as any)
    await notifyOrderEvent('ord1', 'READY')
    expect(sentMail().html).toContain('Hola &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;,')
    expect(sentMail().html).not.toContain('<script>')
  })

  it('el nombre del negocio con <b> y & sale escapado en el HTML', async () => {
    prismaMock.order.findUnique.mockResolvedValue({ ...ORDER, venue: { name: 'Tacos <b>&', slug: 'tacos' } } as any)
    await notifyOrderEvent('ord1', 'READY')
    expect(sentMail().html).toContain('Tacos &lt;b&gt;&amp;')
    expect(sentMail().html).not.toContain('<b>')
  })

  it('un slug o token con comillas no puede salirse del atributo href', async () => {
    prismaMock.order.findUnique.mockResolvedValue({
      ...ORDER,
      venue: { name: 'Flautas', slug: 'a"b' },
      onlineOrder: { ...ORDER.onlineOrder, trackingToken: 'T"x y' },
    } as any)
    await notifyOrderEvent('ord1', 'READY')
    const { html, text } = sentMail()
    expect(html).toContain('href="https://pedidos.avoqado.io/a%22b/pedido/T%22x%20y"')
    expect(html).toMatch(/<a href="[^"]*">Ver mi pedido<\/a>/)
    expect(text).toContain('/a%22b/pedido/T%22x%20y')
  })
})

describe('notifyOrderEvent: variables de WhatsApp', () => {
  beforeEach(() => {
    process.env.ONLINE_ORDERING_WHATSAPP_ENABLED = 'true'
  })

  const sentData = () => (sendOrderStatusUpdateWhatsApp as jest.Mock).mock.calls[0][1]

  it('venueName y status pasan por sanitizeTemplateVar (sin saltos ni ligas)', async () => {
    prismaMock.order.findUnique.mockResolvedValue({ ...ORDER, venue: { name: 'Flautas\nhttps://malo.example', slug: 'f' } } as any)
    await notifyOrderEvent('ord1', 'READY')
    expect(sentData().venueName).toBe('Flautas [enlace]')
    expect(sentData().status).toBe('Tu pedido WABCD en Flautas [enlace] ya está listo para recoger.')
  })

  it('respetan los topes de la plantilla: venueName 60 y status 200', async () => {
    prismaMock.order.findUnique.mockResolvedValue({ ...ORDER, venue: { name: 'V'.repeat(300), slug: 'f' } } as any)
    await notifyOrderEvent('ord1', 'READY')
    expect(sentData().venueName).toHaveLength(60)
    expect(sentData().status).toHaveLength(200)
  })

  it.each([[null], [''], ['   '], ['\u0001']])('un nombre vacío (%j) se manda como "cliente", nunca como parámetro vacío', async name => {
    prismaMock.order.findUnique.mockResolvedValue({ ...ORDER, customerName: name } as any)
    await notifyOrderEvent('ord1', 'READY')
    expect(sentData().customerName).toBe('cliente')
  })
})
