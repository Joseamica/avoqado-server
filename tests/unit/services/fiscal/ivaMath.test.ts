// tests/unit/services/fiscal/ivaMath.test.ts
import {
  splitIvaIncluded,
  allocateByWeights,
  splitIvaByRate,
  splitPaymentIvaByOrderRates,
  grossByRateFromItems,
} from '../../../../src/services/fiscal/ivaMath'

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

describe('allocateByWeights (proportional cent split, no cent lost)', () => {
  it('sums to the total EXACTLY for any weights', () => {
    for (const [total, weights] of [
      [10000, [1, 1]],
      [10001, [1, 1]], // odd cent → remainder absorbed
      [10000, [1, 2, 3]],
      [99999, [7, 3]],
      [1, [1, 1, 1]],
      [12345, [500, 300, 200]],
    ] as [number, number[]][]) {
      const parts = allocateByWeights(total, weights)
      expect(parts.reduce((a, b) => a + b, 0)).toBe(total)
    }
  })

  it('splits proportionally (50/50, 2:1)', () => {
    expect(allocateByWeights(10000, [1, 1])).toEqual([5000, 5000])
    expect(allocateByWeights(9000, [2, 1])).toEqual([6000, 3000])
  })

  it('the largest bucket absorbs the rounding remainder', () => {
    // 10001 split 1:1 → 5000 + 5000 = 10000, drift +1 goes to a bucket → sum 10001.
    const parts = allocateByWeights(10001, [1, 1])
    expect(parts.reduce((a, b) => a + b, 0)).toBe(10001)
  })

  it('edge cases: empty → [], all-zero weights → first bucket takes all', () => {
    expect(allocateByWeights(10000, [])).toEqual([])
    expect(allocateByWeights(10000, [0, 0])).toEqual([10000, 0])
  })
})

describe('splitIvaByRate + splitPaymentIvaByOrderRates (per-rate IVA)', () => {
  it('single 16% order behaves exactly like the flat split (no regression)', () => {
    const r = splitPaymentIvaByOrderRates(11600, [{ rate: 0.16, grossCents: 11600 }])
    expect(r).toEqual({ netCents: 10000, taxCents: 1600, taxByRate: { '0.16': 1600 } })
    expect(r.netCents + r.taxCents).toBe(11600)
  })

  it('single 8% frontera order taxes at 8%, NOT 16% (the core fix)', () => {
    const r = splitPaymentIvaByOrderRates(10800, [{ rate: 0.08, grossCents: 10800 }])
    expect(r.taxCents).toBe(800) // 8% → 800, flat-16% would have wrongly said 1490
    expect(r.taxByRate).toEqual({ '0.08': 800 })
    expect(r.netCents + r.taxCents).toBe(10800)
  })

  it('mixed 16% + 8% order → per-rate breakdown, still cuadra al centavo', () => {
    // $116 @16% (gross 11600) + $108 @8% (gross 10800) = 22400 gross.
    const r = splitPaymentIvaByOrderRates(22400, [
      { rate: 0.16, grossCents: 11600 },
      { rate: 0.08, grossCents: 10800 },
    ])
    expect(r.taxByRate).toEqual({ '0.16': 1600, '0.08': 800 })
    expect(r.taxCents).toBe(2400)
    expect(r.netCents + r.taxCents).toBe(22400)
  })

  it('0%/exempt items add no tax; net + tax still == gross', () => {
    const r = splitPaymentIvaByOrderRates(15000, [
      { rate: 0.16, grossCents: 11600 },
      { rate: 0, grossCents: 3400 },
    ])
    expect(r.taxByRate).toEqual({ '0.16': 1600 })
    expect(r.netCents + r.taxCents).toBe(15000)
  })

  it('PARTIAL / split payment allocates proportionally and still cuadra', () => {
    // Order is 50/50 16%/8% (gross 20000), customer pays only half (10000).
    const r = splitPaymentIvaByOrderRates(10000, [
      { rate: 0.16, grossCents: 10000 },
      { rate: 0.08, grossCents: 10000 },
    ])
    expect(r.netCents + r.taxCents).toBe(10000) // exact, no cent lost
    // ~half of each rate's IVA
    expect(Object.keys(r.taxByRate).sort()).toEqual(['0.08', '0.16'])
  })

  it('custom-amount order (NO items) falls back to flat 16%', () => {
    const r = splitPaymentIvaByOrderRates(2500, [])
    expect(r.netCents).toBe(splitIvaIncluded(2500, 0.16).netCents)
    expect(r.netCents + r.taxCents).toBe(2500)
  })

  it('splitIvaByRate: Σnet + Σtax === Σgross for any mix', () => {
    const r = splitIvaByRate([
      { grossCents: 12345, rate: 0.16 },
      { grossCents: 6789, rate: 0.08 },
      { grossCents: 4321, rate: 0 },
    ])
    expect(r.netCents + r.taxCents).toBe(12345 + 6789 + 4321)
  })
})

