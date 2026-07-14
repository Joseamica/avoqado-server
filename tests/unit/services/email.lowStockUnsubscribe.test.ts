import emailService from '../../../src/services/email.service'
import { NotificationType } from '@prisma/client'

// We only care about what sendLowStockDigestEmail passes to the transport.
const sendSpy = jest.spyOn(emailService as any, 'sendEmail').mockResolvedValue(true)

const baseData = {
  venueName: 'Mindform',
  items: [{ name: 'Leche de Avena', category: 'DAIRY', currentStock: 1, reorderPoint: 4, unit: 'LITER', isOutOfStock: false }],
  dashboardUrl: 'https://dash/x',
  preferencesUrl: 'https://dash/x/notifications/preferences',
}
const UNSUB = 'https://api.avoqado.io/api/v1/public/unsubscribe?token=TOK123'

beforeEach(() => sendSpy.mockClear())

// Silence the unused import lint (kept to document the type this email covers).
void NotificationType

describe('sendLowStockDigestEmail — one-click unsubscribe wiring', () => {
  it('sets RFC 8058 List-Unsubscribe headers when an unsubscribeUrl is given', async () => {
    await emailService.sendLowStockDigestEmail('jose@example.com', { ...baseData, unsubscribeUrl: UNSUB })

    const opts = sendSpy.mock.calls[0][0] as any
    expect(opts.headers).toEqual({
      'List-Unsubscribe': `<${UNSUB}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    })
  })

  it('embeds the unsubscribe link in BOTH the html and the plain-text body', async () => {
    await emailService.sendLowStockDigestEmail('jose@example.com', { ...baseData, unsubscribeUrl: UNSUB })

    const opts = sendSpy.mock.calls[0][0] as any
    expect(opts.html).toContain(UNSUB)
    expect(opts.html).toContain('Dejar de recibir estas alertas por correo')
    expect(opts.text).toContain(UNSUB)
  })

  it('regression: no unsubscribe headers when no unsubscribeUrl (backwards compatible)', async () => {
    await emailService.sendLowStockDigestEmail('jose@example.com', baseData)

    const opts = sendSpy.mock.calls[0][0] as any
    expect(opts.headers).toBeUndefined()
    // Still renders the preferences link + a subject with no emoji.
    expect(opts.html).toContain(baseData.preferencesUrl)
    expect(opts.subject).toBe('Alertas de bajas existencias en Mindform')
    expect(opts.text.length).toBeGreaterThan(0)
  })
})
