import { randomBytes, createHash, timingSafeEqual } from 'crypto'

// 32 bytes of CSPRNG -> base64url (43 chars). Per spec §Session access token.
export function generateAccessToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashAccessToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

// Constant-time comparison.
export function verifyAccessToken(presented: string, storedHash: string): boolean {
  const presentedHash = hashAccessToken(presented)
  const a = Buffer.from(presentedHash, 'hex')
  const b = Buffer.from(storedHash, 'hex')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