describe('grossByRateFromItems (group order items → gross by real rate)', () => {
  it('groups two items of the same rate into one bucket (cents)', () => {
    const g = grossByRateFromItems([
      { unitPrice: 100, quantity: 2, discountAmount: 0, taxRate: 0.16 }, // 200
      { unitPrice: 50, quantity: 1, discountAmount: 0, taxRate: 0.16 }, // 50
    ])
    expect(g).toEqual([{ rate: 0.16, grossCents: 25000 }])
  })

  it('keeps distinct rates in distinct buckets (mixed 16% + 8%)', () => {
    const g = grossByRateFromItems([
      { unitPrice: 116, quantity: 1, discountAmount: 0, taxRate: 0.16 },
      { unitPrice: 108, quantity: 1, discountAmount: 0, taxRate: 0.08 },
    ])
    expect(g).toEqual([
      { rate: 0.16, grossCents: 11600 },
      { rate: 0.08, grossCents: 10800 },
    ])
  })

  it('applies quantity and per-line discount before grouping', () => {
    // 3 × $40 = 120, minus $15 discount → $105 gross
    const g = grossByRateFromItems([{ unitPrice: 40, quantity: 3, discountAmount: 15, taxRate: 0.16 }])
    expect(g).toEqual([{ rate: 0.16, grossCents: 10500 }])
  })

  it('null taxRate falls back to the default rate (16%, same as the CFDI)', () => {
    const g = grossByRateFromItems([{ unitPrice: 100, quantity: 1, discountAmount: 0, taxRate: null }])
    expect(g).toEqual([{ rate: 0.16, grossCents: 10000 }])
  })

  it('honors a custom default rate for null-rate items', () => {
    const g = grossByRateFromItems([{ unitPrice: 100, quantity: 1, discountAmount: 0, taxRate: null }], 0.08)
    expect(g).toEqual([{ rate: 0.08, grossCents: 10000 }])
  })

  it('skips 0-gross lines (fully discounted / free)', () => {
    const g = grossByRateFromItems([
      { unitPrice: 50, quantity: 1, discountAmount: 50, taxRate: 0.16 }, // net 0 → skipped
      { unitPrice: 100, quantity: 1, discountAmount: 0, taxRate: 0.16 },
    ])
    expect(g).toEqual([{ rate: 0.16, grossCents: 10000 }])
  })

  it('empty items → [] (custom-amount sale, caller falls back)', () => {
    expect(grossByRateFromItems([])).toEqual([])
  })

  it('feeds splitPaymentIvaByOrderRates end-to-end: 8% order taxes at 8%', () => {
    const g = grossByRateFromItems([{ unitPrice: 108, quantity: 1, discountAmount: 0, taxRate: 0.08 }])
    const s = splitPaymentIvaByOrderRates(10800, g)
    expect(s.taxCents).toBe(800)
    expect(s.taxByRate).toEqual({ '0.08': 800 })
  })
})
