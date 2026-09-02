import campaignFixture from '@/contracts/commercial/fixtures/v2/campaign-pos-50.json'
import catalogFixture from '@/contracts/commercial/fixtures/v2/catalog-base.json'
import entitlementFixture from '@/contracts/commercial/fixtures/v2/entitlement-pos.json'
import lifecycleFixture from '@/contracts/commercial/fixtures/v2/lifecycle-vocabulary.json'
import quoteFixture from '@/contracts/commercial/fixtures/v2/quote-pos-50-acquisition.json'
import {
  validateCommercialCampaignV2,
  validateCommercialCatalogV2,
  validateCommercialEntitlementsV2,
  validateCommercialLifecycleV2,
  validateCommercialQuoteV2,
} from '@/services/commercial/commercialContractV2.service'
import type { CommercialCampaignSnapshotV2, CommercialCatalogSnapshotV2 } from '@/types/commercialV2'
import { cloneJson, expectTrustedSnapshot, validationRule } from './commercialContractV2.testSupport'

const catalogAuthority = catalogFixture as unknown as CommercialCatalogSnapshotV2
const campaignAuthority = campaignFixture as unknown as CommercialCampaignSnapshotV2

const validatorCases = [
  ['catalog', catalogFixture, (value: unknown) => validateCommercialCatalogV2(value)],
  ['campaign', campaignFixture, (value: unknown) => validateCommercialCampaignV2(value)],
  ['quote', quoteFixture, (value: unknown) => validateCommercialQuoteV2(value, { catalog: catalogAuthority, campaign: campaignAuthority })],
  ['entitlements', entitlementFixture, (value: unknown) => validateCommercialEntitlementsV2(value)],
  ['lifecycle', lifecycleFixture, (value: unknown) => validateCommercialLifecycleV2(value)],
] as const

describe('commercial v2 final materialization boundary matrix', () => {
  it.each(validatorCases)('rejects a Proxy-constructor exotic prototype without trap reads for %s', (_label, fixture, validate) => {
    const value = cloneJson(fixture) as object
    const exoticPrototype = Object.create(null) as Record<string, unknown>
    const constructorTarget = function Object() {}
    constructorTarget.prototype = exoticPrototype
    let constructorProxyReads = 0
    const constructorProxy = new Proxy(constructorTarget, {
      get(target, property, receiver) {
        constructorProxyReads += 1
        return Reflect.get(target, property, receiver)
      },
    })
    Object.defineProperty(exoticPrototype, 'constructor', { value: constructorProxy })
    Object.setPrototypeOf(value, exoticPrototype)

    expect(validationRule(() => validate(value))).toBe('BOUNDARY')
    expect(constructorProxyReads).toBe(0)
  })

  it.each(validatorCases)('rejects an additional root property for %s', (_label, fixture, validate) => {
    const value = cloneJson(fixture) as Record<string, unknown>
    value.unexpectedRoot = true
    expect(validationRule(() => validate(value))).toBe('SCHEMA')
  })

  it.each([
    ['campaign', campaignFixture, (value: unknown) => validateCommercialCampaignV2(value)],
    [
      'quote',
      quoteFixture,
      (value: unknown) => validateCommercialQuoteV2(value, { catalog: catalogAuthority, campaign: campaignAuthority }),
    ],
  ])('returns a recursively frozen trusted %s snapshot', (_label, fixture, validate) => {
    expectTrustedSnapshot(validate(fixture), fixture)
  })
})
