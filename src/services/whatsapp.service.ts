/**
 * WhatsApp Business API Service
 *
 * Sends messages via Meta Cloud API (WhatsApp Business).
 * Uses pre-approved message templates for transactional messages.
 *
 * Prerequisites:
 * 1. Meta Business Manager account
 * 2. WhatsApp Business API configured
 * 3. Approved message templates in es_MX
 * 4. Environment variables: WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_ACCESS_TOKEN
 *
 * Templates:
 * - receipt_link: Receipt link (3 params: venueName, totalAmount, receiptUrl)
 * - purchase_confirmation: Purchase confirmation (3 params: name, venue, amount)
 * - reservation_confirmation: Reservation confirmation (4 params: name, venue, date, time)
 * - reservation_reminder: Reservation reminder (4 params: name, venue, date, time)
 * - reservation_reschedule: Reservation reschedule (5 params: name, venue, date, time, message)
 * - order_status_update: Order status update (3 params: name, venue, status)
 */

import logger from '@/config/logger'
import { sanitizeServiceMessage, sanitizeTemplateVar } from '@/utils/whatsappSanitize'

const WHATSAPP_API_URL = 'https://graph.facebook.com/v21.0'

// ===== TYPES =====

interface WhatsAppReceiptData {
  venueName: string
  totalAmount: string
  receiptUrl: string
}

interface WhatsAppPaymentLinkShareData {
  /** Restaurant/venue name — fills {{1}} in the approved template. */
  venueName: string
  /** Free-form description of what's being charged — fills {{2}}. Typical
   *  format: "Hamburguesa BBQ — $164.50 MXN". Caller formats. */
  concepto: string
  /** Full payment-link URL the customer taps to pay — fills {{3}}. */
  paymentLinkUrl: string
}

interface WhatsAppPurchaseConfirmationData {
  customerName: string
  venueName: string
  amount: string
}

interface WhatsAppReservationData {
  customerName: string
  venueName: string
  date: string
  time: string
}

interface WhatsAppOrderStatusData {
  customerName: string
  venueName: string
  status: string
}

type WhatsAppTemplateParam = { type: 'text'; text: string }

// ===== CORE SENDER =====

/**
 * Normalize phone number to E.164 format without +
 * Cleans spaces/dashes, defaults to Mexico +52 for 10-digit numbers
 */
function normalizePhone(phone: string): string {
  const clean = phone.replace(/[\s\-()]/g, '')
  if (clean.startsWith('+')) return clean.replace('+', '')
  if (clean.length === 10) return `52${clean}`
  return clean
}

// Send a WhatsApp template message via Meta Cloud API. Throws on failure.
// Returns the Cloud API messageId (wamid) so callers that need to track the
// outbound message in their own state machine (e.g. the venue-chat relay) can
// store it. Exported wrappers below translate this back to Promise<boolean> for
// backward compatibility.
async function sendTemplateMessage(
  phone: string,
  templateName: string,
  parameters: WhatsAppTemplateParam[],
): Promise<{ messageId: string }> {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN

  if (!phoneNumberId || !accessToken) {
    logger.warn('WhatsApp Business API not configured. Set WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN.')
    throw new Error('WhatsApp Business API no esta configurado')
  }

  const fullPhone = normalizePhone(phone)
  const url = `${WHATSAPP_API_URL}/${phoneNumberId}/messages`

  const body = {
    messaging_product: 'whatsapp',
    to: fullPhone,
    type: 'template',
    template: {
      name: templateName,
      language: { code: 'es_MX' },
      components: [
        {
          type: 'body',
          parameters,
        },
      ],
    },
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
    })

    const result = (await response.json()) as Record<string, any>

    if (!response.ok) {
      const errorMsg = result?.error?.message || `HTTP ${response.status}`
      logger.error(`WhatsApp API error: ${errorMsg}`, { phone: fullPhone, template: templateName, status: response.status })
      throw new Error(`Error al enviar WhatsApp: ${errorMsg}`)
    }

    const messageId = result?.messages?.[0]?.id
    if (!messageId) {
      logger.error('WhatsApp API returned 200 but no messages[0].id', { phone: fullPhone, template: templateName, result })
      throw new Error('Error al enviar WhatsApp: no message id in response')
    }

    logger.info(`WhatsApp template "${templateName}" sent to ${fullPhone}`, { messageId })
    return { messageId }
  } catch (error) {
    if ((error as Error).message.startsWith('Error al enviar') || (error as Error).message.startsWith('WhatsApp Business API')) {
      throw error
    }
    logger.error(`WhatsApp send failed: ${(error as Error).message}`, { phone: fullPhone, template: templateName })
    throw new Error(`No se pudo enviar el mensaje de WhatsApp: ${(error as Error).message}`)
  }
}

