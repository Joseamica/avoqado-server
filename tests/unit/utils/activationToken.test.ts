import { generateActivationToken, hashActivationToken, last4 } from '@/utils/activationToken'

describe('activation token', () => {
  it('generates 12-char token from ambiguity-safe alphabet', () => {
    const tok = generateActivationToken()
    expect(tok).toHaveLength(12)
    expect(tok).toMatch(/^[A-HJ-NP-Z2-9]{12}$/)
  })

  it('last4 returns last 4 chars', () => {
    expect(last4('ABCDEFGHJKMN')).toBe('JKMN')
  })

  it('hashes deterministically', () => {
    const tok = 'ABCDEFGHJKMN'
    expect(hashActivationToken(tok)).toBe(hashActivationToken(tok))
  })

  it('hash differs across tokens', () => {
    expect(hashActivationToken('AAAAAAAAAAAA')).not.toBe(hashActivationToken('BBBBBBBBBBBB'))
  })
})
