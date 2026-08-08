/**
 * Production change that makes this suite pass: a neutral Decimal-based normalizer/calculator must
 * distinguish the new counted/skip protocol from the active legacy Desktop declaration protocol.
 */

import { normalizeCashReconciliationRequest, calculateCashReconciliation } from '@/services/shared/cashReconciliation.service'

describe('normalizeCashReconciliationRequest', () => {
  it.each([{}, { venueId: 'v1', shiftId: 's1', closeData: null }])('treats omission as NOT_REQUESTED', body => {
    expect(normalizeCashReconciliationRequest(body)).toEqual({
      source: 'NONE',
      outcome: 'NOT_REQUESTED',
    })
  })

  it('accepts a canonical zero as a real new physical count', () => {
    const result = normalizeCashReconciliationRequest({
      cashReconciliationAction: 'COUNTED',
      countedCash: '0.00',
    })

    expect(result.source).toBe('NEW')
    expect(result.outcome).toBe('APPLIED')
    expect(result.countedCash?.toFixed(2)).toBe('0.00')
  })

  it('accepts the largest value supported by Decimal(10,2)', () => {
    const result = normalizeCashReconciliationRequest({
      cashReconciliationAction: 'COUNTED',
      countedCash: '99999999.99',
    })

    expect(result.outcome).toBe('APPLIED')
    expect(result.countedCash?.toFixed(2)).toBe('99999999.99')
  })

  it.each([
    undefined,
    null,
    '',
    ' 1.00',
    '1.00 ',
    '-1.00',
    '+1.00',
    '1e2',
    '1,00',
    '1.001',
    '100000000.00',
    1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])('rejects non-canonical new count %# without blocking normalization', countedCash => {
    const result = normalizeCashReconciliationRequest({
      cashReconciliationAction: 'COUNTED',
      countedCash,
    })

    expect(result).toMatchObject({ source: 'NEW', outcome: 'IGNORED_INVALID' })
    expect(result.countedCash).toBeUndefined()
  })

  it('does not fall back to a valid legacy declaration when the new action is invalid', () => {
    expect(
      normalizeCashReconciliationRequest({
        cashReconciliationAction: 'COUNTED',
        countedCash: 'invalid',
        cashDeclared: 6000,
      }),
    ).toMatchObject({ source: 'NEW', outcome: 'IGNORED_INVALID' })
  })

  it('marks an explicit skip without guessing from omission', () => {
    expect(normalizeCashReconciliationRequest({ cashReconciliationAction: 'SKIPPED' })).toEqual({
      source: 'NEW',
      action: 'SKIPPED',
      outcome: 'SKIPPED',
    })
  })

  it('rejects SKIPPED combined with any count', () => {
    expect(
      normalizeCashReconciliationRequest({
        cashReconciliationAction: 'SKIPPED',
        countedCash: '0.00',
      }),
    ).toMatchObject({ source: 'NEW', outcome: 'IGNORED_INVALID' })
  })

  it('preserves Avoqado Desktop top-level declarations and prefers them over nested legacy data', () => {
    const result = normalizeCashReconciliationRequest({
      cashDeclared: 6000,
      cardDeclared: 200,
      notes: 'Desktop close',
      closeData: { cashDeclared: 9999, vouchersDeclared: 300 },
    })

    expect(result).toEqual({
      source: 'LEGACY',
      outcome: 'LEGACY_APPLIED',
      legacyCloseData: {
        cashDeclared: 6000,
        cardDeclared: 200,
        vouchersDeclared: 0,
        otherDeclared: 0,
        notes: 'Desktop close',
      },
    })
  })

  it('accepts the nested legacy shape when top-level declaration fields are absent', () => {
    expect(normalizeCashReconciliationRequest({ closeData: { cashDeclared: 450 } })).toEqual({
      source: 'LEGACY',
      outcome: 'LEGACY_APPLIED',
      legacyCloseData: {
        cashDeclared: 450,
        cardDeclared: 0,
        vouchersDeclared: 0,
        otherDeclared: 0,
        notes: undefined,
      },
    })
  })
})

describe('calculateCashReconciliation', () => {
  it('calculates balanced/short/over exactly with Decimal strings', () => {
    expect(calculateCashReconciliation('6000.00', '1000.00', '5000.00').difference.toFixed(2)).toBe('0.00')
    expect(calculateCashReconciliation('5900.00', '1000.00', '5000.00').difference.toFixed(2)).toBe('-100.00')
    expect(calculateCashReconciliation('6050.00', '1000.00', '5000.00').difference.toFixed(2)).toBe('50.00')
  })

  it('does not leak binary floating-point dust', () => {
    const result = calculateCashReconciliation('0.30', '0.10', '0.20')

    expect(result.expectedCash.toFixed(2)).toBe('0.30')
    expect(result.difference.toFixed(2)).toBe('0.00')
    expect(result.fitsDifferenceColumn).toBe(true)
  })

  it('reports when the difference does not fit Shift.cashDifference Decimal(10,2)', () => {
    const result = calculateCashReconciliation('0.00', '99999999.99', '1.00')

    expect(result.difference.toFixed(2)).toBe('-100000000.99')
    expect(result.fitsDifferenceColumn).toBe(false)
  })
})
