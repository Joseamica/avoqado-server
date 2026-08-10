/**
 * The entry point is the label an investigation filters by: "show me everything that came
 * through POST /api/v1/tpv/payments". That only works if the label is stable.
 *
 * Left raw, `/api/v1/orders/cmr123` and `/api/v1/orders/cmr456` would be two different
 * entry points, and the question "how often does this endpoint fail" becomes unanswerable.
 *
 * The second job is privacy: query strings in this platform carry emails, RFCs and tokens.
 * They must not survive into a log field.
 */

import { normalizeEntrypoint } from '@/observability/entrypoint'

describe('normalizeEntrypoint', () => {
  it('uppercases the method and keeps a plain path', () => {
    expect(normalizeEntrypoint('post', '/api/v1/tpv/payments')).toBe('POST /api/v1/tpv/payments')
  })

  it('replaces a cuid segment, which is what this schema uses everywhere', () => {
    expect(normalizeEntrypoint('GET', '/api/v1/orders/cmrb9clsl0001c9126obyxp2q')).toBe('GET /api/v1/orders/:id')
  })

  it('replaces a uuid segment', () => {
    expect(normalizeEntrypoint('GET', '/api/v1/venues/3f2504e0-4f89-41d3-9a0c-0305e82c3301/staff')).toBe('GET /api/v1/venues/:id/staff')
  })

  it('replaces a numeric id segment', () => {
    expect(normalizeEntrypoint('DELETE', '/api/v1/tables/4218')).toBe('DELETE /api/v1/tables/:id')
  })

  it('replaces every id in a path with more than one', () => {
    expect(normalizeEntrypoint('GET', '/api/v1/venues/cmrb9clsl0001c9126obyxp2q/orders/cmrb9clsl0001c9126obyxp3z')).toBe(
      'GET /api/v1/venues/:id/orders/:id',
    )
  })

  it('🔴 drops the query string entirely — it carries emails, RFCs and tokens', () => {
    expect(normalizeEntrypoint('GET', '/api/v1/customers?email=cliente@ejemplo.com&rfc=AAA010101AAA')).toBe('GET /api/v1/customers')
  })

  it('keeps the version segment, which is not an id', () => {
    expect(normalizeEntrypoint('GET', '/api/v1/health')).toBe('GET /api/v1/health')
  })

  it('keeps a venue slug: a small stable set, and useful to see', () => {
    expect(normalizeEntrypoint('GET', '/api/v1/venues/mindform-hidrogeno/menu')).toBe('GET /api/v1/venues/mindform-hidrogeno/menu')
  })

  it('keeps ordinary resource names that merely contain digits', () => {
    expect(normalizeEntrypoint('GET', '/api/v1/cfdi40/status')).toBe('GET /api/v1/cfdi40/status')
  })

  it('handles the root path', () => {
    expect(normalizeEntrypoint('GET', '/')).toBe('GET /')
  })

  it('🔴 collapses the same endpoint hit with different ids into one label', () => {
    const first = normalizeEntrypoint('GET', '/api/v1/orders/cmrb9clsl0001c9126obyxp2q')
    const second = normalizeEntrypoint('GET', '/api/v1/orders/cmk8aaaaa0001c9126obyxp3z')
    expect(first).toBe(second)
  })
})
