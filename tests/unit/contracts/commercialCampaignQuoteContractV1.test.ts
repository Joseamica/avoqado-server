import Ajv from 'ajv'
import campaignSchema from '@/contracts/commercial/commercial-campaign-v1.schema.json'
import quoteSchema from '@/contracts/commercial/commercial-quote-v1.schema.json'
import campaignFixture from '@/contracts/commercial/fixtures/campaign-pos-50-v1.json'
import quoteFixture from '@/contracts/commercial/fixtures/quote-pos-50-v1.json'
import pricingVectors from '@/contracts/commercial/fixtures/pricing-vectors-v1.json'
import {
  COMMERCIAL_CAMPAIGN_CONTRACT_HASH,
  COMMERCIAL_CONTRACT_HASH,
  COMMERCIAL_QUOTE_CONTRACT_HASH,
} from '@/contracts/commercial/contractHash'

const ajv = new Ajv({ allErrors: true, jsonPointers: true })
const validateCampaign = ajv.compile(campaignSchema)
const validateQuote = ajv.compile(quoteSchema)

describe('Commercial campaign and quote contracts v1', () => {
  it('validates the golden POS $50 campaign without turning it into a base price', () => {
    expect(validateCampaign(campaignFixture)).toBe(true)
    expect(validateCampaign.errors).toBeNull()
    expect(campaignFixture.rules[0]).toMatchObject({ type: 'FIXED_PRICE', amountMinor: 5000, cycles: 3 })
    expect(COMMERCIAL_CAMPAIGN_CONTRACT_HASH).toMatch(/^[0-9a-f]{64}$/)
  })

  it('validates exact current and renewal totals including IVA', () => {
    expect(validateQuote(quoteFixture)).toBe(true)
    expect(validateQuote.errors).toBeNull()
    expect(quoteFixture.totals).toMatchObject({ subtotalMinor: 5000, taxMinor: 800, totalMinor: 5800 })
    expect(quoteFixture.renewal).toMatchObject({ subtotalMinor: 24900, taxMinor: 3984, totalMinor: 28884 })
    expect(COMMERCIAL_QUOTE_CONTRACT_HASH).toMatch(/^[0-9a-f]{64}$/)
    expect(COMMERCIAL_CONTRACT_HASH).toMatch(/^[0-9a-f]{64}$/)
  })

  it('rejects browser-authoritative money and unknown campaign fields', () => {
    const quote = { ...structuredClone(quoteFixture), stripePriceId: 'price_attacker' }
    const campaign = { ...structuredClone(campaignFixture), totalMinor: 1 }
    expect(validateQuote(quote)).toBe(false)
    expect(validateCampaign(campaign)).toBe(false)
  })

  it('freezes every approved campaign vector for TypeScript, Kotlin and Swift parity', () => {
    expect(pricingVectors.map(vector => vector.code)).toEqual([
      'POS_FIXED_50',
      'POS_FIXED_22',
      'TEN_PERCENT_POS',
      'TEN_PERCENT_MODULES',
      'TEN_PERCENT_POS_AND_MODULES',
    ])
    for (const vector of pricingVectors) {
      expect(validateCampaign(vector.campaign)).toBe(true)
      expect(vector.expected.totals.totalMinor).toBeGreaterThanOrEqual(0)
      expect(vector.expected.renewal.totalMinor).toBeGreaterThanOrEqual(vector.expected.totals.totalMinor)
    }
  })
})
