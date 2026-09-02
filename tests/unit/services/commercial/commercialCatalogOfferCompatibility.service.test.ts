import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import catalogFixture from '@/contracts/commercial/fixtures/v2/catalog-base.json'
import offerFixture from '@/contracts/commercial/fixtures/v3/commercial-offer-v3.json'
import {
  CommercialCatalogOfferCompatibilityError,
  validateCommercialCatalogOfferCompatibilityV3,
} from '@/services/commercial/offers/commercialCatalogOfferCompatibility.service'
import { resolveCommercialOfferV3WithRegistry } from '@/services/commercial/offers/commercialOfferResolutionRegistry.service'
import { commercialQuoteV3RuleTargetsLine } from '@/services/commercial/quotes-v3/commercialQuoteV3RuleMatcher.service'
import type { CommercialCampaignRuleV2, CommercialCatalogSnapshotV2 } from '@/types/commercialV2'
import type { CommercialOfferSnapshotV3 } from '@/types/commercialOfferV3'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function pair(
  catalog: CommercialCatalogSnapshotV2 = clone(catalogFixture) as CommercialCatalogSnapshotV2,
  offer: CommercialOfferSnapshotV3 = clone(offerFixture) as CommercialOfferSnapshotV3,
) {
  return validateCommercialCatalogOfferCompatibilityV3({ catalog, offer, resolvedAt: '2026-08-15T12:00:00.000Z' })
}

function saasBenefit(offer: CommercialOfferSnapshotV3, index = 0) {
  const benefits = offer.benefits.filter(benefit => benefit.kind === 'SAAS_PRICE')
  const benefit = benefits[index]
  if (!benefit || benefit.kind !== 'SAAS_PRICE') throw new Error('Expected SAAS_PRICE benefit')
  return benefit
}

function copyRule(source: CommercialCampaignRuleV2, overrides: Partial<CommercialCampaignRuleV2>): CommercialCampaignRuleV2 {
  const rule = { ...clone(source), ...clone(overrides) } as CommercialCampaignRuleV2
  if (rule.type === 'PERCENT_OFF') delete (rule as { amount?: string }).amount
  if (rule.type === 'FREE_PERIOD') {
    delete (rule as { amount?: string }).amount
    delete (rule as { percentBasisPoints?: number }).percentBasisPoints
  }
  return rule
}

function expectCompatibilityError(operation: () => unknown, rule: string): void {
  expect(operation).toThrow(
    expect.objectContaining({
      code: 'COMMERCIAL_CATALOG_OFFER_INCOMPATIBLE',
      rule,
      message: 'El catálogo y la oferta comercial no son compatibles.',
      statusCode: 409,
      details: { retryable: false },
    }) as CommercialCatalogOfferCompatibilityError,
  )
}

function exhaustiveRevision2Accepts(catalog: CommercialCatalogSnapshotV2, offer: CommercialOfferSnapshotV3): boolean {
  const identities = [
    ...catalog.products.flatMap(product =>
      product.prices.map(price => ({
        lineKey: `PRODUCT:${product.code}:${price.code}`,
        targetType: 'PRODUCT' as const,
        targetCode: product.code,
        productKind: product.kind,
      })),
    ),
    ...catalog.bundles.flatMap(bundle =>
      bundle.prices.map(price => ({
        lineKey: `BUNDLE:${bundle.code}:${price.code}`,
        targetType: 'BUNDLE' as const,
        targetCode: bundle.code,
        productKind: 'BUNDLE' as const,
      })),
    ),
  ]
  const rules = offer.benefits.flatMap(benefit => (benefit.kind === 'SAAS_PRICE' ? benefit.rules : []))
  const proofs = identities
    .map(identity => ({
      lineKey: identity.lineKey,
      ruleCodes: rules
        .filter(rule => commercialQuoteV3RuleTargetsLine(rule, identity))
        .map(rule => rule.code)
        .sort(),
    }))
    .filter(proof => proof.ruleCodes.length > 0)
  try {
    for (const proof of proofs.length === 0 ? [null] : proofs) {
      resolveCommercialOfferV3WithRegistry({
        resolutionVersion: 2,
        offer,
        resolvedAt: '2026-08-15T12:00:00.000Z',
        saasMatches: proof ? [proof] : [],
        hardwareSelections: [],
        rateBlockers: [],
      })
    }
    return true
  } catch {
    return false
  }
}

