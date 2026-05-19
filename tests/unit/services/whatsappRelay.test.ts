import { relayCustomerMessageToVenue } from '@/services/whatsappRelay.service'

import { prismaMock } from '../../__helpers__/setup'

// Mock the WhatsApp transport helpers. The relay-under-test only owns
// transport selection + status lifecycle; the actual Cloud API calls are
// covered by whatsapp.service.test.ts.
jest.mock('@/services/whatsapp.service', () => {
  class WhatsappCloudApiError extends Error {
    cloudApiErrorCode?: number
    constructor(message: string, code?: number) {
      super(message)
      this.name = 'WhatsappCloudApiError'
      this.cloudApiErrorCode = code
    }
  }
  return {
    sendVenueChatTemplate: jest.fn(),
    sendServiceMessage: jest.fn(),
    WhatsappCloudApiError,
  }
})

import { sendServiceMessage, sendVenueChatTemplate, WhatsappCloudApiError } from '@/services/whatsapp.service'

const MESSAGE_ID = 'msg-1'
const SESSION_ID = 'sess-1'
const VENUE_ID = 'venue-1'
const VENUE_PHONE = '+525500001234'

function buildMessageWithSession(overrides: { lastInboundAt?: Date | null; flowOrigin?: string } = {}) {
  return {
    id: MESSAGE_ID,
    sessionId: SESSION_ID,
    direction: 'INBOUND_FROM_CUSTOMER' as const,
    body: 'hola',
    relayStatus: 'PENDING' as const,
    session: {
      id: SESSION_ID,
      shortCode: 'ABCD',
      customerName: 'Juan',
      flowOrigin: overrides.flowOrigin ?? 'appointments',
      venue: {
        id: VENUE_ID,
        name: 'Estética Bella',
        whatsappContactMode: 'RELAY' as const,
        whatsappOptInPhone: VENUE_PHONE,
      },
    },
  }
}

