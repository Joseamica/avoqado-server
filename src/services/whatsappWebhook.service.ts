import logger from '@/config/logger'
import { getWhatsappAdminAlertEmail } from '@/config/whatsappCloud'
import { normalizePhoneE164 } from '@/utils/phone'
import prisma from '@/utils/prismaClient'

import { handleActivationCommand } from './venueChatActivation.service'
import { maybeSendVenueReplyEmail } from './venueChatEmail.service'
import { sendServiceMessage, WhatsappCloudApiError } from './whatsapp.service'

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

// Reply templates kept as constants so tests can match them with substring asserts.
const REPLY_ACTIVATION_OK =
  '✅ Listo. A partir de ahora recibirás aquí los mensajes que te manden los clientes desde tu sitio Avoqado.\n\nPara contestarle a un cliente, mantén presionado su mensaje y toca "Responder".'
const REPLY_ACTIVATION_INVALID =
  '❌ Ese código no es válido o ya expiró. Genera uno nuevo desde tu dashboard de Avoqado en Configuración → Chat con clientes.'
const REPLY_DEACTIVATE_REDIRECT = 'Para desactivar el chat, hazlo desde tu dashboard de Avoqado en Configuración → Chat con clientes.'
const REPLY_SESSION_CLOSED = 'Esta conversación ya cerró. El cliente ya no está esperando una respuesta.'
const REPLY_NO_CONTEXT = '⚠️ ¿A qué cliente le contestas? Mantén presionado el mensaje del cliente y toca "Responder".'
const REPLY_NON_TEXT =
  'Por ahora solo puedo reenviar texto. Por favor escribe tu respuesta como texto y mantén presionado el mensaje del cliente para citarlo.'

const ACTIVAR_REGEX = /^ACTIVAR\s+([A-Z0-9]{12})\s*$/i
const DESACTIVAR_REGEX = /^DESACTIVAR\b/i
const NON_TEXT_TYPES = new Set(['image', 'audio', 'video', 'sticker', 'document', 'location'])

