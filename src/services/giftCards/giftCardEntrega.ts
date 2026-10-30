// src/services/giftCards/giftCardEntrega.ts
/**
 * Lo común de la entrega de tarjetas (1b): la liga de la página, LA forma del teléfono y los textos de fallo. Sin Prisma: lo
 * importan el servicio de entrega, la cuenta del POS, los reportes y el MCP.
 */
import type { GiftCardDeliveryChannel } from '@prisma/client'
import { canonicalPhoneE164 } from '@/utils/phone'

/** Q22, S-12: la liga pública de la tarjeta. Las apps la imprimen y la comparten tal cual; nunca arman el host. */
export function urlDeLaPagina(pageToken: string): string {
  return `${(process.env.GIFT_CARD_PAGE_BASE_URL || 'https://pay.avoqado.io').replace(/\/+$/, '')}/tarjeta/${pageToken}`
}

/** Q25: LA forma con que se guarda `recipientPhone` y con que se compara en phone/* (= canonicalPhoneE164). null = no se entiende. */
export function telefonoDeTarjeta(raw: string | null | undefined): string | null {
  return raw ? canonicalPhoneE164(raw) : null
}

/** S-7: la base guarda el CÓDIGO del fallo (`GiftCard.deliveryErrorCode`); el texto se arma al responder. */
export type CodigoDeFalloDeEntrega =
  | 'TEMPLATE_NOT_AVAILABLE'
  | 'WHATSAPP_SEND_FAILED'
  | 'WHATSAPP_UNDELIVERED'
  | 'EMAIL_SEND_FAILED'
  | 'EMAIL_INVALID_ADDRESS'
  | 'UNCONFIRMED'

export const TEXTO_DE_FALLO_DE_ENTREGA: Readonly<Record<CodigoDeFalloDeEntrega, string>> = {
  TEMPLATE_NOT_AVAILABLE: 'WhatsApp todavía no está disponible para tarjetas; imprímela, mándala por correo o enseña la liga.',
  WHATSAPP_SEND_FAILED: 'No se pudo enviar por WhatsApp. Reenvíala, cambia el destino o imprímela.',
  WHATSAPP_UNDELIVERED: 'WhatsApp no pudo entregar el mensaje. Reenvíala, cambia el destino o imprímela.',
  EMAIL_SEND_FAILED: 'No se pudo enviar el correo. Reenvíala, cambia el destino o imprímela.',
  EMAIL_INVALID_ADDRESS: 'No se pudo mandar el correo a esa dirección. Revisa el correo, cambia el destino o imprímela.',
  UNCONFIRMED: 'No se pudo confirmar el envío. Reenvíala o imprímela.',
}

const TEXTO_DE_FALLO_GENERICO = 'No se pudo entregar la tarjeta. Reenvíala, cambia el destino o imprímela.'

/** Un código desconocido (escrito por una versión más nueva) da un texto genérico, nunca `undefined`. */
export function textoDeFalloDeEntrega(code: string | null): string | null {
  if (code == null) return null
  return Object.prototype.hasOwnProperty.call(TEXTO_DE_FALLO_DE_ENTREGA, code)
    ? TEXTO_DE_FALLO_DE_ENTREGA[code as CodigoDeFalloDeEntrega]
    : TEXTO_DE_FALLO_GENERICO
}

/**
 * S4: el destino que se ENSEÑA (POS, panel, bitácora), nunca el completo. Teléfono: sus últimos 10 dígitos con los 2 primeros y
 * los 3 últimos ('+525512345678' ⇒ '55•••••678'); correo: la primera letra y el dominio ('ana@gmail.com' ⇒ 'a•••@gmail.com').
 * Impresa o en mano no tiene destino. Un dato tan corto que el patrón lo enseñaría entero sale todo tapado.
 */
export function enmascararDestino(t: {
  deliveryChannel: GiftCardDeliveryChannel
  recipientPhone: string | null
  recipientEmail: string | null
}): string | null {
  if (t.deliveryChannel === 'WHATSAPP') {
    const d = (t.recipientPhone ?? '').replace(/\D/g, '').slice(-10)
    if (!d) return null
    return d.length < 6 ? '•'.repeat(d.length) : `${d.slice(0, 2)}${'•'.repeat(d.length - 5)}${d.slice(-3)}`
  }
  if (t.deliveryChannel === 'EMAIL') {
    const correo = t.recipientEmail?.trim() ?? ''
    const arroba = correo.lastIndexOf('@')
    if (!correo) return null
    return arroba < 1 ? '•••' : `${correo[0]}•••${correo.slice(arroba)}`
  }
  return null
}
