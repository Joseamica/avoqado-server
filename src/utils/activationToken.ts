import { randomBytes, createHash } from 'crypto'
import { AMBIGUITY_SAFE_ALPHABET } from './shortCode'

// 12-char activation token from CSPRNG + ambiguity-safe alphabet
// (31^12 ≈ 7.9×10^17 distinct values).
export function generateActivationToken(): string {
  const bytes = randomBytes(12)
  let out = ''
  for (let i = 0; i < 12; i++) {
    out += AMBIGUITY_SAFE_ALPHABET[bytes[i] % AMBIGUITY_SAFE_ALPHABET.length]
  }
  return out
}

export function hashActivationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function last4(token: string): string {
  return token.slice(-4)
}
