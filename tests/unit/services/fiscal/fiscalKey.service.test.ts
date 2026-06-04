import { encryptProviderKey, decryptProviderKey } from '../../../../src/services/fiscal/fiscalKey.service'

describe('fiscalKey.service', () => {
  const KEY = 'a'.repeat(64) // 32-byte hex
  beforeAll(() => {
    process.env.FISCAL_PROVIDER_KEY = KEY
  })

  it('round-trips a provider key through encrypt/decrypt', () => {
    const enc = encryptProviderKey('sk_live_secret123')
    expect(enc).not.toContain('sk_live_secret123') // stored ciphertext, not plaintext
    expect(decryptProviderKey(enc)).toBe('sk_live_secret123')
  })

  it('throws if FISCAL_PROVIDER_KEY is missing', () => {
    delete process.env.FISCAL_PROVIDER_KEY
    expect(() => encryptProviderKey('x')).toThrow()
    process.env.FISCAL_PROVIDER_KEY = KEY
  })
})