// Process an entire Meta webhook delivery. Returns once all entries are processed.
// Throws if any individual message throws — caller should return 5xx so Meta retries.
export async function processWhatsappWebhook(payload: CloudApiWebhookPayload): Promise<void> {
  const entries = payload?.entry ?? []
  for (const entry of entries) {
    const changes = entry.changes ?? []
    for (const change of changes) {
      if (change.field === 'messages') {
        await processMessagesChange(change)
      } else if (change.field === 'message_template_status_update') {
        await handleTemplateStatusUpdate(change.value)
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

  // Window upsert unconditional — every inbound refreshes the 24h service window.
  await prisma.whatsappContactWindow.upsert({
    where: { phone: fromPhone },
    create: { phone: fromPhone, lastInboundAt: new Date() },
    update: { lastInboundAt: new Date() },
  })

  await routeAndReply(msg, fromPhone, event.id)

  await prisma.whatsappInboundEvent.update({
    where: { id: event.id },
    data: { processedAt: new Date() },
  })
}

async function routeAndReply(msg: CloudApiInboundMessage, fromPhone: string, eventId: string): Promise<void> {
  if (msg.type === 'text' && msg.text?.body) {
    const body = msg.text.body

    // ACTIVAR <12-char token> — onboarding command.
    const activarMatch = body.match(ACTIVAR_REGEX)
    if (activarMatch) {
      const token = activarMatch[1].toUpperCase()
      const res = await handleActivationCommand({ token, senderPhone: fromPhone })
      const replyBody = res.outcome === 'INVALID' ? REPLY_ACTIVATION_INVALID : REPLY_ACTIVATION_OK
      await idempotentReply(eventId, fromPhone, replyBody)
      await prisma.whatsappInboundEvent.update({
        where: { id: eventId },
        data: { routedAs: res.outcome === 'INVALID' ? 'ACTIVATION_FAILED' : 'ACTIVATION_CONSUMED' },
      })
      return
    }

    // DESACTIVAR — redirect to dashboard (no destructive action via WhatsApp).
    if (DESACTIVAR_REGEX.test(body)) {
      await idempotentReply(eventId, fromPhone, REPLY_DEACTIVATE_REDIRECT)
      await prisma.whatsappInboundEvent.update({
        where: { id: eventId },
        data: { routedAs: 'DEACTIVATION_REDIRECT' },
      })
      return
    }

    // Quote-reply (context.id present): venue replied by quoting a relay template.
    if (msg.context?.id) {
      await routeQuoteReply(msg, fromPhone, eventId)
      return
    }

    // Text without context.id from a venue — they typed without quoting.
    await idempotentReply(eventId, fromPhone, REPLY_NO_CONTEXT)
    await prisma.whatsappInboundEvent.update({
      where: { id: eventId },
      data: { routedAs: 'VENUE_REPLY_NO_CONTEXT' },
    })
    return
  }

  // Non-text media types — politely reject (v1 is text-only).
  if (NON_TEXT_TYPES.has(msg.type)) {
    await idempotentReply(eventId, fromPhone, REPLY_NON_TEXT)
    await prisma.whatsappInboundEvent.update({
      where: { id: eventId },
      data: { routedAs: 'NON_TEXT_REJECTED' },
    })
    return
  }

  // Anything else (unknown types, system messages, reactions): log, no reply
  // (avoids accidental reply loops on unknown payload shapes).
  await prisma.whatsappInboundEvent.update({
    where: { id: eventId },
    data: { routedAs: 'IGNORED' },
  })
}

async function routeQuoteReply(msg: CloudApiInboundMessage, fromPhone: string, eventId: string): Promise<void> {
  const contextId = msg.context!.id
  const original = await prisma.venueChatMessage.findUnique({
    where: { whatsappMessageId: contextId },
    include: { session: { include: { venue: true } } },
  })

  const sessionOk =
    original && original.session.venue.whatsappContactMode === 'RELAY' && original.session.venue.whatsappOptInPhone === fromPhone

  if (!sessionOk) {
    // Either: no such relay message, or venue is no longer in RELAY mode, or
    // sender phone doesn't match the venue's opt-in phone (potential hijack).
    await prisma.whatsappInboundEvent.update({
      where: { id: eventId },
      data: { routedAs: 'VENUE_REPLY_ORPHAN' },
    })
    return
  }

  if (original.session.status !== 'OPEN') {
    await idempotentReply(eventId, fromPhone, REPLY_SESSION_CLOSED)
    await prisma.whatsappInboundEvent.update({
      where: { id: eventId },
      data: { routedAs: 'VENUE_REPLY_ROUTED', routedSessionId: original.sessionId },
    })
    return
  }

  // Persist the venue reply. @unique on whatsappMessageId makes the insert
  // idempotent — Meta retries land on P2002 and we swallow it.
  let persisted = true
  try {
    await prisma.venueChatMessage.create({
      data: {
        sessionId: original.sessionId,
        direction: 'INBOUND_FROM_VENUE',
        body: msg.text?.body ?? '',
        whatsappMessageId: msg.id,
        whatsappContextId: contextId,
      },
    })
    await prisma.venueChatSession.update({
      where: { id: original.sessionId },
      data: { lastActivityAt: new Date() },
    })
  } catch (err: unknown) {
    if ((err as { code?: string }).code !== 'P2002') throw err
    persisted = false
  }

  await prisma.whatsappInboundEvent.update({
    where: { id: eventId },
    data: { routedAs: 'VENUE_REPLY_ROUTED', routedSessionId: original.sessionId },
  })

  // Fire-and-forget email notification to the customer. Idempotent on
  // Meta-retry: P2002 path above sets persisted=false so we don't re-notify
  // when the venue reply was already stored on an earlier delivery.
  if (persisted) {
    maybeSendVenueReplyEmail(original.sessionId).catch(err => {
      logger.error('[Webhook] maybeSendVenueReplyEmail failed', { sessionId: original.sessionId, err })
    })
  }
}

// Idempotent reply: skip the Cloud API call if a reply was already sent for
// this event. Meta retries the same wamid on transient 5xx; without this
// guard we would send the same reply N times.
async function idempotentReply(eventId: string, toPhone: string, body: string): Promise<void> {
  const event = await prisma.whatsappInboundEvent.findUnique({ where: { id: eventId } })
  if (event?.replySentAt) return
  try {
    const { messageId } = await sendServiceMessage(toPhone, body)
    await prisma.whatsappInboundEvent.update({
      where: { id: eventId },
      data: { replyWamid: messageId, replySentAt: new Date() },
    })
  } catch (err) {
    if (err instanceof WhatsappCloudApiError) {
      logger.error('Bot reply failed', { eventId, code: err.cloudApiErrorCode, msg: err.message })
    }
    throw err
  }
}

interface TemplateStatusValue {
  event?: string
  message_template_name?: string
  reason?: string
  [key: string]: unknown
}

// Surface REJECTED/FLAGGED/PAUSED template status events to ops. APPROVED is
// only logged (informational). Email dispatch is best-effort — never throws
// because Meta retries 5xx and we don't want re-alerts.
async function handleTemplateStatusUpdate(value: unknown): Promise<void> {
  const v = (value || {}) as TemplateStatusValue
  const event = v.event ?? 'UNKNOWN'
  const template = v.message_template_name ?? 'unknown'
  const reason = v.reason ?? 'none'

  logger.warn('WhatsApp template status update', { template, event, reason })

  if (['REJECTED', 'FLAGGED', 'PAUSED'].includes(event)) {
    const email = getWhatsappAdminAlertEmail()
    if (email) {
      // TODO(venue-chat): replace this log with a real email send via the
      // existing email service once the API is identified. For now the WARN
      // log + monitoring on the WhatsApp template state in Meta BM are the
      // safety net.
      logger.error(`[ADMIN ALERT] Template ${template} ${event}: ${reason} → notify ${email}`)
    } else {
      logger.error(`[ADMIN ALERT] Template ${template} ${event}: ${reason} (no WHATSAPP_ADMIN_ALERT_EMAIL set)`)
    }
  }
}
