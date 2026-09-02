import catalogFixtureJson from '@/contracts/commercial/fixtures/v2/catalog-base.json'
import pricingVectorsJson from '@/contracts/commercial/fixtures/v2/pricing-vectors.json'
import { evaluateCommercialQuoteV2 } from '@/services/commercial/commercialQuoteEngineV2.service'
import type { CommercialCampaignRuleV2, CommercialCampaignSnapshotV2, CommercialCatalogSnapshotV2 } from '@/types/commercialV2'

const catalog = catalogFixtureJson as CommercialCatalogSnapshotV2
const now = new Date('2026-08-22T15:00:00.000Z')

type PricingVector = (typeof pricingVectorsJson.vectors)[number]

function catalogForVector(vector: PricingVector): CommercialCatalogSnapshotV2 {
  const value = JSON.parse(JSON.stringify(catalog)) as CommercialCatalogSnapshotV2
  const edge = vector.lines.find(line => line.targetCode === 'EDGE')
  if (edge) {
    value.products.push({
      code: 'EDGE',
      slug: 'edge',
      kind: 'POS',
      name: 'Edge',
      description: 'Synthetic exact-money boundary target.',
      salesMode: 'SELF_SERVICE',
      sortOrder: 999,
      capabilityBindings: [{ capabilityCode: 'POS_CORE', capabilityKind: 'CORE', activationRequirement: { mode: 'NOT_REQUIRED' } }],
      prices: [
        {
          code: edge.priceCode,
          billingUnit: 'VENUE_MONTH',
          amount: edge.unitAmount,
          currency: 'MXN',
          taxBehavior: 'EXCLUSIVE',
          taxRateBasisPoints: 1600,
        },
      ],
    })
  }
  return value
}

function campaignForVector(vector: PricingVector): CommercialCampaignSnapshotV2 | null {
  if (vector.campaignRules.length === 0) return null
  const rules = vector.campaignRules.map((source, index) => {
    const target = {
      ...(source.targetProductCodes ? { productCodes: source.targetProductCodes } : {}),
      ...('targetProductKinds' in source && source.targetProductKinds ? { productKinds: source.targetProductKinds } : {}),
    }
    const base = { code: source.code, priority: 100 - index, target, cycles: source.cycles }
    if (source.type === 'PERCENT_OFF') {
      if (!('percentBasisPoints' in source)) throw new Error('Percent vector is missing percentBasisPoints')
      return { ...base, type: source.type, percentBasisPoints: source.percentBasisPoints }
    }
    if (source.type === 'FREE_PERIOD') return { ...base, type: source.type }
    if (!('amount' in source)) throw new Error('Amount vector is missing amount')
    return { ...base, type: source.type, amount: source.amount }
  }) as CommercialCampaignRuleV2[]
  return {
    schemaVersion: 2,
    contractVersion: '2.0.0',
    campaignVersionId: `campaign-${vector.code.toLowerCase()}`,
    campaignCode: vector.code,
    version: 1,
    status: 'ACTIVE',
    publishedAt: '2026-07-31T06:00:00.000Z',
    startsAt: '2026-08-01T06:00:00.000Z',
    endsAt: '2026-09-01T06:00:00.000Z',
    stackingGroups: [],
    rules,
  }
}

function activeCampaign(
  rules: CommercialCampaignRuleV2[],
  stackingGroups: CommercialCampaignSnapshotV2['stackingGroups'] = [],
): CommercialCampaignSnapshotV2 {
  return {
    schemaVersion: 2,
    contractVersion: '2.0.0',
    campaignVersionId: 'campaign-version-engine-v2',
    campaignCode: 'ENGINE_V2',
    version: 1,
    status: 'ACTIVE',
    publishedAt: '2026-07-31T06:00:00.000Z',
    startsAt: '2026-08-01T06:00:00.000Z',
    endsAt: '2026-09-01T06:00:00.000Z',
    stackingGroups,
    rules,
  }
}

const posSelection = { targetType: 'PRODUCT' as const, targetCode: 'POS', priceCode: 'POS_MONTHLY', quantity: 1 }
const kitchenSelection = {
  targetType: 'PRODUCT' as const,
  targetCode: 'KITCHEN_DISPLAY_MODULE',
  priceCode: 'KITCHEN_DISPLAY_MONTHLY',
  quantity: 1,
}

function fixed(code: string, amount: string, cycles = 3, priority = 100): CommercialCampaignRuleV2 {
  return { code, type: 'FIXED_PRICE', priority, target: { productCodes: ['POS'] }, cycles, amount }
}

