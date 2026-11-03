import crypto from 'crypto'
import { ACCESS_TOKEN_SECRET, env } from '../config/env'

/**
 * La liga de baja de los correos de Avoqado (campañas del CRM, la prueba a sí mismo): una firma SIN estado atada a UN correo.
 * Mismo patrón que `customerActionToken.ts`.
 *
 * - La llave se DERIVA de `ACCESS_TOKEN_SECRET` con una etiqueta propia, así que el token de baja de un cliente o de un staff
 *   nunca vale aquí (ni al revés), y no hace falta otra variable de entorno.
 * - Atado a un propósito (`p: 'plat-unsub'`): sólo autoriza dar de baja ESE correo de los correos de Avoqado.
 * - No expira: las ligas de los correos viejos tienen que seguir sirviendo.
 * - Daño acotado: un token filtrado sólo da de baja una dirección (idempotente) y nada más.
 */
interface PlatformUnsubscribePayload {
  v: 1
  p: 'plat-unsub'
  em: string // correo, normalizado
}

const KEY_LABEL = 'avoqado-platform-unsub-v1'
/** Un correo cabe en 254 caracteres (RFC 5321): un token con más es basura aunque la firma cuadre. */
const MAX_EMAIL_LENGTH = 254

function key(): Buffer {
  return crypto.createHmac('sha256', ACCESS_TOKEN_SECRET).update(KEY_LABEL).digest()
}

function sign(b64Body: string): string {
  return crypto.createHmac('sha256', key()).update(b64Body).digest('base64url')
}

export function signPlatformUnsubscribeToken(email: string): string {
  const payload: PlatformUnsubscribePayload = { v: 1, p: 'plat-unsub', em: email.trim().toLowerCase() }
  const b64Body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${b64Body}.${sign(b64Body)}`
}

/**
 * Verifica y decodifica. Devuelve null ante cualquier cosa mal formada, alterada o de otro propósito. La firma se compara en
 * tiempo constante.
 */
export function verifyPlatformUnsubscribeToken(token: unknown): { email: string } | null {
  if (typeof token !== 'string') return null
  const dot = token.indexOf('.')
  if (dot <= 0 || dot === token.length - 1) return null

  const b64Body = token.slice(0, dot)
  const provided = Buffer.from(token.slice(dot + 1))
  const expected = Buffer.from(sign(b64Body))
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) return null

  let payload: PlatformUnsubscribePayload
  try {
    payload = JSON.parse(Buffer.from(b64Body, 'base64url').toString('utf-8'))
  } catch {
    return null
  }
  if (!payload || payload.v !== 1 || payload.p !== 'plat-unsub') return null
  if (typeof payload.em !== 'string' || !payload.em || payload.em.length > MAX_EMAIL_LENGTH) return null

  return { email: payload.em }
}

/** La liga que va en el pie y en la cabecera `List-Unsubscribe` de cada correo de Avoqado. */
export function platformUnsubscribeUrl(email: string): string {
  const base = (env.BASE_URL || 'https://api.avoqado.io').replace(/\/$/, '')
  return `${base}/api/v1/public/avoqado/unsubscribe?token=${encodeURIComponent(signPlatformUnsubscribeToken(email))}`
}
