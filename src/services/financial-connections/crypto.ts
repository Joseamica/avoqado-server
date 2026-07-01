import { createTokenCipher, type TokenCipher } from '@/lib/token-encryption'

// Lazy: no cifra al boot; falla cerrada la PRIMERA vez que se use sin la llave.
let _cipher: TokenCipher | null = null
function cipher(): TokenCipher {
  return (_cipher ??= createTokenCipher('FINANCIAL_CONNECTION_KEY'))
}

/** Cifra un grant (p.ej. { refreshToken, expiresAt }) a base64 AES-256-GCM. */
export function encryptGrant(grant: unknown): string {
  return cipher().encryptToBase64(JSON.stringify(grant))
}

/** Descifra un grant. Lanza si la llave/formato no cuadran. */
export function decryptGrant<T = any>(enc: string): T {
  return JSON.parse(cipher().decryptFromBase64(enc)) as T
}
