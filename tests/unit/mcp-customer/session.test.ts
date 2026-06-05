import jwt from 'jsonwebtoken'
import { ACCESS_TOKEN_SECRET } from '@/config/env'
import { staffIdFromDashboardSession } from '../../../src/mcp/oauth/session'

const sign = (payload: object, opts?: jwt.SignOptions) => jwt.sign(payload, ACCESS_TOKEN_SECRET, { algorithm: 'HS256', ...opts })

describe('staffIdFromDashboardSession', () => {
  it('returns the staffId (sub) from a valid dashboard session cookie', () => {
    const token = sign({ sub: 'staff-1', orgId: 'o1', venueId: 'v1', role: 'OWNER' })
    expect(staffIdFromDashboardSession({ cookies: { accessToken: token } })).toBe('staff-1')
  })

  it('returns null when there is no cookie', () => {
    expect(staffIdFromDashboardSession({})).toBeNull()
    expect(staffIdFromDashboardSession({ cookies: {} })).toBeNull()
  })

  it('returns null for an impersonation session (act claim) — never SSO as the impersonated user', () => {
    const token = sign({ sub: 'victim', act: { sub: 'admin' }, role: 'OWNER' })
    expect(staffIdFromDashboardSession({ cookies: { accessToken: token } })).toBeNull()
  })

  it('returns null for a token signed with the wrong secret (tampered)', () => {
    const token = jwt.sign({ sub: 'staff-1' }, 'a-totally-different-secret-1234567890', { algorithm: 'HS256' })
    expect(staffIdFromDashboardSession({ cookies: { accessToken: token } })).toBeNull()
  })

  it('returns null for an expired token', () => {
    const token = sign({ sub: 'staff-1' }, { expiresIn: '-1s' })
    expect(staffIdFromDashboardSession({ cookies: { accessToken: token } })).toBeNull()
  })

  it('returns null for a malformed token', () => {
    expect(staffIdFromDashboardSession({ cookies: { accessToken: 'not.a.jwt' } })).toBeNull()
  })
})
