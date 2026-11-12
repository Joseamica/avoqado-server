/**
 * D17 (codex-r1 #1): `sendOtpWhatsApp` dice si el código de verdad salió. En un negocio demo el candado no llama a Meta y contesta
 * «enviado» (`negocio-demo`); para el código eso es «no salió», y la página no debe decir «te lo enviamos».
 */
const mockOmitir = jest.fn()
jest.mock('@/services/demo/candadoDemo', () => ({ omitirPorDemo: (...a: unknown[]) => mockOmitir(...a) }))

import { sendOtpWhatsApp } from '@/services/whatsapp.service'

describe('D17: sendOtpWhatsApp', () => {
  const env = { id: process.env.WHATSAPP_PHONE_NUMBER_ID, token: process.env.WHATSAPP_ACCESS_TOKEN }
  const fetchReal = global.fetch
  beforeEach(() => {
    process.env.WHATSAPP_PHONE_NUMBER_ID = 'test-phone-id'
    process.env.WHATSAPP_ACCESS_TOKEN = 'test-token'
    mockOmitir.mockReset().mockResolvedValue(null)
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ messages: [{ id: 'wamid.OTP1' }] }) }) as any
  })
  afterAll(() => {
    process.env.WHATSAPP_PHONE_NUMBER_ID = env.id
    process.env.WHATSAPP_ACCESS_TOKEN = env.token
    global.fetch = fetchReal
  })

  it('negocio demo: no se llama a Meta y responde false (no salió)', async () => {
    mockOmitir.mockResolvedValue('negocio demo')
    await expect(sendOtpWhatsApp('+525512345678', '123456')).resolves.toBe(false)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('regresión: Meta lo aceptó ⇒ true', async () => {
    await expect(sendOtpWhatsApp('+525512345678', '123456')).resolves.toBe(true)
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  it('regresión: Meta lo rechazó ⇒ lanza (pedirCodigo lo cuenta como «no salió»)', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: { message: 'bad', code: 131000 } }) }) as any
    await expect(sendOtpWhatsApp('+525512345678', '123456')).rejects.toThrow(/Error al enviar WhatsApp/)
  })
})
