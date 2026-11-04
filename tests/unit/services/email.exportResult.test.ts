// tests/unit/services/email.exportResult.test.ts
import emailService from '../../../src/services/email.service'

const envio = jest.spyOn(emailService as unknown as { sendEmail: (o: unknown) => Promise<boolean> }, 'sendEmail').mockResolvedValue(true)
beforeEach(() => envio.mockClear())

const base = {
  venueName: 'Café <Centro>',
  titulo: 'Pagos',
  filas: 4224,
  formato: 'xlsx' as const,
  expiresAt: new Date('2026-11-10T18:00:00Z'),
  url: 'https://dash.test/venues/cafe-centro/exports/crun1',
}
const enviado = () =>
  envio.mock.calls[0][0] as {
    to: string
    subject: string
    html: string
    text: string
    headers?: Record<string, string>
    idempotencyKey?: string
  }

describe('sendExportResultEmail — plantilla canónica (email-templates.md)', () => {
  it('READY: isotipo arriba y abajo, botón negro al enlace del pedido, sin emoji, html y text, pie legal y llave', async () => {
    await emailService.sendExportResultEmail('duena@example.com', { ...base, estado: 'READY', idempotencyKey: 'export-crun1-READY' })
    const o = enviado()
    expect(o.to).toBe('duena@example.com')
    expect(o.subject).toBe('Café <Centro>: tu archivo de Pagos está listo')
    expect(o.subject).not.toMatch(/\p{Extended_Pictographic}/u)
    expect(o.html.split('https://avoqado.io/isotipo.svg').length - 1).toBeGreaterThanOrEqual(2)
    expect(o.html).toContain('background-color: #000000')
    expect(o.html).toContain(`href="${base.url}"`)
    expect(o.html).toContain('4,224')
    expect(o.html).toContain('Servicios Tecnologicos Avo S.A. de C.V.')
    expect(o.text).toContain(base.url)
    expect(o.idempotencyKey).toBe('export-crun1-READY')
  })
  it('🔴 recibo pedido: sin List-Unsubscribe ni preferencias, y el pie dice por qué le llega', async () => {
    await emailService.sendExportResultEmail('duena@example.com', { ...base, estado: 'READY', idempotencyKey: 'k' })
    const o = enviado()
    expect(o.headers?.['List-Unsubscribe']).toBeUndefined()
    for (const cuerpo of [o.html, o.text]) {
      expect(cuerpo).not.toContain('/notifications/preferences')
      expect(cuerpo).toMatch(/pediste este archivo/i)
    }
  })
  it('🔴 el enlace pide entrar a Avoqado (lo dice), no es una liga de descarga', async () => {
    await emailService.sendExportResultEmail('duena@example.com', { ...base, estado: 'READY', idempotencyKey: 'k' })
    expect(enviado().html).toMatch(/te pide entrar a Avoqado/)
    expect(enviado().html).not.toContain('storage.googleapis.com')
  })
  it('FAILED: «no pudimos», botón para intentar otra vez al MISMO enlace', async () => {
    await emailService.sendExportResultEmail('duena@example.com', { ...base, estado: 'FAILED', idempotencyKey: 'export-crun1-FAILED' })
    const o = enviado()
    expect(o.subject).toBe('Café <Centro>: no pudimos armar tu archivo de Pagos')
    expect(o.html).toContain('Intentar otra vez')
    expect(o.html).toContain(`href="${base.url}"`)
    expect(o.html).toContain('background-color: #000000')
  })
  it('escapa el nombre del negocio en el HTML y el texto plano va sin acentos', async () => {
    await emailService.sendExportResultEmail('duena@example.com', { ...base, estado: 'READY', idempotencyKey: 'k' })
    const o = enviado()
    expect(o.html).not.toContain('<Centro>')
    expect(o.html).toContain('Café &lt;Centro&gt;')
    expect(o.text).toMatch(/^[\t\n\r -~]*$/)
  })
})