describe('relayCustomerMessageToVenue', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('uses SERVICE transport when contact window is OPEN', async () => {
    prismaMock.venueChatMessage.findUnique.mockResolvedValue(buildMessageWithSession())
    prismaMock.whatsappContactWindow.findUnique.mockResolvedValue({
      phone: VENUE_PHONE,
      lastInboundAt: new Date(),
      updatedAt: new Date(),
    })
    ;(sendServiceMessage as jest.Mock).mockResolvedValue({ messageId: 'wamid.SVC_1' })
    prismaMock.venueChatMessage.update.mockResolvedValue({} as any)

    await relayCustomerMessageToVenue(MESSAGE_ID)

    expect(sendServiceMessage).toHaveBeenCalledTimes(1)
    expect(sendVenueChatTemplate).not.toHaveBeenCalled()
    expect(prismaMock.venueChatMessage.update).toHaveBeenCalledWith({
      where: { id: MESSAGE_ID },
      data: { relayStatus: 'SENT', whatsappTransport: 'SERVICE', whatsappMessageId: 'wamid.SVC_1' },
    })
  })

  it('uses TEMPLATE transport when window is CLOSED (no window row)', async () => {
    prismaMock.venueChatMessage.findUnique.mockResolvedValue(buildMessageWithSession())
    prismaMock.whatsappContactWindow.findUnique.mockResolvedValue(null)
    ;(sendVenueChatTemplate as jest.Mock).mockResolvedValue({ messageId: 'wamid.TPL_1' })
    prismaMock.venueChatMessage.update.mockResolvedValue({} as any)

    await relayCustomerMessageToVenue(MESSAGE_ID)

    expect(sendVenueChatTemplate).toHaveBeenCalledTimes(1)
    expect(sendServiceMessage).not.toHaveBeenCalled()
    expect(prismaMock.venueChatMessage.update).toHaveBeenCalledWith({
      where: { id: MESSAGE_ID },
      data: { relayStatus: 'SENT', whatsappTransport: 'TEMPLATE', whatsappMessageId: 'wamid.TPL_1' },
    })
  })

  it('treats a >24h old window as CLOSED and uses TEMPLATE', async () => {
    prismaMock.venueChatMessage.findUnique.mockResolvedValue(buildMessageWithSession())
    prismaMock.whatsappContactWindow.findUnique.mockResolvedValue({
      phone: VENUE_PHONE,
      lastInboundAt: new Date(Date.now() - 25 * 3600_000),
      updatedAt: new Date(),
    })
    ;(sendVenueChatTemplate as jest.Mock).mockResolvedValue({ messageId: 'wamid.TPL_OLD' })
    prismaMock.venueChatMessage.update.mockResolvedValue({} as any)

    await relayCustomerMessageToVenue(MESSAGE_ID)

    expect(sendServiceMessage).not.toHaveBeenCalled()
    expect(sendVenueChatTemplate).toHaveBeenCalledTimes(1)
  })

  it('auto-retries with TEMPLATE on 131047 from SERVICE attempt and clears window', async () => {
    prismaMock.venueChatMessage.findUnique.mockResolvedValue(buildMessageWithSession())
    prismaMock.whatsappContactWindow.findUnique.mockResolvedValue({
      phone: VENUE_PHONE,
      lastInboundAt: new Date(),
      updatedAt: new Date(),
    })
    ;(sendServiceMessage as jest.Mock).mockRejectedValue(new WhatsappCloudApiError('Re-engagement message', 131047))
    ;(sendVenueChatTemplate as jest.Mock).mockResolvedValue({ messageId: 'wamid.RETRY_1' })
    prismaMock.whatsappContactWindow.update.mockResolvedValue({} as any)
    prismaMock.venueChatMessage.update.mockResolvedValue({} as any)

    await relayCustomerMessageToVenue(MESSAGE_ID)

    expect(sendServiceMessage).toHaveBeenCalledTimes(1)
    expect(sendVenueChatTemplate).toHaveBeenCalledTimes(1)
    expect(prismaMock.whatsappContactWindow.update).toHaveBeenCalledWith({
      where: { phone: VENUE_PHONE },
      data: { lastInboundAt: null },
    })
    expect(prismaMock.venueChatMessage.update).toHaveBeenCalledWith({
      where: { id: MESSAGE_ID },
      data: { relayStatus: 'SENT', whatsappTransport: 'TEMPLATE', whatsappMessageId: 'wamid.RETRY_1' },
    })
  })

  it('auto-retries with TEMPLATE on 131026 (alternate stale-window code)', async () => {
    prismaMock.venueChatMessage.findUnique.mockResolvedValue(buildMessageWithSession())
    prismaMock.whatsappContactWindow.findUnique.mockResolvedValue({
      phone: VENUE_PHONE,
      lastInboundAt: new Date(),
      updatedAt: new Date(),
    })
    ;(sendServiceMessage as jest.Mock).mockRejectedValue(new WhatsappCloudApiError('Undeliverable', 131026))
    ;(sendVenueChatTemplate as jest.Mock).mockResolvedValue({ messageId: 'wamid.RETRY_2' })
    prismaMock.whatsappContactWindow.update.mockResolvedValue({} as any)
    prismaMock.venueChatMessage.update.mockResolvedValue({} as any)

    await relayCustomerMessageToVenue(MESSAGE_ID)

    expect(sendVenueChatTemplate).toHaveBeenCalledTimes(1)
  })

  it('marks FAILED with sendErrorCode on non-recoverable Cloud API error from SERVICE', async () => {
    prismaMock.venueChatMessage.findUnique.mockResolvedValue(buildMessageWithSession())
    prismaMock.whatsappContactWindow.findUnique.mockResolvedValue({
      phone: VENUE_PHONE,
      lastInboundAt: new Date(),
      updatedAt: new Date(),
    })
    ;(sendServiceMessage as jest.Mock).mockRejectedValue(new WhatsappCloudApiError('Some other error', 999))
    prismaMock.venueChatMessage.update.mockResolvedValue({} as any)

    await expect(relayCustomerMessageToVenue(MESSAGE_ID)).rejects.toThrow('Some other error')

    expect(sendVenueChatTemplate).not.toHaveBeenCalled()
    expect(prismaMock.venueChatMessage.update).toHaveBeenCalledWith({
      where: { id: MESSAGE_ID },
      data: { relayStatus: 'FAILED', sendErrorCode: '999', sendErrorMessage: 'Some other error' },
    })
  })

  it('marks FAILED on TEMPLATE-path Cloud API error', async () => {
    prismaMock.venueChatMessage.findUnique.mockResolvedValue(buildMessageWithSession())
    prismaMock.whatsappContactWindow.findUnique.mockResolvedValue(null)
    ;(sendVenueChatTemplate as jest.Mock).mockRejectedValue(new WhatsappCloudApiError('Template rejected', 132001))
    prismaMock.venueChatMessage.update.mockResolvedValue({} as any)

    await expect(relayCustomerMessageToVenue(MESSAGE_ID)).rejects.toThrow('Template rejected')

    expect(prismaMock.venueChatMessage.update).toHaveBeenCalledWith({
      where: { id: MESSAGE_ID },
      data: { relayStatus: 'FAILED', sendErrorCode: '132001', sendErrorMessage: 'Template rejected' },
    })
  })

  it('records UNKNOWN error code for non-WhatsappCloudApiError failures', async () => {
    prismaMock.venueChatMessage.findUnique.mockResolvedValue(buildMessageWithSession())
    prismaMock.whatsappContactWindow.findUnique.mockResolvedValue(null)
    ;(sendVenueChatTemplate as jest.Mock).mockRejectedValue(new Error('network down'))
    prismaMock.venueChatMessage.update.mockResolvedValue({} as any)

    await expect(relayCustomerMessageToVenue(MESSAGE_ID)).rejects.toThrow('network down')

    expect(prismaMock.venueChatMessage.update).toHaveBeenCalledWith({
      where: { id: MESSAGE_ID },
      data: { relayStatus: 'FAILED', sendErrorCode: 'UNKNOWN', sendErrorMessage: 'network down' },
    })
  })

  it('records SENT_NO_WAMID when wamid uniqueness collides (P2002)', async () => {
    prismaMock.venueChatMessage.findUnique.mockResolvedValue(buildMessageWithSession())
    prismaMock.whatsappContactWindow.findUnique.mockResolvedValue(null)
    ;(sendVenueChatTemplate as jest.Mock).mockResolvedValue({ messageId: 'wamid.DUP' })

    const p2002 = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })
    prismaMock.venueChatMessage.update.mockRejectedValueOnce(p2002).mockResolvedValueOnce({} as any)

    await relayCustomerMessageToVenue(MESSAGE_ID)

    expect(prismaMock.venueChatMessage.update).toHaveBeenNthCalledWith(2, {
      where: { id: MESSAGE_ID },
      data: { relayStatus: 'SENT_NO_WAMID', whatsappTransport: 'TEMPLATE' },
    })
  })

  it('throws when message does not exist', async () => {
    prismaMock.venueChatMessage.findUnique.mockResolvedValue(null)
    await expect(relayCustomerMessageToVenue('missing')).rejects.toThrow('message missing not found')
  })

  it('throws when message is not INBOUND_FROM_CUSTOMER', async () => {
    const wrong = buildMessageWithSession()
    ;(wrong as any).direction = 'INBOUND_FROM_VENUE'
    prismaMock.venueChatMessage.findUnique.mockResolvedValue(wrong)
    await expect(relayCustomerMessageToVenue(MESSAGE_ID)).rejects.toThrow('not INBOUND_FROM_CUSTOMER')
  })

  it('throws when venue has no opted-in phone', async () => {
    const noPhone = buildMessageWithSession()
    noPhone.session.venue.whatsappOptInPhone = null as any
    prismaMock.venueChatMessage.findUnique.mockResolvedValue(noPhone)
    await expect(relayCustomerMessageToVenue(MESSAGE_ID)).rejects.toThrow('no opted-in phone')
  })

  it('passes localized flowLabel ("Clases") through to sendVenueChatTemplate', async () => {
    prismaMock.venueChatMessage.findUnique.mockResolvedValue(buildMessageWithSession({ flowOrigin: 'classes' }))
    prismaMock.whatsappContactWindow.findUnique.mockResolvedValue(null)
    ;(sendVenueChatTemplate as jest.Mock).mockResolvedValue({ messageId: 'wamid.X' })
    prismaMock.venueChatMessage.update.mockResolvedValue({} as any)

    await relayCustomerMessageToVenue(MESSAGE_ID)

    expect(sendVenueChatTemplate).toHaveBeenCalledWith(
      VENUE_PHONE,
      expect.objectContaining({ flowLabel: 'Clases', shortCode: 'ABCD', customerName: 'Juan' }),
    )
  })
})
