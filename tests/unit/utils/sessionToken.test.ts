import { generateAccessToken, hashAccessToken, verifyAccessToken } from '@/utils/sessionToken'

describe('access token', () => {
  it('generates 43-char base64url tokens (32 bytes)', () => {
    const tok = generateAccessToken()
    expect(tok).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('produces different tokens each call', () => {
    expect(generateAccessToken()).not.toBe(generateAccessToken())
  })

  it('hashes deterministically', () => {
    const tok = 'fixed-token-for-test'
    expect(hashAccessToken(tok)).toBe(hashAccessToken(tok))
    expect(hashAccessToken(tok)).toHaveLength(64)
  })

  it('verifyAccessToken matches when hash matches', () => {
    const tok = generateAccessToken()
    const hash = hashAccessToken(tok)
    expect(verifyAccessToken(tok, hash)).toBe(true)
    expect(verifyAccessToken('wrong', hash)).toBe(false)
  })
})
