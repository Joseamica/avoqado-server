import { compileHybridPublication, previewHybridOffer } from '@/services/launchCampaigns/hybridOffer.service'

const terms = {
  currency: 'MXN',
  interval: 'MONTHLY',
  price: 379.5,
  taxIncluded: true,
  promotionCycles: 4,
  renewal: { kind: 'REPRICE', price: 529 },
} as const
const fixed = { schemaVersion: 1, kind: 'FEATURES', featureCodes: ['LOYALTY_PROGRAM'], terms } as const

describe('published hybrid offer composition', () => {
  it.each(['PRO', 'PREMIUM'])('publishes exactly the reviewed %s catalog without assisted capabilities', planTier => {
    const offer = { schemaVersion: 1, kind: 'PLAN', planTier, terms }
    const publication = compileHybridPublication(offer)
    const preview = previewHybridOffer({ offer, catalog: { page: 1, pageSize: 100 } })
    expect(publication.includedFeatureCodes).toEqual(
      preview.catalog.items.flatMap(row => (row.featureCode ? [row.featureCode] : [])).sort(),
    )
    expect(publication.includedFeatureCodes).not.toContain('WHITE_LABEL_DASHBOARD')
    expect(publication.includedFeatureCodes).not.toContain('MASTER_CATALOG')
    expect(publication.includedFeatureCodes).toContain('AGGREGATOR_PASSES') // pases de TotalPass/Wellhub: Pro (D4, 2-oct)
  })
  it('snapshots a fixed offer and its exact total without inventing per-feature prices', () => {
    const publication = compileHybridPublication(fixed)
    expect(publication.definition).toMatchObject({ featureCodes: ['LOYALTY_PROGRAM'], terms: { price: 379.5, renewal: { price: 529 } } })
    expect(publication.includedFeatureCodes).toEqual(['LOYALTY_PROGRAM'])
    expect(publication.definitionHash).toMatch(/^[a-f0-9]{64}$/)
  })
  // Spec §4.2 rule 1: a single function publishes alone (the quote checks its dependency, with dates); a bundle does not.
  it('rejects a fixed bundle missing its paid dependency, but publishes that function alone', () => {
    expect(() => compileHybridPublication({ ...fixed, featureCodes: ['UPSELL_AI', 'CFDI'] })).toThrow(/requiere|dependencia/i)
    expect(() => compileHybridPublication({ ...fixed, featureCodes: ['AGGREGATOR_PASSES', 'CFDI'] })).toThrow(/requiere|dependencia/i) // R36
    expect(compileHybridPublication({ ...fixed, featureCodes: ['UPSELL_AI'] }).includedFeatureCodes).toEqual(['UPSELL_AI'])
  })
  it('rejects a choice pool containing a dependency that cannot fit in N', () => {
    expect(() =>
      compileHybridPublication({
        schemaVersion: 1,
        kind: 'CHOICE_BUNDLE',
        terms,
        choiceCount: 1,
        eligibleFeatureCodes: ['UPSELL_AI', 'UPSELL'],
      }),
    ).toThrow(/dependencia|cantidad/i)
  })
  it('rejects a choice pool missing a required paid capability', () => {
    expect(() =>
      compileHybridPublication({
        schemaVersion: 1,
        kind: 'CHOICE_BUNDLE',
        terms,
        choiceCount: 2,
        eligibleFeatureCodes: ['UPSELL_AI', 'CFDI'],
      }),
    ).toThrow(/dependencia|requiere/i)
  })
  it.each([1, 2, 3, 4])('can publish N=%i using the complete eligible pool', n => {
    const pub = compileHybridPublication({
      schemaVersion: 1,
      kind: 'CHOICE_BUNDLE',
      terms,
      choiceCount: n,
      eligibleFeatureCodes: ['LOYALTY_PROGRAM', 'CFDI', 'PROMOTIONS', 'TABLE_SERVICE'],
    })
    expect(pub.definition).toMatchObject({ choiceCount: n, terms: { price: 379.5 } })
    expect(pub.includedFeatureCodes).toEqual([])
  })
  it('freezes plan inclusions independently of later catalog publications', () => {
    const pub = compileHybridPublication({ schemaVersion: 1, kind: 'PLAN', planTier: 'PRO', terms })
    expect(pub.includedFeatureCodes).toContain('LOYALTY_PROGRAM')
    expect(pub.includedFeatureCodes).not.toContain('CFDI')
    expect(pub.includedFeatureCodes).not.toContain('FUTURE_NOT_PUBLISHED')
  })
  it('keeps existing invalid-currency and free-feature protections', () => {
    expect(() => compileHybridPublication({ ...fixed, terms: { ...terms, currency: 'USD' } })).toThrow()
    expect(() => compileHybridPublication({ ...fixed, featureCodes: ['CHATBOT'] })).toThrow()
  })
})
