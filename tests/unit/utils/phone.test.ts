import { canonicalPhoneE164, formaLegadaDeTelefonoMx, normalizePhoneE164, normalizarTelefonoMx, phoneLast10, phonesMatch } from '@/utils/phone'

// Lo que se GUARDA (y se compara en SQL) debe ser la misma forma que `phonesMatch` considera igual: si no, un `+521…` pasa la
// identidad y se guarda aparte del `+52…` de la misma persona (tope por teléfono partido en dos).
describe('canonicalPhoneE164', () => {
  it('convierte el formato mexicano viejo +521 a +52', () => {
    expect(canonicalPhoneE164('+5215543453965')).toBe('+525543453965')
  })

  it('deja igual un E.164 ya canónico', () => {
    expect(canonicalPhoneE164('+525543453965')).toBe('+525543453965')
  })

  it('devuelve null con basura', () => {
    expect(canonicalPhoneE164('not a phone')).toBeNull()
  })
})

describe('normalizePhoneE164', () => {
  it('normalizes 10-digit Mexican number', () => {
    expect(normalizePhoneE164('5512345678')).toBe('+525512345678')
  })

  it('keeps already-E164 numbers', () => {
    expect(normalizePhoneE164('+525512345678')).toBe('+525512345678')
  })

  it('strips spaces/dashes/parens', () => {
    expect(normalizePhoneE164('+52 55 1234 5678')).toBe('+525512345678')
    expect(normalizePhoneE164('(55) 1234-5678')).toBe('+525512345678')
  })

  it('handles US numbers correctly', () => {
    expect(normalizePhoneE164('+14155551234')).toBe('+14155551234')
  })

  it('returns null for invalid input', () => {
    expect(normalizePhoneE164('not a phone')).toBeNull()
    expect(normalizePhoneE164('')).toBeNull()
  })

  it('returns null for too-short numbers without country code', () => {
    expect(normalizePhoneE164('12345')).toBeNull()
  })
})

describe('phoneLast10', () => {
  it('returns the last 10 digits, stripping formatting', () => {
    expect(phoneLast10('+52 55 1234 5678')).toBe('5512345678')
    expect(phoneLast10('(55) 1234-5678')).toBe('5512345678')
    expect(phoneLast10('+14155551234')).toBe('4155551234')
  })

  it('returns null when fewer than 10 digits', () => {
    expect(phoneLast10('12345')).toBeNull()
    expect(phoneLast10('')).toBeNull()
  })
})

describe('phonesMatch', () => {
  it('matches two formats of the same Mexican number', () => {
    expect(phonesMatch('+525512345678', '55 1234 5678')).toBe(true)
    expect(phonesMatch('5512345678', '+52 (55) 1234-5678')).toBe(true)
  })

  it('does not match different numbers', () => {
    expect(phonesMatch('+525512345678', '+525599999999')).toBe(false)
  })

  it('returns false when either side is empty', () => {
    expect(phonesMatch('+525512345678', '')).toBe(false)
    expect(phonesMatch(null, '+525512345678')).toBe(false)
    expect(phonesMatch(undefined, undefined)).toBe(false)
  })

  // 🔴 Auditoría 2026-10-01: con un lado inválido se comparaban sólo los últimos 10 dígitos, así que un `+1 551…` (válido, del
  // atacante) se quedaba con la cuenta de un `+521 55…` (formato viejo, de la víctima). Ahora: formatos viejos convertidos y
  // E.164 idéntico; lo que no se entiende no empata con nada.
  it('los formatos mexicanos viejos (+521, 044, 045) siguen encontrando a su dueño', () => {
    expect(phonesMatch('+5215512345678', '+525512345678')).toBe(true)
    expect(phonesMatch('521 55 1234 5678', '+525512345678')).toBe(true)
    expect(phonesMatch('044 55 1234 5678', '+525512345678')).toBe(true)
    expect(phonesMatch('045 (55) 1234-5678', '+525512345678')).toBe(true)
  })

  it('un número de otro país con los mismos 10 dígitos NO empata con un formato mexicano viejo', () => {
    expect(phonesMatch('+5215512345678', '+15512345678')).toBe(false)
  })

  it('un número que no se entiende no empata con nada (falla cerrada)', () => {
    expect(phonesMatch('5512345678', '99-5512345678')).toBe(false)
  })
  // Addendum 14-oct: «+» + 10 dígitos es NUESTRO mal guardado del OTP viejo, no un número extranjero.
  it('«+» + 10 dígitos (OTP viejo) es el mismo celular mexicano', () => {
    expect(phonesMatch('+5544422262', '5544422262')).toBe(true)
    expect(phonesMatch('+5544422262', '+525544422262')).toBe(true)
    expect(phonesMatch('+5543453965', '+52 55 4345 3965')).toBe(true)
  })

  it('regresión: lo que hoy NO empata sigue sin empatar (medido el 14-oct)', () => {
    // Hoy: '+14155550100' → +14155550100 y '4155550100' → +524155550100 (lada 415 es válida en México): distintos.
    expect(phonesMatch('+14155550100', '4155550100')).toBe(false)
    expect(phonesMatch('+14155550100', '+14155550100')).toBe(true)
    // «+» + 11 dígitos no se toca: un +1 sigue siendo de EE. UU.
    expect(phonesMatch('+15512345678', '+525512345678')).toBe(false)
  })
})

/**
 * Teléfono mexicano por defecto (spec 2026-10-14 §2). El OTP guardaba `'+' + dígitos`: 40 de 41 clientes de Testarudo
 * quedaron como `+5543453965` (sin lada) y ya hay un duplicado `+8129440042` / `+528129440042`.
 */
describe('normalizarTelefonoMx', () => {
  it.each([
    ['5543453965', '+525543453965'],
    ['+5543453965', '+525543453965'],
    ['55 4345 3965', '+525543453965'],
    ['+52 55 4345 3965', '+525543453965'],
    ['525543453965', '+525543453965'],
    ['+52 1 55 4345 3965', '+525543453965'],
    ['5215543453965', '+525543453965'],
    ['(55) 4345-3965', '+525543453965'],
    ['+1 415 555 0100', '+14155550100'],
    ['', ''],
    ['abc', ''],
  ])('%p ⇒ %p', (entrada, esperado) => {
    expect(normalizarTelefonoMx(entrada)).toBe(esperado)
  })

  it('regresión: lo que no es mexicano se deja como «+» + dígitos (no se inventa lada)', () => {
    expect(normalizarTelefonoMx('+44 20 7946 0958')).toBe('+442079460958')
    expect(normalizarTelefonoMx('12345')).toBe('+12345')
  })
})

describe('formaLegadaDeTelefonoMx', () => {
  it('da la forma sin lada que guardaba el OTP viejo', () => {
    expect(formaLegadaDeTelefonoMx('+525543453965')).toBe('+5543453965')
  })
  it('null si no es un +52 de 10 dígitos', () => {
    expect(formaLegadaDeTelefonoMx('+14155550100')).toBeNull()
    expect(formaLegadaDeTelefonoMx('')).toBeNull()
  })
})
