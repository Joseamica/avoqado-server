import { createTokenCipher } from '../../lib/token-encryption'

// Lazy: createTokenCipher reads process.env[name] on each call, so a single instance is fine.
const cipher = createTokenCipher('FISCAL_PROVIDER_KEY')

/** Encrypt a facturapi per-org secret key for storage in FiscalEmisor.providerKeyEnc (base64). */
export function encryptProviderKey(plaintext: string): string {
  return cipher.encryptToBase64(plaintext)
}

/** Decrypt FiscalEmisor.providerKeyEnc back to the facturapi secret key. */
export function decryptProviderKey(encBase64: string): string {
  return cipher.decryptFromBase64(encBase64)
}
