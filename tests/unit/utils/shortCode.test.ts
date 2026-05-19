import { generateShortCode, AMBIGUITY_SAFE_ALPHABET } from '@/utils/shortCode'

describe('generateShortCode', () => {
  it('returns 4 characters', () => {
    expect(generateShortCode()).toHaveLength(4)
  })

  it('uses only ambiguity-safe alphabet (no 0/O/1/I/L)', () => {
    for (let i = 0; i < 100; i++) {
      const code = generateShortCode()
      for (const ch of code) {
        expect(AMBIGUITY_SAFE_ALPHABET).toContain(ch)
      }
      expect(code).not.toMatch(/[0O1IL]/)
    }
  })

  it('produces different values across calls (probabilistic)', () => {
    const codes = new Set<string>()
    for (let i = 0; i < 50; i++) codes.add(generateShortCode())
    expect(codes.size).toBeGreaterThan(40)
  })
})
