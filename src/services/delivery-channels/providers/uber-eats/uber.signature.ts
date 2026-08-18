/**
 * X-Uber-Signature — HMAC-SHA256 hex del body CRUDO (spec paso 3).
 *
 * `timingSafeEqual` tras validar longitud y charset, mismo patrón que
 * `deliverect.hmac.ts` (que NO se toca — Deliverect congelado).
 *
 * 🔴 La LLAVE llega por parámetro a propósito: su origen es un supuesto ABIERTO
 * de la spec — el dashboard de Uber exige una "Signing Key" dedicada al dar de
 * alta el webhook con Basic HMAC, mientras su documentación pública sigue
 * diciendo client secret. Este módulo no decide cuál: lo resuelve el primer
 * webhook real, guardando su body crudo + firma como fixture de contrato.
 */
import crypto from 'crypto'

const HEX_64 = /^[0-9a-f]{64}$/

export function verifyUberSignature(rawBody: Buffer, headerValue: string | undefined, signingKey: string): boolean {
  if (!headerValue || !signingKey || !Buffer.isBuffer(rawBody)) return false

  const esperado = crypto.createHmac('sha256', signingKey).update(rawBody).digest('hex')
  const recibido = headerValue.trim().toLowerCase()

  if (recibido.length !== esperado.length || !HEX_64.test(recibido)) return false
  return crypto.timingSafeEqual(Buffer.from(recibido, 'hex'), Buffer.from(esperado, 'hex'))
}
