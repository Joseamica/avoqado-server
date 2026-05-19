import { randomBytes } from 'crypto'

// 31 chars: A-Z minus I, L, O + 2-9 (drop 0, 1)
export const AMBIGUITY_SAFE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

// Generate a 4-character shortCode using a CSPRNG and the ambiguity-safe
// alphabet. Used as a human-readable session identifier in WhatsApp template
// variable {{3}}. Per spec §shortCode generation.
export function generateShortCode(): string {
  const bytes = randomBytes(4)
  let out = ''
  for (let i = 0; i < 4; i++) {
    out += AMBIGUITY_SAFE_ALPHABET[bytes[i] % AMBIGUITY_SAFE_ALPHABET.length]
  }
  return out
}
