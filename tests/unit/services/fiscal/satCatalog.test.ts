// tests/unit/services/fiscal/satCatalog.test.ts
import { mapFormaPago, sectorSatDefaults, isValidRegimen } from '../../../../src/services/fiscal/satCatalog'

describe('satCatalog', () => {
  it('maps Avoqado PaymentMethod → SAT c_FormaPago', () => {
    expect(mapFormaPago('CASH')).toBe('01')
    expect(mapFormaPago('CREDIT_CARD')).toBe('04')
    expect(mapFormaPago('DEBIT_CARD')).toBe('28')
    expect(mapFormaPago('BANK_TRANSFER')).toBe('03')
  })

  it('returns 99 (por definir) for ambiguous methods and flags them', () => {
    expect(mapFormaPago('OTHER')).toBe('99')
    expect(mapFormaPago('CRYPTOCURRENCY')).toBe('99')
    expect(mapFormaPago('DIGITAL_WALLET')).toBe('99') // disambiguation deferred (spec §10)
  })

  it('gives a per-sector SAT key default', () => {
    expect(sectorSatDefaults('RESTAURANT').productKey).toBe('90101500')
    expect(sectorSatDefaults('RESTAURANT').unitKey).toBe('E48')
    expect(sectorSatDefaults('RETAIL_STORE').unitKey).toBe('H87') // pieza
  })

  it('validates régimen codes (numeric, 3 digits)', () => {
    expect(isValidRegimen('601')).toBe(true)
    expect(isValidRegimen('616')).toBe(true)
    expect(isValidRegimen('99')).toBe(false)
    expect(isValidRegimen('abc')).toBe(false)
  })
})
