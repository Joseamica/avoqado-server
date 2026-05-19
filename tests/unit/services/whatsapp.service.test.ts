import { sendReceiptWhatsApp, sendServiceMessage, sendVenueChatTemplate, WhatsappCloudApiError } from '@/services/whatsapp.service'

describe('sendReceiptWhatsApp (backward-compat after refactor)', () => {
  beforeEach(() => {
    process.env.WHATSAPP_PHONE_NUMBER_ID = 'test-phone-id'
    process.env.WHATSAPP_ACCESS_TOKEN = 'test-token'
  })

  it('still returns boolean true on success', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [{ id: 'wamid.TEST123' }] }),
    }) as unknown as typeof global.fetch
    const result = await sendReceiptWhatsApp('+525512345678', {
      venueName: 'Test',
      totalAmount: '100',
      receiptUrl: 'https://x.io/r',
    })
    expect(result).toBe(true)
  })

  it('still throws on Cloud API failure', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: 'bad number' } }),
    }) as unknown as typeof global.fetch
    await expect(
      sendReceiptWhatsApp('+525512345678', { venueName: 'T', totalAmount: '100', receiptUrl: 'https://x.io/r' }),
    ).rejects.toThrow(/Error al enviar WhatsApp/)
  })
})

describe('sendVenueChatTemplate', () => {
  beforeEach(() => {
    process.env.WHATSAPP_PHONE_NUMBER_ID = 'test-phone-id'
    process.env.WHATSAPP_ACCESS_TOKEN = 'test-token'
  })

  it('sends v2 template with all 5 variables and returns messageId', async () => {
    let capturedBody: any
    global.fetch = jest.fn().mockImplementation(async (_url, opts: any) => {
      capturedBody = JSON.parse(opts.body)
      return {
        ok: true,
        json: async () => ({ messages: [{ id: 'wamid.VENUE_CHAT_123' }] }),
      }
    }) as unknown as typeof global.fetch

    const result = await sendVenueChatTemplate('+525512345678', {
      venueName: 'Gym Pavón',
      customerName: 'Juan',
      shortCode: 'A3F2',
      flowLabel: 'Citas',
      messageBody: 'Hola',
    })

    expect(result.messageId).toBe('wamid.VENUE_CHAT_123')
    expect(capturedBody.template.name).toBe('venue_new_customer_message_v2')
    const params = capturedBody.template.components[0].parameters
    expect(params[0].text).toBe('Gym Pavón')
    expect(params[1].text).toBe('Juan')
    expect(params[2].text).toBe('A3F2')
    expect(params[3].text).toBe('Citas')
    expect(params[4].text).toBe('Hola')
  })

  it('sanitizes user-provided text (strips URLs, control chars, caps length)', async () => {
    let capturedBody: any
    global.fetch = jest.fn().mockImplementation(async (_url, opts: any) => {
      capturedBody = JSON.parse(opts.body)
      return { ok: true, json: async () => ({ messages: [{ id: 'wamid.X' }] }) }
    }) as unknown as typeof global.fetch

    await sendVenueChatTemplate('+525512345678', {
      venueName: 'Venue',
      customerName: 'Juan\nMalicioso',
      shortCode: 'ABCD',
      flowLabel: 'Citas',
      messageBody: 'visita https://evil.com hoy',
    })

    const params = capturedBody.template.components[0].parameters
    expect(params[1].text).toBe('Juan Malicioso')
    expect(params[4].text).toBe('visita [enlace] hoy')
  })
})

describe('sendServiceMessage', () => {
  beforeEach(() => {
    process.env.WHATSAPP_PHONE_NUMBER_ID = 'test-phone-id'
    process.env.WHATSAPP_ACCESS_TOKEN = 'test-token'
  })

  it('sends a non-template text message and returns messageId', async () => {
    let capturedBody: any
    global.fetch = jest.fn().mockImplementation(async (_url, opts: any) => {
      capturedBody = JSON.parse(opts.body)
      return { ok: true, json: async () => ({ messages: [{ id: 'wamid.SVC_1' }] }) }
    }) as unknown as typeof global.fetch

    const result = await sendServiceMessage('+525512345678', 'hola')
    expect(result.messageId).toBe('wamid.SVC_1')
    expect(capturedBody.type).toBe('text')
    expect(capturedBody.text.body).toBe('hola')
  })

  it('truncates messages over 1500 chars', async () => {
    let capturedBody: any
    global.fetch = jest.fn().mockImplementation(async (_url, opts: any) => {
      capturedBody = JSON.parse(opts.body)
      return { ok: true, json: async () => ({ messages: [{ id: 'wamid.X' }] }) }
    }) as unknown as typeof global.fetch

    await sendServiceMessage('+525512345678', 'a'.repeat(2000))
    expect(capturedBody.text.body.endsWith('… [mensaje truncado]')).toBe(true)
    expect(capturedBody.text.body.length).toBeLessThanOrEqual(1500 + ' … [mensaje truncado]'.length)
  })

  it('surfaces Cloud API window-closed errors as WhatsappCloudApiError with code', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: { code: 131047, message: 'Re-engagement message' } }),
    }) as unknown as typeof global.fetch

    let caught: unknown
    try {
      await sendServiceMessage('+525512345678', 'hi')
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(WhatsappCloudApiError)
    expect((caught as WhatsappCloudApiError).message).toContain('Re-engagement')
    expect((caught as WhatsappCloudApiError).cloudApiErrorCode).toBe(131047)
  })
})
