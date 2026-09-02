import schema from './commercial-contract-v1.schema.json'
import fixture from './fixtures/catalog-v1.json'
import campaignSchema from './commercial-campaign-v1.schema.json'
import campaignFixture from './fixtures/campaign-pos-50-v1.json'
import quoteSchema from './commercial-quote-v1.schema.json'
import quoteFixture from './fixtures/quote-pos-50-v1.json'
import pricingVectors from './fixtures/pricing-vectors-v1.json'
import { hashCanonicalJsonV1 } from '@/services/master-catalog/catalogHash.service'

export const COMMERCIAL_CONTRACT_SCHEMA_VERSION = 1 as const

export function computeCommercialContractHash(contractSchema: unknown, goldenFixture: unknown): string {
  return hashCanonicalJsonV1('commercial-contract', {
    schemaVersion: COMMERCIAL_CONTRACT_SCHEMA_VERSION,
    schema: contractSchema,
    fixture: goldenFixture,
  })
}

export const COMMERCIAL_CATALOG_CONTRACT_HASH = computeCommercialContractHash(schema, fixture)

export const COMMERCIAL_CAMPAIGN_CONTRACT_HASH = hashCanonicalJsonV1('commercial-campaign-contract', {
  schemaVersion: COMMERCIAL_CONTRACT_SCHEMA_VERSION,
  schema: campaignSchema,
  fixture: campaignFixture,
})

export const COMMERCIAL_QUOTE_CONTRACT_HASH = hashCanonicalJsonV1('commercial-quote-contract', {
  schemaVersion: COMMERCIAL_CONTRACT_SCHEMA_VERSION,
  schema: quoteSchema,
  fixture: quoteFixture,
})

export const COMMERCIAL_CONTRACT_HASH = hashCanonicalJsonV1('commercial-contract-bundle', {
  schemaVersion: COMMERCIAL_CONTRACT_SCHEMA_VERSION,
  catalog: COMMERCIAL_CATALOG_CONTRACT_HASH,
  campaign: COMMERCIAL_CAMPAIGN_CONTRACT_HASH,
  quote: COMMERCIAL_QUOTE_CONTRACT_HASH,
  pricingVectors,
})
