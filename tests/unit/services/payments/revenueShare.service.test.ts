/**
 * computeRevenueSplit — función pura que reparte el fee de una transacción entre
 * provider, agregador y Avoqado. Spec:
 * docs/superpowers/specs/2026-05-22-revenue-share-fee-model-design.md
 */
import { computeRevenueSplit, type RevenueSplitInput } from '@/services/payments/revenueShare.service'

const base: Omit<RevenueSplitInput, 'share'> = {
  amount: 100,
  cardType: 'CREDIT',
  providerCostRate: 0.02,
  providerCostIncludesTax: false,
  venueChargeRate: 0.05,
  venueChargeIncludesTax: false,
}

describe('computeRevenueSplit', () => {
  it('sin share → toda la ganancia a Avoqado (comportamiento histórico)', () => {
    const r = computeRevenueSplit({ ...base, share: null })
    expect(r.providerNet).toBeCloseTo(2)
    expect(r.avoqadoNet).toBeCloseTo(3)
    expect(r.aggregatorNet).toBe(0)
    // tramo fields: no-config → all from provider margin, none from aggregator
    expect(r.avoqadoFromAggregatorMargin).toBe(0)
    expect(r.avoqadoFromProviderMargin).toBeCloseTo(r.avoqadoNet)
  })

  it('directo: margen partido por avoqadoShareOfProviderMargin', () => {
    const r = computeRevenueSplit({
      ...base,
      share: {
        aggregatorPrice: null,
        aggregatorPriceIncludesTax: false,
        avoqadoShareOfProviderMargin: 0.5,
        avoqadoShareOfAggregatorMargin: null,
        taxRate: 0.16,
      },
    })
    // margen = 5 − 2 = 3 ; Avoqado 50% = 1.5 ; provider = 5 − 1.5 = 3.5
    expect(r.providerNet).toBeCloseTo(3.5)
    expect(r.avoqadoNet).toBeCloseTo(1.5)
    expect(r.aggregatorNet).toBe(0)
    expect(r.providerNet + r.avoqadoNet + r.aggregatorNet).toBeCloseTo(5)
    // tramo fields: direct → all from provider margin, none from aggregator
    expect(r.avoqadoFromAggregatorMargin).toBe(0)
    expect(r.avoqadoFromProviderMargin).toBeCloseTo(r.avoqadoNet)
  })

  it('con agregador: 2 márgenes, 2 splits, suma = fee al venue', () => {
    const r = computeRevenueSplit({
      ...base,
      venueChargeRate: 0.07,
      share: {
        aggregatorPrice: { DEBIT: 0.04, CREDIT: 0.04, AMEX: 0.04, INTERNATIONAL: 0.04 },
        aggregatorPriceIncludesTax: false,
        avoqadoShareOfProviderMargin: 0.5,
        avoqadoShareOfAggregatorMargin: 0.5,
        taxRate: 0.16,
      },
    })
    // M1 = 4 − 2 = 2 → Avoqado 1, provider 1 ; M2 = 7 − 4 = 3 → Avoqado 1.5, agg 1.5
    expect(r.providerNet).toBeCloseTo(3)
    expect(r.avoqadoNet).toBeCloseTo(2.5)
    expect(r.aggregatorNet).toBeCloseTo(1.5)
    expect(r.providerNet + r.avoqadoNet + r.aggregatorNet).toBeCloseTo(7)
    // tramo fields: aggregator case — tramos sum to avoqadoNet
    expect(r.avoqadoFromProviderMargin).toBeCloseTo(1) // Avoqado's cut of M1
    expect(r.avoqadoFromAggregatorMargin).toBeCloseTo(1.5) // Avoqado's cut of M2
    expect(r.avoqadoFromProviderMargin + r.avoqadoFromAggregatorMargin).toBeCloseTo(r.avoqadoNet)
  })

  it('share 0-100 (Avoqado se queda 0 del margen agregador → todo al agregador)', () => {
    const r = computeRevenueSplit({
      ...base,
      venueChargeRate: 0.07,
      share: {
        aggregatorPrice: { DEBIT: 0.04, CREDIT: 0.04, AMEX: 0.04, INTERNATIONAL: 0.04 },
        aggregatorPriceIncludesTax: false,
        avoqadoShareOfProviderMargin: 0.5,
        avoqadoShareOfAggregatorMargin: 0,
        taxRate: 0.16,
      },
    })
    expect(r.aggregatorNet).toBeCloseTo(3) // todo el M2
    expect(r.avoqadoNet).toBeCloseTo(1) // solo su parte del M1
    expect(r.providerNet).toBeCloseTo(3) // costo + su parte del M1
  })

  it('IVA "+ IVA" (includesTax = false) calcula IVA por capa como pass-through', () => {
    const r = computeRevenueSplit({ ...base, share: null })
    // venueCharge pre-IVA = 5 ; IVA venue = 5 × 0.16 = 0.80
    expect(r.ivaByLayer.venue).toBeCloseTo(0.8)
    expect(r.ivaByLayer.provider).toBeCloseTo(0.32) // 2 × 0.16
    expect(r.ivaByLayer.aggregator).toBe(0)
  })

  it('IVA ya incluido (includesTax = true) → IVA por capa = 0', () => {
    const r = computeRevenueSplit({
      ...base,
      providerCostIncludesTax: true,
      venueChargeIncludesTax: true,
      share: null,
    })
    expect(r.ivaByLayer.venue).toBe(0)
    expect(r.ivaByLayer.provider).toBe(0)
  })
})
