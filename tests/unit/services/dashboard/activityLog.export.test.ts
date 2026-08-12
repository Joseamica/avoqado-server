/**
 * Audit-log export.
 *
 * The matrix answers "exportable" for the audit trail and it was not — the generic export
 * helper existed and was wired to exactly three listings (payments, orders, sales summary).
 *
 * Two of these tests are about a file leaving the building, which is a different risk from
 * a screen rendering: the dashboard redacts sensitive keys at render time, and only on ONE
 * of its two audit screens (the organization one prints the raw JSON). A download passes
 * through neither, so the redaction has to live on the server.
 */

import { redactSensitive, summarizeLogData } from '@/services/dashboard/activityLog.format'

describe('redactSensitive', () => {
  it.each([
    ['password', { password: 'hunter2' }],
    ['token', { token: 'abc.def' }],
    ['apiKey', { apiKey: 'sk-live-1' }],
    ['authorization', { authorization: 'Bearer x' }],
    ['cardNumber', { cardNumber: '4111111111111111' }],
    ['clabe', { clabe: '012180001234567895' }],
    ['cvv', { cvv: '123' }],
  ])('🔴 redacts %s', (_label, payload) => {
    const out = redactSensitive(payload) as Record<string, unknown>
    expect(Object.values(out)[0]).toBe('••• redacted')
  })

  it('reaches nested objects and arrays, not just the top level', () => {
    // A payload is rarely flat. Redacting only the first level is the same as not redacting.
    const out = redactSensitive({ meta: { secret: 's' }, items: [{ token: 't' }] }) as any
    expect(out.meta.secret).toBe('••• redacted')
    expect(out.items[0].token).toBe('••• redacted')
  })

  it('leaves ordinary fields alone — the row still has to be readable', () => {
    const out = redactSensitive({ reason: 'empaque dañado', quantity: 12 }) as any
    expect(out).toEqual({ reason: 'empaque dañado', quantity: 12 })
  })

  it('is case-insensitive and matches the usual spellings', () => {
    const out = redactSensitive({ API_KEY: 'x', 'private-key': 'y', Password: 'z' }) as any
    expect(Object.values(out)).toEqual(['••• redacted', '••• redacted', '••• redacted'])
  })
})

describe('summarizeLogData', () => {
  it('flattens the jsonb into something readable in a cell', () => {
    // Raw JSON in a spreadsheet cell makes the file unreadable, and an audit trail nobody
    // reads is not an audit trail.
    expect(summarizeLogData({ reason: 'muy caro', orderNumber: 'OC-001' })).toBe('reason: muy caro · orderNumber: OC-001')
  })

  it('🔴 redacts before summarizing — the summary column is a leak too', () => {
    expect(summarizeLogData({ token: 'abc' })).toBe('token: ••• redacted')
  })

  it('collapses nested structures instead of drowning the reader', () => {
    expect(summarizeLogData({ items: [1, 2, 3], meta: { a: 1 } })).toBe('items: (3) · meta: {…}')
  })

  it('truncates long payloads with an ellipsis', () => {
    const largo = summarizeLogData({ nota: 'x'.repeat(500) })
    expect(largo.length).toBeLessThanOrEqual(300)
    expect(largo.endsWith('…')).toBe(true)
  })

  it('empty payloads produce an empty cell, not "null"', () => {
    expect(summarizeLogData(null)).toBe('')
    expect(summarizeLogData(undefined)).toBe('')
  })
})