// ===== TEMPLATE-SPECIFIC SENDERS =====

/**
 * Send receipt link via WhatsApp
 * Template: receipt_link — params: {{1}}=venueName, {{2}}=totalAmount, {{3}}=receiptUrl
 */
export async function sendReceiptWhatsApp(phone: string, data: WhatsAppReceiptData): Promise<boolean> {
  await sendTemplateMessage(phone, 'receipt_link', [
    { type: 'text', text: data.venueName },
    { type: 'text', text: data.totalAmount },
    { type: 'text', text: data.receiptUrl },
  ])
  return true
}

/**
 * Share a payment link with a customer via WhatsApp.
 *
 * Uses the approved Utility template `payment_link_share` — body copy:
 *
 *   Hola, {{1}} te envió una liga de pago.
 *   Concepto: {{2}}
 *   Paga de forma segura aquí: {{3}}
 *   ¡Gracias por tu preferencia!
 *
 * Template name is configurable via WHATSAPP_TEMPLATE_PAYMENT_LINK_SHARE so
 * we can swap to a renamed/v2 template without a code change if Meta ever
 * asks us to.
 */
export async function sendPaymentLinkShareWhatsApp(phone: string, data: WhatsAppPaymentLinkShareData): Promise<boolean> {
  const template = process.env.WHATSAPP_TEMPLATE_PAYMENT_LINK_SHARE || 'payment_link_share'
  await sendTemplateMessage(phone, template, [
    { type: 'text', text: data.venueName },
    { type: 'text', text: data.concepto },
    { type: 'text', text: data.paymentLinkUrl },
  ])
  return true
}

/**
 * Send purchase confirmation via WhatsApp
 * Template: purchase_confirmation — params: {{1}}=name, {{2}}=venue, {{3}}=amount
 */
export async function sendPurchaseConfirmationWhatsApp(phone: string, data: WhatsAppPurchaseConfirmationData): Promise<boolean> {
  await sendTemplateMessage(phone, 'purchase_confirmation', [
    { type: 'text', text: data.customerName },
    { type: 'text', text: data.venueName },
    { type: 'text', text: data.amount },
  ])
  return true
}

/**
 * Format picked modifiers as a single line for the WhatsApp template.
 * Example: "Esmalte de color +$150, Por uña × 3 +$30"
 * Returns empty string when no modifiers — caller decides which template to use.
 */
export function formatModifiersForWhatsApp(modifiers: Array<{ name: string | null; quantity: number; price: number }>): string {
  return modifiers
    .filter(m => m.name)
    .map(m => {
      const qtyLabel = m.quantity > 1 ? ` × ${m.quantity}` : ''
      const total = m.price * m.quantity
      const priceLabel = total > 0 ? ` +$${total.toLocaleString('es-MX', { maximumFractionDigits: 0 })}` : ''
      return `${m.name}${qtyLabel}${priceLabel}`
    })
    .join(', ')
}

/**
 * Send reservation confirmation via WhatsApp
 * Template: reservation_confirmation — params: {{1}}=name, {{2}}=venue, {{3}}=date, {{4}}=time
 *
 * When `data.extras` is set (modifier breakdown), routes to the extended template
 * `reservation_confirmation_with_extras` which adds {{5}}=extras line.
 *
 * AWAITING META TEMPLATE APPROVAL — register a new template named
 * `reservation_confirmation_with_extras` (es_MX) with 5 body params:
 *   "Hola {{1}}, confirmamos tu cita en {{2}} el {{3}} a las {{4}}. Extras: {{5}}"
 * Until approved, callers should leave `extras` undefined so the legacy 4-param
 * template fires — modifier info will still reach the customer via the email.
 */
export async function sendReservationConfirmationWhatsApp(
  phone: string,
  data: WhatsAppReservationData & { extras?: string },
): Promise<boolean> {
  if (data.extras && data.extras.trim().length > 0) {
    await sendTemplateMessage(phone, 'reservation_confirmation_with_extras', [
      { type: 'text', text: data.customerName },
      { type: 'text', text: data.venueName },
      { type: 'text', text: data.date },
      { type: 'text', text: data.time },
      { type: 'text', text: data.extras },
    ])
    return true
  }
  await sendTemplateMessage(phone, 'reservation_confirmation', [
    { type: 'text', text: data.customerName },
    { type: 'text', text: data.venueName },
    { type: 'text', text: data.date },
    { type: 'text', text: data.time },
  ])
  return true
}

/**
 * Send reservation reminder via WhatsApp
 * Template: reservation_reminder — params: {{1}}=name, {{2}}=venue, {{3}}=date, {{4}}=time
 */
export async function sendReservationReminderWhatsApp(phone: string, data: WhatsAppReservationData): Promise<boolean> {
  await sendTemplateMessage(phone, 'reservation_reminder', [
    { type: 'text', text: data.customerName },
    { type: 'text', text: data.venueName },
    { type: 'text', text: data.date },
    { type: 'text', text: data.time },
  ])
  return true
}

