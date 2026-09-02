import catalogFixture from '@/contracts/commercial/fixtures/v2/catalog-base.json'
import campaignFixture from '@/contracts/commercial/fixtures/v2/campaign-pos-50.json'
import entitlementFixture from '@/contracts/commercial/fixtures/v2/entitlement-pos.json'
import lifecycleFixture from '@/contracts/commercial/fixtures/v2/lifecycle-vocabulary.json'
import migrationVectors from '@/contracts/commercial/fixtures/v2/migration-vectors.json'
import pricingVectors from '@/contracts/commercial/fixtures/v2/pricing-vectors.json'
import quoteAcquisitionFixture from '@/contracts/commercial/fixtures/v2/quote-pos-50-acquisition.json'
import quoteVenueFixture from '@/contracts/commercial/fixtures/v2/quote-pos-50-venue.json'
import {
  validateCommercialCampaignV2,
  validateCommercialCatalogV2,
  validateCommercialEntitlementsV2,
  validateCommercialLifecycleV2,
  validateCommercialQuoteV2,
} from '@/services/commercial/commercialContractV2.service'
import type {
  CommercialCampaignSnapshotV2,
  CommercialCampaignTargetV2,
  CommercialCatalogSnapshotV2,
  CommercialLifecycleVocabularyV2,
} from '@/types/commercialV2'
import { cloneJson as clone, expectTrustedSnapshot, validationRule } from './commercialContractV2.testSupport'

type IsAssignable<From, To> = [From] extends [To] ? true : false
type ExpectFalse<Value extends false> = Value
type EmptyCampaignTargetMustFail = ExpectFalse<IsAssignable<{}, CommercialCampaignTargetV2>>
type EmptyProductCodesMustFail = ExpectFalse<IsAssignable<{ productCodes: [] }, CommercialCampaignTargetV2>>
type ReorderedLifecycleMustFail = ExpectFalse<
  IsAssignable<
    Omit<CommercialLifecycleVocabularyV2, 'quoteStates'> & { quoteStates: ['VOIDED', 'ISSUED', 'EXPIRED'] },
    CommercialLifecycleVocabularyV2
  >
>
type IncompleteLifecycleMustFail = ExpectFalse<
  IsAssignable<
    Omit<CommercialLifecycleVocabularyV2, 'quoteStates'> & { quoteStates: ['ISSUED', 'VOIDED'] },
    CommercialLifecycleVocabularyV2
  >
>

void (0 as unknown as EmptyCampaignTargetMustFail)
void (0 as unknown as EmptyProductCodesMustFail)
void (0 as unknown as ReorderedLifecycleMustFail)
void (0 as unknown as IncompleteLifecycleMustFail)

const catalogAuthority = catalogFixture as unknown as CommercialCatalogSnapshotV2
const campaignAuthority = campaignFixture as unknown as CommercialCampaignSnapshotV2

function allKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(allKeys)
  if (typeof value !== 'object' || value === null) return []
  return Object.entries(value).flatMap(([key, nested]) => [key, ...allKeys(nested)])
}

const validatorCases = [
  ['catalog', catalogFixture, 'publicationId', (value: unknown) => validateCommercialCatalogV2(value)],
  ['campaign', campaignFixture, 'campaignCode', (value: unknown) => validateCommercialCampaignV2(value)],
  [
    'quote',
    quoteAcquisitionFixture,
    'quoteId',
    (value: unknown) => validateCommercialQuoteV2(value, { catalog: catalogAuthority, campaign: campaignAuthority }),
  ],
  ['entitlements', entitlementFixture, 'subject', (value: unknown) => validateCommercialEntitlementsV2(value)],
  ['lifecycle', lifecycleFixture, 'quoteStates', (value: unknown) => validateCommercialLifecycleV2(value)],
] as const

