/**
 * T-F14 (ruling T-P1, 18-nov): el asistente de soporte tiene su PROPIO número (SUPPORT_WHATSAPP_PHONE_NUMBER_ID). El central
 * (WHATSAPP_PHONE_NUMBER_ID) manda reservaciones, recibos y códigos a clientes FINALES: lo que llega ahí nunca toca al soporte, y
 * lo que llega al número del soporte nunca va al relay viejo, cuyas respuestas saldrían del central.
 */
jest.mock('@/services/whatsapp.service', () => ({
  sendServiceMessage: jest.fn().mockResolvedValue({ messageId: 'wamid.RESPUESTA' }),
  WhatsappCloudApiError: class WhatsappCloudApiError extends Error {},
}))
jest.mock('@/services/giftCards/giftCardDelivery.service', () => ({ marcarEntregaFallidaPorMensaje: jest.fn().mockResolvedValue(true) }))
jest.mock('@/services/venueChatActivation.service', () => ({ handleActivationCommand: jest.fn() }))
jest.mock('@/services/venueChatEmail.service', () => ({ maybeSendVenueReplyEmail: jest.fn().mockResolvedValue(undefined) }))
jest.mock('@/services/support/router.service', () => ({ tryRouteSupport: jest.fn().mockResolvedValue('QUEUED') }))
jest.mock('@/services/support/delivery.service', () => ({ recordSupportDeliveryFailure: jest.fn().mockResolvedValue(false) }))

import { sendServiceMessage } from '@/services/whatsapp.service'
import { handleActivationCommand } from '@/services/venueChatActivation.service'
import { tryRouteSupport } from '@/services/support/router.service'
import { recordSupportDeliveryFailure } from '@/services/support/delivery.service'
import { processWhatsappWebhook } from '@/services/whatsappWebhook.service'
import prisma from '@/utils/prismaClient'

const CENTRAL = '111000111'
const VENTAS = '172120185993202'
const SOPORTE = '1150848214780108'
const db = prisma as any
const router = tryRouteSupport as jest.Mock
const enviar = sendServiceMessage as jest.Mock

// The value as Meta sends it; Record keeps the fixtures free of the service's private payload types.
const aviso = (phoneNumberId: string, messages: unknown[], extra: Record<string, unknown> = {}) => {
  const value: Record<string, unknown> = { metadata: { phone_number_id: phoneNumberId }, messages, ...extra }
  return { entry: [{ changes: [{ field: 'messages', value }] }] }
}
const texto = (id: string, body: string, extra: Record<string, unknown> = {}) => ({
  id,
  from: '5215511112222',
  timestamp: String(Math.floor(Date.now() / 1000)),
  type: 'text',
  text: { body },
  ...extra,
})

beforeEach(() => {
  process.env.WHATSAPP_PHONE_NUMBER_ID = CENTRAL
  process.env.WHATSAPP_SALES_PHONE_NUMBER_ID = VENTAS
  process.env.SUPPORT_WHATSAPP_PHONE_NUMBER_ID = SOPORTE
  process.env.SUPPORT_WHATSAPP_ENABLED = 'true'
  process.env.SUPPORT_WHATSAPP_ENC_KEY = 'e'.repeat(64)
  db.whatsappInboundEvent.upsert.mockResolvedValue({ id: 'ev1', processedAt: null })
  db.whatsappInboundEvent.update.mockResolvedValue({})
  db.whatsappInboundEvent.findUnique.mockResolvedValue({ id: 'ev1', replySentAt: null })
  db.whatsappContactWindow.upsert.mockResolvedValue({})
  db.venueChatMessage.findUnique.mockResolvedValue(null)
})
afterAll(() => {
  for (const key of [
    'WHATSAPP_SALES_PHONE_NUMBER_ID',
    'SUPPORT_WHATSAPP_PHONE_NUMBER_ID',
    'SUPPORT_WHATSAPP_ENABLED',
    'SUPPORT_WHATSAPP_ENC_KEY',
  ])
    delete process.env[key]
})