function deterministicScenario(seed: number): { catalog: CommercialCatalogSnapshotV2; offer: CommercialOfferSnapshotV3 } {
  let state = seed >>> 0
  const random = () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x1_0000_0000
  }
  const catalog = clone(catalogFixture) as CommercialCatalogSnapshotV2
  const template = clone(catalog.products[0])
  catalog.products = Array.from({ length: 10 }, (_, index) => ({
    ...clone(template),
    code: `DIFF_PLAN_${String(index).padStart(2, '0')}`,
    slug: `diff-plan-${String(index).padStart(2, '0')}`,
    prices: [{ ...clone(template.prices[0]), code: `DIFF_PRICE_${String(index).padStart(2, '0')}` }],
  }))
  catalog.bundles = []
  const offer = clone(offerFixture) as CommercialOfferSnapshotV3
  const benefit = saasBenefit(offer)
  benefit.stackingGroups = []
  benefit.rules = Array.from({ length: 6 }, (_, ruleIndex) => {
    const targeted = catalog.products.map(product => product.code).filter(() => random() >= 0.55)
    const productCodes = (targeted.length > 0 ? targeted : [catalog.products[ruleIndex % catalog.products.length].code]).sort()
    return copyRule(benefit.rules[0], {
      code: `DIFF_RULE_${String(ruleIndex).padStart(2, '0')}`,
      type: 'PERCENT_OFF',
      priority: 1 + Math.floor(random() * 4),
      target: { productCodes: productCodes as [string, ...string[]] },
      percentBasisPoints: 100 + ruleIndex,
    })
  }).sort((left, right) => (left.code < right.code ? -1 : 1))
  return { catalog, offer }
}

