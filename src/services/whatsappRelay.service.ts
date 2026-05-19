import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'

import { sendServiceMessage, sendVenueChatTemplate, WhatsappCloudApiError } from './whatsapp.service'

const WINDOW_INTERVAL_HOURS = 24
// 131047 = Re-engagement required; 131026 = message undeliverable in current
// session window. Both indicate the cached "window is open" state is stale.
const STALE_WINDOW_ERROR_CODES = new Set<number>([131047, 131026])

type TransportKind = 'SERVICE' | 'TEMPLATE'

interface RelayParams {
  venueName: string
  customerName: string
  shortCode: string
  flowLabel: string
  messageBody: string
}

// Bridges an inbound customer message to the venue's WhatsApp. Picks SERVICE
// vs TEMPLATE transport based on the 24h window cached in
// WhatsappContactWindow, auto-retries with TEMPLATE when the SERVICE path
// reports a stale window, and writes the lifecycle outcome onto the
// VenueChatMessage row. Throws on unrecoverable Cloud API failures so the
// scheduler/cron path can observe + alert.
export async function relayCustomerMessageToVenue(messageId: string): Promise<void> {
  const msg = await prisma.venueChatMessage.findUnique({
    where: { id: messageId },
    include: { session: { include: { venue: true } } },
  })
  if (!msg) throw new Error(`relay: message ${messageId} not found`)
  if (msg.direction !== 'INBOUND_FROM_CUSTOMER') {
    throw new Error(`relay: message ${messageId} is not INBOUND_FROM_CUSTOMER`)
  }
  if (!msg.session.venue.whatsappOptInPhone) {
    throw new Error(`relay: venue ${msg.session.venue.id} has no opted-in phone`)
  }

  const venuePhone = msg.session.venue.whatsappOptInPhone
  const params: RelayParams = {
    venueName: msg.session.venue.name,
    customerName: msg.session.customerName,
    shortCode: msg.session.shortCode,
    flowLabel: flowLabel(msg.session.flowOrigin),
    messageBody: msg.body,
  }

  const window = await prisma.whatsappContactWindow.findUnique({ where: { phone: venuePhone } })
  const isOpen = isWindowOpen(window?.lastInboundAt ?? null)

  if (isOpen) {
    try {
      const { messageId: wamid } = await sendServiceMessage(venuePhone, formatServiceBody(params))
      await markSent(messageId, wamid, 'SERVICE')
      return
    } catch (err) {
      if (err instanceof WhatsappCloudApiError && err.cloudApiErrorCode != null && STALE_WINDOW_ERROR_CODES.has(err.cloudApiErrorCode)) {
        logger.warn('[Relay] Stale-window false positive, retrying as TEMPLATE', {
          messageId,
          code: err.cloudApiErrorCode,
        })
        // Clear the cached window so future relays don't repeat the SERVICE
        // attempt + retry cycle. Window will repopulate on the next inbound
        // (webhook re-upserts WhatsappContactWindow on every inbound).
        await prisma.whatsappContactWindow.update({
          where: { phone: venuePhone },
          data: { lastInboundAt: null },
        })
        // fall through to TEMPLATE attempt below
      } else {
        await markFailed(messageId, err as Error)
        throw err
      }
    }
  }

  try {
    const { messageId: wamid } = await sendVenueChatTemplate(venuePhone, params)
    await markSent(messageId, wamid, 'TEMPLATE')
  } catch (err) {
    await markFailed(messageId, err as Error)
    throw err
  }
}

function isWindowOpen(lastInboundAt: Date | null): boolean {
  if (!lastInboundAt) return false
  return Date.now() - lastInboundAt.getTime() < WINDOW_INTERVAL_HOURS * 3600_000
}

function flowLabel(origin: string): string {
  switch (origin) {
    case 'classes':
      return 'Clases'
    case 'packs':
      return 'Paquetes'
    case 'appointments':
    default:
      return 'Citas'
  }
}

function formatServiceBody(p: RelayParams): string {
  return [
    `💬 Nuevo mensaje de cliente en ${p.venueName}`,
    '',
    `Cliente: ${p.customerName}  ·  ID: #${p.shortCode}`,
    `Sección: ${p.flowLabel}`,
    '',
    `"${p.messageBody}"`,
    '',
    '↩️ Para contestarle, mantén presionado el mensaje y elige "Responder".',
  ].join('\n')
}

async function markSent(messageId: string, wamid: string, transport: TransportKind): Promise<void> {
  try {
    await prisma.venueChatMessage.update({
      where: { id: messageId },
      data: { relayStatus: 'SENT', whatsappTransport: transport, whatsappMessageId: wamid },
    })
  } catch (err: any) {
    // P2002 = unique constraint violation on whatsappMessageId. Extremely
    // improbable (Meta-issued wamids are globally unique) but if it ever
    // happens we still record the transport so observers can correlate.
    if (err?.code === 'P2002') {
      logger.error('[Relay] wamid uniqueness collision; recording SENT_NO_WAMID', { messageId, wamid })
      await prisma.venueChatMessage.update({
        where: { id: messageId },
        data: { relayStatus: 'SENT_NO_WAMID', whatsappTransport: transport },
      })
    } else {
      throw err
    }
  }
}

async function markFailed(messageId: string, err: Error): Promise<void> {
  const code = err instanceof WhatsappCloudApiError && err.cloudApiErrorCode != null ? String(err.cloudApiErrorCode) : 'UNKNOWN'
  await prisma.venueChatMessage.update({
    where: { id: messageId },
    data: { relayStatus: 'FAILED', sendErrorCode: code, sendErrorMessage: err.message },
  })
}
