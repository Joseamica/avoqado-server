import crypto from 'crypto'
import logger from '@/config/logger'
import { createTokenCipher } from '@/lib/token-encryption'

// `process.env` y no `@/config/env`: importar `env` en una prueba hace `process.exit` si falta algo
// (.claude/rules/contexto-de-ejecucion.md). Mismo patrón que `aggregators/core/credentials.ts`.
export function appCredentials(appKey: 'PILOTO' | 'PUBLICA'): { clientId: string; clientSecret: string } | null {
  const clientId = appKey === 'PILOTO' ? process.env.SHOPIFY_PILOTO_CLIENT_ID : process.env.SHOPIFY_PUBLICA_CLIENT_ID
  const clientSecret = appKey === 'PILOTO' ? process.env.SHOPIFY_PILOTO_CLIENT_SECRET : process.env.SHOPIFY_PUBLICA_CLIENT_SECRET
  return clientId && clientSecret ? { clientId, clientSecret } : null
}

function iguales(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b)
}

/** Webhooks: HMAC-SHA256 del cuerpo CRUDO, en base64 (header X-Shopify-Hmac-Sha256). */
export function verifyWebhookHmac(rawBody: Buffer, header: string | undefined, secret: string): boolean {
  if (!header || !secret || !Buffer.isBuffer(rawBody)) return false
  const esperado = crypto.createHmac('sha256', secret).update(rawBody).digest()
  return iguales(Buffer.from(header.trim(), 'base64'), esperado)
}

export type FormaDeFirmaOAuth = 'codificada' | 'decodificada'

/**
 * Callback OAuth: HMAC-SHA256 en hex de `k=v&…` ordenado, sin `hmac` ni `signature`. Se acepta en DOS formas (L1): la de
 * la biblioteca oficial de Shopify (valores codificados con `URLSearchParams`, `+` → `%20`) y la unión decodificada del
 * ejemplo de su doc. Las dos exigen el secreto; un `host` terminado en `==` sólo cuadra en la primera. Un valor que no es
 * texto (parámetro repetido ⇒ arreglo) no es algo que Shopify haya firmado: se rechaza.
 */
export function formaDeFirmaOAuth(query: Record<string, unknown>, secret: string): FormaDeFirmaOAuth | null {
  const recibido = query.hmac
  if (typeof recibido !== 'string' || !/^[0-9a-f]{64}$/i.test(recibido) || !secret) return null
  if (!Object.values(query).every(v => typeof v === 'string')) return null
  const pares = Object.keys(query)
    .filter(k => k !== 'hmac' && k !== 'signature')
    .sort()
    .map(k => [k, query[k] as string])
  const firma = Buffer.from(recibido, 'hex')
  const cuadra = (msg: string) => iguales(firma, crypto.createHmac('sha256', secret).update(msg).digest())
  if (cuadra(new URLSearchParams(pares).toString().replace(/\+/g, '%20'))) return 'codificada'
  if (cuadra(pares.map(([k, v]) => `${k}=${v}`).join('&'))) return 'decodificada'
  return null
}

export function verifyOAuthQueryHmac(query: Record<string, string>, secret: string): boolean {
  const forma = formaDeFirmaOAuth(query, secret)
  // C10: en el sandbox se mira qué forma usa Shopify de verdad. Sólo la forma: nunca el hmac ni el secreto.
  if (forma) logger.info(`[SHOPIFY] callback OAuth: firma válida en la forma ${forma}`)
  return forma !== null
}

export function isValidShopDomain(shop: string): boolean {
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)
}

const cipher = () => createTokenCipher('SHOPIFY_TOKEN_KEY')
export const encryptShopifyToken = (plain: string): Uint8Array => new Uint8Array(cipher().encrypt(plain))
export const decryptShopifyToken = (blob: Uint8Array | Buffer): string => cipher().decrypt(Buffer.from(blob))

const firma = (id: string) =>
  crypto
    .createHmac('sha256', process.env.OAUTH_STATE_SECRET ?? '')
    .update(`shopify-intent:${id}`)
    .digest('hex')
export function signIntentId(id: string): string {
  if (!process.env.OAUTH_STATE_SECRET) throw new Error('Falta OAUTH_STATE_SECRET')
  return `${id}.${firma(id)}`
}
export function readIntentId(signed: string): string | null {
  const [id, sig] = signed.split('.')
  if (!id || !sig || !process.env.OAUTH_STATE_SECRET) return null
  return iguales(Buffer.from(sig, 'hex'), Buffer.from(firma(id), 'hex')) ? id : null
}

export const toGid = (kind: string, id: number | string): string => `gid://shopify/${kind}/${id}`
