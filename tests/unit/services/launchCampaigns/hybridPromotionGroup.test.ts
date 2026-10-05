import { FEATURE_CATALOG } from '@/config/featureCatalog'
import { LISTABLE_FEATURE_CODES } from '@/services/launchCampaigns/hybridListPrice.service'
import { discounted, targetFeatureCodes } from '@/services/launchCampaigns/hybridPromotionGroup.service'

describe('discounted (Review Focus 3: shown, quoted and charged to the cent)', () => {
  it('rounds half-up to cents', () => {
    expect(discounted(599, 20)).toBe(479.2)
    expect(discounted(99.99, 15)).toBe(84.99) // 84.9915 → 84.99
    expect(discounted(10.05, 50)).toBe(5.03) // 5.025 → 5.03 (and BELOW_MINIMUM in preview)
  })

  it('never drifts in binary floating point', () => {
    // 0.1 + 0.2 territory: 19.99 × 0.7 = 13.993 → 13.99, and 1.005-style halves round up, not down.
    expect(discounted(19.99, 30)).toBe(13.99)
    expect(discounted(2.01, 50)).toBe(1.01) // 1.005 → 1.01
  })
})

describe('targetFeatureCodes', () => {
  it('ALL_FEATURES is every listable function, sorted', () => {
    expect(targetFeatureCodes({ kind: 'ALL_FEATURES' })).toEqual([...LISTABLE_FEATURE_CODES].sort())
  })

  it('CATEGORIES keeps only listable functions of those categories', () => {
    const money = FEATURE_CATALOG.filter(e => e.category === 'money' && e.featureCode && LISTABLE_FEATURE_CODES.includes(e.featureCode))
    expect(targetFeatureCodes({ kind: 'CATEGORIES', categories: ['money'] })).toEqual(money.map(e => e.featureCode!).sort())
  })

  it('FEATURES is intersected with the listable ones, deduplicated and sorted', () => {
    // CHATBOT is free and WHITE_LABEL_DASHBOARD is sold by quote: neither takes a list price, so neither is discounted.
    expect(
      targetFeatureCodes({ kind: 'FEATURES', featureCodes: ['RESERVATIONS', 'CHATBOT', 'CFDI', 'WHITE_LABEL_DASHBOARD', 'CFDI'] }),
    ).toEqual(['CFDI', 'RESERVATIONS'])
  })
})
