/** El webhook de Meta (1b S3, Q2): sólo el `failed` de un mensaje toca la entrega de una tarjeta. */
jest.mock('@/services/giftCards/giftCardDelivery.service', () => ({ marcarEntregaFallidaPorMensaje: jest.fn().mockResolvedValue(true) }))
jest.mock('@/services/support/delivery.service', () => ({ recordSupportDeliveryFailure: jest.fn().mockResolvedValue(true) }))

import { marcarEntregaFallidaPorMensaje } from '@/services/giftCards/giftCardDelivery.service'
import { processWhatsappWebhook } from '@/services/whatsappWebhook.service'
import { recordSupportDeliveryFailure } from '@/services/support/delivery.service'

const marcar = marcarEntregaFallidaPorMensaje as jest.Mock
const conEstados = (statuses: Array<{ id: string; status: string }>) => ({
  entry: [{ changes: [{ field: 'messages', value: { statuses } }] }],
})

describe('whatsappWebhook — estados de mensajes de tarjetas', () => {
  it.each(['gift', 'support'])('a failing %s handler cannot prevent the other from persisting its callback', async failing => {
    process.env.WHATSAPP_PHONE_NUMBER_ID = 'central-fixture'
    process.env.WHATSAPP_SALES_PHONE_NUMBER_ID = 'sales-fixture'
    const support = recordSupportDeliveryFailure as jest.Mock
    ;(failing === 'gift' ? marcar : support).mockRejectedValueOnce(new Error('fixture persistence failed'))
    await expect(
      processWhatsappWebhook({
        entry: [
          {
            changes: [
              {
                field: 'messages',
                value: {
                  metadata: { phone_number_id: 'central-fixture' },
                  statuses: [{ id: 'wamid.fixture-callback', status: 'failed' }],
                },
              },
            ],
          },
        ],
      }),
    ).rejects.toThrow('fixture persistence failed')
    expect(marcar).toHaveBeenCalledWith('wamid.fixture-callback')
    expect(support).toHaveBeenCalledWith('wamid.fixture-callback', 'central-fixture')
  })
  it.each(['support-status-sales', 'support-status-other'])(
    'status failure on %s is retried even if messages share the change',
    async receiver => {
      const previous = process.env.WHATSAPP_SALES_PHONE_NUMBER_ID
      process.env.WHATSAPP_SALES_PHONE_NUMBER_ID = 'support-status-sales'
      marcar.mockRejectedValueOnce(new Error('status persistence failed'))
      try {
        await expect(
          processWhatsappWebhook({
            entry: [
              {
                changes: [
                  {
                    field: 'messages',
                    value: {
                      metadata: { phone_number_id: receiver },
                      statuses: [{ id: 'wamid.failed', status: 'failed' }],
                      messages: [
                        { id: 'wamid.other', from: '525500004001', type: 'text', text: { body: 'hola' }, timestamp: '1794160000' },
                      ],
                    },
                  },
                ],
              },
            ],
          }),
        ).rejects.toThrow('status persistence failed')
      } finally {
        if (previous === undefined) delete process.env.WHATSAPP_SALES_PHONE_NUMBER_ID
        else process.env.WHATSAPP_SALES_PHONE_NUMBER_ID = previous
      }
    },
  )
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
