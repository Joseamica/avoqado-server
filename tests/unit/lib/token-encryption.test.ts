import { createTokenCipher } from '@/lib/token-encryption'

describe('createTokenCipher', () => {
  const cipher = createTokenCipher('MERCADO_PAGO_TOKEN_KEY')

  it('roundtrips a token through encrypt → decrypt', () => {
    const plaintext = 'APP_USR-1234567890abcdef-mp-access-token'
    const blob = cipher.encrypt(plaintext)
    expect(blob).toBeInstanceOf(Buffer)
    expect(cipher.decrypt(blob)).toBe(plaintext)
  })

  it('produces different ciphertext on each call (random IV)', () => {
    const a = cipher.encrypt('same input')
    const b = cipher.encrypt('same input')
    expect(a.equals(b)).toBe(false)
    expect(cipher.decrypt(a)).toBe('same input')
    expect(cipher.decrypt(b)).toBe('same input')
  })

  it('throws when authTag is tampered', () => {
    const blob = cipher.encrypt('secret')
    // Flip a byte inside the auth tag (offsets 12..27)
    blob[15] = blob[15] ^ 0x01
    expect(() => cipher.decrypt(blob)).toThrow()
  })

  it('throws when the configured env key is missing or wrong length', () => {
    const broken = createTokenCipher('NONEXISTENT_KEY_FOR_TEST')
    expect(() => broken.encrypt('x')).toThrow(/NONEXISTENT_KEY_FOR_TEST/)
  })

  it('base64 helpers roundtrip', () => {
    const b64 = cipher.encryptToBase64('token-value')
    expect(typeof b64).toBe('string')
    expect(cipher.decryptFromBase64(b64)).toBe('token-value')
  })

  it('isolates keys per env var (different keys → cannot cross-decrypt)', () => {
    process.env.OTHER_TEST_KEY = '1111111111111111111111111111111111111111111111111111111111111111'
    const a = createTokenCipher('MERCADO_PAGO_TOKEN_KEY')
    const b = createTokenCipher('OTHER_TEST_KEY')
    const blob = a.encrypt('hello')
    expect(() => b.decrypt(blob)).toThrow()
    delete process.env.OTHER_TEST_KEY
  })

  it('payload layout is [IV(12) | AuthTag(16) | Ciphertext(n)]', () => {
    const blob = cipher.encrypt('hi')
    // Minimum length = 12 (IV) + 16 (tag) + 0 (ciphertext for empty) — must be at least 28
    expect(blob.length).toBeGreaterThanOrEqual(28)
  })
})
