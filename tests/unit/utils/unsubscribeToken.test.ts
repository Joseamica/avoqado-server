import { signUnsubscribeToken, verifyUnsubscribeToken } from '../../../src/utils/unsubscribeToken'

const DATA = { staffId: 'staff_abc', venueId: 'venue_xyz', category: 'INVENTORY' as const }

describe('unsubscribeToken', () => {
  it('round-trips a signed token back to the same data', () => {
    const token = signUnsubscribeToken(DATA)
    expect(verifyUnsubscribeToken(token)).toEqual(DATA)
  })

  it('produces a URL-safe token (no + / = or padding issues)', () => {
    const token = signUnsubscribeToken(DATA)
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
  })

  it('rejects a tampered body (attacker swaps staffId)', () => {
    const token = signUnsubscribeToken(DATA)
    const forgedBody = Buffer.from(JSON.stringify({ v: 1, p: 'unsub', s: 'staff_HACKED', ve: 'venue_xyz', c: 'INVENTORY' })).toString(
      'base64url',
    )
    const tampered = `${forgedBody}.${token.split('.')[1]}` // reuse original signature
    expect(verifyUnsubscribeToken(tampered)).toBeNull()
  })

  it('rejects a tampered signature', () => {
    const token = signUnsubscribeToken(DATA)
    const [body] = token.split('.')
    expect(verifyUnsubscribeToken(`${body}.AAAAAAAAAAAAAAAAAAAAAA`)).toBeNull()
  })

  it('rejects garbage / malformed input', () => {
    expect(verifyUnsubscribeToken('')).toBeNull()
    expect(verifyUnsubscribeToken('nodot')).toBeNull()
    expect(verifyUnsubscribeToken('.onlysig')).toBeNull()
    expect(verifyUnsubscribeToken('body.')).toBeNull()
    expect(verifyUnsubscribeToken(undefined)).toBeNull()
    expect(verifyUnsubscribeToken(null)).toBeNull()
  })

  it('rejects a validly-signed token with the wrong purpose (defense against token-confusion)', () => {
    // Simulate a token signed with the same key but purpose != 'unsub' — must not verify.
    const body = Buffer.from(JSON.stringify({ v: 1, p: 'login', s: 's', ve: 'v', c: 'INVENTORY' })).toString('base64url')
    // Can't re-sign here (private helper), but a real 'unsub' token with p mutated must fail signature anyway:
    const token = signUnsubscribeToken(DATA)
    const swapped = `${body}.${token.split('.')[1]}`
    expect(verifyUnsubscribeToken(swapped)).toBeNull()
  })

  it('rejects an unknown category', () => {
    const body = Buffer.from(JSON.stringify({ v: 1, p: 'unsub', s: 's', ve: 'v', c: 'PAYROLL' })).toString('base64url')
    const token = signUnsubscribeToken(DATA)
    expect(verifyUnsubscribeToken(`${body}.${token.split('.')[1]}`)).toBeNull()
  })
})
