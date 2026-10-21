import { buildHybridQuote, unusedPaidCredit } from '@/services/launchCampaigns/hybridQuote'
import { compileHybridPublication } from '@/services/launchCampaigns/hybridOffer.service'

const terms = {
  currency: 'MXN',
  interval: 'MONTHLY',
  price: 379.5,
  taxIncluded: true,
  promotionCycles: 4,
  renewal: { kind: 'REPRICE', price: 529 },
} as const
const publication = (id: string, offer: object) => ({ id, name: id, ...compileHybridPublication({ schemaVersion: 1, terms, ...offer }) })
const bundle = publication('bundle', {
  kind: 'CHOICE_BUNDLE',
  choiceCount: 2,
  eligibleFeatureCodes: ['CFDI', 'LOYALTY_PROGRAM', 'PROMOTIONS', 'TABLE_SERVICE'],
})
const pro = publication('pro', { kind: 'PLAN', planTier: 'PRO' })
const input = (lines: any[], existing: any[] = []) => ({
  lines,
  existing,
  retainedFeatureCodes: [] as string[],
  dropFeatureCodes: [] as string[],
})

describe('immutable hybrid quote composition', () => {
  it('prices a configurable bundle as one published unit and keeps its exact renewal', () => {
    const quote = buildHybridQuote(input([{ publication: bundle, selectedFeatureCodes: ['CFDI', 'LOYALTY_PROGRAM'] }]))
    expect(quote.total).toBe('379.50')
    expect(quote.lines[0]).toMatchObject({ featureCodes: ['CFDI', 'LOYALTY_PROGRAM'], terms: { price: 379.5, renewal: { price: 529 } } })
    expect(quote.lines[0]).not.toHaveProperty('pricePerFeature')
  })
  it.each([[], ['CFDI'], ['CFDI', 'CFDI'], ['CFDI', 'CHATBOT'], ['CFDI', 'LOYALTY_PROGRAM', 'PROMOTIONS']].map(choices => ({ choices })))(
    'rejects invalid choices $choices',
    ({ choices }) => {
      expect(() => buildHybridQuote(input([{ publication: bundle, selectedFeatureCodes: choices }]))).toThrow()
    },
  )
  it('allows a plan and a paid extra it does not include', () => {
    const cfdi = publication('cfdi', { kind: 'FEATURES', featureCodes: ['CFDI'] })
    expect(buildHybridQuote(input([{ publication: pro }, { publication: cfdi }])).total).toBe('759.00')
  })
  it('rejects overlap between a plan and another line regardless of order', () => {
    for (const lines of [
      [{ publication: pro }, { publication: bundle, selectedFeatureCodes: ['CFDI', 'LOYALTY_PROGRAM'] }],
      [{ publication: bundle, selectedFeatureCodes: ['CFDI', 'LOYALTY_PROGRAM'] }, { publication: pro }],
    ]) {
      expect(() => buildHybridQuote(input(lines))).toThrow(/incluida|repetida/i)
    }
  })
  it('names the repeated capability as the customer knows it, never by its internal code', () => {
    const loyalty = publication('loyalty', { kind: 'FEATURES', featureCodes: ['LOYALTY_PROGRAM'] })
    const lines = [{ publication: bundle, selectedFeatureCodes: ['CFDI', 'LOYALTY_PROGRAM'] }, { publication: loyalty }]
    expect(() => buildHybridQuote(input(lines))).toThrow('Programa de lealtad ya está incluida; no se cobra otra vez.')
  })
  it('does not charge for a capability retained from another paid origin', () => {
    expect(() =>
      buildHybridQuote({
        ...input([{ publication: bundle, selectedFeatureCodes: ['CFDI', 'LOYALTY_PROGRAM'] }]),
        retainedFeatureCodes: ['CFDI'],
      }),
    ).toThrow(/incluida/i)
  })
  it('requires replacing the whole partly absorbed bundle without silently losing its remainder', () => {
    const existing = [{ subscriptionId: 'sub_old', featureCodes: ['LOYALTY_PROGRAM', 'CFDI'] }]
    expect(() => buildHybridQuote(input([{ publication: pro }], existing))).toThrow(/CFDI/)
    const cfdi = publication('cfdi', { kind: 'FEATURES', featureCodes: ['CFDI'] })
    expect(buildHybridQuote(input([{ publication: pro }, { publication: cfdi }], existing)).replaces).toEqual(['sub_old'])
    expect(buildHybridQuote({ ...input([{ publication: pro }], existing), dropFeatureCodes: ['CFDI'] }).droppedFeatureCodes).toEqual([
      'CFDI',
    ])
  })
  it('rejects two base plans, duplicate products and an oversized cart', () => {
    expect(() => buildHybridQuote(input([{ publication: pro }, { publication: pro }]))).toThrow()
    expect(() => buildHybridQuote(input(Array.from({ length: 9 }, () => ({ publication: pro }))))).toThrow()
  })
  // Spec §4.2 rule 2: the dependency is checked once, with dates, over the whole purchase (retained + every line).
  it('leaves a missing dependency to the whole-purchase check instead of rejecting the line alone', () => {
    const inventory = publication('inventory', {
      kind: 'CHOICE_BUNDLE',
      choiceCount: 2,
      eligibleFeatureCodes: ['AUTO_REORDER', 'INVENTORY_TRACKING', 'CFDI'],
    })
    expect(buildHybridQuote(input([{ publication: inventory, selectedFeatureCodes: ['AUTO_REORDER', 'CFDI'] }])).featureCodes).toEqual([
      'AUTO_REORDER',
      'CFDI',
    ])
    // Every other selection rule still applies to the line.
    expect(() => buildHybridQuote(input([{ publication: inventory, selectedFeatureCodes: ['AUTO_REORDER'] }]))).toThrow(/exactamente/)
  })
  it('uses frozen plan inclusions, even if a future catalog changes', () => {
    expect(buildHybridQuote(input([{ publication: { ...pro, includedFeatureCodes: ['LOYALTY_PROGRAM'] } }])).featureCodes).toEqual([
      'LOYALTY_PROGRAM',
    ])
  })
})

describe('credit for actually funded unused coverage', () => {
  const source = { paid: '379.50', refunded: '0', alreadyCredited: '0', start: 1000, end: 31000, effectiveAt: 16000 }
  it('calculates in pesos, to the cent, over the actual paid interval', () => expect(unusedPaidCredit(source)).toBe('189.75'))
  it('never credits unpaid, refunded, previously credited or expired value', () => {
    expect(unusedPaidCredit({ ...source, paid: '0' })).toBe('0.00')
    expect(unusedPaidCredit({ ...source, refunded: '379.50' })).toBe('0.00')
    expect(unusedPaidCredit({ ...source, alreadyCredited: '100' })).toBe('89.75')
    expect(unusedPaidCredit({ ...source, effectiveAt: 32000 })).toBe('0.00')
  })
  it('caps credit before the period starts and rounds down instead of minting money', () => {
    expect(unusedPaidCredit({ ...source, effectiveAt: 0 })).toBe('379.50')
    expect(unusedPaidCredit({ ...source, paid: '1', start: 0, end: 3, effectiveAt: 1 })).toBe('0.66')
  })
  it('rejects invalid coverage and negative money', () => {
    expect(() => unusedPaidCredit({ ...source, end: source.start })).toThrow()
    expect(() => unusedPaidCredit({ ...source, paid: '-1' })).toThrow()
  })
})
