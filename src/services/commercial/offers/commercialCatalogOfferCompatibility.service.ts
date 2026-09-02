import type { CommercialCampaignRuleV2, CommercialCatalogSnapshotV2 } from '@/types/commercialV2'
import type { CommercialOfferSnapshotV3, CommercialSaasPriceBenefitV3 } from '@/types/commercialOfferV3'
import { ConflictError } from '@/errors/AppError'

import {
  commercialQuoteV3LineTargetKeys,
  commercialQuoteV3RuleTargetKeys,
} from '../quotes-v3/commercialQuoteV3RuleMatcher.service'
import {
  CommercialOfferResolutionError,
  resolveCommercialOfferV3WithRegistry,
} from './commercialOfferResolutionRegistry.service'

const MAX_CONCRETE_IDENTITIES = 500
const MAX_MATCHING_RULES = 100
const MAX_LINE_KEY_LENGTH = 128

type CompatibilityFailureRule =
  | 'CATALOG_IDENTITY_CAPACITY'
  | 'LINE_KEY_LENGTH'
  | 'MATCHING_RULE_CAPACITY'
  | 'RULE_CODE_DUPLICATE'
  | 'CROSS_BENEFIT_MATCH'
  | 'RESOLUTION'

export interface CommercialCatalogOfferCompatibilityCounts {
  identityCount: number
  matchedIdentityCount: number
  maxMatchingRulesPerIdentity: number
  resolverInvocationCount: number
}

const EMPTY_COMPATIBILITY_COUNTS: CommercialCatalogOfferCompatibilityCounts = Object.freeze({
  identityCount: 0,
  matchedIdentityCount: 0,
  maxMatchingRulesPerIdentity: 0,
  resolverInvocationCount: 0,
})

export class CommercialCatalogOfferCompatibilityError extends ConflictError {
  readonly code = 'COMMERCIAL_CATALOG_OFFER_INCOMPATIBLE'

  constructor(
    readonly rule: CompatibilityFailureRule,
    readonly counts: Readonly<CommercialCatalogOfferCompatibilityCounts> = EMPTY_COMPATIBILITY_COUNTS,
  ) {
    super(
      'El catálogo y la oferta comercial no son compatibles.',
      'COMMERCIAL_CATALOG_OFFER_INCOMPATIBLE',
      { retryable: false },
    )
    this.name = 'CommercialCatalogOfferCompatibilityError'
  }
}

export interface CommercialCatalogOfferCompatibilityInputV3 {
  catalog: CommercialCatalogSnapshotV2
  offer: CommercialOfferSnapshotV3
  resolvedAt: string
}

export interface CommercialCatalogOfferCompatibilityResultV3 {
  catalogPublicationId: string
  offerVersionId: string
  identityCount: number
  matchedIdentityCount: number
  resolverInvocationCount: number
}

interface ConcreteCatalogIdentity {
  lineKey: string
  targetType: 'PRODUCT' | 'BUNDLE'
  targetCode: string
  productKind: CommercialCatalogSnapshotV2['products'][number]['kind'] | 'BUNDLE'
}

interface IndexedSaasRule {
  benefit: CommercialSaasPriceBenefitV3
  rule: CommercialCampaignRuleV2
}

interface SaasRuleIndex {
  targets: Map<string, IndexedSaasRule[]>
}

function incompatible(rule: CompatibilityFailureRule, counts?: CommercialCatalogOfferCompatibilityCounts): never {
  throw new CommercialCatalogOfferCompatibilityError(rule, Object.freeze(counts ?? { ...EMPTY_COMPATIBILITY_COUNTS }))
}

