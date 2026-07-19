import crypto from 'crypto'

/**
 * Header HMAC de Deliverect sobre el body crudo del webhook de órdenes.
 * Doc: developers.deliverect.com/docs/validating-orders-in-pos-using-hmac
 * REVALIDAR EN STAGING: nombre exacto del header y encoding (base64 asumido).
 */
export const DELIVERECT_HMAC_HEADER = 'x-deliverect-hmac-sha256'

export function verifyDeliverectHmac(rawBody: Buffer, headerValue: string | undefined, secret: string): boolean {
  if (!headerValue) return false
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('base64')
  const a = Buffer.from(expected)
  const b = Buffer.from(headerValue)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}
