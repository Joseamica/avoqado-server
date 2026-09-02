import catalogFixture from '@/contracts/commercial/fixtures/v2/catalog-base.json'
import campaignFixture from '@/contracts/commercial/fixtures/v2/campaign-pos-50.json'
import quoteFixture from '@/contracts/commercial/fixtures/v2/quote-pos-50-venue.json'
import * as commercialContractV2 from '@/services/commercial/commercialContractV2.service'
import {
  reconcileCommercialQuoteAuthoritiesV2,
  validateCommercialQuoteIntrinsicV2,
} from '@/services/commercial/commercialQuoteContractV2.service'
import {
  CommercialContractV2ValidationError,
  validateCommercialCampaignV2,
  validateCommercialCatalogV2,
  validateCommercialQuoteV2,
} from '@/services/commercial/commercialContractV2.service'
import type { CommercialCampaignSnapshotV2, CommercialCatalogSnapshotV2, CommercialQuoteSnapshotV2 } from '@/types/commercialV2'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function validationRule(operation: () => unknown): string | null {
  try {
    operation()
    return null
  } catch (error) {
    expect(error).toBeInstanceOf(CommercialContractV2ValidationError)
    return (error as CommercialContractV2ValidationError).rule
  }
}

function recursivelyFrozen(value: unknown): boolean {
  return (
    typeof value !== 'object' ||
    value === null ||
    (Object.isFrozen(value) && Object.values(value).every(nested => recursivelyFrozen(nested)))
  )
}

describe('commercial quote authority reconciliation boundary', () => {
  it('does not expose raw authority reconciliation from the public v2 contract module', () => {
    expect('reconcileCommercialQuoteAuthoritiesV2' in commercialContractV2).toBe(false)
  })

  it('rejects unmaterialized authorities and never observes a Proxy authority', () => {
    const quote = validateCommercialQuoteIntrinsicV2(clone(quoteFixture) as CommercialQuoteSnapshotV2)
    const mutableCatalog = clone(catalogFixture) as CommercialCatalogSnapshotV2
    const campaign = validateCommercialCampaignV2(clone(campaignFixture))
    expect(validationRule(() => reconcileCommercialQuoteAuthoritiesV2(quote, { catalog: mutableCatalog, campaign }))).toBe('BOUNDARY')

    let traps = 0
    const proxyCatalog = new Proxy(validateCommercialCatalogV2(clone(catalogFixture)), {
      get() {
        traps += 1
        throw new Error('caller-secret')
      },
      ownKeys() {
        traps += 1
        throw new Error('caller-secret')
      },
    })
    expect(validationRule(() => reconcileCommercialQuoteAuthoritiesV2(quote, { catalog: proxyCatalog, campaign }))).toBe('BOUNDARY')
    expect(traps).toBe(0)
  })

  it('accepts only the branded intrinsic quote and materialized authorities', () => {
    const quote = validateCommercialQuoteIntrinsicV2(clone(quoteFixture) as CommercialQuoteSnapshotV2)
    const catalog = validateCommercialCatalogV2(clone(catalogFixture))
    const campaign = validateCommercialCampaignV2(clone(campaignFixture))
    const reconciled = reconcileCommercialQuoteAuthoritiesV2(quote, { catalog, campaign })

    expect(reconciled).toBe(quote)
    expect(recursivelyFrozen(reconciled)).toBe(true)

    const mutableQuote = clone(quoteFixture) as CommercialQuoteSnapshotV2
    expect(validationRule(() => reconcileCommercialQuoteAuthoritiesV2(mutableQuote, { catalog, campaign }))).toBe('BOUNDARY')
  })

  it('keeps public full validation deeply frozen and detached from every caller alias', () => {
    const quote = clone(quoteFixture) as CommercialQuoteSnapshotV2
    const catalog = clone(catalogFixture) as CommercialCatalogSnapshotV2
    const campaign = clone(campaignFixture) as unknown as CommercialCampaignSnapshotV2
    const validated = validateCommercialQuoteV2(quote, { catalog, campaign })

    quote.lines[0].name = 'mutated quote'
    catalog.products[0].name = 'mutated catalog'
    campaign.rules[0].code = 'MUTATED_CAMPAIGN_RULE'

    expect(validated.lines[0].name).not.toBe('mutated quote')
    expect(recursivelyFrozen(validated)).toBe(true)
  })
})
