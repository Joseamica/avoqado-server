import crypto from 'crypto'
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

/** Callback OAuth: HMAC-SHA256 en hex de `k=v&…` ordenado, sin `hmac` ni `signature`. */
export function verifyOAuthQueryHmac(query: Record<string, string>, secret: string): boolean {
  const recibido = query.hmac
  if (!recibido || !/^[0-9a-f]{64}$/i.test(recibido)) return false
  const msg = Object.keys(query)
    .filter(k => k !== 'hmac' && k !== 'signature')
    .sort()
    .map(k => `${k}=${query[k]}`)
    .join('&')
  return iguales(Buffer.from(recibido, 'hex'), crypto.createHmac('sha256', secret).update(msg).digest())
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