describe('commercial v2 materialized JSON boundary', () => {
  it.each(validatorCases)('rejects a root Proxy before reflecting %s', (_label, fixture, _field, validate) => {
    const proxy = new Proxy(clone(fixture), {})
    expect(validationRule(() => validate(proxy))).toBe('BOUNDARY')
  })

  it.each(validatorCases)('rejects an enumerable accessor without invoking it for %s', (_label, fixture, field, validate) => {
    const value = clone(fixture) as any
    const original = value[field]
    let getterReads = 0
    Object.defineProperty(value, field, {
      enumerable: true,
      get: () => {
        getterReads += 1
        return original
      },
    })
    expect(validationRule(() => validate(value))).toBe('BOUNDARY')
    expect(getterReads).toBe(0)
  })

  it.each(validatorCases)('rejects an exotic root prototype for %s', (_label, fixture, _field, validate) => {
    const value = clone(fixture) as object
    Object.setPrototypeOf(value, class CallerObject {}.prototype)
    expect(validationRule(() => validate(value))).toBe('BOUNDARY')
  })
})

describe('commercial catalog contract v2', () => {
  it('validates the complete frozen catalog without changing the approved offer', () => {
    expectTrustedSnapshot(validateCommercialCatalogV2(catalogFixture), catalogFixture)
    expect(catalogFixture.products.slice(0, 5).map(product => product.code)).toEqual(['FREE', 'PRO', 'PREMIUM', 'ENTERPRISE', 'POS'])
    expect(catalogFixture.products.filter(product => product.kind === 'MODULE')).toHaveLength(9)
    expect(catalogFixture.bundles[0].items).toHaveLength(9)
  })

  it('uses only canonical decimal-string money and excludes legacy/campaign-only base data', () => {
    const prices = [
      ...catalogFixture.products.flatMap(product => product.prices),
      ...catalogFixture.bundles.flatMap(bundle => bundle.prices),
    ]
    expect(prices.map(price => price.amount)).toEqual(
      expect.arrayContaining(['0.00', '249.00', '999.00', '9990.00', '1699.00', '16990.00', '179.00', '269.00', '1999.00']),
    )
    expect(prices.map(price => price.amount)).not.toEqual(expect.arrayContaining(['22.00', '50.00', '499.00']))
    expect(JSON.stringify(catalogFixture)).not.toMatch(/fundadores?/i)
    expect(allKeys(catalogFixture).filter(key => /Minor$/.test(key))).toEqual([])
    expect(prices.every(price => typeof price.amount === 'string')).toBe(true)
  })

  it.each([
    ['missing root property', (value: any) => delete value.market, 'SCHEMA'],
    ['extra root property', (value: any) => (value.internal = true), 'SCHEMA'],
    ['extra nested property', (value: any) => (value.products[0].prices[0].internal = true), 'SCHEMA'],
    ['legacy money property', (value: any) => (value.products[0].prices[0].amountMinor = 0), 'SCHEMA'],
    ['numeric money', (value: any) => (value.products[0].prices[0].amount = 0), 'SCHEMA'],
    ['malformed money', (value: any) => (value.products[0].prices[0].amount = '01.00'), 'SCHEMA'],
    ['wrong schema version', (value: any) => (value.schemaVersion = 3), 'SCHEMA_VERSION'],
    ['wrong contract version', (value: any) => (value.contractVersion = '2.1.0'), 'CONTRACT_VERSION'],
  ])('rejects %s with a stable rule', (_label, mutate, rule) => {
    const value = clone(catalogFixture) as any
    mutate(value)
    expect(validationRule(() => validateCommercialCatalogV2(value))).toBe(rule)
  })

  it.each([
    ['product order', (value: any) => value.products.splice(0, 2, value.products[1], value.products[0]), 'PRODUCT_ORDER'],
    ['product code duplicate', (value: any) => (value.products[1].code = value.products[0].code), 'PRODUCT_CODE_UNIQUE'],
    ['product slug duplicate', (value: any) => (value.products[1].slug = value.products[0].slug), 'PRODUCT_SLUG_UNIQUE'],
    ['price order', (value: any) => value.products[0].prices.reverse(), 'PRICE_ORDER'],
    ['price code duplicate', (value: any) => (value.products[0].prices[1].code = value.products[0].prices[0].code), 'PRICE_CODE_UNIQUE'],
    ['billing unit duplicate', (value: any) => (value.products[0].prices[1].billingUnit = 'VENUE_MONTH'), 'PRICE_BILLING_UNIT_UNIQUE'],
    ['binding order', (value: any) => value.products[1].capabilityBindings.reverse(), 'CAPABILITY_BINDING_ORDER'],
    [
      'binding duplicate',
      (value: any) => (value.products[1].capabilityBindings[1] = clone(value.products[1].capabilityBindings[0])),
      'CAPABILITY_BINDING_UNIQUE',
    ],
    ['bundle item order', (value: any) => value.bundles[0].items.reverse(), 'BUNDLE_ITEM_ORDER'],
    [
      'bundle item duplicate',
      (value: any) => (value.bundles[0].items[1].productCode = value.bundles[0].items[0].productCode),
      'BUNDLE_ITEM_UNIQUE',
    ],
  ])('rejects noncanonical %s', (_label, mutate, rule) => {
    const value = clone(catalogFixture) as any
    mutate(value)
    expect(validationRule(() => validateCommercialCatalogV2(value))).toBe(rule)
  })

  it('rejects priced targets that resolve to no capability', () => {
    const product = clone(catalogFixture) as any
    product.products.find((entry: any) => entry.code === 'POS').capabilityBindings = []
    expect(validationRule(() => validateCommercialCatalogV2(product))).toBe('PRICED_PRODUCT_WITHOUT_CAPABILITY')

    const bundle = clone(catalogFixture) as any
    for (const item of bundle.bundles[0].items) {
      const product = bundle.products.find((entry: any) => entry.code === item.productCode)
      product.prices = []
      product.capabilityBindings = []
    }
    expect(validationRule(() => validateCommercialCatalogV2(bundle))).toBe('PRICED_BUNDLE_WITHOUT_CAPABILITY')
  })

  it('rejects duplicate or noncanonical bundles', () => {
    const duplicate = clone(catalogFixture) as any
    duplicate.bundles.push(clone(duplicate.bundles[0]))
    expect(validationRule(() => validateCommercialCatalogV2(duplicate))).toBe('BUNDLE_CODE_UNIQUE')

    const reordered = clone(catalogFixture) as any
    reordered.bundles.push({ ...clone(reordered.bundles[0]), code: 'AAA_BUNDLE', slug: 'aaa-bundle', sortOrder: 0 })
    expect(validationRule(() => validateCommercialCatalogV2(reordered))).toBe('BUNDLE_ORDER')

    const duplicateSlug = clone(catalogFixture) as any
    duplicateSlug.bundles.push({
      ...clone(duplicateSlug.bundles[0]),
      code: 'ZZZ_BUNDLE',
      sortOrder: duplicateSlug.bundles[0].sortOrder + 1,
    })
    expect(validationRule(() => validateCommercialCatalogV2(duplicateSlug))).toBe('BUNDLE_SLUG_UNIQUE')
  })

  it.each([
    ['unknown capability', (binding: any) => (binding.capabilityCode = 'UNKNOWN_CAPABILITY'), 'CAPABILITY_UNKNOWN'],
    ['wrong kind', (binding: any) => (binding.capabilityKind = 'MODULE'), 'CAPABILITY_KIND_MISMATCH'],
    [
      'wrong activation',
      (binding: any) => (binding.activationRequirement = { mode: 'VENUE_SETTING', settingKey: 'other', defaultState: 'OFF' }),
      'CAPABILITY_ACTIVATION_MISMATCH',
    ],
  ])('rejects %s against the capability authority', (_label, mutate, rule) => {
    const value = clone(catalogFixture) as any
    mutate(value.products.find((entry: any) => entry.code === 'POS').capabilityBindings[0])
    expect(validationRule(() => validateCommercialCatalogV2(value))).toBe(rule)
  })
})

