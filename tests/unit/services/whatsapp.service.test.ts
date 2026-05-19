import { sendReceiptWhatsApp } from '@/services/whatsapp.service'

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
