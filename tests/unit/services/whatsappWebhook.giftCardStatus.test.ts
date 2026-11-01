/** El webhook de Meta (1b S3, Q2): sólo el `failed` de un mensaje toca la entrega de una tarjeta. */
jest.mock('@/services/giftCards/giftCardDelivery.service', () => ({ marcarEntregaFallidaPorMensaje: jest.fn().mockResolvedValue(true) }))

import { marcarEntregaFallidaPorMensaje } from '@/services/giftCards/giftCardDelivery.service'
import { processWhatsappWebhook } from '@/services/whatsappWebhook.service'

const marcar = marcarEntregaFallidaPorMensaje as jest.Mock
const conEstados = (statuses: Array<{ id: string; status: string }>) => ({
  entry: [{ changes: [{ field: 'messages', value: { statuses } }] }],
})

describe('whatsappWebhook — estados de mensajes de tarjetas', () => {
  it("statuses failed ⇒ marcarEntregaFallidaPorMensaje('wamid.X') una vez", async () => {
    await processWhatsappWebhook(conEstados([{ id: 'wamid.X', status: 'failed' }]))

    expect(marcar).toHaveBeenCalledTimes(1)
    expect(marcar).toHaveBeenCalledWith('wamid.X')
  })

  it.each(['sent', 'delivered', 'read'])('statuses %s ⇒ nunca', async status => {
    await processWhatsappWebhook(conEstados([{ id: 'wamid.X', status }]))

    expect(marcar).not.toHaveBeenCalled()
  })

  it('si marcar la tarjeta falla, el error sube (el controlador responde 500 y Meta reintenta)', async () => {
    marcar.mockRejectedValueOnce(new Error('se cayó la base'))

    await expect(processWhatsappWebhook(conEstados([{ id: 'wamid.X', status: 'failed' }]))).rejects.toThrow('se cayó la base')
  })
})
