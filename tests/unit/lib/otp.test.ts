import { generateOtpCode, hashOtpCode, normalizeEmail } from '@/lib/otp'

describe('otp helpers', () => {
  it('generateOtpCode returns a 6-digit numeric string', () => {
    for (let i = 0; i < 50; i++) expect(generateOtpCode()).toMatch(/^\d{6}$/)
  })
  it('hashOtpCode is deterministic and not the plaintext', () => {
    process.env.OTP_PEPPER = 'test-pepper'
    const h1 = hashOtpCode('123456')
    expect(h1).toBe(hashOtpCode('123456'))
    expect(h1).not.toContain('123456')
    expect(hashOtpCode('654321')).not.toBe(h1)
  })
  it('normalizeEmail lowercases + trims', () => {
    expect(normalizeEmail('  Foo@Bar.COM ')).toBe('foo@bar.com')
  })
})