function percent(code: string, percentBasisPoints: number, cycles = 3, priority = 90): CommercialCampaignRuleV2 {
  return { code, type: 'PERCENT_OFF', priority, target: { productCodes: ['POS'] }, cycles, percentBasisPoints }
}

function amountOff(code: string, amount: string, cycles = 3, priority = 80): CommercialCampaignRuleV2 {
  return { code, type: 'AMOUNT_OFF', priority, target: { productCodes: ['POS'] }, cycles, amount }
}

function repeatedProductCatalog(
  count: number,
  options: { amount?: string; sharedCapability?: boolean; taxRateBasisPoints?: 0 | 1600 } = {},
): CommercialCatalogSnapshotV2 {
  const value = JSON.parse(JSON.stringify(catalog)) as CommercialCatalogSnapshotV2
  const source = value.products.find(product => product.code === 'POS')!
  value.products = Array.from({ length: count }, (_, index) => {
    const suffix = String(index + 1).padStart(2, '0')
    return {
      ...JSON.parse(JSON.stringify(source)),
      code: `SYNTHETIC_${suffix}`,
      slug: `synthetic-${suffix}`,
      sortOrder: index + 1,
      capabilityBindings:
        options.sharedCapability === undefined
          ? []
          : [
              {
                capabilityCode: options.sharedCapability ? 'POS_CORE' : `SYNTHETIC_CAPABILITY_${suffix}`,
                capabilityKind: 'CORE' as const,
                activationRequirement: { mode: 'NOT_REQUIRED' as const },
              },
            ],
      prices: [
        {
          ...source.prices[0],
          code: `SYNTHETIC_PRICE_${suffix}`,
          amount: options.amount ?? '1.00',
          taxRateBasisPoints: options.taxRateBasisPoints ?? 0,
          taxBehavior: options.taxRateBasisPoints === 1600 ? ('EXCLUSIVE' as const) : ('NOT_APPLICABLE' as const),
        },
      ],
    }
  })
  value.bundles = []
  return value
}

function selectAllProducts(value: CommercialCatalogSnapshotV2, quantity = 1) {
  return value.products.map(product => ({
    targetType: 'PRODUCT' as const,
    targetCode: product.code,
    priceCode: product.prices[0].code,
    quantity,
  }))
}

