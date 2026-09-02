import { buildInitialCommercialDraftV1, COMMERCIAL_INITIAL_SOURCE_KEY } from '@/services/commercial/commercialInitialCatalog'
import { normalizeAndValidateCommercialDraft } from '@/services/commercial/commercialValidation.service'
import { getCommercialCapabilityKind } from '@/services/commercial/commercialCapabilityRegistry'

describe('buildInitialCommercialDraftV1', () => {
  it('contains the frozen Mexico offer as an inactive-by-default draft seed', () => {
    const initial = buildInitialCommercialDraftV1()
    const product = (code: string) => initial.draft.products.find(item => item.code === code)
    const price = (code: string) => initial.draft.prices.find(item => item.code === code)?.amount

    expect(initial.sourceKey).toBe(COMMERCIAL_INITIAL_SOURCE_KEY)
    expect(initial.draft.products.filter(item => item.kind === 'MODULE')).toHaveLength(9)
    expect(product('FREE')).toBeDefined()
    expect(price('FREE_MONTHLY')).toBe('0.00')
    expect(price('PRO_MONTHLY')).toBe('999.00')
    expect(price('PRO_ANNUAL')).toBe('9990.00')
    expect(price('PREMIUM_MONTHLY')).toBe('1699.00')
    expect(price('PREMIUM_ANNUAL')).toBe('16990.00')
    expect(product('ENTERPRISE')?.salesMode).toBe('CONTACT')
    expect(price('POS_MONTHLY')).toBe('249.00')
    expect(
      initial.draft.prices
        .filter(item => item.productCode?.endsWith('_MODULE'))
        .map(item => item.amount)
        .sort(),
    ).toEqual(['179.00', '179.00', '179.00', '179.00', '179.00', '179.00', '269.00', '269.00', '269.00'])
    expect(price('ALL_MODULES_MONTHLY')).toBe('1999.00')
    expect(initial.draft.bundleItems).toHaveLength(9)
    expect(
      initial.draft.featureBindings.every(binding => binding.capabilityKind === getCommercialCapabilityKind(binding.capabilityCode)),
    ).toBe(true)
    expect(initial.draft.featureBindings.find(binding => binding.capabilityCode === 'TABLE_SERVICE')?.capabilityKind).toBe('FEATURE')
    expect(initial.draft.featureBindings.find(binding => binding.capabilityCode === 'COMMISSIONS')?.capabilityKind).toBe('MODULE')
  })

  it('is publishable but contains no retired founder or campaign base price', () => {
    const initial = buildInitialCommercialDraftV1()
    const result = normalizeAndValidateCommercialDraft(initial.draft)
    const serialized = JSON.stringify(initial)

    expect(result.valid).toBe(true)
    expect(serialized).not.toMatch(/fundador|499\.00|"22\.00"|"50\.00"/i)
  })

  it('returns a fresh deterministic graph on every invocation', () => {
    const first = buildInitialCommercialDraftV1()
    const second = buildInitialCommercialDraftV1()
    first.draft.products[0].name = 'Mutado'

    expect(second.draft.products[0].name).toBe('Free')
    expect(buildInitialCommercialDraftV1()).toEqual(second)
  })
})
