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

// Formatos mexicanos viejos que libphonenumber ya no acepta: `+521`/`521` (celular) y `044`/`045` (marcación a celular),
// seguidos de los 10 dígitos. Se reescriben a `+52` + 10 dígitos; lo demás se deja como venía.
function sinPrefijoMexicanoViejo(input: string): string {
  const digits = input.replace(/\D/g, '')
  return /^(521|04[45])\d{10}$/.test(digits) ? `+52${digits.slice(3)}` : input
}

// True when a and b are the same phone number: E.164 idéntico tras convertir los formatos mexicanos viejos. 🔴 Si un lado no
// se entiende, NO empata (auditoría 2026-10-01): comparar sólo los últimos 10 dígitos le daba a un `+1 551…` la cuenta de un
// `+521 55…`. `phoneLast10` sigue sirviendo como prefiltro SQL. Returns false if either side is empty.
export function phonesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  const na = normalizePhoneE164(sinPrefijoMexicanoViejo(a))
  return !!na && na === normalizePhoneE164(sinPrefijoMexicanoViejo(b))
}
