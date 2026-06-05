import crypto from 'crypto'

/** 6-digit numeric OTP, uniform across 000000–999999. */
export function generateOtpCode(): string {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0')
}

/** sha256(code + pepper). Pepper is a server secret. */
export function hashOtpCode(code: string): string {
  const pepper = process.env.OTP_PEPPER
  if (!pepper) throw new Error('OTP_PEPPER no está configurado')
  return crypto.createHash('sha256').update(`${code}:${pepper}`).digest('hex')
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}
