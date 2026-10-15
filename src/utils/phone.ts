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

// Teléfono mexicano por defecto (spec 2026-10-14 §2). Lo usan los dos pasos del OTP (pedir y verificar) y la reparación de datos,
// así el reto, el Consumer y el Customer quedan con el MISMO valor. 10 dígitos (con o sin «+») ⇒ «+52» + 10; «52» + 10 ⇒ «+52…»;
// «521» + 10 ⇒ «+52» + los últimos 10; cualquier otro ⇒ «+» + dígitos (no se inventa lada). Sin dígitos ⇒ '' y quien llama decide.
export function normalizarTelefonoMx(input: string): string {
  const digitos = (input ?? '').replace(/\D/g, '')
  if (!digitos) return ''
  if (digitos.length === 10) return `+52${digitos}`
  if (digitos.length === 12 && digitos.startsWith('52')) return `+${digitos}`
  if (digitos.length === 13 && digitos.startsWith('521')) return `+52${digitos.slice(3)}`
  return `+${digitos}`
}

// Cómo guardaba el OTP viejo (antes del 14-oct-2026) un celular mexicano: «+» + 10 dígitos, sin lada. Sirve para encontrar al
// Consumer que ya existe en vez de crearle otro. `null` si `normalizado` no es un «+52» + 10.
export function formaLegadaDeTelefonoMx(normalizado: string): string | null {
  return /^\+52\d{10}$/.test(normalizado) ? `+${normalizado.slice(3)}` : null
}

// Formatos mexicanos viejos que libphonenumber ya no acepta: `+521`/`521` (celular) y `044`/`045` (marcación a celular),
// seguidos de los 10 dígitos. Se reescriben a `+52` + 10 dígitos; lo demás se deja como venía.
// 🔴 Y «+» + EXACTAMENTE 10 dígitos: es NUESTRO mal guardado (el OTP antes del 14-oct-2026 guardaba «'+' + dígitos» sin lada:
// 71 clientes y 73 consumidores en 4 negocios). En este mercado no es un E.164 extranjero real; se lee como celular mexicano.
// Existen E.164 válidos de 10 dígitos (Islandia: +354 + 7); si algún día se atiende ese mercado, esto se revisa. No abre una puerta:
// el OTP manda el código a `normalizarTelefonoMx(entrada)`, así que nadie recibe el código de un número que no es suyo.
function sinPrefijoMexicanoViejo(input: string): string {
  const limpio = input.trim()
  if (/^\+\d{10}$/.test(limpio)) return `+52${limpio.slice(1)}`
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
