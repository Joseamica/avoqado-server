/**
 * Regression tests for the MindForm legacy QR payments filter bug.
 *
 * Bug: the legacy QR rows were merged into the /payments list response
 * regardless of the user's method/source filter, so filtering by "Método:
 * Efectivo" still leaked QR_LEGACY/Tarjeta rows into the cash-filtered view.
 *
 * These tests pin down the two pure helpers that fix the leak:
 *   - `shouldIncludeLegacyPayments` — pre-flight skip when the filter cannot
 *     match any legacy row at all.
 *   - `filterLegacyRowsByMethodSource` — post-fetch drop of legacy rows whose
 *     method/source doesn't satisfy the filter.
 */

import {
  shouldIncludeLegacyPayments,
  filterLegacyRowsByMethodSource,
  LEGACY_METHOD_VALUES,
  LEGACY_SOURCE_VALUE,
} from '@/services/legacy/qrPayments.legacy.service'

describe('qrPayments.legacy.service — shouldIncludeLegacyPayments', () => {
  it('returns true when no filter is provided (no constraint)', () => {
    expect(shouldIncludeLegacyPayments(undefined)).toBe(true)
    expect(shouldIncludeLegacyPayments({})).toBe(true)
  })

  it('returns true when methods/sources arrays are empty', () => {
    expect(shouldIncludeLegacyPayments({ methods: [], sources: [] })).toBe(true)
  })

  it('returns true when methods filter includes a legacy method value', () => {
    expect(shouldIncludeLegacyPayments({ methods: ['CASH'] })).toBe(true)
    expect(shouldIncludeLegacyPayments({ methods: ['CARD'] })).toBe(true)
    expect(shouldIncludeLegacyPayments({ methods: ['CASH', 'CREDIT_CARD'] })).toBe(true)
  })

  it('returns false when methods filter excludes ALL legacy method values', () => {
    // This is the canonical bug case: user filters by "Efectivo" only.
    // Legacy CARD rows must not be considered → skip the legacy DB call entirely.
    // (The legacy mapper emits either 'CASH' or 'CARD'; nothing else.)
    expect(shouldIncludeLegacyPayments({ methods: ['CREDIT_CARD'] })).toBe(false)
    expect(shouldIncludeLegacyPayments({ methods: ['DEBIT_CARD'] })).toBe(false)
    expect(shouldIncludeLegacyPayments({ methods: ['CREDIT_CARD', 'DEBIT_CARD'] })).toBe(false)
  })

  it('returns true when sources filter includes QR_LEGACY', () => {
    expect(shouldIncludeLegacyPayments({ sources: ['QR_LEGACY'] })).toBe(true)
    expect(shouldIncludeLegacyPayments({ sources: ['TPV', 'QR_LEGACY'] })).toBe(true)
  })

  it('returns false when sources filter excludes QR_LEGACY', () => {
    expect(shouldIncludeLegacyPayments({ sources: ['TPV'] })).toBe(false)
    expect(shouldIncludeLegacyPayments({ sources: ['WEB'] })).toBe(false)
    expect(shouldIncludeLegacyPayments({ sources: ['TPV', 'WEB', 'OTHER'] })).toBe(false)
  })

  it('returns false when EITHER constraint excludes legacy (logical AND)', () => {
    // methods allows it but sources doesn't
    expect(shouldIncludeLegacyPayments({ methods: ['CASH'], sources: ['TPV'] })).toBe(false)
    // sources allows it but methods doesn't
    expect(shouldIncludeLegacyPayments({ methods: ['CREDIT_CARD'], sources: ['QR_LEGACY'] })).toBe(false)
  })

  it('returns true only when BOTH constraints allow legacy', () => {
    expect(shouldIncludeLegacyPayments({ methods: ['CASH'], sources: ['QR_LEGACY'] })).toBe(true)
    expect(shouldIncludeLegacyPayments({ methods: ['CARD', 'CASH'], sources: ['QR_LEGACY', 'TPV'] })).toBe(true)
  })

  it('pins the constants used to decide the filter — bumping them must update the helper', () => {
    // Sanity guard: if these change, both the helper and these tests must change.
    expect(LEGACY_METHOD_VALUES).toEqual(['CASH', 'CARD'])
    expect(LEGACY_SOURCE_VALUE).toBe('QR_LEGACY')
  })
})

describe('qrPayments.legacy.service — filterLegacyRowsByMethodSource', () => {
  const baseRows = [
    { id: 'l1', method: 'CARD', source: 'QR_LEGACY' },
    { id: 'l2', method: 'CASH', source: 'QR_LEGACY' },
    { id: 'l3', method: 'CARD', source: 'QR_LEGACY' },
  ]

  it('returns the input unchanged when no filter is provided', () => {
    expect(filterLegacyRowsByMethodSource(baseRows, undefined)).toBe(baseRows)
    expect(filterLegacyRowsByMethodSource(baseRows, {})).toBe(baseRows)
    expect(filterLegacyRowsByMethodSource(baseRows, { methods: [], sources: [] })).toBe(baseRows)
  })

  it('drops rows whose method does not match the methods filter', () => {
    // User filters by "Efectivo" → only the CASH legacy row should survive,
    // not the CARD ones. This was the leak the user reported.
    const result = filterLegacyRowsByMethodSource(baseRows, { methods: ['CASH'] })
    expect(result.map(r => r.id)).toEqual(['l2'])
  })

  it('keeps all rows when method filter includes every emitted legacy method', () => {
    const result = filterLegacyRowsByMethodSource(baseRows, { methods: ['CASH', 'CARD'] })
    expect(result).toHaveLength(3)
  })

  it('drops rows whose source does not match the sources filter', () => {
    // Simulate a hypothetical row with a non-legacy source (defensive — today
    // the mapper always emits QR_LEGACY, but the filter shouldn't trust that).
    const rows = [...baseRows, { id: 'l4', method: 'CASH', source: 'OTHER' as any }]
    const result = filterLegacyRowsByMethodSource(rows, { sources: ['QR_LEGACY'] })
    expect(result.map(r => r.id)).toEqual(['l1', 'l2', 'l3'])
  })

  it('drops rows that fail EITHER the method or the source filter', () => {
    const result = filterLegacyRowsByMethodSource(baseRows, {
      methods: ['CASH'],
      sources: ['QR_LEGACY'],
    })
    expect(result.map(r => r.id)).toEqual(['l2'])
  })

  it('returns an empty array when no rows pass the filter', () => {
    // methods=['CREDIT_CARD'] excludes every legacy row (legacy is CASH/CARD).
    const result = filterLegacyRowsByMethodSource(baseRows, { methods: ['CREDIT_CARD'] })
    expect(result).toEqual([])
  })
})
