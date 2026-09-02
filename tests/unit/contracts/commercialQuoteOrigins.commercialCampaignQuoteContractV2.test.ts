import catalogFixture from '@/contracts/commercial/fixtures/v2/catalog-base.json'
import quoteAcquisitionFixture from '@/contracts/commercial/fixtures/v2/quote-pos-50-acquisition.json'
import {
  cloneJson as clone,
  expectTrustedSnapshot,
  formatMinor,
  parseMinor,
  productGrant,
  productLine,
  reconcileQuoteTotals,
  taxMinor,
  validateCommercialQuoteV2,
  validateQuoteAgainst,
  validationRule,
} from './commercialContractV2.testSupport'

describe('commercial quote provenance contract v2', () => {
  it('rejects a campaign origin that disagrees with the quote root', () => {
    const value = clone(quoteAcquisitionFixture) as any
    value.entitlementGrants[0].origins[1].sourceId = 'campaign-version-other'
    expect(validationRule(() => validateCommercialQuoteV2(value))).toBe('ORIGIN_CAMPAIGN_MISMATCH')
  })

  it('rejects grants and applied rules that disagree with decoded catalog/campaign authorities', () => {
    const wrongGrant = clone(quoteAcquisitionFixture) as any
    Object.assign(wrongGrant.entitlementGrants[0], {
      capabilityCode: 'CHATBOT',
      capabilityKind: 'FEATURE',
      activationRequirement: { mode: 'NOT_REQUIRED' },
    })
    expect(validationRule(() => validateCommercialQuoteV2(wrongGrant))).toBe('QUOTE_CATALOG_GRANT_MISMATCH')

    const wrongRule = clone(quoteAcquisitionFixture) as any
    wrongRule.lines[0].appliedCampaigns[0].cycles = 4
    wrongRule.lines[0].promotionalCycles = 4
    expect(validationRule(() => validateCommercialQuoteV2(wrongRule))).toBe('QUOTE_CAMPAIGN_RULE_MISMATCH')
  })

  it.each([
    ['wrong product source', (value: any) => (value.entitlementGrants[0].origins[0].sourceCode = 'FREE')],
    ['wrong product line', (value: any) => (value.entitlementGrants[0].origins[0].lineKey = 'PRODUCT:FREE:FREE_MONTHLY')],
    [
      'wrong bundle parent',
      (value: any) =>
        (value.entitlementGrants[0].origins[0] = {
          kind: 'BUNDLE_COMPONENT',
          sourceCode: 'POS',
          parentSourceCode: 'OTHER_BUNDLE',
          lineKey: value.lines[0].lineKey,
        }),
    ],
    ['campaign origin on an unrelated line', (value: any) => (value.entitlementGrants[0].origins[1].lineKey = 'PRODUCT:FREE:FREE_MONTHLY')],
    ['missing campaign origin', (value: any) => value.entitlementGrants[0].origins.splice(1, 1)],
  ])('rejects catalog-derived provenance with %s', (_label, mutate) => {
    const value = clone(quoteAcquisitionFixture) as any
    mutate(value)
    expect(validationRule(() => validateCommercialQuoteV2(value))).toBe('QUOTE_CATALOG_ORIGIN_MISMATCH')
  })

  it.each([
    { kind: 'BUNDLE', sourceCode: 'POS', lineKey: 'PRODUCT:POS:POS_MONTHLY' },
    { kind: 'TRIAL', sourceId: 'trial-001' },
    { kind: 'GRANDFATHERED', sourceId: 'grandfathered-001' },
    { kind: 'CONTRACT', sourceId: 'contract-001' },
    { kind: 'MANUAL', sourceId: 'manual-001' },
  ])('rejects unsupported quote authority origin %#', unsupported => {
    const value = clone(quoteAcquisitionFixture) as any
    const campaignOrigin = value.entitlementGrants[0].origins[1]
    value.entitlementGrants[0].origins = ['TRIAL', 'GRANDFATHERED', 'CONTRACT', 'MANUAL'].includes(unsupported.kind)
      ? [campaignOrigin, unsupported]
      : [unsupported, campaignOrigin]
    expect(validationRule(() => validateCommercialQuoteV2(value))).toBe('QUOTE_CATALOG_ORIGIN_MISMATCH')
  })

  it('accepts the exact FREE and bundle-component origins derived from catalog authorities', () => {
    const freeQuote = clone(quoteAcquisitionFixture) as any
    freeQuote.campaignVersionId = null
    freeQuote.campaignCode = null
    const freeLine = productLine('FREE', 'FREE_MONTHLY')
    freeQuote.lines = [freeLine]
    freeQuote.entitlementGrants = [productGrant('FREE', freeLine.lineKey, false)]
    reconcileQuoteTotals(freeQuote)
    expectTrustedSnapshot(validateQuoteAgainst(freeQuote, null), freeQuote)

    const catalog = clone(catalogFixture) as any
    catalog.bundles[0].items = [catalog.bundles[0].items[0]]
    const bundle = catalog.bundles[0]
    const price = bundle.prices[0]
    const amount = parseMinor(price.amount)
    const tax = taxMinor(amount, price.taxRateBasisPoints)
    const bundleLine = {
      ...productLine('POS', 'POS_MONTHLY'),
      lineKey: `BUNDLE:${bundle.code}:${price.code}`,
      targetType: 'BUNDLE',
      targetCode: bundle.code,
      priceCode: price.code,
      productKind: 'BUNDLE',
      name: bundle.name,
      billingUnit: price.billingUnit,
      unitAmount: price.amount,
      listSubtotal: price.amount,
      subtotal: price.amount,
      tax: formatMinor(tax),
      total: formatMinor(amount + tax),
      renewalSubtotal: price.amount,
      renewalTax: formatMinor(tax),
      renewalTotal: formatMinor(amount + tax),
    }
    const item = catalog.products.find((product: any) => product.code === bundle.items[0].productCode)
    const binding = item.capabilityBindings[0]
    const bundleQuote = clone(freeQuote) as any
    bundleQuote.lines = [bundleLine]
    bundleQuote.entitlementGrants = [
      {
        capabilityCode: binding.capabilityCode,
        capabilityKind: binding.capabilityKind,
        origins: [
          {
            kind: 'BUNDLE_COMPONENT',
            sourceCode: item.code,
            parentSourceCode: bundle.code,
            lineKey: bundleLine.lineKey,
          },
        ],
        activationRequirement: binding.activationRequirement,
      },
    ]
    reconcileQuoteTotals(bundleQuote)
    expectTrustedSnapshot(validateQuoteAgainst(bundleQuote, null, catalog), bundleQuote)
  })

  it.each([
    ['missing required origin field', (origins: any[]) => delete origins[0].sourceCode, 'SCHEMA'],
    ['prohibited origin field', (origins: any[]) => (origins[0].sourceId = 'forbidden'), 'SCHEMA'],
    ['origin order', (origins: any[]) => origins.reverse(), 'ORIGIN_ORDER'],
    ['origin duplicate', (origins: any[]) => origins.push(clone(origins[0])), 'ORIGIN_UNIQUE'],
    ['campaign-only grant', (origins: any[]) => origins.splice(0, 1), 'CAMPAIGN_ONLY_GRANT'],
  ])('rejects %s', (_label, mutate, rule) => {
    const value = clone(quoteAcquisitionFixture) as any
    mutate(value.entitlementGrants[0].origins)
    expect(validationRule(() => validateCommercialQuoteV2(value))).toBe(rule)
  })

  it.each([
    [{ kind: 'FREE', sourceCode: 'POS', lineKey: 'PRODUCT:POS:POS_MONTHLY' }, 'sourceCode', 'sourceId'],
    [{ kind: 'PRODUCT', sourceCode: 'POS', lineKey: 'PRODUCT:POS:POS_MONTHLY' }, 'lineKey', 'parentSourceCode'],
    [{ kind: 'BUNDLE', sourceCode: 'ALL_MODULES', lineKey: 'BUNDLE:ALL_MODULES:ALL_MODULES_MONTHLY' }, 'sourceCode', 'sourceId'],
    [
      {
        kind: 'BUNDLE_COMPONENT',
        sourceCode: 'KITCHEN_DISPLAY_MODULE',
        parentSourceCode: 'ALL_MODULES',
        lineKey: 'BUNDLE:ALL_MODULES:ALL_MODULES_MONTHLY',
      },
      'parentSourceCode',
      'sourceId',
    ],
    [
      { kind: 'CAMPAIGN', sourceCode: 'POS_50', sourceId: 'campaign-version-pos-50-v2', lineKey: 'PRODUCT:POS:POS_MONTHLY' },
      'sourceId',
      'parentSourceCode',
    ],
    [{ kind: 'TRIAL', sourceId: 'trial-001' }, 'sourceId', 'sourceCode'],
    [{ kind: 'GRANDFATHERED', sourceId: 'grandfathered-001' }, 'sourceId', 'lineKey'],
    [{ kind: 'CONTRACT', sourceId: 'contract-001' }, 'sourceId', 'parentSourceCode'],
    [{ kind: 'MANUAL', sourceId: 'manual-001' }, 'sourceId', 'sourceCode'],
  ])('enforces required and prohibited fields for origin %#', (origin, required, prohibited) => {
    const missing = clone(quoteAcquisitionFixture) as any
    missing.entitlementGrants[0].origins =
      origin.kind === 'CAMPAIGN' ? [missing.entitlementGrants[0].origins[0], clone(origin)] : [clone(origin)]
    delete missing.entitlementGrants[0].origins.at(-1)[required]
    expect(validationRule(() => validateCommercialQuoteV2(missing))).toBe('SCHEMA')

    const extra = clone(quoteAcquisitionFixture) as any
    extra.entitlementGrants[0].origins =
      origin.kind === 'CAMPAIGN' ? [extra.entitlementGrants[0].origins[0], clone(origin)] : [clone(origin)]
    extra.entitlementGrants[0].origins.at(-1)[prohibited] = 'forbidden'
    expect(validationRule(() => validateCommercialQuoteV2(extra))).toBe('SCHEMA')
  })
})
