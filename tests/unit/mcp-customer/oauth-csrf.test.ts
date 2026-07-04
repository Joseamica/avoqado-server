/**
 * CSRF guard for POST /mcp-oauth/approve (isTrustedOrigin). The dashboard `accessToken` cookie is
 * SameSite=None in prod, so a cross-site POST would carry the victim's session; without this guard a
 * malicious page could auto-POST sso=1 and mint an auth code for the victim (account takeover).
 * MCP_ISSUER_URL defaults to http://localhost:12344 in tests (no env), so that is the trusted origin.
 */
jest.mock('@/utils/prismaClient', () => ({ __esModule: true, default: {} }))

import { isTrustedOrigin } from '../../../src/mcp/oauth/router'

const reqWith = (headers: Record<string, string | undefined>) => ({
  get: (h: string) => headers[h.toLowerCase()],
})

describe('isTrustedOrigin (CSRF guard)', () => {
  it('accepts a same-origin request (Origin matches the issuer)', () => {
    expect(isTrustedOrigin(reqWith({ origin: 'http://localhost:12344' }))).toBe(true)
  })

  it('REJECTS a cross-site Origin (the attack) — this is the whole point', () => {
    expect(isTrustedOrigin(reqWith({ origin: 'https://evil.example' }))).toBe(false)
  })

  it('rejects even when a valid Referer is present but the Origin is foreign (Origin wins)', () => {
    expect(isTrustedOrigin(reqWith({ origin: 'https://evil.example', referer: 'http://localhost:12344/authorize' }))).toBe(false)
  })

  it('falls back to Referer origin when Origin is absent', () => {
    expect(isTrustedOrigin(reqWith({ referer: 'http://localhost:12344/authorize?x=1' }))).toBe(true)
    expect(isTrustedOrigin(reqWith({ referer: 'https://evil.example/x' }))).toBe(false)
  })

  it('rejects a garbage Referer', () => {
    expect(isTrustedOrigin(reqWith({ referer: 'not a url' }))).toBe(false)
  })

  it('allows when NEITHER header is present (unreachable via a cross-site browser POST — browser always sets Origin)', () => {
    expect(isTrustedOrigin(reqWith({}))).toBe(true)
  })
})
