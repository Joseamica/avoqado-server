import campaignFixture from '@/contracts/commercial/fixtures/v2/campaign-pos-50.json'
import catalogFixture from '@/contracts/commercial/fixtures/v2/catalog-base.json'
import quoteFixture from '@/contracts/commercial/fixtures/v2/quote-pos-50-acquisition.json'
import {
  cloneJson,
  expectTrustedSnapshot,
  reconcileQuoteTotals,
  setCurrentSubtotal,
  validateQuoteAgainst,
  validationRule,
} from './commercialContractV2.testSupport'

describe('commercial quote authoritative money edge cases v2', () => {
  it.each(['FIXED_PRICE', 'BUNDLE_PRICE'])('rejects a published %s price that increases the current input', type => {
    const authority = cloneJson(campaignFixture) as any
    authority.rules[0].type = type
    authority.rules[0].amount = '300.00'
    const quote = cloneJson(quoteFixture) as any
    quote.lines[0].appliedCampaigns[0].type = type

    expect(validationRule(() => validateQuoteAgainst(quote, authority))).toBe('QUOTE_CAMPAIGN_CALCULATION')
  })

  it('rounds a half-cent percentage discount up at the published basis-point boundary', () => {
    const catalog = cloneJson(catalogFixture) as any
    catalog.products.find((product: any) => product.code === 'POS').prices[0].amount = '249.01'
    const authority = cloneJson(campaignFixture) as any
    authority.rules[0].type = 'PERCENT_OFF'
    authority.rules[0].percentBasisPoints = 5000
    delete authority.rules[0].amount
    const quote = cloneJson(quoteFixture) as any
    const line = quote.lines[0]
    line.unitAmount = '249.01'
    line.listSubtotal = '249.01'
    Object.assign(line.appliedCampaigns[0], {
      type: 'PERCENT_OFF',
      inputAmount: '249.01',
      discountAmount: '124.51',
      outputAmount: '124.50',
    })
    setCurrentSubtotal(line, '124.50')
    Object.assign(line, { renewalSubtotal: '249.01', renewalTax: '39.84', renewalTotal: '288.85' })
    reconcileQuoteTotals(quote)

    expectTrustedSnapshot(validateQuoteAgainst(quote, authority, catalog), quote)
  })

  it('multiplies a published amount-off by quantity before applying the cap', () => {
    const authority = cloneJson(campaignFixture) as any
    authority.rules[0].type = 'AMOUNT_OFF'
    authority.rules[0].amount = '60.00'
    const quote = cloneJson(quoteFixture) as any
    const line = quote.lines[0]
    line.quantity = 2
    line.listSubtotal = '498.00'
    Object.assign(line.appliedCampaigns[0], {
      type: 'AMOUNT_OFF',
      inputAmount: '498.00',
      discountAmount: '120.00',
      outputAmount: '378.00',
    })
    setCurrentSubtotal(line, '378.00')
    Object.assign(line, { renewalSubtotal: '498.00', renewalTax: '79.68', renewalTotal: '577.68' })
    reconcileQuoteTotals(quote)

    expectTrustedSnapshot(validateQuoteAgainst(quote, authority), quote)
  })
})
