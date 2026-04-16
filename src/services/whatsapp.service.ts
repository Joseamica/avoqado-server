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
 * - order_status_update: Order status update (3 params: name, venue, status)
 */

import logger from '@/config/logger'

const WHATSAPP_API_URL = 'https://graph.facebook.com/v21.0'

// ===== TYPES =====

interface WhatsAppReceiptData {
  venueName: string
  totalAmount: string
  receiptUrl: string
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

/**
 * Send a WhatsApp template message via Meta Cloud API
 */
async function sendTemplateMessage(phone: string, templateName: string, parameters: WhatsAppTemplateParam[]): Promise<boolean> {
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

    logger.info(`WhatsApp template "${templateName}" sent to ${fullPhone}`, {
      messageId: result?.messages?.[0]?.id,
    })

    return true
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
  return sendTemplateMessage(phone, 'receipt_link', [
    { type: 'text', text: data.venueName },
    { type: 'text', text: data.totalAmount },
    { type: 'text', text: data.receiptUrl },
  ])
}

/**
 * Send purchase confirmation via WhatsApp
 * Template: purchase_confirmation — params: {{1}}=name, {{2}}=venue, {{3}}=amount
 */
export async function sendPurchaseConfirmationWhatsApp(phone: string, data: WhatsAppPurchaseConfirmationData): Promise<boolean> {
  return sendTemplateMessage(phone, 'purchase_confirmation', [
    { type: 'text', text: data.customerName },
    { type: 'text', text: data.venueName },
    { type: 'text', text: data.amount },
  ])
}

/**
 * Send reservation confirmation via WhatsApp
 * Template: reservation_confirmation — params: {{1}}=name, {{2}}=venue, {{3}}=date, {{4}}=time
 */
export async function sendReservationConfirmationWhatsApp(phone: string, data: WhatsAppReservationData): Promise<boolean> {
  return sendTemplateMessage(phone, 'reservation_confirmation', [
    { type: 'text', text: data.customerName },
    { type: 'text', text: data.venueName },
    { type: 'text', text: data.date },
    { type: 'text', text: data.time },
  ])
}

/**
 * Send reservation reminder via WhatsApp
 * Template: reservation_reminder — params: {{1}}=name, {{2}}=venue, {{3}}=date, {{4}}=time
 */
export async function sendReservationReminderWhatsApp(phone: string, data: WhatsAppReservationData): Promise<boolean> {
  return sendTemplateMessage(phone, 'reservation_reminder', [
    { type: 'text', text: data.customerName },
    { type: 'text', text: data.venueName },
    { type: 'text', text: data.date },
    { type: 'text', text: data.time },
  ])
}

/**
 * Send order status update via WhatsApp
 * Template: order_status_update — params: {{1}}=name, {{2}}=venue, {{3}}=status
 */
export async function sendOrderStatusUpdateWhatsApp(phone: string, data: WhatsAppOrderStatusData): Promise<boolean> {
  return sendTemplateMessage(phone, 'order_status_update', [
    { type: 'text', text: data.customerName },
    { type: 'text', text: data.venueName },
    { type: 'text', text: data.status },
  ])
}
