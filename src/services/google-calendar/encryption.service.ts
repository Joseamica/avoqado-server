/**
 * Google Calendar token encryption — thin wrapper around the generalized
 * AES-256-GCM helper.
 *
 * Encrypts the refresh token (long-lived) and access token (short-lived) at
 * rest before persisting them in Prisma as `Bytes`. The output layout is:
 *
 *   [ IV (12 bytes) | AuthTag (16 bytes) | Ciphertext (n bytes) ]
 *
 * Key is loaded from `GOOGLE_CALENDAR_TOKEN_KEY` (32-byte hex string).
 * ROTATE-SEPARATELY from `JWT_SECRET`, `MERCADO_PAGO_TOKEN_KEY`, and any
 * future OAuth integration keys. Leaking this key compromises every Google
 * account a customer connected to Avoqado.
 *
 * New code should `import { createTokenCipher }` from `@/lib/token-encryption`
 * directly. The `encryptToken` / `decryptToken` exports are kept for backward
 * compatibility with existing callers.
 */
import { createTokenCipher } from '@/lib/token-encryption'

const cipher = createTokenCipher('GOOGLE_CALENDAR_TOKEN_KEY')

export const encryptToken = cipher.encrypt
export const decryptToken = cipher.decrypt
