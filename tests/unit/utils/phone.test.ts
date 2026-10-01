import { normalizePhoneE164, phoneLast10, phonesMatch } from '@/utils/phone'

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
})
