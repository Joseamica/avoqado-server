import { previewHybridOffer } from '@/services/launchCampaigns/hybridOffer.service'

const codes = ['CFDI', 'INVENTORY_TRACKING', 'LOYALTY_PROGRAM', 'RESERVATIONS']
const terms = {
  currency: 'MXN',
  interval: 'MONTHLY',
  price: 250,
  taxIncluded: true,
  promotionCycles: 3,
  renewal: { kind: 'REPRICE', price: 490 },
}
const choice = (choiceCount = 3, price = 250) => ({
  schemaVersion: 1,
  kind: 'CHOICE_BUNDLE',
  eligibleFeatureCodes: codes,
  choiceCount,
  terms: { ...terms, price },
})

describe('Hybrid offer definitions and selection preview', () => {
  it.each([
    [1, 89],
    [2, 179.9],
    [3, 250],
    [4, 699],
  ])('accepts exactly %i choices at one total price of %s pesos', (count, price) => {
    const result = previewHybridOffer({ offer: choice(count, price), selectedFeatureCodes: codes.slice(0, count) })
    expect(result.selection.valid).toBe(true)
    expect(result.selection.requiredCount).toBe(count)
    expect(result.terms.price).toBe(price)
    expect(result.terms.renewal).toEqual({ kind: 'REPRICE', price: 490 })
    expect(result.purchaseAvailable).toBe(false)
    expect(result.mode).toBe('PREVIEW_ONLY')
  })

  it.each([[], codes.slice(0, 2), codes].map(selection => [selection]))(
    'explains incomplete/excess selections without changing the price',
    selectedFeatureCodes => {
      const result = previewHybridOffer({ offer: choice(), selectedFeatureCodes })
      expect(result.selection.valid).toBe(false)
      expect(result.selection.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'CHOICE_COUNT' })]))
      expect(result.terms.price).toBe(250)
    },
  )

  it.each(
    [
      ['CFDI', 'CFDI'],
      ['CFDI', 'NO_SUCH_FEATURE'],
      ['CFDI', 'CHATBOT'],
      ['CFDI', 'UPSELL'],
    ].map(selection => [selection]),
  )('rejects duplicates and codes outside the offer: %j', selectedFeatureCodes => {
    expect(() => previewHybridOffer({ offer: choice(), selectedFeatureCodes })).toThrow(
      expect.objectContaining({
        statusCode: 400,
        code: selectedFeatureCodes[0] === selectedFeatureCodes[1] ? 'HYBRID_OFFER_DUPLICATE' : 'HYBRID_OFFER_SELECTION_OUTSIDE',
      }),
    )
  })

  it.each(['CHATBOT', 'BASE_POS', 'WHITE_LABEL_DASHBOARD', 'MASTER_CATALOG', 'ADVANCED_ANALYTICS', 'PLAN_PRO'])(
    'does not turn %s into a billable feature from presentation metadata',
    code => {
      expect(() => previewHybridOffer({ offer: { ...choice(1), eligibleFeatureCodes: [code] }, selectedFeatureCodes: [code] })).toThrow()
    },
  )

  it('excludes features included by a plan or another grant without spending a slot', () => {
    const result = previewHybridOffer({
      offer: choice(2),
      selectedFeatureCodes: ['CFDI', 'LOYALTY_PROGRAM'],
      scenario: { planTier: 'PRO', grantedFeatureCodes: ['CFDI'] },
    })
    expect(result.selection.valid).toBe(false)
    expect(result.selection.eligibleSelectedCount).toBe(0)
    expect(result.selection.issues.map(issue => issue.code)).toContain('INSUFFICIENT_ELIGIBLE_FEATURES')
    expect(result.catalog.items.find(entry => entry.featureCode === 'CFDI')?.alreadyIncluded).toBe(true)
    expect(result.catalog.items.find(entry => entry.featureCode === 'LOYALTY_PROGRAM')?.alreadyIncluded).toBe(true)
  })

  it('keeps selection independent of the visible catalog page and search', () => {
    const selectedFeatureCodes = codes.slice(0, 3)
    const result = previewHybridOffer({ offer: choice(), selectedFeatureCodes, catalog: { q: 'reservas', pageSize: 1 } })
    expect(result.catalog.total).toBe(1)
    expect(result.catalog.items[0].featureCode).toBe('RESERVATIONS')
    expect(result.selection.featureCodes).toEqual([...selectedFeatureCodes].sort())
    expect(result.selection.valid).toBe(true)
    expect(() => previewHybridOffer({ offer: choice(), catalog: { pageSize: 101 } })).toThrow()
  })

  it('requires paid dependencies to be selected or already included, without adding them or charging extra', () => {
    const offer = { ...choice(1), eligibleFeatureCodes: ['UPSELL_AI', 'UPSELL'] }
    const missing = previewHybridOffer({ offer, selectedFeatureCodes: ['UPSELL_AI'] })
    expect(missing.selection.valid).toBe(false)
    expect(missing.selection.issues).toContainEqual(
      expect.objectContaining({ code: 'MISSING_DEPENDENCY', featureCode: 'UPSELL_AI', requiredFeatureCode: 'UPSELL' }),
    )
    expect(missing.selection.featureCodes).toEqual(['UPSELL_AI'])
    expect(previewHybridOffer({ offer, selectedFeatureCodes: ['UPSELL_AI'], scenario: { planTier: 'PRO' } }).selection.valid).toBe(true)
    expect(previewHybridOffer({ offer: { ...offer, choiceCount: 2 }, selectedFeatureCodes: ['UPSELL_AI', 'UPSELL'] }).selection.valid).toBe(
      true,
    )
    const inventory = previewHybridOffer({
      offer: { ...choice(1), eligibleFeatureCodes: ['AUTO_REORDER'] },
      selectedFeatureCodes: ['AUTO_REORDER'],
    })
    expect(inventory.selection.issues).toContainEqual(expect.objectContaining({ requiredFeatureCode: 'INVENTORY_TRACKING' }))
  })

  it('reports operational prerequisites separately from the commercial selection', () => {
    const result = previewHybridOffer({
      offer: { ...choice(1), eligibleFeatureCodes: ['SERIALIZED_INVENTORY'] },
      selectedFeatureCodes: ['SERIALIZED_INVENTORY'],
    })
    expect(result.selection.valid).toBe(true)
    expect(result.requirements).toEqual([
      expect.objectContaining({ featureCode: 'SERIALIZED_INVENTORY', message: expect.stringContaining('módulo') }),
    ])
    expect(result.purchaseAvailable).toBe(false)
  })

  it('fixes feature offers and plans without asking the customer to choose N', () => {
    const fixed = previewHybridOffer({ offer: { schemaVersion: 1, kind: 'FEATURES', featureCodes: codes.slice(0, 2), terms } })
    expect(fixed.selection.featureCodes).toEqual(codes.slice(0, 2).sort())
    expect(fixed.selection.valid).toBe(true)
    expect(fixed.selection.requiredCount).toBeNull()
    expect(() =>
      previewHybridOffer({
        offer: { schemaVersion: 1, kind: 'FEATURES', featureCodes: codes.slice(0, 2), terms },
        selectedFeatureCodes: ['RESERVATIONS'],
      }),
    ).toThrow()
    const plan = previewHybridOffer({ offer: { schemaVersion: 1, kind: 'PLAN', planTier: 'PRO', terms } })
    expect(plan.selection.requiredCount).toBeNull()
    expect(plan.selection.valid).toBe(true)
    expect(plan.selection.featureCodes).toEqual([])
    expect(plan.catalog.items.some(entry => entry.featureCode === 'CFDI')).toBe(false)
  })

  it('does not accept overlapping fixed offers as a valid selection', () => {
    const result = previewHybridOffer({
      offer: { schemaVersion: 1, kind: 'FEATURES', featureCodes: ['CFDI'], terms },
      scenario: { grantedFeatureCodes: ['CFDI'] },
    })
    expect(result.selection.valid).toBe(false)
    expect(result.selection.issues.map(issue => issue.code)).toContain('ALREADY_INCLUDED')
  })

  it('keeps a canonical hash and rejects an obsolete definition', () => {
    const first = previewHybridOffer({ offer: choice() })
    expect(previewHybridOffer({ offer: { ...choice(), eligibleFeatureCodes: [...codes].reverse() } }).definitionHash).toBe(
      first.definitionHash,
    )
    expect(previewHybridOffer({ offer: choice(3, 251) }).definitionHash).not.toBe(first.definitionHash)
    expect(() => previewHybridOffer({ offer: choice(2), expectedDefinitionHash: first.definitionHash })).toThrow(
      expect.objectContaining({ statusCode: 409, code: 'HYBRID_OFFER_STALE' }),
    )
  })

  it.each([0, -1, 9.99, 1.005, NaN, Infinity, 100_001, '250'])('rejects invalid prices without rounding them: %s', price => {
    expect(() => previewHybridOffer({ offer: { ...choice(), terms: { ...terms, price } } })).toThrow()
  })

  it('requires an explicit renewal and rejects unsupported mechanics, revisions, and fields', () => {
    for (const offer of [
      { ...choice(), kind: 'CUSTOM_CAMPAIGN' },
      { ...choice(), schemaVersion: 2 },
      { ...choice(), terms: { ...terms, renewal: undefined } },
      { ...choice(), terms: { ...terms, promotionCycles: null } },
      { ...choice(), terms: { ...terms, interval: 'ANNUAL' } },
      { ...choice(), terms: { ...terms, taxIncluded: false } },
      { ...choice(), discount: 0.5 },
      { ...choice(), eligibleFeatureCodes: ['CFDI', 'CFDI'] },
      { ...choice(), choiceCount: 5 },
    ])
      expect(() => previewHybridOffer({ offer })).toThrow()
    expect(previewHybridOffer({ offer: { ...choice(), terms: { ...terms, renewal: { kind: 'END' } } } }).terms.renewal).toEqual({
      kind: 'END',
    })
    expect(
      previewHybridOffer({ offer: { ...choice(), terms: { ...terms, promotionCycles: null, renewal: { kind: 'SAME_PRICE' } } } }).terms
        .renewal,
    ).toEqual({ kind: 'SAME_PRICE' })
  })
})
