import crypto from 'crypto'

/**
 * Header HMAC de Deliverect sobre el body crudo del webhook de órdenes.
 * Doc: https://developers.deliverect.com/reference/hmac-authentication
 *
 * Fix C1 (auditoría G-Stack + Codex, 2026-07-19, spec §10.1.1): el scaffold
 * asumió `x-deliverect-hmac-sha256` + base64 — la doc real confirma
 * `x-server-authorization-hmac-sha256` + HEX. Con el valor viejo, TODO
 * webhook auténtico de Deliverect se rechazaba con 401 (timingSafeEqual no
 * salva comparar la representación equivocada — length casi siempre difiere
 * entre base64 y hex del mismo digest de 32 bytes).
 */
export const DELIVERECT_HMAC_HEADER = 'x-server-authorization-hmac-sha256'

export function verifyDeliverectHmac(rawBody: Buffer, headerValue: string | undefined, secret: string): boolean {
  if (!headerValue) return false
  // REVALIDAR EN STAGING: el secreto real lo entrega Deliverect en el onboarding
  // (identificador de location/integración), no el random por-link que genera hoy
  // `deliveryChannelLink.service.ts` (createChannelLink) — fuera del scope de este
  // fix (archivo no tocado aquí). Este verify es agnóstico al origen del secreto:
  // solo exige que `secret` sea EXACTAMENTE el valor que Deliverect usó para firmar.
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
  const a = Buffer.from(expected)
  const b = Buffer.from(headerValue)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}
