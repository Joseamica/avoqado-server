/**
 * Environment validation is fail-fast: `src/config/env.ts` calls `process.exit(1)` when any
 * variable fails its schema. That is the right behavior for a payments backend — better to
 * refuse to start than to run with a half-configured integration.
 *
 * The trap is that Zod treats an EMPTY variable as a present value. `SENTRY_DSN=""` is a
 * string, so `z.string().url().optional()` runs `.url()` on it, fails, and the process
 * exits. The variable is optional and nothing depends on it, yet the API is down.
 *
 * How that happens in real life: you open the Render dashboard to wire up an integration,
 * create the key, and save it blank because you do not have the value yet. Next restart,
 * every venue is offline.
 *
 * `dropEmptyValues` closes that door for every variable at once, not just the URL ones, so
 * the next optional variable somebody adds inherits the fix instead of re-arming the trap.
 */

// Imported from envHelpers, NOT from env.ts: importing env.ts runs the full validation and
// can call process.exit(1), which would kill the Jest worker instead of failing a test.
import { z } from 'zod'
import { dropEmptyValues } from '@/config/envHelpers'

describe('dropEmptyValues', () => {
  it('removes keys whose value is an empty string', () => {
    expect(dropEmptyValues({ SENTRY_DSN: '', DATABASE_URL: 'postgres://x' })).toEqual({ DATABASE_URL: 'postgres://x' })
  })

  it('keeps real values untouched, including ones that look falsy', () => {
    const input = { A: 'value', B: '0', C: 'false', D: ' ' }
    expect(dropEmptyValues(input)).toEqual(input)
  })

  it('keeps explicitly undefined keys out without throwing', () => {
    expect(dropEmptyValues({ A: undefined, B: 'x' })).toEqual({ B: 'x' })
  })

  it('handles an empty environment', () => {
    expect(dropEmptyValues({})).toEqual({})
  })
})

describe('🔴 the boot trap this prevents', () => {
  // A faithful slice of the real schema: an optional URL, a URL with a default, and a
  // required value. These three shapes cover every variable in src/config/env.ts.
  const schema = z.object({
    SENTRY_DSN: z.string().url().optional(),
    FRONTEND_URL: z.string().url().default('http://localhost:5173'),
    DATABASE_URL: z.string().min(1),
  })

  const env = { DATABASE_URL: 'postgres://x', SENTRY_DSN: '' }

  it('reproduces the crash: a blank optional URL fails validation on raw process.env', () => {
    const result = schema.safeParse(env)
    expect(result.success).toBe(false)
    // This is the failure that reaches process.exit(1) in production.
    expect(result.success ? [] : result.error.issues.map(i => i.path[0])).toContain('SENTRY_DSN')
  })

  it('a blank optional URL is accepted once empty values are dropped', () => {
    const result = schema.safeParse(dropEmptyValues(env))
    expect(result.success).toBe(true)
    expect(result.success && result.data.SENTRY_DSN).toBeUndefined()
  })

  it('a blank variable that HAS a default falls back to the default instead of crashing', () => {
    const result = schema.safeParse(dropEmptyValues({ ...env, FRONTEND_URL: '' }))
    expect(result.success).toBe(true)
    expect(result.success && result.data.FRONTEND_URL).toBe('http://localhost:5173')
  })

  it('still rejects a genuinely malformed value — this must not become a blanket bypass', () => {
    const result = schema.safeParse(dropEmptyValues({ ...env, SENTRY_DSN: 'not-a-url' }))
    expect(result.success).toBe(false)
  })

  it('still rejects a missing REQUIRED variable', () => {
    const result = schema.safeParse(dropEmptyValues({ DATABASE_URL: '' }))
    expect(result.success).toBe(false)
  })
})
