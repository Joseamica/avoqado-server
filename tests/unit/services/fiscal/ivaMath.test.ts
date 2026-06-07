// tests/unit/services/fiscal/ivaMath.test.ts
import { splitIvaIncluded } from '../../../../src/services/fiscal/ivaMath'

describe('splitIvaIncluded (IVA-included → base + tax)', () => {
  // ── NEW BEHAVIOUR ──────────────────────────────────────────────────────────

  it('splits a gross amount so net + tax === gross EXACTLY (cuadra al centavo)', () => {
    // The invariant that guarantees a CFDI total can never drift from what the customer paid.
    for (const gross of [10000, 9900, 25050, 11600, 1, 333, 99999, 12345]) {
      const { netCents, taxCents } = splitIvaIncluded(gross, 0.16)
      expect(netCents + taxCents).toBe(gross)
      expect(netCents).toBe(Math.round(gross / 1.16))
    }
  })

  it('REGRESSION: the $99.00 case that breaks naive net-derivation still cuadra', () => {
    // Naive "net = round(gross/1.16) then ×1.16": 9900 → net 8534 → 8534×1.16 = 9899.44 → 9899 (off 1¢).
    // splitIvaIncluded lets the tax absorb the remainder so net + tax === 9900 (the paid amount).
    const { netCents, taxCents } = splitIvaIncluded(9900, 0.16)
    expect(netCents).toBe(8534)
    expect(taxCents).toBe(1366)
    expect(netCents + taxCents).toBe(9900)
  })

  it('handles the 8% frontera rate', () => {
    const { netCents, taxCents } = splitIvaIncluded(10800, 0.08)
    expect(netCents).toBe(10000)
    expect(taxCents).toBe(800)
    expect(netCents + taxCents).toBe(10800)
  })

  it('exempt / 0% / invalid rate → everything is base, zero tax', () => {
    expect(splitIvaIncluded(10000, 0)).toEqual({ netCents: 10000, taxCents: 0 })
    expect(splitIvaIncluded(10000, -1)).toEqual({ netCents: 10000, taxCents: 0 })
    expect(splitIvaIncluded(10000, NaN)).toEqual({ netCents: 10000, taxCents: 0 })
  })
})