describe('T-F14: the support number', () => {
  it('a message to the support number goes only to the support router, without its raw text, and never to the relay', async () => {
    await processWhatsappWebhook(aviso(SOPORTE, [texto('wamid.S1', '¿cómo agrego un producto?')]))
    expect(router).toHaveBeenCalledTimes(1)
    const input = router.mock.calls[0][0]
    expect(input).toMatchObject({ receiverId: SOPORTE, wamid: 'wamid.S1', phone: '+525511112222', body: '¿cómo agrego un producto?' })
    expect(input).not.toHaveProperty('legacyRaw')
    expect(enviar).not.toHaveBeenCalled()
    expect(db.whatsappContactWindow.upsert).not.toHaveBeenCalled()
    expect(db.whatsappInboundEvent.upsert).not.toHaveBeenCalled()
  })

  it('a LEGACY from the router (since T-F15 only an event stored under another route) is never handed to the relay: recorded as ignored', async () => {
    router.mockResolvedValueOnce('LEGACY').mockResolvedValueOnce('LEGACY')
    await processWhatsappWebhook(
      aviso(SOPORTE, [texto('wamid.S2', 'ACTIVAR ABCDEF123456'), texto('wamid.S3', 'sí', { context: { id: 'wamid.RELAY' } })]),
    )
    expect(router).toHaveBeenCalledTimes(2)
    expect(handleActivationCommand).not.toHaveBeenCalled()
    expect(enviar).not.toHaveBeenCalled()
    expect(db.whatsappContactWindow.upsert).not.toHaveBeenCalled()
    expect(db.venueChatMessage.findUnique).not.toHaveBeenCalled()
    for (const [i, wamid] of ['wamid.S2', 'wamid.S3'].entries()) {
      const call = db.whatsappInboundEvent.upsert.mock.calls[i][0]
      expect(call.where).toEqual({ wamid })
      expect(call.create).toMatchObject({ wamid, receiverId: SOPORTE, routedAs: 'SUPPORT_IGNORED' })
      expect(call.update).toEqual({}) // T-F15: an event already stored keeps its route
      expect(call.create.processedAt).toBeInstanceOf(Date)
      expect(call.create.supportTombstoneUntil).toBeInstanceOf(Date)
      expect(JSON.stringify(call)).not.toContain('ACTIVAR')
    }
  })

  it('a sender that is not a phone is recorded as ignored, without the router or the relay', async () => {
    await processWhatsappWebhook(aviso(SOPORTE, [{ ...texto('wamid.S4', 'hola'), from: '12' }]))
    expect(router).not.toHaveBeenCalled()
    expect(enviar).not.toHaveBeenCalled()
    expect(db.whatsappInboundEvent.upsert.mock.calls[0][0].create).toMatchObject({ wamid: 'wamid.S4', routedAs: 'SUPPORT_IGNORED' })
  })

  it('a failed status of the support number reaches the support with that number', async () => {
    await processWhatsappWebhook(aviso(SOPORTE, [], { statuses: [{ id: 'wamid.OUT', status: 'failed' }] }))
    expect(recordSupportDeliveryFailure).toHaveBeenCalledWith('wamid.OUT', SOPORTE)
  })
})

describe('T-F14: the central number never reaches the support', () => {
  it('a reply to a reservation message on the central number stays with the relay: no support router, no notice', async () => {
    await processWhatsappWebhook(aviso(CENTRAL, [texto('wamid.C1', 'Sí, confirmo', { context: { id: 'wamid.RESERVACION' } })]))
    expect(router).not.toHaveBeenCalled()
    expect(db.venueChatMessage.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { whatsappMessageId: 'wamid.RESERVACION' } }),
    )
    expect(db.whatsappInboundEvent.update).toHaveBeenCalledWith({ where: { id: 'ev1' }, data: { routedAs: 'VENUE_REPLY_ORPHAN' } })
    expect(enviar).not.toHaveBeenCalled()
  })

  it.each(['AYUDA', 'PERSONA', '¿cómo agrego un producto?'])(
    '«%s» on the central number gets the relay nudge, never support',
    async body => {
      await processWhatsappWebhook(aviso(CENTRAL, [texto('wamid.C2', body)]))
      expect(router).not.toHaveBeenCalled()
      expect(enviar).toHaveBeenCalledTimes(1)
      expect(enviar.mock.calls[0]).toHaveLength(2) // central send: no support options
      expect(enviar.mock.calls[0][1]).toContain('¿A qué cliente le contestas?')
    },
  )

  it.each([
    ['unset', undefined],
    ['equal to the central', CENTRAL],
  ])('with the support number %s the support is off: the central works as before', async (_case, value) => {
    if (value === undefined) delete process.env.SUPPORT_WHATSAPP_PHONE_NUMBER_ID
    else process.env.SUPPORT_WHATSAPP_PHONE_NUMBER_ID = value
    await processWhatsappWebhook(aviso(CENTRAL, [texto('wamid.C3', 'AYUDA')]))
    expect(router).not.toHaveBeenCalled()
    expect(enviar).toHaveBeenCalledTimes(1)
    expect(enviar.mock.calls[0][1]).toContain('¿A qué cliente le contestas?')
  })

  it('with the support number unset, a message to it is a number we do not know: neither answered nor stored', async () => {
    delete process.env.SUPPORT_WHATSAPP_PHONE_NUMBER_ID
    await processWhatsappWebhook(aviso(SOPORTE, [texto('wamid.S5', 'AYUDA')]))
    expect(router).not.toHaveBeenCalled()
    expect(enviar).not.toHaveBeenCalled()
    expect(db.whatsappInboundEvent.upsert).not.toHaveBeenCalled()
  })

  it('a support number equal to sales leaves sales first: archived, never answered nor routed', async () => {
    process.env.SUPPORT_WHATSAPP_PHONE_NUMBER_ID = VENTAS
    db.crmWhatsappMessage.createMany.mockResolvedValue({ count: 1 })
    await processWhatsappWebhook(aviso(VENTAS, [texto('wamid.V1', 'AYUDA')]))
    expect(router).not.toHaveBeenCalled()
    expect(enviar).not.toHaveBeenCalled()
    expect(db.crmWhatsappMessage.createMany).toHaveBeenCalledTimes(1)
  })
})