describe('evaluateCommercialQuoteV2', () => {
  it('quotes POS 249.00 plus 39.84 IVA and derives its published entitlement', () => {
    const evaluation = evaluateCommercialQuoteV2({
      catalog,
      campaign: null,
      lines: [{ targetType: 'PRODUCT', targetCode: 'POS', priceCode: 'POS_MONTHLY', quantity: 1 }],
      now,
    })

    expect(evaluation.totals).toEqual({
      listSubtotal: '249.00',
      discount: '0.00',
      subtotal: '249.00',
      tax: '39.84',
      total: '288.84',
    })
    expect(evaluation.renewal).toEqual({ subtotal: '249.00', tax: '39.84', total: '288.84' })
    expect(evaluation.lines[0]).toMatchObject({
      lineKey: 'PRODUCT:POS:POS_MONTHLY',
      unitAmount: '249.00',
      listSubtotal: '249.00',
      appliedCampaigns: [],
      promotionalCycles: null,
    })
    expect(evaluation.entitlementGrants).toEqual([
      {
        capabilityCode: 'POS_CORE',
        capabilityKind: 'CORE',
        activationRequirement: { mode: 'NOT_REQUIRED' },
        origins: [{ kind: 'PRODUCT', sourceCode: 'POS', lineKey: 'PRODUCT:POS:POS_MONTHLY' }],
      },
    ])
  })

  it('is behaviorally stable when an unreferenced capability registry definition changes', () => {
    const input = { catalog, campaign: null, lines: [posSelection], now }
    const baseline = evaluateCommercialQuoteV2(input)
    let isolatedEvaluation: ReturnType<typeof evaluateCommercialQuoteV2> | undefined

    jest.isolateModules(() => {
      jest.doMock('@/services/commercial/commercialCapabilityRegistry', () => ({
        COMMERCIAL_CAPABILITY_REGISTRY: Object.freeze({
          UNREFERENCED_CAPABILITY: Object.freeze({
            capabilityKind: 'FEATURE',
            activationRequirement: Object.freeze({ mode: 'NOT_REQUIRED' }),
          }),
        }),
        getCommercialCapabilityDefinition: (code: string) =>
          code === 'UNREFERENCED_CAPABILITY' ? { capabilityKind: 'FEATURE', activationRequirement: { mode: 'NOT_REQUIRED' } } : undefined,
        getCommercialCapabilityKind: (code: string) => (code === 'UNREFERENCED_CAPABILITY' ? 'FEATURE' : undefined),
      }))
      const isolated = jest.requireActual(
        '@/services/commercial/commercialQuoteEngineV2.service',
      ) as typeof import('@/services/commercial/commercialQuoteEngineV2.service')
      isolatedEvaluation = isolated.evaluateCommercialQuoteV2(input)
    })
    jest.dontMock('@/services/commercial/commercialCapabilityRegistry')

    expect(isolatedEvaluation).toEqual(baseline)
  })

  it.each(pricingVectorsJson.vectors)('matches canonical bigint pricing vector $code', vector => {
    const evaluation = evaluateCommercialQuoteV2({
      catalog: catalogForVector(vector),
      campaign: campaignForVector(vector),
      lines: vector.lines.map(line => ({
        targetType: line.targetType as 'PRODUCT' | 'BUNDLE',
        targetCode: line.targetCode,
        priceCode: line.priceCode,
        quantity: line.quantity,
      })),
      now,
    })

    expect(evaluation.totals).toEqual(vector.expected.current)
    expect(evaluation.renewal).toEqual(vector.expected.renewal)
  })

  it('applies the complete anchor group in published order and renumbers emitted positions', () => {
    const evaluation = evaluateCommercialQuoteV2({
      catalog,
      campaign: activeCampaign(
        [fixed('FIXED_50', '50.00'), percent('TEN_PERCENT', 1000)],
        [
          {
            code: 'POS_STACK',
            steps: [
              { position: 1, ruleCode: 'FIXED_50' },
              { position: 2, ruleCode: 'TEN_PERCENT' },
            ],
          },
        ],
      ),
      lines: [posSelection],
      now,
    })

    expect(evaluation.lines[0].appliedCampaigns).toMatchObject([
      { ruleCode: 'FIXED_50', position: 1, inputAmount: '249.00', discountAmount: '199.00', outputAmount: '50.00' },
      { ruleCode: 'TEN_PERCENT', position: 2, inputAmount: '50.00', discountAmount: '5.00', outputAmount: '45.00' },
    ])
    expect(evaluation.totals).toEqual({
      listSubtotal: '249.00',
      discount: '204.00',
      subtotal: '45.00',
      tax: '7.20',
      total: '52.20',
    })
  })

  it('ignores an incomplete group and applies only its winning anchor', () => {
    const nonTargeting = {
      code: 'MODULE_ONLY',
      type: 'PERCENT_OFF' as const,
      priority: 90,
      target: { productKinds: ['MODULE'] as ['MODULE'] },
      cycles: 3,
      percentBasisPoints: 1000,
    }
    const evaluation = evaluateCommercialQuoteV2({
      catalog,
      campaign: activeCampaign(
        [fixed('FIXED_50', '50.00'), nonTargeting],
        [
          {
            code: 'INCOMPLETE',
            steps: [
              { position: 1, ruleCode: 'FIXED_50' },
              { position: 2, ruleCode: 'MODULE_ONLY' },
            ],
          },
        ],
      ),
      lines: [posSelection],
      now,
    })

    expect(evaluation.lines[0].appliedCampaigns.map(step => step.ruleCode)).toEqual(['FIXED_50'])
    expect(evaluation.totals.total).toBe('58.00')
  })

  it('chooses the largest complete group containing the anchor', () => {
    const evaluation = evaluateCommercialQuoteV2({
      catalog,
      campaign: activeCampaign(
        [fixed('FIXED_50', '50.00'), percent('TEN_PERCENT', 1000), amountOff('FIVE_MORE', '5.00')],
        [
          {
            code: 'TWO',
            steps: [
              { position: 1, ruleCode: 'FIXED_50' },
              { position: 2, ruleCode: 'TEN_PERCENT' },
            ],
          },
          {
            code: 'THREE',
            steps: [
              { position: 1, ruleCode: 'FIXED_50' },
              { position: 2, ruleCode: 'TEN_PERCENT' },
              { position: 3, ruleCode: 'FIVE_MORE' },
            ],
          },
        ],
      ),
      lines: [posSelection],
      now,
    })

    expect(evaluation.lines[0].appliedCampaigns.map(step => step.ruleCode)).toEqual(['FIXED_50', 'TEN_PERCENT', 'FIVE_MORE'])
    expect(evaluation.totals).toMatchObject({ subtotal: '40.00', tax: '6.40', total: '46.40' })
  })

  it('breaks equal-size group ties by exact ASCII group code', () => {
    const evaluation = evaluateCommercialQuoteV2({
      catalog,
      campaign: activeCampaign(
        [fixed('FIXED_50', '50.00'), percent('TEN_PERCENT', 1000), amountOff('TEN_MORE', '10.00')],
        [
          {
            code: 'B_STACK',
            steps: [
              { position: 1, ruleCode: 'FIXED_50' },
              { position: 2, ruleCode: 'TEN_MORE' },
            ],
          },
          {
            code: 'A_STACK',
            steps: [
              { position: 1, ruleCode: 'FIXED_50' },
              { position: 2, ruleCode: 'TEN_PERCENT' },
            ],
          },
        ],
      ),
      lines: [posSelection],
      now,
    })

    expect(evaluation.lines[0].appliedCampaigns.map(step => step.ruleCode)).toEqual(['FIXED_50', 'TEN_PERCENT'])
    expect(evaluation.totals.total).toBe('52.20')
  })

  it('breaks equal-priority rule ties by exact ASCII code independent of insertion order', () => {
    const evaluation = evaluateCommercialQuoteV2({
      catalog,
      campaign: activeCampaign([fixed('Z_RULE', '50.00', 3, 100), fixed('A_RULE', '22.00', 3, 100)]),
      lines: [posSelection],
      now,
    })

    expect(evaluation.lines[0].appliedCampaigns.map(step => step.ruleCode)).toEqual(['A_RULE'])
    expect(evaluation.totals.total).toBe('25.52')
  })

  it('keeps FREE_PERIOD isolated even in a synthetic invalid group where it is not the anchor', () => {
    const freePeriod: CommercialCampaignRuleV2 = {
      code: 'FREE_LATER',
      type: 'FREE_PERIOD',
      priority: 90,
      target: { productCodes: ['POS'] },
      cycles: 3,
    }
    const evaluation = evaluateCommercialQuoteV2({
      catalog,
      campaign: activeCampaign(
        [fixed('FIXED_50', '50.00'), freePeriod],
        [
          {
            code: 'INVALID_FREE_STACK',
            steps: [
              { position: 1, ruleCode: 'FIXED_50' },
              { position: 2, ruleCode: 'FREE_LATER' },
            ],
          },
        ],
      ),
      lines: [posSelection],
      now,
    })

    expect(evaluation.lines[0].appliedCampaigns.map(step => step.ruleCode)).toEqual(['FIXED_50'])
    expect(evaluation.totals.total).toBe('58.00')
  })

  it('clamps AMOUNT_OFF at zero without changing renewal', () => {
    const evaluation = evaluateCommercialQuoteV2({
      catalog,
      campaign: activeCampaign([amountOff('THREE_HUNDRED', '300.00', 3, 100)]),
      lines: [posSelection],
      now,
    })

    expect(evaluation.totals).toEqual({ listSubtotal: '249.00', discount: '249.00', subtotal: '0.00', tax: '0.00', total: '0.00' })
    expect(evaluation.renewal.total).toBe('288.84')
  })

  it('applies the maximum 100% percentage without producing negative money', () => {
    const evaluation = evaluateCommercialQuoteV2({
      catalog,
      campaign: activeCampaign([percent('ONE_HUNDRED_PERCENT', 10_000, 3, 100)]),
      lines: [posSelection],
      now,
    })

    expect(evaluation.totals).toEqual({ listSubtotal: '249.00', discount: '249.00', subtotal: '0.00', tax: '0.00', total: '0.00' })
  })

  it('applies BUNDLE_PRICE and derives canonical component origins', () => {
    const evaluation = evaluateCommercialQuoteV2({
      catalog,
      campaign: activeCampaign([
        {
          code: 'BUNDLE_1500',
          type: 'BUNDLE_PRICE',
          priority: 100,
          target: { bundleCodes: ['ALL_MODULES'] },
          cycles: 3,
          amount: '1500.00',
        },
      ]),
      lines: [{ targetType: 'BUNDLE', targetCode: 'ALL_MODULES', priceCode: 'ALL_MODULES_MONTHLY', quantity: 1 }],
      now,
    })

    expect(evaluation.totals).toEqual({
      listSubtotal: '1999.00',
      discount: '499.00',
      subtotal: '1500.00',
      tax: '240.00',
      total: '1740.00',
    })
    expect(evaluation.renewal.total).toBe('2318.84')
    expect(evaluation.entitlementGrants[0].origins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'BUNDLE_COMPONENT', parentSourceCode: 'ALL_MODULES' }),
        {
          kind: 'CAMPAIGN',
          sourceCode: 'ENGINE_V2',
          sourceId: 'campaign-version-engine-v2',
          lineKey: 'BUNDLE:ALL_MODULES:ALL_MODULES_MONTHLY',
        },
      ]),
    )
    evaluation.entitlementGrants.forEach(grant =>
      expect(new Set(grant.origins.map(origin => JSON.stringify(origin))).size).toBe(grant.origins.length),
    )
  })

  it('keeps cycles for a zero-discount applied step without inventing a CAMPAIGN origin', () => {
    const evaluation = evaluateCommercialQuoteV2({
      catalog,
      campaign: activeCampaign([fixed('FIXED_249', '249.00')]),
      lines: [posSelection],
      now,
    })

    expect(evaluation.lines[0]).toMatchObject({ discount: '0.00', promotionalCycles: 3 })
    expect(evaluation.lines[0].appliedCampaigns).toHaveLength(1)
    expect(evaluation.entitlementGrants[0].origins).toEqual([{ kind: 'PRODUCT', sourceCode: 'POS', lineKey: 'PRODUCT:POS:POS_MONTHLY' }])
  })

  it('does not let a bundle-code collision target a product line', () => {
    const evaluation = evaluateCommercialQuoteV2({
      catalog,
      campaign: activeCampaign([
        { code: 'WRONG_TARGET_ARRAY', type: 'FIXED_PRICE', priority: 100, target: { bundleCodes: ['POS'] }, cycles: 3, amount: '50.00' },
      ]),
      lines: [posSelection],
      now,
    })

    expect(evaluation.lines[0]).toMatchObject({ discount: '0.00', appliedCampaigns: [] })
  })

  it('does not let a product-code or product-kind target select a bundle line', () => {
    const evaluation = evaluateCommercialQuoteV2({
      catalog,
      campaign: activeCampaign([
        {
          code: 'WRONG_PRODUCT_CODE',
          type: 'FIXED_PRICE',
          priority: 100,
          target: { productCodes: ['ALL_MODULES'] },
          cycles: 3,
          amount: '50.00',
        },
        {
          code: 'WRONG_PRODUCT_KIND',
          type: 'PERCENT_OFF',
          priority: 90,
          target: { productKinds: ['MODULE'] },
          cycles: 3,
          percentBasisPoints: 1000,
        },
      ]),
      lines: [{ targetType: 'BUNDLE', targetCode: 'ALL_MODULES', priceCode: 'ALL_MODULES_MONTHLY', quantity: 1 }],
      now,
    })

    expect(evaluation.lines[0]).toMatchObject({ discount: '0.00', appliedCampaigns: [] })
  })

  it.each([
    {
      label: 'selected price increase',
      campaign: activeCampaign([fixed('FIXED_300', '300.00')]),
      lines: [posSelection],
      code: 'COMMERCIAL_CAMPAIGN_INCREASES_PRICE',
    },
    {
      label: 'selected bundle price increase',
      campaign: activeCampaign([
        {
          code: 'BUNDLE_2500',
          type: 'BUNDLE_PRICE' as const,
          priority: 100,
          target: { bundleCodes: ['ALL_MODULES'] as ['ALL_MODULES'] },
          cycles: 3,
          amount: '2500.00',
        },
      ]),
      lines: [{ targetType: 'BUNDLE' as const, targetCode: 'ALL_MODULES', priceCode: 'ALL_MODULES_MONTHLY', quantity: 1 }],
      code: 'COMMERCIAL_CAMPAIGN_INCREASES_PRICE',
    },
    {
      label: 'stack cycle mismatch',
      campaign: activeCampaign(
        [fixed('FIXED_50', '50.00', 3), percent('TEN_PERCENT', 1000, 2)],
        [
          {
            code: 'MIXED',
            steps: [
              { position: 1, ruleCode: 'FIXED_50' },
              { position: 2, ruleCode: 'TEN_PERCENT' },
            ],
          },
        ],
      ),
      lines: [posSelection],
      code: 'COMMERCIAL_CAMPAIGN_STACK_CYCLE_MISMATCH',
    },
    {
      label: 'quote cycle mismatch',
      campaign: activeCampaign([
        fixed('POS_THREE', '50.00', 3),
        {
          code: 'MODULE_TWO',
          type: 'PERCENT_OFF' as const,
          priority: 100,
          target: { productCodes: ['KITCHEN_DISPLAY_MODULE'] as ['KITCHEN_DISPLAY_MODULE'] },
          cycles: 2,
          percentBasisPoints: 1000,
        },
      ]),
      lines: [posSelection, kitchenSelection],
      code: 'COMMERCIAL_CAMPAIGN_QUOTE_CYCLE_MISMATCH',
    },
  ])('fails closed for $label', scenario => {
    expect(() => evaluateCommercialQuoteV2({ catalog, campaign: scenario.campaign, lines: scenario.lines, now })).toThrow(
      expect.objectContaining({ statusCode: 422, code: scenario.code }),
    )
  })

  it.each([
    { label: 'inactive', mutate: (value: CommercialCampaignSnapshotV2) => (value.status = 'INACTIVE' as 'ACTIVE') },
    { label: 'not started', mutate: (value: CommercialCampaignSnapshotV2) => (value.startsAt = new Date(now.getTime() + 1).toISOString()) },
    { label: 'ended at the exclusive boundary', mutate: (value: CommercialCampaignSnapshotV2) => (value.endsAt = now.toISOString()) },
    { label: 'malformed window', mutate: (value: CommercialCampaignSnapshotV2) => (value.startsAt = 'not-a-date') },
  ])('rejects a campaign that is $label', scenario => {
    const campaign = activeCampaign([fixed('FIXED_50', '50.00')])
    scenario.mutate(campaign)
    expect(() => evaluateCommercialQuoteV2({ catalog, campaign, lines: [posSelection], now })).toThrow(
      expect.objectContaining({ statusCode: 422, code: 'COMMERCIAL_CAMPAIGN_NOT_ACTIVE' }),
    )
  })

  it('validates selection quantities before an otherwise inactive campaign', () => {
    const campaign = activeCampaign([fixed('FIXED_50', '50.00')])
    campaign.status = 'INACTIVE'
    expect(() => evaluateCommercialQuoteV2({ catalog, campaign, lines: [{ ...posSelection, quantity: 0 }], now })).toThrow(
      expect.objectContaining({ statusCode: 422, code: 'COMMERCIAL_QUOTE_INVALID_QUANTITY' }),
    )
  })

  it.each([
    { label: 'empty', lines: [], code: 'COMMERCIAL_QUOTE_EMPTY' },
    { label: 'too many', lines: Array.from({ length: 51 }, () => posSelection), code: 'COMMERCIAL_QUOTE_TOO_MANY_LINES' },
    { label: 'duplicate', lines: [posSelection, posSelection], code: 'COMMERCIAL_QUOTE_DUPLICATE_LINE' },
    { label: 'zero quantity', lines: [{ ...posSelection, quantity: 0 }], code: 'COMMERCIAL_QUOTE_INVALID_QUANTITY' },
    { label: 'quantity above the limit', lines: [{ ...posSelection, quantity: 1_001 }], code: 'COMMERCIAL_QUOTE_INVALID_QUANTITY' },
    { label: 'fractional quantity', lines: [{ ...posSelection, quantity: 1.5 }], code: 'COMMERCIAL_QUOTE_INVALID_QUANTITY' },
    { label: 'unknown price', lines: [{ ...posSelection, priceCode: 'UNKNOWN' }], code: 'COMMERCIAL_QUOTE_PRICE_NOT_FOUND' },
  ])('rejects $label selections with the stable 422 code', scenario => {
    expect(() => evaluateCommercialQuoteV2({ catalog, campaign: null, lines: scenario.lines, now })).toThrow(
      expect.objectContaining({ statusCode: 422, code: scenario.code }),
    )
  })

  it('rejects a priced CONTACT product with the same non-disclosing price code', () => {
    const contactCatalog = JSON.parse(JSON.stringify(catalog)) as CommercialCatalogSnapshotV2
    contactCatalog.products.find(product => product.code === 'POS')!.salesMode = 'CONTACT'
    expect(() => evaluateCommercialQuoteV2({ catalog: contactCatalog, campaign: null, lines: [posSelection], now })).toThrow(
      expect.objectContaining({ statusCode: 422, code: 'COMMERCIAL_QUOTE_PRICE_NOT_FOUND' }),
    )
  })

  it('rejects a non-MXN price with the same non-disclosing price code', () => {
    const nonMxnCatalog = JSON.parse(JSON.stringify(catalog)) as CommercialCatalogSnapshotV2
    nonMxnCatalog.products.find(product => product.code === 'POS')!.prices[0].currency = 'USD' as 'MXN'
    expect(() => evaluateCommercialQuoteV2({ catalog: nonMxnCatalog, campaign: null, lines: [posSelection], now })).toThrow(
      expect.objectContaining({ statusCode: 422, code: 'COMMERCIAL_QUOTE_PRICE_NOT_FOUND' }),
    )
  })

  it('rejects a non-finite quote clock even without a campaign', () => {
    expect(() => evaluateCommercialQuoteV2({ catalog, campaign: null, lines: [posSelection], now: new Date(Number.NaN) })).toThrow(
      expect.objectContaining({ statusCode: 422, code: 'COMMERCIAL_QUOTE_INVALID_WINDOW' }),
    )
  })

  it('uses the intrinsic quote clock for campaign validity even when getTime is overridden', () => {
    class AdversarialDate extends Date {
      override getTime(): number {
        throw new TypeError('overridden getTime must not participate in quote evaluation')
      }
    }

    expect(
      evaluateCommercialQuoteV2({
        catalog,
        campaign: activeCampaign([fixed('FIXED_50', '50.00')]),
        lines: [posSelection],
        now: new AdversarialDate('2026-08-24T12:00:00.000Z'),
      }).totals.total,
    ).toBe('58.00')
  })

  it('orders complete line keys by ASCII rather than by a field tuple', () => {
    const asciiCatalog = JSON.parse(JSON.stringify(catalog)) as CommercialCatalogSnapshotV2
    const source = asciiCatalog.products.find(product => product.code === 'POS')!
    asciiCatalog.products.push(
      { ...JSON.parse(JSON.stringify(source)), code: 'AA', slug: 'aa', sortOrder: 998, prices: [{ ...source.prices[0], code: 'P' }] },
      { ...JSON.parse(JSON.stringify(source)), code: 'AA0', slug: 'aa0', sortOrder: 999, prices: [{ ...source.prices[0], code: 'P' }] },
    )
    const evaluation = evaluateCommercialQuoteV2({
      catalog: asciiCatalog,
      campaign: null,
      lines: [
        { targetType: 'PRODUCT', targetCode: 'AA', priceCode: 'P', quantity: 1 },
        { targetType: 'PRODUCT', targetCode: 'AA0', priceCode: 'P', quantity: 1 },
      ],
      now,
    })

    expect(evaluation.lines.map(line => line.lineKey)).toEqual(['PRODUCT:AA0:P', 'PRODUCT:AA:P'])
  })

  it('preserves FREE and venue-setting activation requirements from the catalog snapshot', () => {
    const evaluation = evaluateCommercialQuoteV2({
      catalog,
      campaign: null,
      lines: [
        { targetType: 'PRODUCT', targetCode: 'FREE', priceCode: 'FREE_MONTHLY', quantity: 1 },
        { targetType: 'PRODUCT', targetCode: 'PRO', priceCode: 'PRO_MONTHLY', quantity: 1 },
      ],
      now,
    })

    expect(evaluation.entitlementGrants.find(grant => grant.capabilityCode === 'CHATBOT')?.origins).toEqual([
      { kind: 'FREE', sourceCode: 'FREE', lineKey: 'PRODUCT:FREE:FREE_MONTHLY' },
      { kind: 'PRODUCT', sourceCode: 'PRO', lineKey: 'PRODUCT:PRO:PRO_MONTHLY' },
    ])
    expect(evaluation.entitlementGrants.find(grant => grant.capabilityCode === 'CASH_RECONCILIATION')).toMatchObject({
      activationRequirement: { mode: 'VENUE_SETTING', settingKey: 'cashReconciliationEnabled', defaultState: 'OFF' },
    })
  })

  it('quotes the real catalog Free plan at exact zero without a campaign', () => {
    const evaluation = evaluateCommercialQuoteV2({
      catalog,
      campaign: null,
      lines: [{ targetType: 'PRODUCT', targetCode: 'FREE', priceCode: 'FREE_MONTHLY', quantity: 1 }],
      now,
    })

    expect(evaluation.totals).toEqual({ listSubtotal: '0.00', discount: '0.00', subtotal: '0.00', tax: '0.00', total: '0.00' })
    expect(evaluation.renewal).toEqual({ subtotal: '0.00', tax: '0.00', total: '0.00' })
    expect(evaluation.entitlementGrants[0].origins).toEqual([{ kind: 'FREE', sourceCode: 'FREE', lineKey: 'PRODUCT:FREE:FREE_MONTHLY' }])
  })

  it('maps invalid or over-limit published money to the stable overflow code', () => {
    const overflowCatalog = JSON.parse(JSON.stringify(catalog)) as CommercialCatalogSnapshotV2
    overflowCatalog.products.find(product => product.code === 'POS')!.prices[0].amount = '10000000000.00'
    expect(() => evaluateCommercialQuoteV2({ catalog: overflowCatalog, campaign: null, lines: [posSelection], now })).toThrow(
      expect.objectContaining({ statusCode: 422, code: 'COMMERCIAL_QUOTE_MONEY_OVERFLOW' }),
    )
  })

  it('applies the unit-money limit to a published campaign amount before multiplying', () => {
    expect(() =>
      evaluateCommercialQuoteV2({
        catalog,
        campaign: activeCampaign([amountOff('TOO_LARGE_PER_UNIT', '10000000000.00')]),
        lines: [posSelection],
        now,
      }),
    ).toThrow(expect.objectContaining({ statusCode: 422, code: 'COMMERCIAL_QUOTE_MONEY_OVERFLOW' }))
  })

  it('does not disguise an unexpected engine failure as a money overflow', () => {
    const malformedCatalog = JSON.parse(JSON.stringify(catalog)) as CommercialCatalogSnapshotV2
    const sentinel = new TypeError('unexpected price accessor failure')
    Object.defineProperty(malformedCatalog.products.find(product => product.code === 'POS')!.prices[0], 'amount', {
      enumerable: true,
      get: () => {
        throw sentinel
      },
    })

    expect(() => evaluateCommercialQuoteV2({ catalog: malformedCatalog, campaign: null, lines: [posSelection], now })).toThrow(sentinel)
  })

  it('materializes each request selection field exactly once before evaluation', () => {
    const reads = { targetType: 0, targetCode: 0, priceCode: 0, quantity: 0 }
    const once =
      <K extends keyof typeof reads>(field: K, value: (typeof posSelection)[K]) =>
      () => {
        reads[field] += 1
        if (reads[field] > 1) throw new TypeError(`${field} was read more than once`)
        return value
      }
    const selection = Object.defineProperties(
      {},
      {
        targetType: { enumerable: true, get: once('targetType', posSelection.targetType) },
        targetCode: { enumerable: true, get: once('targetCode', posSelection.targetCode) },
        priceCode: { enumerable: true, get: once('priceCode', posSelection.priceCode) },
        quantity: { enumerable: true, get: once('quantity', posSelection.quantity) },
      },
    ) as typeof posSelection

    expect(evaluateCommercialQuoteV2({ catalog, campaign: null, lines: [selection], now }).totals.total).toBe('288.84')
    expect(reads).toEqual({ targetType: 1, targetCode: 1, priceCode: 1, quantity: 1 })
  })

  it('fails with a stable 422 before an emitted grant could exceed 32 origins', () => {
    const sharedCatalog = repeatedProductCatalog(33, { sharedCapability: true })
    expect(() =>
      evaluateCommercialQuoteV2({ catalog: sharedCatalog, campaign: null, lines: selectAllProducts(sharedCatalog), now }),
    ).toThrow(expect.objectContaining({ statusCode: 422, code: 'COMMERCIAL_QUOTE_TOO_MANY_ORIGINS' }))
  })

  it('reaches every undiscounted aggregate money maximum exactly with 50 canonical lines', () => {
    const maximumCatalog = repeatedProductCatalog(50, { amount: '9999999999.99', taxRateBasisPoints: 1600 })
    const evaluation = evaluateCommercialQuoteV2({
      catalog: maximumCatalog,
      campaign: null,
      lines: selectAllProducts(maximumCatalog, 1_000),
      now,
    })

    expect(evaluation.totals).toEqual({
      listSubtotal: '499999999999500.00',
      discount: '0.00',
      subtotal: '499999999999500.00',
      tax: '79999999999920.00',
      total: '579999999999420.00',
    })
    expect(evaluation.renewal).toEqual({
      subtotal: '499999999999500.00',
      tax: '79999999999920.00',
      total: '579999999999420.00',
    })
  })

  it('reaches the aggregate discount maximum while preserving every renewal maximum', () => {
    const maximumCatalog = repeatedProductCatalog(50, { amount: '9999999999.99', taxRateBasisPoints: 1600 })
    const evaluation = evaluateCommercialQuoteV2({
      catalog: maximumCatalog,
      campaign: activeCampaign([
        {
          code: 'ALL_FREE',
          type: 'PERCENT_OFF',
          priority: 100,
          target: { productKinds: ['POS'] },
          cycles: 1,
          percentBasisPoints: 10_000,
        },
      ]),
      lines: selectAllProducts(maximumCatalog, 1_000),
      now,
    })

    expect(evaluation.totals).toEqual({
      listSubtotal: '499999999999500.00',
      discount: '499999999999500.00',
      subtotal: '0.00',
      tax: '0.00',
      total: '0.00',
    })
    expect(evaluation.renewal).toEqual({
      subtotal: '499999999999500.00',
      tax: '79999999999920.00',
      total: '579999999999420.00',
    })
  })
})
