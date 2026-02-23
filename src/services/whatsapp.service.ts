/**
 * WhatsApp Business API Service
 *
 * Sends messages via Meta Cloud API (WhatsApp Business).
 * Uses pre-approved message templates for transactional messages.
 *
 * Prerequisites:
 * 1. Meta Business Manager account
 * 2. WhatsApp Business API configured
 * 3. Approved message template "receipt_link" in es_MX
 * 4. Environment variables: WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_ACCESS_TOKEN
 */

import logger from '@/config/logger'

const WHATSAPP_API_URL = 'https://graph.facebook.com/v21.0'

interface WhatsAppReceiptData {
  venueName: string
  totalAmount: string
  receiptUrl: string
}

/**
 * Send a receipt link via WhatsApp Business API.
 * Uses the "receipt_link" template with parameters: venue name, total, receipt URL.
 *
 * @param phone - Phone number with country code (e.g., "521234567890")
 * @param data - Receipt data for the template
 * @returns true if message was sent successfully
 */
export async function sendReceiptWhatsApp(phone: string, data: WhatsAppReceiptData): Promise<boolean> {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN

  if (!phoneNumberId || !accessToken) {
    logger.warn('WhatsApp Business API not configured. Set WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN.')
    throw new Error('WhatsApp Business API no está configurado')
  }

  // Clean phone number - remove spaces, dashes, parentheses
  const cleanPhone = phone.replace(/[\s\-\(\)]/g, '')

  // Ensure phone has country code (default to Mexico +52)
  const fullPhone = cleanPhone.startsWith('+') ? cleanPhone.replace('+', '') : cleanPhone.length === 10 ? `52${cleanPhone}` : cleanPhone

  const url = `${WHATSAPP_API_URL}/${phoneNumberId}/messages`

  const body = {
    messaging_product: 'whatsapp',
    to: fullPhone,
    type: 'template',
    template: {
      name: 'receipt_link',
      language: {
        code: 'es_MX',
      },
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: data.venueName },
            { type: 'text', text: data.totalAmount },
            { type: 'text', text: data.receiptUrl },
          ],
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
      logger.error(`WhatsApp API error: ${errorMsg}`, { phone: fullPhone, status: response.status })
      throw new Error(`Error al enviar WhatsApp: ${errorMsg}`)
    }

    logger.info(`WhatsApp receipt sent to ${fullPhone}`, {
      messageId: result?.messages?.[0]?.id,
      venueName: data.venueName,
    })

    return true
  } catch (error) {
    if ((error as Error).message.startsWith('Error al enviar')) {
      throw error
    }
    logger.error(`WhatsApp send failed: ${(error as Error).message}`, { phone: fullPhone })
    throw new Error(`No se pudo enviar el mensaje de WhatsApp: ${(error as Error).message}`)
  }
}
