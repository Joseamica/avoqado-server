// tests/unit/services/email.shopifyPorRevisar.test.ts
import emailService from '../../../src/services/email.service'

const envio = jest.spyOn(emailService as unknown as { sendEmail: (o: unknown) => Promise<boolean> }, 'sendEmail').mockResolvedValue(true)
beforeEach(() => envio.mockClear())

const datos = {
  venueName: 'Tienda <Centro>',
  total: 3,
  items: [
    { name: 'Camisa <b>lino</b>', avoqado: '9', shopify: 10, motivo: 'No cuadra' },
    { name: 'Pantalón', avoqado: '2', shopify: 4, motivo: 'Cambios sin enviar' },
  ],
  dashboardUrl: 'https://dash.test/venues/x/settings/integrations/shopify#por-revisar',
  preferencesUrl: 'https://dash.test/venues/x/notifications/preferences',
  idempotencyKey: 'shopify-por-revisar:v:2026-10-08:a@b.test',
}
const enviado = () => envio.mock.calls[0][0] as { subject: string; html: string; text: string; idempotencyKey?: string }

describe('sendShopifyPorRevisarEmail — plantilla canónica (email-templates.md)', () => {
  it('isotipo arriba y abajo, botón negro, sin emoji, html y text, pie legal y llave de idempotencia', async () => {
    await emailService.sendShopifyPorRevisarEmail('dueno@example.com', datos)
    const o = enviado()
    expect(o.subject).toBe('Stock por revisar entre Avoqado y Shopify en Tienda <Centro>')
    expect(o.subject).not.toMatch(/\p{Extended_Pictographic}/u)
    expect(o.html.split('https://avoqado.io/isotipo.svg').length - 1).toBeGreaterThanOrEqual(2)
    expect(o.html).toContain('background-color: #000000')
    expect(o.html).toContain(datos.dashboardUrl)
    expect(o.html).toContain('Servicios Tecnologicos Avo S.A. de C.V.')
    expect(o.text.length).toBeGreaterThan(0)
    expect(o.text).toContain(datos.dashboardUrl)
    expect(o.idempotencyKey).toBe(datos.idempotencyKey)
  })

  // Ruling I1/L19: las preferencias NO gobiernan este correo, así que el pie no puede ofrecer apagarlo ahí.
  it('🔴 el pie dice que sale una vez al día y NO liga a las preferencias de notificaciones (html y text)', async () => {
    await emailService.sendShopifyPorRevisarEmail('dueno@example.com', datos)
    const o = enviado()
    const frase = 'Este correo sale una vez al día mientras haya algo por revisar.'
    expect(o.html).toContain(frase)
    expect(o.text).toContain(frase)
    for (const cuerpo of [o.html, o.text]) {
      expect(cuerpo).not.toContain(datos.preferencesUrl)
      expect(cuerpo).not.toMatch(/preferencias/i)
    }
  })

  it('escapa los nombres de producto y de negocio en el HTML', async () => {
    await emailService.sendShopifyPorRevisarEmail('dueno@example.com', datos)
    const o = enviado()
    expect(o.html).not.toContain('<b>lino</b>')
    expect(o.html).toContain('Camisa &lt;b&gt;lino&lt;/b&gt;')
    expect(o.html).toContain('Tienda &lt;Centro&gt;')
  })

  it('dice cuántos más hay cuando la tabla se corta', async () => {
    await emailService.sendShopifyPorRevisarEmail('dueno@example.com', datos)
    expect(enviado().html).toContain('y 1 más')
    expect(enviado().text).toContain('y 1 más')
  })
})
