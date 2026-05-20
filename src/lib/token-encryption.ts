/**
 * AES-256-GCM token encryption helper, parametrized by env var name.
 *
 * Stored layout (Buffer):
 *   [ IV (12 bytes) | AuthTag (16 bytes) | Ciphertext (n bytes) ]
 *
 * Each consumer (Google Calendar, Mercado Pago, future OAuth integrations) has
 * its OWN key env var so leaks isolate per integration. Rotate keys
 * separately. Never reuse the same key across integrations.
 *
 * Usage:
 *   const cipher = createTokenCipher('MERCADO_PAGO_TOKEN_KEY')
 *   const blob = cipher.encrypt(refreshToken)  // → Buffer for Prisma Bytes column
 *   const b64  = cipher.encryptToBase64(token) // → string for JSON column
 *
 * The factory pattern reads `process.env[envKeyName]` lazily on each call —
 * tests can rotate env vars between calls without re-creating the cipher.
 */
import crypto from 'crypto'

const ALGO = 'aes-256-gcm'
const IV_LEN = 12
const TAG_LEN = 16

export interface TokenCipher {
  encrypt(plaintext: string): Buffer
  decrypt(blob: Buffer): string
  encryptToBase64(plaintext: string): string
  decryptFromBase64(b64: string): string
}

export function createTokenCipher(envKeyName: string): TokenCipher {
  function getKey(): Buffer {
    const hex = process.env[envKeyName]
    if (!hex || hex.length !== 64) {
      throw new Error(`${envKeyName} missing or wrong length (expect 32-byte hex string)`)
    }
    return Buffer.from(hex, 'hex')
  }

  const api: TokenCipher = {
    encrypt(plaintext) {
      const iv = crypto.randomBytes(IV_LEN)
      const cipher = crypto.createCipheriv(ALGO, getKey(), iv)
      const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
      const tag = cipher.getAuthTag()
      return Buffer.concat([iv, tag, ct])
    },
    decrypt(blob) {
      const iv = blob.subarray(0, IV_LEN)
      const tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN)
      const ct = blob.subarray(IV_LEN + TAG_LEN)
      const decipher = crypto.createDecipheriv(ALGO, getKey(), iv)
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
    },
    encryptToBase64(plaintext) {
      return api.encrypt(plaintext).toString('base64')
    },
    decryptFromBase64(b64) {
      return api.decrypt(Buffer.from(b64, 'base64'))
    },
  }
  return api
}