describe('commercial entitlement projection contract v2', () => {
  it('validates the active POS projection and keeps entitlement separate from activation', () => {
    expectTrustedSnapshot(validateCommercialEntitlementsV2(entitlementFixture), entitlementFixture)
    expect(entitlementFixture.capabilities[0]).toEqual({
      capabilityCode: 'POS_CORE',
      capabilityKind: 'CORE',
      entitlement: {
        state: 'ACTIVE',
        origins: [{ kind: 'PRODUCT', sourceCode: 'POS', lineKey: 'PRODUCT:POS:POS_MONTHLY' }],
      },
      activation: { state: 'NOT_REQUIRED' },
    })
  })

  it.each([
    ['unknown state', (value: any) => (value.capabilities[0].entitlement.state = 'UNKNOWN'), 'SCHEMA'],
    ['empty origins', (value: any) => (value.capabilities[0].entitlement.origins = []), 'SCHEMA'],
    ['unknown capability', (value: any) => (value.capabilities[0].capabilityCode = 'UNKNOWN_CAPABILITY'), 'CAPABILITY_UNKNOWN'],
    ['wrong capability kind', (value: any) => (value.capabilities[0].capabilityKind = 'FEATURE'), 'CAPABILITY_KIND_MISMATCH'],
    ['wrong activation state', (value: any) => (value.capabilities[0].activation.state = 'ON'), 'ENTITLEMENT_ACTIVATION_MISMATCH'],
    ['extra allowed decision', (value: any) => (value.capabilities[0].allowed = true), 'SCHEMA'],
  ])('rejects %s', (_label, mutate, rule) => {
    const value = clone(entitlementFixture) as any
    mutate(value)
    expect(validationRule(() => validateCommercialEntitlementsV2(value))).toBe(rule)
  })

  it('rejects duplicate or noncanonical capability order', () => {
    const duplicate = clone(entitlementFixture) as any
    duplicate.capabilities.push(clone(duplicate.capabilities[0]))
    expect(validationRule(() => validateCommercialEntitlementsV2(duplicate))).toBe('CAPABILITY_UNIQUE')

    const reordered = clone(entitlementFixture) as any
    reordered.capabilities.push({
      capabilityCode: 'CHATBOT',
      capabilityKind: 'FEATURE',
      entitlement: { state: 'ACTIVE', origins: [{ kind: 'PRODUCT', sourceCode: 'FREE', lineKey: 'PRODUCT:FREE:FREE_MONTHLY' }] },
      activation: { state: 'NOT_REQUIRED' },
    })
    expect(validationRule(() => validateCommercialEntitlementsV2(reordered))).toBe('CAPABILITY_ORDER')
  })

  it('requires ON or OFF for the one venue-setting capability and rejects NOT_REQUIRED', () => {
    for (const state of ['ON', 'OFF'] as const) {
      const value = clone(entitlementFixture) as any
      Object.assign(value.capabilities[0], {
        capabilityCode: 'CASH_RECONCILIATION',
        capabilityKind: 'FEATURE',
        activation: { state },
      })
      expectTrustedSnapshot(validateCommercialEntitlementsV2(value), value)
    }

    const invalid = clone(entitlementFixture) as any
    Object.assign(invalid.capabilities[0], {
      capabilityCode: 'CASH_RECONCILIATION',
      capabilityKind: 'FEATURE',
      activation: { state: 'NOT_REQUIRED' },
    })
    expect(validationRule(() => validateCommercialEntitlementsV2(invalid))).toBe('ENTITLEMENT_ACTIVATION_MISMATCH')
  })
})

