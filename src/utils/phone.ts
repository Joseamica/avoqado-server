import { parsePhoneNumberFromString } from 'libphonenumber-js'

// Normalize a phone string to E.164 format (e.g. "+525512345678").
// 10-digit numbers without a country code default to Mexico (+52).
// Returns null if the input cannot be parsed as a valid phone number.
export function normalizePhoneE164(input: string): string | null {
  if (!input) return null
  const cleaned = input.replace(/[\s\-()]/g, '')
  const parsed = parsePhoneNumberFromString(cleaned, 'MX')
  if (!parsed || !parsed.isValid()) return null
  return parsed.format('E.164')
}
