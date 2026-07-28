/**
 * CORS origin policy tests.
 *
 * Motivated by the 2026-07-26 finding: the Cloudflare Pages preview branch was
 * matched with an UNANCHORED regex whose project-name segment behaved as a
 * prefix (`/\.(?:demo-)?avoqado-web-dashboard.*\.pages\.dev$/`). Since anyone can
 * register a Cloudflare Pages project, a name like `avoqado-web-dashboard-attacker`
 * produced branch previews that satisfied the pattern and received a CORS grant —
 * with `credentials: true` and auth cookies issued `sameSite: 'none'` + `secure`,
 * that is enough for an attacker page to call the API as the victim and read the
 * responses.
 *
 * These tests pin the exact allow/deny boundary so the wildcard cannot come back.
 */

import { getCorsConfig, Environment } from '@/config/corsOptions'

/** Runs the real `origin` callback and reports whether the origin was accepted. */
const isAllowed = (env: Environment, origin: string | undefined): boolean => {
  const originFn = getCorsConfig(env).origin as (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => void

  let allowed = false
  originFn(origin, (err, allow) => {
    allowed = !err && allow === true
  })
  return allowed
}

describe('CORS origin policy', () => {
  describe('Cloudflare Pages previews — the attack this regex must stop', () => {
    // Every one of these was ACCEPTED by the pre-fix pattern.
    const attackerControlled = [
      'https://abc123.avoqado-web-dashboard-atacante.pages.dev',
      'https://x.avoqado-web-dashboard-evil.pages.dev',
      'https://a.avoqado-web-dashboardZZZ.pages.dev',
      'https://evil.com.avoqado-web-dashboard-x.pages.dev',
      'https://deploy.avoqado-web-dashboard.evil.pages.dev',
    ]

    it.each(attackerControlled)('rejects %s in production', origin => {
      expect(isAllowed('production', origin)).toBe(false)
    })

    it.each(attackerControlled)('rejects %s in staging too (the branch is env-agnostic)', origin => {
      expect(isAllowed('staging', origin)).toBe(false)
    })

    it('rejects a plaintext http:// preview even on the exact project name', () => {
      expect(isAllowed('production', 'http://abc123.avoqado-web-dashboard.pages.dev')).toBe(false)
    })

    it('rejects a lookalike suffixed onto the real host', () => {
      expect(isAllowed('production', 'https://abc.avoqado-web-dashboard.pages.dev.evil.com')).toBe(false)
    })
  })

  describe('Cloudflare Pages previews — legitimate deploys still work (regression)', () => {
    const legitimatePreviews = [
      'https://develop.avoqado-web-dashboard.pages.dev',
      'https://abc123.avoqado-web-dashboard.pages.dev',
      'https://4wx.avoqado-web-dashboard.pages.dev',
      'https://feature-branch-x.avoqado-web-dashboard.pages.dev',
      'https://preview.demo-avoqado-web-dashboard.pages.dev',
    ]

    it.each(legitimatePreviews)('accepts %s', origin => {
      expect(isAllowed('production', origin)).toBe(true)
    })
  })

  describe('Explicit allowlists still hold (regression)', () => {
    it('accepts the production dashboard', () => {
      expect(isAllowed('production', 'https://dashboard.avoqado.io')).toBe(true)
    })

    it('accepts the superadmin console', () => {
      expect(isAllowed('production', 'https://superadmin.avoqado.io')).toBe(true)
    })

    it('accepts the public booking + payment sites', () => {
      expect(isAllowed('production', 'https://book.avoqado.io')).toBe(true)
      expect(isAllowed('production', 'https://pay.avoqado.io')).toBe(true)
    })

    it('accepts the staging demo dashboard by exact allowlist', () => {
      expect(isAllowed('staging', 'https://demo-avoqado-web-dashboard.pages.dev')).toBe(true)
    })

    it('allows requests with no Origin (native apps, curl, server-to-server)', () => {
      expect(isAllowed('production', undefined)).toBe(true)
    })

    it('rejects an unrelated origin', () => {
      expect(isAllowed('production', 'https://evil.com')).toBe(false)
    })
  })

  describe('Environment isolation (regression)', () => {
    it('does NOT accept the "null" origin in production', () => {
      // 'null' is reachable from local files and data: URLs — dev-only on purpose.
      expect(isAllowed('production', 'null')).toBe(false)
      expect(isAllowed('development', 'null')).toBe(true)
    })

    it('does NOT accept localhost in production', () => {
      expect(isAllowed('production', 'http://localhost:5173')).toBe(false)
      expect(isAllowed('development', 'http://localhost:5173')).toBe(true)
    })

    it('keeps dev-only tunnel origins out of production', () => {
      expect(isAllowed('production', 'https://random-name.trycloudflare.com')).toBe(false)
      expect(isAllowed('development', 'https://random-name.trycloudflare.com')).toBe(true)
    })
  })
})