/**
 * Send reservation reschedule via WhatsApp
 * Template: reservation_reschedule — params:
 *   {{1}}=name, {{2}}=venue, {{3}}=date, {{4}}=time, {{5}}=staff message (or default)
 *
 * If `data.message` is empty/undefined, sends a sensible default in {{5}} so the
 * Meta template (which requires non-empty variables) does not reject the send.
 */
export async function sendReservationRescheduleWhatsApp(
  phone: string,
  data: WhatsAppReservationData & { message?: string },
): Promise<boolean> {
  const fifth = data.message?.trim() || 'Te esperamos.'
  await sendTemplateMessage(phone, 'reservation_reschedule', [
    { type: 'text', text: data.customerName },
    { type: 'text', text: data.venueName },
    { type: 'text', text: data.date },
    { type: 'text', text: data.time },
    { type: 'text', text: fifth },
  ])
  return true
}

/**
 * Send order status update via WhatsApp
 * Template: order_status_update — params: {{1}}=name, {{2}}=venue, {{3}}=status
 */
export async function sendOrderStatusUpdateWhatsApp(phone: string, data: WhatsAppOrderStatusData): Promise<boolean> {
  await sendTemplateMessage(phone, 'order_status_update', [
    { type: 'text', text: data.customerName },
    { type: 'text', text: data.venueName },
    { type: 'text', text: data.status },
  ])
  return true
}

// ===== VENUE CHAT (relay) =====

export interface VenueChatTemplateParams {
  venueName: string // {{1}}
  customerName: string // {{2}}
  shortCode: string // {{3}}
  flowLabel: string // {{4}}
  messageBody: string // {{5}}
}

// Send the venue_new_customer_message_v2 utility template. Used by the relay
// to notify the venue (on WhatsApp) of a new customer message when the 24h
// service window is closed. Returns wamid so the relay can correlate the
// venue's WhatsApp reply back to the originating chat session.
export async function sendVenueChatTemplate(phone: string, params: VenueChatTemplateParams): Promise<{ messageId: string }> {
  const sanitized: WhatsAppTemplateParam[] = [
    { type: 'text', text: sanitizeTemplateVar(params.venueName, 60) },
    { type: 'text', text: sanitizeTemplateVar(params.customerName, 40) },
    { type: 'text', text: sanitizeTemplateVar(params.shortCode, 8) },
    { type: 'text', text: sanitizeTemplateVar(params.flowLabel, 30) },
    { type: 'text', text: sanitizeTemplateVar(params.messageBody, 250) },
  ]
  return sendTemplateMessage(phone, 'venue_new_customer_message_v2', sanitized)
}

// Error subclass that carries the Cloud API numeric error code so callers can
// branch on specific failures — e.g. 131047 ("Re-engagement message") means
// the 24h window closed and the relay must retry as a template.
export class WhatsappCloudApiError extends Error {
  cloudApiErrorCode?: number
  constructor(message: string, code?: number) {
    super(message)
    this.name = 'WhatsappCloudApiError'
    this.cloudApiErrorCode = code
  }
}

// Send a free-form service (non-template) text message. Valid only inside an
// open 24h customer-service window. Caller must check WhatsappContactWindow
// before invoking. On Cloud API failure, throws WhatsappCloudApiError so the
// caller can branch on cloudApiErrorCode (e.g. 131047 → fall back to template).
export async function sendServiceMessage(phone: string, body: string): Promise<{ messageId: string }> {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN
  if (!phoneNumberId || !accessToken) {
    throw new Error('WhatsApp Business API no esta configurado')
  }

  const fullPhone = normalizePhone(phone)
  const sanitized = sanitizeServiceMessage(body)

  const response = await fetch(`${WHATSAPP_API_URL}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: fullPhone,
      type: 'text',
      text: { body: sanitized },
    }),
  })

  const result = (await response.json()) as Record<string, any>
  if (!response.ok) {
    const code = result?.error?.code
    const msg = result?.error?.message || `HTTP ${response.status}`
    logger.error(`WhatsApp service msg error: ${msg}`, { phone: fullPhone, status: response.status, code })
    throw new WhatsappCloudApiError(`Error al enviar WhatsApp: ${msg}`, typeof code === 'number' ? code : undefined)
  }

  const messageId = result?.messages?.[0]?.id
  if (!messageId) {
    logger.error('WhatsApp service msg 200 but no messages[0].id', { phone: fullPhone, result })
    throw new Error('Error al enviar WhatsApp: no message id in response')
  }

  logger.info(`WhatsApp service message sent to ${fullPhone}`, { messageId })
  return { messageId }
}