function concreteIdentities(catalog: CommercialCatalogSnapshotV2): ConcreteCatalogIdentity[] {
  const identities: ConcreteCatalogIdentity[] = []
  for (const product of catalog.products) {
    for (const price of product.prices) {
      identities.push({
        lineKey: `PRODUCT:${product.code}:${price.code}`,
        targetType: 'PRODUCT',
        targetCode: product.code,
        productKind: product.kind,
      })
    }
  }
  for (const bundle of catalog.bundles) {
    for (const price of bundle.prices) {
      identities.push({
        lineKey: `BUNDLE:${bundle.code}:${price.code}`,
        targetType: 'BUNDLE',
        targetCode: bundle.code,
        productKind: 'BUNDLE',
      })
    }
  }
  if (identities.length > MAX_CONCRETE_IDENTITIES) {
    incompatible('CATALOG_IDENTITY_CAPACITY', {
      identityCount: identities.length,
      matchedIdentityCount: 0,
      maxMatchingRulesPerIdentity: 0,
      resolverInvocationCount: 0,
    })
  }
  return identities
}

function saasBenefits(offer: CommercialOfferSnapshotV3): CommercialSaasPriceBenefitV3[] {
  return offer.benefits.filter((benefit): benefit is CommercialSaasPriceBenefitV3 => benefit.kind === 'SAAS_PRICE')
}

function assertUniqueRuleCodes(benefits: readonly CommercialSaasPriceBenefitV3[], identityCount: number): void {
  const codes = new Set<string>()
  for (const benefit of benefits) {
    for (const rule of benefit.rules) {
      if (codes.has(rule.code)) {
        incompatible('RULE_CODE_DUPLICATE', {
          identityCount,
          matchedIdentityCount: 0,
          maxMatchingRulesPerIdentity: 0,
          resolverInvocationCount: 0,
        })
      }
      codes.add(rule.code)
    }
  }
}

function appendRule(index: Map<string, IndexedSaasRule[]>, key: string, value: IndexedSaasRule): void {
  const existing = index.get(key)
  if (existing) existing.push(value)
  else index.set(key, [value])
}

function buildSaasRuleIndex(benefits: readonly CommercialSaasPriceBenefitV3[]): SaasRuleIndex {
  const index: SaasRuleIndex = { targets: new Map() }
  for (const benefit of benefits) {
    for (const rule of benefit.rules) {
      const value = { benefit, rule }
      for (const targetKey of commercialQuoteV3RuleTargetKeys(rule)) appendRule(index.targets, targetKey, value)
    }
  }
  return index
}

function matchingRules(identity: ConcreteCatalogIdentity, index: SaasRuleIndex): IndexedSaasRule[] {
  const candidates = commercialQuoteV3LineTargetKeys(identity).flatMap(targetKey => index.targets.get(targetKey) ?? [])
  const unique = new Map<string, IndexedSaasRule>()
  for (const candidate of candidates) {
    if (unique.has(candidate.rule.code)) continue
    unique.set(candidate.rule.code, candidate)
  }
  return [...unique.values()]
}

function sameRuleCodes(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const expected = new Set(left)
  return expected.size === left.length && right.every(code => expected.has(code))
}

// This classifier is permanently pinned to resolution revision 2. Its only purpose is proof reuse:
// every observed outcome class still goes through the frozen resolver below. A differential test
// compares it with exhaustive per-identity resolution, and the architecture test prevents a third
// production copy of these branches.
function resolutionRevision2ProofClass(
  benefits: readonly CommercialSaasPriceBenefitV3[],
  benefit: CommercialSaasPriceBenefitV3,
  matches: readonly IndexedSaasRule[],
  ruleCodes: readonly string[],
): string {
  const exactGroups = benefit.stackingGroups.filter(group =>
    sameRuleCodes(
      group.steps.map(step => step.ruleCode),
      ruleCodes,
    ),
  )
  if (exactGroups.length > 1) return 'AMBIGUOUS_EXACT_STACK'
  if (exactGroups.length === 1) return 'EXACT_STACK'
  const matched = new Set(ruleCodes)
  if (
    benefits.some(candidateBenefit =>
      candidateBenefit.stackingGroups.some(
        group => group.steps.length < ruleCodes.length && group.steps.every(step => matched.has(step.ruleCode)),
      ),
    )
  ) {
    return 'AMBIGUOUS_STRICT_SUBSET'
  }
  const priorities = matches.map(match => match.rule.priority).sort((left, right) => right - left)
  return priorities.length > 1 && priorities[0] === priorities[1] ? 'AMBIGUOUS_PRIORITY_TIE' : 'PRIORITY_WINNER'
}