describe('commercial lifecycle vocabulary contract v2', () => {
  it('accepts only the exact frozen ordered vocabulary', () => {
    expectTrustedSnapshot(validateCommercialLifecycleV2(lifecycleFixture), lifecycleFixture)
    expect(lifecycleFixture.quoteStates).toEqual(['ISSUED', 'VOIDED', 'EXPIRED'])
    expect(lifecycleFixture.checkoutAttemptStates).toEqual([
      'PENDING',
      'PROCESSING',
      'STRIPE_PENDING',
      'OUTCOME_UNKNOWN',
      'SUCCEEDED',
      'FAILED_RETRYABLE',
      'FAILED_FINAL',
    ])
  })

  it.each([
    ['unknown value', (value: any) => (value.quoteStates[0] = 'UNKNOWN')],
    ['reordered values', (value: any) => value.acceptanceStates.reverse()],
    ['duplicate value', (value: any) => (value.redemptionStates[1] = value.redemptionStates[0])],
  ])('rejects %s', (_label, mutate) => {
    const value = clone(lifecycleFixture) as any
    mutate(value)
    expect(validationRule(() => validateCommercialLifecycleV2(value))).toBe('LIFECYCLE_VOCABULARY')
  })
})

describe('commercial v2 exhaustive strictness and money boundaries', () => {
  it.each([
    [
      'campaign missing root',
      campaignFixture,
      (value: any) => delete value.publishedAt,
      (value: unknown) => validateCommercialCampaignV2(value),
      'SCHEMA',
    ],
    [
      'campaign extra nested',
      campaignFixture,
      (value: any) => (value.rules[0].target.internal = true),
      (value: unknown) => validateCommercialCampaignV2(value),
      'SCHEMA',
    ],
    [
      'campaign schema version',
      campaignFixture,
      (value: any) => (value.schemaVersion = 3),
      (value: unknown) => validateCommercialCampaignV2(value),
      'SCHEMA_VERSION',
    ],
    [
      'campaign contract version',
      campaignFixture,
      (value: any) => (value.contractVersion = '2.0.1'),
      (value: unknown) => validateCommercialCampaignV2(value),
      'CONTRACT_VERSION',
    ],
    [
      'entitlements missing root',
      entitlementFixture,
      (value: any) => delete value.subject,
      (value: unknown) => validateCommercialEntitlementsV2(value),
      'SCHEMA',
    ],
    [
      'entitlements extra nested',
      entitlementFixture,
      (value: any) => (value.capabilities[0].activation.internal = true),
      (value: unknown) => validateCommercialEntitlementsV2(value),
      'SCHEMA',
    ],
    [
      'entitlements schema version',
      entitlementFixture,
      (value: any) => (value.schemaVersion = 3),
      (value: unknown) => validateCommercialEntitlementsV2(value),
      'SCHEMA_VERSION',
    ],
    [
      'entitlements contract version',
      entitlementFixture,
      (value: any) => (value.contractVersion = '2.0.1'),
      (value: unknown) => validateCommercialEntitlementsV2(value),
      'CONTRACT_VERSION',
    ],
    [
      'lifecycle missing root',
      lifecycleFixture,
      (value: any) => delete value.entitlementStates,
      (value: unknown) => validateCommercialLifecycleV2(value),
      'SCHEMA',
    ],
    [
      'lifecycle extra root',
      lifecycleFixture,
      (value: any) => (value.internal = true),
      (value: unknown) => validateCommercialLifecycleV2(value),
      'SCHEMA',
    ],
    [
      'lifecycle schema version',
      lifecycleFixture,
      (value: any) => (value.schemaVersion = 3),
      (value: unknown) => validateCommercialLifecycleV2(value),
      'SCHEMA_VERSION',
    ],
    [
      'lifecycle contract version',
      lifecycleFixture,
      (value: any) => (value.contractVersion = '2.0.1'),
      (value: unknown) => validateCommercialLifecycleV2(value),
      'CONTRACT_VERSION',
    ],
  ])('rejects %s', (_label, fixture, mutate, validate, rule) => {
    const value = clone(fixture) as any
    mutate(value)
    expect(validationRule(() => validate(value))).toBe(rule)
  })

  it.each([
    [
      'catalog unit amount',
      catalogFixture,
      (value: any): void => {
        value.products.find((product: any) => product.code === 'POS').prices[0].amount = '10000000000.00'
      },
      (value: unknown) => validateCommercialCatalogV2(value),
    ],
    [
      'campaign unit amount',
      campaignFixture,
      (value: any): void => {
        value.rules[0].amount = '10000000000.00'
      },
      (value: unknown) => validateCommercialCampaignV2(value),
    ],
    [
      'quote line list subtotal',
      quoteAcquisitionFixture,
      (value: any): void => {
        value.lines[0].listSubtotal = '10000000000000.00'
      },
      (value: unknown) => validateCommercialQuoteV2(value, { catalog: catalogAuthority, campaign: campaignAuthority }),
    ],
  ])('selects the bounded A1 money domain for %s', (_label, fixture, mutate, validate) => {
    const value = clone(fixture) as any
    mutate(value)
    expect(validationRule(() => validate(value))).toBe('MONEY')
  })
})

