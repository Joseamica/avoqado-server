import logger from '@/config/logger'
import { normalizePhoneE164 } from '@/utils/phone'
import prisma from '@/utils/prismaClient'

// Meta Cloud API inbound message shape (only fields we read; rest preserved as rawBody).
interface CloudApiInboundMessage {
  id: string
  from: string
  type: string
  text?: { body: string }
  context?: { id: string }
  timestamp: string
  [key: string]: unknown
}

interface CloudApiStatusEvent {
  id: string
  status: string
  [key: string]: unknown
}

interface CloudApiChange {
  field: string
  value: {
    messages?: CloudApiInboundMessage[]
    statuses?: CloudApiStatusEvent[]
    [key: string]: unknown
  }
}

interface CloudApiWebhookPayload {
  entry?: { changes?: CloudApiChange[] }[]
}

// Process an entire Meta webhook delivery. Returns once all entries are processed.
// Throws if any individual message throws — caller should return 5xx so Meta retries.
// Per spec §POST /api/v1/webhooks/whatsapp and Phase 4 Task 4.4.
export async function processWhatsappWebhook(payload: CloudApiWebhookPayload): Promise<void> {
  const entries = payload?.entry ?? []
  for (const entry of entries) {
    const changes = entry.changes ?? []
    for (const change of changes) {
      if (change.field === 'messages') {
        await processMessagesChange(change)
      } else if (change.field === 'message_template_status_update') {
        logger.info('Template status update received', { value: change.value })
        // Phase 4 Task 4.9 will dispatch the admin alert email.
      } else {
        logger.warn('Unknown webhook field', { field: change.field })
      }
    }
  }
}

async function processMessagesChange(change: CloudApiChange) {
  const statuses = change.value.statuses ?? []
  for (const s of statuses) {
    logger.info('WhatsApp status event', { wamid: s.id, status: s.status })
    // v1: log only, do not persist. Per spec §Status events.
  }

  const messages = change.value.messages ?? []
  for (const msg of messages) {
    await processInboundMessage(msg)
  }
}

async function processInboundMessage(msg: CloudApiInboundMessage): Promise<void> {
  const fromPhone = normalizePhoneE164(msg.from) || `+${msg.from}`

  // Idempotency: upsert by wamid (unique). If we've seen this wamid before,
  // we still want the record to exist but skip routing on the retry.
  const event = await prisma.whatsappInboundEvent.upsert({
    where: { wamid: msg.id },
    update: {},
    create: {
      wamid: msg.id,
      fromPhone,
      messageType: msg.type,
      rawBody: msg as unknown as object,
    },
  })

  if (event.processedAt) {
    logger.info('Skipping fully-processed inbound message', { wamid: msg.id })
    return
  }

  // Window upsert is unconditional — every inbound message refreshes the 24h
  // service window for this phone, regardless of routing outcome.
  await prisma.whatsappContactWindow.upsert({
    where: { phone: fromPhone },
    create: { phone: fromPhone, lastInboundAt: new Date() },
    update: { lastInboundAt: new Date() },
  })

  // Routing branches (ACTIVAR / DESACTIVAR / venue reply / etc.) land in Tasks
  // 4.5-4.8. For now, mark processed with routedAs=IGNORED so retries no-op.
  await prisma.whatsappInboundEvent.update({
    where: { wamid: msg.id },
    data: { processedAt: new Date(), routedAs: 'IGNORED' },
  })
}
