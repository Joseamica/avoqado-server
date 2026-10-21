// src/services/giftCards/giftCardEntrega.ts
/**
 * Lo común de la entrega de tarjetas (1b): la liga de la página, LA forma del teléfono y los textos de fallo. Sin Prisma: lo
 * importan el servicio de entrega, la cuenta del POS, los reportes y el MCP.
 */
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
