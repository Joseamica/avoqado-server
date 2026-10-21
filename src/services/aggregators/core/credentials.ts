import crypto from 'crypto'
import { createTokenCipher } from '@/lib/token-encryption'

/** Llave propia del conector: si se filtra, sólo afecta a las credenciales de los proveedores de pases. */
const cipher = () => createTokenCipher('AGGREGATOR_TOKEN_KEY')

/** Cifra la llave de la sucursal (columna Bytes). Nunca se loguea el texto plano. */
export function encryptCredential(plain: string): Buffer {
  return cipher().encrypt(plain)
}

export function decryptCredential(blob: Buffer | Uint8Array | null): string | null {
  if (!blob) return null
  return cipher().decrypt(Buffer.from(blob))
}

/** 32 bytes aleatorios: el proveedor no firma sus webhooks, así que la URL ES el secreto. */
export function newWebhookToken(): string {
  return crypto.randomBytes(32).toString('base64url')
}

/** Comparación en tiempo constante; con largos distintos devuelve false sin llamar a timingSafeEqual (que truena). */
export function tokensEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb)
}
