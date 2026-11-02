/**
 * CRM fase 3: el WhatsApp de ventas entra a la MISMA app de Meta que el número central. Lo del número de ventas sólo se
 * guarda en el CRM y NUNCA se contesta; un número que no conocemos ni se contesta ni se guarda; el central sigue igual.
 * Promesa: Avoqado/docs/audit/2026-11-02-crm-whatsapp-ventas/promesa.md
 */
jest.mock('@/services/whatsapp.service', () => ({
  sendServiceMessage: jest.fn().mockResolvedValue({ messageId: 'wamid.RESPUESTA' }),
  WhatsappCloudApiError: class WhatsappCloudApiError extends Error {},
}))
jest.mock('@/services/giftCards/giftCardDelivery.service', () => ({ marcarEntregaFallidaPorMensaje: jest.fn().mockResolvedValue(true) }))
jest.mock('@/services/venueChatActivation.service', () => ({ handleActivationCommand: jest.fn() }))
jest.mock('@/services/venueChatEmail.service', () => ({ maybeSendVenueReplyEmail: jest.fn().mockResolvedValue(undefined) }))

import { sendServiceMessage } from '@/services/whatsapp.service'
import { maybeSendVenueReplyEmail } from '@/services/venueChatEmail.service'
import { processWhatsappWebhook } from '@/services/whatsappWebhook.service'
import prisma from '@/utils/prismaClient'

const CENTRAL = '111000111'
const VENTAS = '172120185993202'
const enviar = sendServiceMessage as jest.Mock
const db = prisma as any

const aviso = (field: string, value: Record<string, unknown>) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'waba', changes: [{ field, value: { messaging_product: 'whatsapp', ...value } }] }],
})
const metadata = (phoneNumberId: string) => ({ display_phone_number: '525640070001', phone_number_id: phoneNumberId })
const texto = (id: string, from: string, body: string, timestamp = '1762100000') => ({ id, from, timestamp, type: 'text', text: { body } })

// Las filas que se mandaron a guardar, de todas las tandas.
const guardadas = () => db.crmWhatsappMessage.createMany.mock.calls.flatMap((c: any[]) => c[0].data)

function noContestoNiTocoElCentral() {
  expect(enviar).not.toHaveBeenCalled()
  expect(maybeSendVenueReplyEmail).not.toHaveBeenCalled()
  expect(db.whatsappInboundEvent.upsert).not.toHaveBeenCalled()
  expect(db.whatsappContactWindow.upsert).not.toHaveBeenCalled()
}

beforeEach(() => {
  process.env.WHATSAPP_PHONE_NUMBER_ID = CENTRAL
  process.env.WHATSAPP_SALES_PHONE_NUMBER_ID = VENTAS
  db.crmWhatsappMessage.createMany.mockResolvedValue({ count: 0 })
  db.whatsappInboundEvent.upsert.mockResolvedValue({ id: 'ev1', processedAt: null })
  db.whatsappInboundEvent.update.mockResolvedValue({})
  db.whatsappInboundEvent.findUnique.mockResolvedValue({ id: 'ev1', replySentAt: null })
  db.whatsappContactWindow.upsert.mockResolvedValue({})
})

afterAll(() => {
  delete process.env.WHATSAPP_SALES_PHONE_NUMBER_ID
})

