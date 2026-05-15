/**
 * GoogleCalendarTokenEncryption — AES-256-GCM helper tests
 *
 * Covers:
 *  - Round-trip encryption / decryption of refresh tokens
 *  - Random IV per call (different ciphertexts for same plaintext)
 *  - Tamper detection (auth tag rejects bit-flips)
 *  - Required env var validation
 */
import { encryptToken, decryptToken } from '@/services/google-calendar/encryption.service'

describe('GoogleCalendarTokenEncryption', () => {
  const originalKey = process.env.GOOGLE_CALENDAR_TOKEN_KEY

  beforeAll(() => {
    process.env.GOOGLE_CALENDAR_TOKEN_KEY = 'a'.repeat(64) // 32-byte hex
  })

  afterAll(() => {
    if (originalKey === undefined) {
      delete process.env.GOOGLE_CALENDAR_TOKEN_KEY
    } else {
      process.env.GOOGLE_CALENDAR_TOKEN_KEY = originalKey
    }
  })

  it('round-trips a plaintext refresh token', () => {
    const plaintext = '1//0g_some_long_google_refresh_token_xyz'
    const ct = encryptToken(plaintext)
    expect(ct).toBeInstanceOf(Buffer)
    expect(ct.length).toBeGreaterThan(plaintext.length) // IV + tag + ciphertext
    expect(decryptToken(ct)).toBe(plaintext)
  })

  it('produces different ciphertexts for the same plaintext (random IV)', () => {
    const plaintext = 'same-token'
    expect(encryptToken(plaintext).toString('hex')).not.toBe(encryptToken(plaintext).toString('hex'))
  })

  it('throws on tampered ciphertext', () => {
    const ct = encryptToken('hello')
    ct[ct.length - 1] ^= 0xff // flip last byte (auth tag region)
    expect(() => decryptToken(ct)).toThrow()
  })

  it('throws if GOOGLE_CALENDAR_TOKEN_KEY missing', () => {
    delete process.env.GOOGLE_CALENDAR_TOKEN_KEY
    expect(() => encryptToken('x')).toThrow(/GOOGLE_CALENDAR_TOKEN_KEY/)
    process.env.GOOGLE_CALENDAR_TOKEN_KEY = 'a'.repeat(64)
  })
})