describe('commercial v2 declarative vectors', () => {
  it('freezes the no-Minor and string-money rule across every controlled fixture/vector', () => {
    const controlled = [
      catalogFixture,
      campaignFixture,
      quoteAcquisitionFixture,
      quoteVenueFixture,
      entitlementFixture,
      lifecycleFixture,
      pricingVectors,
      migrationVectors,
    ]
    const moneyFields = new Set([
      'amount',
      'unitAmount',
      'listSubtotal',
      'discount',
      'subtotal',
      'tax',
      'total',
      'renewalSubtotal',
      'renewalTax',
      'renewalTotal',
      'inputAmount',
      'discountAmount',
      'outputAmount',
      'wireAmount',
      'storageCents',
    ])
    const violations: string[] = []
    const walk = (value: unknown, path: string): void => {
      if (Array.isArray(value)) return value.forEach((entry, index) => walk(entry, `${path}/${index}`))
      if (typeof value !== 'object' || value === null) return
      for (const [key, nested] of Object.entries(value)) {
        if (/Minor$/.test(key)) violations.push(`${path}/${key}:legacy`)
        const representsV1Cents = key === 'wireAmount' && 'sourceSchemaVersion' in value && value.sourceSchemaVersion === 1
        if (moneyFields.has(key) && typeof nested !== 'string' && !representsV1Cents) violations.push(`${path}/${key}:numeric`)
        walk(nested, `${path}/${key}`)
      }
    }
    controlled.forEach((value, index) => walk(value, String(index)))
    expect(violations).toEqual([])
  })

  it('freezes every required pricing scenario with string current and renewal money', () => {
    expect(pricingVectors.vectors.map(vector => vector.code)).toEqual([
      'POS_BASE',
      'POS_FIXED_50',
      'POS_FIXED_22',
      'TEN_PERCENT_POS',
      'TEN_PERCENT_MODULE',
      'TEN_PERCENT_POS_AND_MODULES',
      'ALL_MODULE_BUNDLE',
      'FREE_PERIOD',
      'QUANTITY_TAX_HALF_UP',
      'DOMAIN_EDGE',
    ])
    for (const vector of pricingVectors.vectors) {
      expect(Object.values(vector.expected.current).every(value => typeof value === 'string')).toBe(true)
      expect(Object.values(vector.expected.renewal).every(value => typeof value === 'string')).toBe(true)
    }
  })

  it('freezes v1/v2 identity, bigint-domain and rollback migration cases without running a database', () => {
    expect(migrationVectors.cases.map(vector => vector.code)).toEqual([
      'V1_INT4_IDENTITY',
      'V2_ABOVE_INT4',
      'V2_MAX_DOMAIN',
      'ROLLBACK_SAFE_V1',
      'ROLLBACK_BLOCKED_BY_V2',
      'ROLLBACK_BLOCKED_BY_INT4_OVERFLOW',
      'IDENTITY_MISMATCH',
    ])
    expect(migrationVectors.cases.find(vector => vector.code === 'V2_MAX_DOMAIN')).toMatchObject({
      wireAmount: '92233720368547758.07',
      storageCents: '9223372036854775807',
    })
  })
})
