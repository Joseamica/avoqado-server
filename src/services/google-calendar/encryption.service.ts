/**
 * AES-256-GCM token encryption helper for Google Calendar OAuth tokens.
 *
 * Encrypts the refresh token (long-lived) and access token (short-lived) at rest
 * before persisting them in Prisma as `Bytes`. The output layout is:
 *
 *   [ IV (12 bytes) | AuthTag (16 bytes) | Ciphertext (n bytes) ]
 *
 * Key is loaded from `GOOGLE_CALENDAR_TOKEN_KEY` (32-byte hex string).
 * ROTATE-SEPARATELY from `JWT_SECRET` — leaking this key compromises every
 * Google account a customer connected to Avoqado.
 */
import crypto from 'crypto'

const ALGO = 'aes-256-gcm'
const IV_LEN = 12
const TAG_LEN = 16

function getKey(): Buffer {
  const hex = process.env.GOOGLE_CALENDAR_TOKEN_KEY
  if (!hex || hex.length !== 64) {
    throw new Error('GOOGLE_CALENDAR_TOKEN_KEY missing or wrong length (expect 32-byte hex string)')
  }
  return Buffer.from(hex, 'hex')
}

export function encryptToken(plaintext: string): Buffer {
  const iv = crypto.randomBytes(IV_LEN)
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, ct])
}

export function decryptToken(blob: Buffer): string {
  const iv = blob.subarray(0, IV_LEN)
  const tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN)
  const ct = blob.subarray(IV_LEN + TAG_LEN)
  const decipher = crypto.createDecipheriv(ALGO, getKey(), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
}
