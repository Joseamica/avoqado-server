/**
 * The correlation id arrives from a client — a browser, a PAX terminal, a POS tablet — and
 * ends up in log fields and, later, in error-tracking tags. That makes it untrusted input
 * on a path that reaches storage.
 *
 * Today the raw header is accepted with no validation at all, so a client can put anything
 * in a log line. This closes that, without breaking clients that already send an id in a
 * format of their own: shape and length are what matter, not the exact scheme.
 *
 * The contract callers rely on: a bad header is never an error. It just means "generate a
 * fresh one".
 */

import { sanitizeCorrelationId, resolveCorrelationId, newCorrelationId } from '@/observability/correlationId'

describe('sanitizeCorrelationId', () => {
  const uuid = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'

  it('accepts a uuid', () => {
    expect(sanitizeCorrelationId(uuid)).toBe(uuid)
  })

  it('accepts a Buffer, which is how AMQP headers can arrive', () => {
    expect(sanitizeCorrelationId(Buffer.from(uuid))).toBe(uuid)
  })

  it('trims surrounding whitespace', () => {
    expect(sanitizeCorrelationId(`  ${uuid}  `)).toBe(uuid)
  })

  it('accepts other reasonable client formats, so existing callers keep their thread', () => {
    expect(sanitizeCorrelationId('tpv_01HX8ZQ4M9KJ3N')).toBe('tpv_01HX8ZQ4M9KJ3N')
    expect(sanitizeCorrelationId('cmrb9clsl0001c9126obyxp2q')).toBe('cmrb9clsl0001c9126obyxp2q')
  })

  it('🔴 rejects an absurdly long value instead of writing it to every log line', () => {
    expect(sanitizeCorrelationId('a'.repeat(500))).toBeUndefined()
  })

  it('🔴 rejects punctuation that would confuse whoever greps the log', () => {
    expect(sanitizeCorrelationId('abc def ghi')).toBeUndefined()
    expect(sanitizeCorrelationId('id"] OR 1=1 --')).toBeUndefined()
    expect(sanitizeCorrelationId('a/b/c/d/e/f')).toBeUndefined()
    expect(sanitizeCorrelationId('{"json":"here"}')).toBeUndefined()
    expect(sanitizeCorrelationId('line\nbreak\nhere')).toBeUndefined()
  })

  it('rejects a value too short to be an id', () => {
    expect(sanitizeCorrelationId('abc')).toBeUndefined()
  })

  it('rejects non-string types without throwing', () => {
    expect(sanitizeCorrelationId(undefined)).toBeUndefined()
    expect(sanitizeCorrelationId(null)).toBeUndefined()
    expect(sanitizeCorrelationId(12345)).toBeUndefined()
    expect(sanitizeCorrelationId({ nested: true })).toBeUndefined()
    expect(sanitizeCorrelationId(['a'])).toBeUndefined()
  })
})

describe('resolveCorrelationId', () => {
  it('reuses a safe client id, which is what makes the cross-console thread work', () => {
    expect(resolveCorrelationId('tpv_01HX8ZQ4M9KJ3N')).toBe('tpv_01HX8ZQ4M9KJ3N')
  })

  it('🔴 generates a fresh id instead of throwing when the header is hostile', () => {
    const resolved = resolveCorrelationId('a'.repeat(500))
    expect(resolved).toMatch(/^[0-9a-f-]{36}$/i)
  })

  it('generates a fresh id when there is no header at all', () => {
    expect(resolveCorrelationId(undefined)).toMatch(/^[0-9a-f-]{36}$/i)
  })
})

describe('newCorrelationId', () => {
  it('produces a unique value each time', () => {
    const ids = new Set(Array.from({ length: 100 }, () => newCorrelationId()))
    expect(ids.size).toBe(100)
  })
})
