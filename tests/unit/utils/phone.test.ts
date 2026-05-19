import { normalizePhoneE164 } from '@/utils/phone'

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