export function validateCommercialCatalogOfferCompatibilityV3(
  input: CommercialCatalogOfferCompatibilityInputV3,
): Readonly<CommercialCatalogOfferCompatibilityResultV3> {
  const identities = concreteIdentities(input.catalog)
  const benefits = saasBenefits(input.offer)
  assertUniqueRuleCodes(benefits, identities.length)
  const ruleIndex = buildSaasRuleIndex(benefits)
  let matchedIdentityCount = 0
  let maxMatchingRulesPerIdentity = 0
  let resolverInvocationCount = 0
  const resolutionProofs = new Map<string, { lineKey: string; ruleCodes: string[] }>()

  for (const identity of identities) {
    if (identity.lineKey.length > MAX_LINE_KEY_LENGTH) {
      incompatible('LINE_KEY_LENGTH', {
        identityCount: identities.length,
        matchedIdentityCount,
        maxMatchingRulesPerIdentity,
        resolverInvocationCount,
      })
    }
    const matches = matchingRules(identity, ruleIndex)
    maxMatchingRulesPerIdentity = Math.max(maxMatchingRulesPerIdentity, matches.length)
    if (matches.length > MAX_MATCHING_RULES) {
      incompatible('MATCHING_RULE_CAPACITY', {
        identityCount: identities.length,
        matchedIdentityCount,
        maxMatchingRulesPerIdentity,
        resolverInvocationCount,
      })
    }
    const ruleCodes = matches.map(match => match.rule.code)
    let matchedBenefitCode: string | null = null
    let matchedBenefit: CommercialSaasPriceBenefitV3 | null = null
    for (const match of matches) {
      if (matchedBenefitCode !== null && matchedBenefitCode !== match.benefit.benefitCode) {
        incompatible('CROSS_BENEFIT_MATCH', {
          identityCount: identities.length,
          matchedIdentityCount,
          maxMatchingRulesPerIdentity,
          resolverInvocationCount,
        })
      }
      matchedBenefitCode = match.benefit.benefitCode
      matchedBenefit = match.benefit
    }
    if (ruleCodes.length > 0) {
      matchedIdentityCount += 1
      ruleCodes.sort()
      const proofKey = resolutionRevision2ProofClass(benefits, matchedBenefit!, matches, ruleCodes)
      if (!resolutionProofs.has(proofKey)) resolutionProofs.set(proofKey, { lineKey: identity.lineKey, ruleCodes })
    }
  }

  const proofs = [...resolutionProofs.values()]
  const batches = proofs.length === 0 ? [[]] : [proofs]
  for (const batch of batches) {
    resolverInvocationCount += 1
    try {
      resolveCommercialOfferV3WithRegistry({
        resolutionVersion: 2,
        offer: input.offer,
        resolvedAt: input.resolvedAt,
        saasMatches: batch,
        hardwareSelections: [],
        rateBlockers: [],
      })
    } catch (error) {
      if (error instanceof CommercialCatalogOfferCompatibilityError) throw error
      if (error instanceof CommercialOfferResolutionError) {
        incompatible('RESOLUTION', {
          identityCount: identities.length,
          matchedIdentityCount,
          maxMatchingRulesPerIdentity,
          resolverInvocationCount,
        })
      }
      throw error
    }
  }

  return Object.freeze({
    catalogPublicationId: input.catalog.publicationId,
    offerVersionId: input.offer.campaignVersionId,
    identityCount: identities.length,
    matchedIdentityCount,
    resolverInvocationCount,
  })
}