describe('whatsappWebhook — número de ventas', () => {
  it('un texto suelto de un prospecto se guarda con su nombre de perfil y NO se contesta', async () => {
    await processWhatsappWebhook(
      aviso('messages', {
        metadata: metadata(VENTAS),
        contacts: [{ profile: { name: 'Paris' }, wa_id: '5216681723991' }],
        messages: [texto('wamid.P1', '5216681723991', 'hola, ¿cuánto cuesta la terminal?')],
      }),
    )

    expect(guardadas()).toEqual([
      expect.objectContaining({
        wamid: 'wamid.P1',
        phoneNumberId: VENTAS,
        contactPhone: '+526681723991',
        contactName: 'Paris',
        direction: 'ENTRA',
        origin: 'MENSAJE',
        type: 'text',
        body: 'hola, ¿cuánto cuesta la terminal?',
        sentAt: new Date(1762100000 * 1000),
      }),
    ])
    expect(db.crmWhatsappMessage.createMany.mock.calls[0][0].skipDuplicates).toBe(true)
    noContestoNiTocoElCentral()
  })

  it('una foto o un audio se guardan (con su pie de foto) y tampoco se contestan', async () => {
    await processWhatsappWebhook(
      aviso('messages', {
        metadata: metadata(VENTAS),
        messages: [
          { id: 'wamid.F1', from: '5215511112222', timestamp: '1762100001', type: 'image', image: { id: 'm1', caption: 'mi local' } },
          { id: 'wamid.A1', from: '5215511112222', timestamp: '1762100002', type: 'audio', audio: { id: 'm2' } },
        ],
      }),
    )

    expect(guardadas().map((m: any) => [m.wamid, m.type, m.body])).toEqual([
      ['wamid.F1', 'image', 'mi local'],
      ['wamid.A1', 'audio', null],
    ])
    noContestoNiTocoElCentral()
  })

  it('lo que el founder manda desde su celular (eco) se guarda como SALE, con el teléfono del prospecto', async () => {
    await processWhatsappWebhook(
      aviso('smb_message_echoes', {
        metadata: metadata(VENTAS),
        message_echoes: [
          {
            from: '525640070001',
            to: '5215511112222',
            id: 'wamid.E1',
            timestamp: '1762100003',
            type: 'text',
            text: { body: 'claro, te mando la liga' },
          },
        ],
      }),
    )

    expect(guardadas()).toEqual([
      expect.objectContaining({
        wamid: 'wamid.E1',
        contactPhone: '+525511112222',
        direction: 'SALE',
        origin: 'ECO',
        body: 'claro, te mando la liga',
      }),
    ])
    noContestoNiTocoElCentral()
  })

  it('el historial se guarda hilo por hilo: ENTRA si lo escribió el prospecto, SALE si lo escribió el negocio', async () => {
    await processWhatsappWebhook(
      aviso('history', {
        metadata: metadata(VENTAS),
        history: [
          {
            metadata: { phase: 1, chunk_order: 2, progress: 40 },
            threads: [
              {
                id: '5215511112222',
                messages: [
                  { ...texto('wamid.H1', '5215511112222', 'buenas'), history_context: { status: 'READ' } },
                  { ...texto('wamid.H2', '525640070001', '¡hola!'), history_context: { status: 'DELIVERED' } },
                ],
              },
            ],
          },
        ],
      }),
    )

    expect(guardadas().map((m: any) => [m.wamid, m.contactPhone, m.direction, m.origin])).toEqual([
      ['wamid.H1', '+525511112222', 'ENTRA', 'HISTORIAL'],
      ['wamid.H2', '+525511112222', 'SALE', 'HISTORIAL'],
    ])
    noContestoNiTocoElCentral()
  })

  it('un historial de miles de mensajes se guarda por tandas de 500', async () => {
    const messages = Array.from({ length: 1201 }, (_, i) => texto(`wamid.M${i}`, '5215511112222', `m${i}`))
    await processWhatsappWebhook(
      aviso('history', { metadata: metadata(VENTAS), history: [{ threads: [{ id: '5215511112222', messages }] }] }),
    )

    expect(db.crmWhatsappMessage.createMany.mock.calls.map((c: any[]) => c[0].data.length)).toEqual([500, 500, 201])
    expect(guardadas()).toHaveLength(1201)
  })

  it('si el negocio no compartió su historial (error 2593109) no se guarda nada y no truena', async () => {
    await processWhatsappWebhook(
      aviso('history', {
        metadata: metadata(VENTAS),
        history: [{ errors: [{ code: 2593109, title: 'History sync is turned off by the business from the WhatsApp Business App.' }] }],
      }),
    )

    expect(db.crmWhatsappMessage.createMany).not.toHaveBeenCalled()
    noContestoNiTocoElCentral()
  })

  it('si la base falla al guardar, el error sube (el controlador responde 500 y Meta reintenta)', async () => {
    db.crmWhatsappMessage.createMany.mockRejectedValueOnce(new Error('se cayó la base'))

    await expect(
      processWhatsappWebhook(aviso('messages', { metadata: metadata(VENTAS), messages: [texto('wamid.X', '5215511112222', 'hola')] })),
    ).rejects.toThrow('se cayó la base')
  })

  it('si por error las dos variables traen el mismo id, gana ventas: se calla en vez de contestarle a un prospecto', async () => {
    process.env.WHATSAPP_PHONE_NUMBER_ID = VENTAS

    await processWhatsappWebhook(aviso('messages', { metadata: metadata(VENTAS), messages: [texto('wamid.Y', '5215511112222', 'hola')] }))

    expect(guardadas()).toHaveLength(1)
    noContestoNiTocoElCentral()
  })
})

describe('whatsappWebhook — número que no conocemos', () => {
  it.each([
    ['otro número', { metadata: metadata('999') }],
    ['sin metadata', {}],
  ])('%s: un texto suelto no se contesta ni se guarda', async (_caso, extra) => {
    await processWhatsappWebhook(aviso('messages', { ...extra, messages: [texto('wamid.Z', '5215511112222', 'hola')] }))

    expect(db.crmWhatsappMessage.createMany).not.toHaveBeenCalled()
    noContestoNiTocoElCentral()
  })

  it('sin la variable del número de ventas, un aviso de ese número no se contesta ni se guarda', async () => {
    delete process.env.WHATSAPP_SALES_PHONE_NUMBER_ID

    await processWhatsappWebhook(aviso('messages', { metadata: metadata(VENTAS), messages: [texto('wamid.Z', '5215511112222', 'hola')] }))

    expect(db.crmWhatsappMessage.createMany).not.toHaveBeenCalled()
    noContestoNiTocoElCentral()
  })

  it.each(['smb_message_echoes', 'history'])('%s de otro número no se guarda', async field => {
    await processWhatsappWebhook(
      aviso(field, {
        metadata: metadata('999'),
        message_echoes: [{ from: '1', to: '5215511112222', id: 'wamid.E9', timestamp: '1', type: 'text', text: { body: 'x' } }],
        history: [{ threads: [{ id: '5215511112222', messages: [texto('wamid.H9', '5215511112222', 'x')] }] }],
      }),
    )

    expect(db.crmWhatsappMessage.createMany).not.toHaveBeenCalled()
  })
})

describe('whatsappWebhook — el número central sigue igual', () => {
  it('a un texto suelto le sigue contestando «¿A qué cliente le contestas?» y no guarda nada en el CRM', async () => {
    await processWhatsappWebhook(aviso('messages', { metadata: metadata(CENTRAL), messages: [texto('wamid.C1', '5215511112222', 'hola')] }))

    expect(enviar).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('¿A qué cliente le contestas?'))
    expect(db.whatsappContactWindow.upsert).toHaveBeenCalled()
    expect(db.crmWhatsappMessage.createMany).not.toHaveBeenCalled()
  })
})