describe('Commercial Catalog v2 × Offer v3 compatibility', () => {
  describe('behavior', () => {
    it('exposes a pure pair validator for every concrete catalog price identity', () => {
      const result = pair()

      expect(result).toEqual({
        catalogPublicationId: 'commercial-catalog-initial-v2',
        offerVersionId: 'commercial-offer-version-summer-2026-v3',
        identityCount: 17,
        matchedIdentityCount: 1,
        resolverInvocationCount: 1,
      })
      expect(Object.isFrozen(result)).toBe(true)
    })

    it('matches product codes, bundle codes and product kinds against every price identity', () => {
      const offer = clone(offerFixture) as CommercialOfferSnapshotV3
      const benefit = saasBenefit(offer)
      benefit.rules = [
        copyRule(benefit.rules[0], { code: 'FREE_BY_CODE', target: { productCodes: ['FREE'] } }),
        copyRule(benefit.rules[0], { code: 'MODULES_BY_KIND', target: { productKinds: ['MODULE'] } }),
        copyRule(benefit.rules[0], { code: 'BUNDLE_BY_CODE', target: { bundleCodes: ['ALL_MODULES'] } }),
      ].sort((left, right) => (left.code < right.code ? -1 : 1))

      expect(pair(undefined, offer)).toMatchObject({ identityCount: 17, matchedIdentityCount: 12, resolverInvocationCount: 1 })
    })

    it('reuses one frozen resolver proof for identities with the same matched rule signature', () => {
      const catalog = clone(catalogFixture) as CommercialCatalogSnapshotV2
      const template = clone(catalog.products[0])
      catalog.products = Array.from({ length: 60 }, (_, index) => ({
        ...clone(template),
        code: `PLAN_${String(index).padStart(3, '0')}`,
        slug: `plan-${String(index).padStart(3, '0')}`,
        prices: [{ ...clone(template.prices[0]), code: `PLAN_PRICE_${String(index).padStart(3, '0')}` }],
      }))
      catalog.bundles = []
      const offer = clone(offerFixture) as CommercialOfferSnapshotV3
      const benefit = saasBenefit(offer)
      benefit.rules = [copyRule(benefit.rules[0], { target: { productKinds: ['PLAN'] } })]

      expect(pair(catalog, offer)).toMatchObject({
        identityCount: 60,
        matchedIdentityCount: 60,
        resolverInvocationCount: 1,
      })
    })

    it('reuses one revision-2 resolver proof for distinct signatures with equivalent resolution semantics', () => {
      const catalog = clone(catalogFixture) as CommercialCatalogSnapshotV2
      const template = clone(catalog.products[0])
      catalog.products = Array.from({ length: 60 }, (_, index) => ({
        ...clone(template),
        code: `PLAN_${String(index).padStart(3, '0')}`,
        slug: `plan-${String(index).padStart(3, '0')}`,
        prices: [{ ...clone(template.prices[0]), code: `PLAN_PRICE_${String(index).padStart(3, '0')}` }],
      }))
      catalog.bundles = []
      const offer = clone(offerFixture) as CommercialOfferSnapshotV3
      const benefit = saasBenefit(offer)
      benefit.rules = catalog.products.map((product, index) =>
        copyRule(benefit.rules[0], {
          code: `PLAN_RULE_${String(index).padStart(3, '0')}`,
          priority: 100 - index,
          target: { productCodes: [product.code] },
        }),
      )

      expect(pair(catalog, offer)).toMatchObject({
        identityCount: 60,
        matchedIdentityCount: 60,
        resolverInvocationCount: 1,
      })
    })

    it.each([
      ['two exact stacking groups', 'EXACT_STACK'],
      ['a strict-subset stacking group', 'STRICT_SUBSET'],
      ['a highest-priority tie', 'PRIORITY_TIE'],
    ] as const)('rejects %s buried after 55 compatible identities', (_label, ambiguity) => {
      const catalog = clone(catalogFixture) as CommercialCatalogSnapshotV2
      const template = clone(catalog.products[0])
      catalog.products = Array.from({ length: 56 }, (_, index) => ({
        ...clone(template),
        code: `PLAN_${String(index).padStart(3, '0')}`,
        slug: `plan-${String(index).padStart(3, '0')}`,
        prices: [{ ...clone(template.prices[0]), code: `PLAN_PRICE_${String(index).padStart(3, '0')}` }],
      }))
      catalog.bundles = []
      const offer = clone(offerFixture) as CommercialOfferSnapshotV3
      const benefit = saasBenefit(offer)
      const compatibleRules = catalog.products.slice(0, 55).map((product, index) =>
        copyRule(benefit.rules[0], {
          code: `PLAN_RULE_${String(index).padStart(3, '0')}`,
          priority: 200 - index,
          target: { productCodes: [product.code] },
        }),
      )
      const ambiguousRules = [
        copyRule(benefit.rules[0], {
          code: 'PLAN_RULE_AMBIGUOUS_A',
          priority: 10,
          target: { productCodes: [catalog.products[55].code] },
        }),
        copyRule(benefit.rules[0], {
          code: 'PLAN_RULE_AMBIGUOUS_B',
          type: ambiguity === 'PRIORITY_TIE' ? 'FIXED_PRICE' : 'PERCENT_OFF',
          ...(ambiguity === 'PRIORITY_TIE' ? { amount: '50.00' } : { percentBasisPoints: 1000 }),
          priority: ambiguity === 'PRIORITY_TIE' ? 10 : 9,
          target: { productCodes: [catalog.products[55].code] },
        }),
        ...(ambiguity === 'STRICT_SUBSET'
          ? [
              copyRule(benefit.rules[0], {
                code: 'PLAN_RULE_AMBIGUOUS_C',
                type: 'PERCENT_OFF',
                percentBasisPoints: 500,
                priority: 8,
                target: { productCodes: [catalog.products[55].code] },
              }),
            ]
          : []),
      ]
      benefit.rules = [...compatibleRules, ...ambiguousRules].sort((left, right) => (left.code < right.code ? -1 : 1))
      const ambiguousSteps = ambiguousRules.map((rule, index) => ({ position: index + 1, ruleCode: rule.code }))
      benefit.stackingGroups =
        ambiguity === 'EXACT_STACK'
          ? [
              { code: 'AMBIGUOUS_EXACT_A', steps: clone(ambiguousSteps) },
              { code: 'AMBIGUOUS_EXACT_B', steps: clone(ambiguousSteps) },
            ]
          : ambiguity === 'STRICT_SUBSET'
            ? [{ code: 'AMBIGUOUS_SUBSET', steps: ambiguousSteps.slice(0, 2) }]
            : []

      expect(() => pair(catalog, offer)).toThrow(
        expect.objectContaining({
          code: 'COMMERCIAL_CATALOG_OFFER_INCOMPATIBLE',
          rule: 'RESOLUTION',
          counts: expect.objectContaining({
            identityCount: 56,
            matchedIdentityCount: 56,
            resolverInvocationCount: 1,
          }),
        }) as CommercialCatalogOfferCompatibilityError,
      )
    })

    it('rejects two exact stacking groups for the same matched rule set', () => {
      const offer = clone(offerFixture) as CommercialOfferSnapshotV3
      const benefit = saasBenefit(offer)
      benefit.rules.push(copyRule(benefit.rules[0], { code: 'POS_PERCENT_10', type: 'PERCENT_OFF', percentBasisPoints: 1000 }))
      benefit.rules.sort((left, right) => (left.code < right.code ? -1 : 1))
      const steps = benefit.rules.map((rule, index) => ({ position: index + 1, ruleCode: rule.code }))
      benefit.stackingGroups = [
        { code: 'POS_STACK_A', steps },
        { code: 'POS_STACK_B', steps: clone(steps) },
      ]

      expectCompatibilityError(() => pair(undefined, offer), 'RESOLUTION')
    })

    it('rejects a strict-subset stacking group when more rules match the same identity', () => {
      const offer = clone(offerFixture) as CommercialOfferSnapshotV3
      const benefit = saasBenefit(offer)
      benefit.rules = ['POS_FIXED_50', 'POS_PERCENT_10', 'POS_PERCENT_05']
        .map((code, index) =>
          copyRule(benefit.rules[0], {
            code,
            type: index === 0 ? ('FIXED_PRICE' as const) : ('PERCENT_OFF' as const),
            priority: 100 - index,
            ...(index === 0 ? { amount: '50.00' } : { percentBasisPoints: index * 500 }),
          }),
        )
        .sort((left, right) => (left.code < right.code ? -1 : 1))
      benefit.stackingGroups = [
        {
          code: 'POS_STRICT_SUBSET',
          steps: benefit.rules.slice(0, 2).map((rule, index) => ({ position: index + 1, ruleCode: rule.code })),
        },
      ]

      expectCompatibilityError(() => pair(undefined, offer), 'RESOLUTION')
    })

    it('rejects an unstacked tie at the highest priority', () => {
      const offer = clone(offerFixture) as CommercialOfferSnapshotV3
      const benefit = saasBenefit(offer)
      benefit.rules.push(copyRule(benefit.rules[0], { code: 'POS_FIXED_TIE' }))
      benefit.rules.sort((left, right) => (left.code < right.code ? -1 : 1))

      expectCompatibilityError(() => pair(undefined, offer), 'RESOLUTION')
    })

    it('rejects more than 100 rules matching one identity before calling the resolver', () => {
      const offer = clone(offerFixture) as CommercialOfferSnapshotV3
      const first = saasBenefit(offer)
      first.rules = Array.from({ length: 100 }, (_, index) =>
        copyRule(first.rules[0], {
          code: `POS_RULE_A_${String(index).padStart(3, '0')}`,
          priority: 200 - index,
        }),
      )
      offer.benefits.push({
        benefitCode: 'SAAS_POS_OVERFLOW',
        kind: 'SAAS_PRICE',
        stackingGroups: [],
        rules: [copyRule(first.rules[0], { code: 'POS_RULE_Z_101', priority: 1 })],
      })
      offer.benefits.sort((left, right) => (left.benefitCode < right.benefitCode ? -1 : 1))

      expectCompatibilityError(() => pair(undefined, offer), 'MATCHING_RULE_CAPACITY')
    })

    it('rejects a canonical line key longer than 128 characters', () => {
      const catalog = clone(catalogFixture) as CommercialCatalogSnapshotV2
      catalog.products[0].code = `P${'R'.repeat(126)}`

      expectCompatibilityError(() => pair(catalog), 'LINE_KEY_LENGTH')
    })

    it('rejects duplicate rule codes across separate SaaS benefits', () => {
      const offer = clone(offerFixture) as CommercialOfferSnapshotV3
      const first = saasBenefit(offer)
      offer.benefits.push({
        benefitCode: 'SAAS_POS_DUPLICATE',
        kind: 'SAAS_PRICE',
        stackingGroups: [],
        rules: [clone(first.rules[0])],
      })
      offer.benefits.sort((left, right) => (left.benefitCode < right.benefitCode ? -1 : 1))

      expectCompatibilityError(() => pair(undefined, offer), 'RULE_CODE_DUPLICATE')
    })

    it('rejects one line matching rules from distinct SaaS benefits', () => {
      const offer = clone(offerFixture) as CommercialOfferSnapshotV3
      const first = saasBenefit(offer)
      offer.benefits.push({
        benefitCode: 'SAAS_POS_SECOND',
        kind: 'SAAS_PRICE',
        stackingGroups: [],
        rules: [copyRule(first.rules[0], { code: 'POS_SECOND_BENEFIT', priority: 10 })],
      })
      offer.benefits.sort((left, right) => (left.benefitCode < right.benefitCode ? -1 : 1))

      expectCompatibilityError(() => pair(undefined, offer), 'CROSS_BENEFIT_MATCH')
    })

    it('rejects a catalog above the 500 concrete identity operating limit', () => {
      const catalog = clone(catalogFixture) as CommercialCatalogSnapshotV2
      catalog.products[0].prices = Array.from({ length: 501 }, (_, index) => ({
        ...catalog.products[0].prices[0],
        code: `FREE_PRICE_${String(index).padStart(3, '0')}`,
      }))
      for (const product of catalog.products.slice(1)) product.prices = []
      catalog.bundles = []

      expectCompatibilityError(() => pair(catalog), 'CATALOG_IDENTITY_CAPACITY')
    })
  })

  describe('regression', () => {
    it('matches exhaustive revision-2 resolution across deterministic randomized catalogs', () => {
      for (let seed = 1; seed <= 24; seed += 1) {
        const { catalog, offer } = deterministicScenario(seed)
        let pairAccepted = true
        try {
          pair(catalog, offer)
        } catch {
          pairAccepted = false
        }
        expect({ seed, pairAccepted }).toEqual({ seed, pairAccepted: exhaustiveRevision2Accepts(catalog, offer) })
      }
    })

    it.each([
      ['EXACT_STACK', true],
      ['AMBIGUOUS_EXACT_STACK', false],
      ['AMBIGUOUS_STRICT_SUBSET', false],
      ['AMBIGUOUS_PRIORITY_TIE', false],
      ['PRIORITY_WINNER', true],
    ] as const)('matches exhaustive revision-2 resolution for the %s semantic class', (semanticClass, expected) => {
      const catalog = clone(catalogFixture) as CommercialCatalogSnapshotV2
      const offer = clone(offerFixture) as CommercialOfferSnapshotV3
      const benefit = saasBenefit(offer)
      const baseRule = benefit.rules[0]
      const rules = [
        copyRule(baseRule, { code: 'DIFF_CLASS_A', priority: semanticClass === 'AMBIGUOUS_PRIORITY_TIE' ? 10 : 30 }),
        copyRule(baseRule, {
          code: 'DIFF_CLASS_B',
          type: 'PERCENT_OFF',
          priority: semanticClass === 'AMBIGUOUS_PRIORITY_TIE' ? 10 : 20,
          percentBasisPoints: 1000,
        }),
        ...(semanticClass === 'AMBIGUOUS_STRICT_SUBSET'
          ? [
              copyRule(baseRule, {
                code: 'DIFF_CLASS_C',
                type: 'PERCENT_OFF' as const,
                priority: 10,
                percentBasisPoints: 500,
              }),
            ]
          : []),
      ].sort((left, right) => (left.code < right.code ? -1 : 1))
      benefit.rules = rules
      const allSteps = rules.map((rule, index) => ({ position: index + 1, ruleCode: rule.code }))
      benefit.stackingGroups =
        semanticClass === 'EXACT_STACK'
          ? [{ code: 'DIFF_EXACT', steps: allSteps }]
          : semanticClass === 'AMBIGUOUS_EXACT_STACK'
            ? [
                { code: 'DIFF_EXACT_A', steps: allSteps },
                { code: 'DIFF_EXACT_B', steps: clone(allSteps) },
              ]
            : semanticClass === 'AMBIGUOUS_STRICT_SUBSET'
              ? [{ code: 'DIFF_SUBSET', steps: allSteps.slice(0, 2) }]
              : []

      let pairAccepted = true
      try {
        pair(catalog, offer)
      } catch {
        pairAccepted = false
      }

      expect(pairAccepted).toBe(exhaustiveRevision2Accepts(catalog, offer))
      expect(pairAccepted).toBe(expected)
    })

    it('keeps Contract, Engine and pair validation on one Quote v3 rule-to-line matcher', () => {
      const root = resolve(__dirname, '../../../..')
      const matcher = readFileSync(
        resolve(root, 'src/services/commercial/quotes-v3/commercialQuoteV3RuleMatcher.service.ts'),
        'utf8',
      )
      const consumers = [
        'src/services/commercial/quotes-v3/commercialQuoteV3Contract.service.ts',
        'src/services/commercial/quotes-v3/commercialQuoteV3Engine.service.ts',
        'src/services/commercial/offers/commercialCatalogOfferCompatibility.service.ts',
      ].map(path => readFileSync(resolve(root, path), 'utf8'))

      expect(matcher).toContain('export function commercialQuoteV3RuleTargetsLine(')
      expect(matcher).toContain("rule.target.productCodes?.includes(line.targetCode)")
      expect(matcher).toContain("rule.target.bundleCodes?.includes(line.targetCode)")
      expect(matcher).toContain("rule.target.productKinds?.includes(line.productKind)")
      for (const source of consumers) {
        expect(source).toMatch(/from '[^']*commercialQuoteV3RuleMatcher\.service'/)
        expect(source).not.toMatch(/function\s+ruleTargetsLine\s*\(/)
        expect(source).not.toContain('rule.target.productCodes?.includes(')
        expect(source).not.toContain('rule.target.bundleCodes?.includes(')
        expect(source).not.toContain('rule.target.productKinds?.includes(')
      }
    })
  })
})
