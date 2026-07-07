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

// Trailing 10 digits of a phone string (national significant number for MX/US),
// used as a cheap, format-agnostic coarse filter before a canonical verify.
// Returns null when the input has fewer than 10 digits.
export function phoneLast10(input: string): string | null {
  const digits = (input ?? '').replace(/\D/g, '')
  return digits.length >= 10 ? digits.slice(-10) : null
}

// True when a and b are the same phone number. Prefers canonical E.164 equality
// (via normalizePhoneE164); when one side can't be parsed to a valid E.164
// number (messy historical/guest-typed data), falls back to comparing the last
// 10 digits. Returns false if either side is empty.
export function phonesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  const na = normalizePhoneE164(a)
  const nb = normalizePhoneE164(b)
  if (na && nb) return na === nb
  const la = phoneLast10(a)
  const lb = phoneLast10(b)
  return !!la && la === lb
}
