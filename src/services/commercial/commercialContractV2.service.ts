import { getCommercialCapabilityDefinition } from './commercialCapabilityRegistry'
import { loadCommercialContractControlledJsonV2, materializeCommercialContractV2Json } from './commercialContractV2Materialization.service'
import { reconcileCommercialQuoteAuthoritiesV2, validateCommercialQuoteIntrinsicV2 } from './commercialQuoteContractV2.service'
import {
  assertCommercialAsciiCodesV2,
  assertCommercialCapabilityV2,
  assertCommercialContractSchemaV2,
  assertCommercialContractVersionsV2,
  assertCommercialOrderedV2,
  assertCommercialUniqueByV2,
  assertCommercialUniqueV2,
  compareCommercialAsciiV2,
  failCommercialContractV2,
  parseCommercialContractMoneyV2,
  validateCommercialArtifactV2,
  validateCommercialOriginsV2,
  withCommercialContractV2Boundary,
} from './commercialContractV2Validation.shared'
import type {
  CommercialCampaignRuleTypeV2,
  CommercialCampaignSnapshotV2,
  CommercialCatalogSnapshotV2,
  CommercialEntitlementProjectionV2,
  CommercialLifecycleVocabularyV2,
  CommercialQuoteSnapshotV2,
} from '@/types/commercialV2'
import type { CommercialQuoteValidationAuthoritiesV2 } from './commercialQuoteContractV2.service'

export { CommercialContractV2ValidationError } from './commercialContractV2Validation.shared'
export type { CommercialQuoteValidationAuthoritiesV2 } from './commercialQuoteContractV2.service'

function validatePrices(prices: CommercialCatalogSnapshotV2['products'][number]['prices']): void {
  assertCommercialUniqueByV2('CATALOG', prices, price => price.code, 'PRICE_CODE_UNIQUE')
  assertCommercialUniqueByV2('CATALOG', prices, price => price.billingUnit, 'PRICE_BILLING_UNIT_UNIQUE')
  const billingRank = { VENUE_MONTH: 0, VENUE_YEAR: 1 } as const
  assertCommercialOrderedV2(
    'CATALOG',
    prices,
    (left, right) => billingRank[left.billingUnit] - billingRank[right.billingUnit] || compareCommercialAsciiV2(left.code, right.code),
    'PRICE_ORDER',
  )
  for (const price of prices) parseCommercialContractMoneyV2('CATALOG', price.amount, 'UNIT_AMOUNT')
}

function validateCatalogSemantics(value: CommercialCatalogSnapshotV2): void {
  assertCommercialUniqueByV2('CATALOG', value.products, product => product.code, 'PRODUCT_CODE_UNIQUE')
  assertCommercialUniqueByV2('CATALOG', value.products, product => product.slug, 'PRODUCT_SLUG_UNIQUE')
  assertCommercialOrderedV2(
    'CATALOG',
    value.products,
    (left, right) => left.sortOrder - right.sortOrder || compareCommercialAsciiV2(left.code, right.code),
    'PRODUCT_ORDER',
  )
  for (const product of value.products) {
    validatePrices(product.prices)
    if (product.prices.length > 0 && product.capabilityBindings.length === 0) {
      failCommercialContractV2('CATALOG', 'PRICED_PRODUCT_WITHOUT_CAPABILITY')
    }
    assertCommercialAsciiCodesV2(
      'CATALOG',
      product.capabilityBindings,
      binding => binding.capabilityCode,
      'CAPABILITY_BINDING_UNIQUE',
      'CAPABILITY_BINDING_ORDER',
    )
    product.capabilityBindings.forEach(binding => assertCommercialCapabilityV2('CATALOG', binding))
  }

  assertCommercialUniqueByV2('CATALOG', value.bundles, bundle => bundle.code, 'BUNDLE_CODE_UNIQUE')
  assertCommercialUniqueByV2('CATALOG', value.bundles, bundle => bundle.slug, 'BUNDLE_SLUG_UNIQUE')
  assertCommercialOrderedV2(
    'CATALOG',
    value.bundles,
    (left, right) => left.sortOrder - right.sortOrder || compareCommercialAsciiV2(left.code, right.code),
    'BUNDLE_ORDER',
  )
  const products = new Map(value.products.map(product => [product.code, product]))
  for (const bundle of value.bundles) {
    validatePrices(bundle.prices)
    assertCommercialUniqueByV2('CATALOG', bundle.items, item => item.productCode, 'BUNDLE_ITEM_UNIQUE')
    assertCommercialOrderedV2(
      'CATALOG',
      bundle.items,
      (left, right) => left.sortOrder - right.sortOrder || compareCommercialAsciiV2(left.productCode, right.productCode),
      'BUNDLE_ITEM_ORDER',
    )
    let resolvedCapabilities = 0
    for (const item of bundle.items) {
      const product = products.get(item.productCode)
      if (!product) failCommercialContractV2('CATALOG', 'BUNDLE_ITEM_REFERENCE')
      resolvedCapabilities += product.capabilityBindings.length
    }
    if (bundle.prices.length > 0 && resolvedCapabilities === 0) {
      failCommercialContractV2('CATALOG', 'PRICED_BUNDLE_WITHOUT_CAPABILITY')
    }
  }
}

export function validateCommercialCatalogV2(value: unknown): CommercialCatalogSnapshotV2 {
  return validateCommercialArtifactV2('CATALOG', value, validateCatalogSemantics)
}

const PRODUCT_KIND_RANK = { PLAN: 0, POS: 1, MODULE: 2 } as const
const STACK_TYPE_RANK: Record<CommercialCampaignRuleTypeV2, number> = {
  FIXED_PRICE: 0,
  BUNDLE_PRICE: 0,
  PERCENT_OFF: 1,
  AMOUNT_OFF: 2,
  FREE_PERIOD: 3,
}

function validateCampaignSemantics(value: CommercialCampaignSnapshotV2): void {
  if (value.startsAt >= value.endsAt) failCommercialContractV2('CAMPAIGN', 'CAMPAIGN_WINDOW')
  assertCommercialAsciiCodesV2('CAMPAIGN', value.rules, rule => rule.code, 'CAMPAIGN_RULE_UNIQUE', 'CAMPAIGN_RULE_ORDER')
  const rules = new Map(value.rules.map(rule => [rule.code, rule]))
  for (const rule of value.rules) {
    if ('amount' in rule) parseCommercialContractMoneyV2('CAMPAIGN', rule.amount, 'UNIT_AMOUNT')
    for (const key of ['productCodes', 'bundleCodes'] as const) {
      const codes = rule.target[key]
      if (!codes) continue
      assertCommercialAsciiCodesV2('CAMPAIGN', codes, code => code, 'CAMPAIGN_TARGET_UNIQUE', 'CAMPAIGN_TARGET_ORDER')
    }
    if (rule.target.productKinds) {
      assertCommercialUniqueV2('CAMPAIGN', rule.target.productKinds, 'CAMPAIGN_TARGET_UNIQUE')
      assertCommercialOrderedV2(
        'CAMPAIGN',
        rule.target.productKinds,
        (left, right) => PRODUCT_KIND_RANK[left] - PRODUCT_KIND_RANK[right],
        'CAMPAIGN_TARGET_ORDER',
      )
    }
  }

  assertCommercialAsciiCodesV2('CAMPAIGN', value.stackingGroups, group => group.code, 'STACKING_GROUP_UNIQUE', 'STACKING_GROUP_ORDER')
  for (const group of value.stackingGroups) {
    assertCommercialUniqueByV2('CAMPAIGN', group.steps, step => step.ruleCode, 'STACKING_RULE_UNIQUE')
    const groupRules = group.steps.map((step, index) => {
      if (step.position !== index + 1) failCommercialContractV2('CAMPAIGN', 'STACKING_POSITION')
      const rule = rules.get(step.ruleCode)
      if (!rule) failCommercialContractV2('CAMPAIGN', 'STACKING_RULE_REFERENCE')
      if (rule.type === 'FREE_PERIOD') failCommercialContractV2('CAMPAIGN', 'STACKING_FREE_PERIOD')
      return rule
    })
    const baseCount = groupRules.filter(rule => rule.type === 'FIXED_PRICE' || rule.type === 'BUNDLE_PRICE').length
    if (baseCount > 1) failCommercialContractV2('CAMPAIGN', 'STACKING_BASE_CONFLICT')
    assertCommercialOrderedV2(
      'CAMPAIGN',
      groupRules,
      (left, right) => STACK_TYPE_RANK[left.type] - STACK_TYPE_RANK[right.type],
      'STACKING_TYPE_ORDER',
    )
  }
}

export function validateCommercialCampaignV2(value: unknown): CommercialCampaignSnapshotV2 {
  return validateCommercialArtifactV2('CAMPAIGN', value, validateCampaignSemantics)
}

export function validateCommercialQuoteV2(value: unknown, authorities: CommercialQuoteValidationAuthoritiesV2): CommercialQuoteSnapshotV2 {
  const quote = validateCommercialQuoteIntrinsicV2(value)
  const catalog = validateCommercialCatalogV2(authorities.catalog)
  const campaign = authorities.campaign === null ? null : validateCommercialCampaignV2(authorities.campaign)
  return reconcileCommercialQuoteAuthoritiesV2(quote, { catalog, campaign })
}

export { validateCommercialQuoteIntrinsicV2 }

function validateEntitlementSemantics(value: CommercialEntitlementProjectionV2): void {
  assertCommercialAsciiCodesV2(
    'ENTITLEMENTS',
    value.capabilities,
    capability => capability.capabilityCode,
    'CAPABILITY_UNIQUE',
    'CAPABILITY_ORDER',
  )
  for (const capability of value.capabilities) {
    const definition = getCommercialCapabilityDefinition(capability.capabilityCode)
    if (!definition) failCommercialContractV2('ENTITLEMENTS', 'CAPABILITY_UNKNOWN')
    if (definition.capabilityKind !== capability.capabilityKind) {
      failCommercialContractV2('ENTITLEMENTS', 'CAPABILITY_KIND_MISMATCH')
    }
    const expectedActivation = definition.activationRequirement.mode === 'NOT_REQUIRED' ? 'NOT_REQUIRED' : undefined
    if (
      (expectedActivation && capability.activation.state !== expectedActivation) ||
      (!expectedActivation && !['ON', 'OFF'].includes(capability.activation.state))
    ) {
      failCommercialContractV2('ENTITLEMENTS', 'ENTITLEMENT_ACTIVATION_MISMATCH')
    }
    validateCommercialOriginsV2('ENTITLEMENTS', capability.entitlement.origins)
  }
}

export function validateCommercialEntitlementsV2(value: unknown): CommercialEntitlementProjectionV2 {
  return validateCommercialArtifactV2('ENTITLEMENTS', value, validateEntitlementSemantics)
}

const LIFECYCLE_KEYS = ['quoteStates', 'acceptanceStates', 'redemptionStates', 'checkoutAttemptStates', 'entitlementStates'] as const
const lifecycleVocabulary = loadCommercialContractControlledJsonV2<CommercialLifecycleVocabularyV2>(
  require.resolve('../../contracts/commercial/fixtures/v2/lifecycle-vocabulary.json'),
)

function validateLifecycleSemantics(value: CommercialLifecycleVocabularyV2): void {
  if (!LIFECYCLE_KEYS.every(key => Array.isArray(value[key]))) return
  for (const key of LIFECYCLE_KEYS) {
    const states = value[key]
    if (states.length !== lifecycleVocabulary[key].length || states.some((entry, index) => entry !== lifecycleVocabulary[key][index])) {
      failCommercialContractV2('LIFECYCLE', 'LIFECYCLE_VOCABULARY')
    }
  }
}

export function validateCommercialLifecycleV2(value: unknown): CommercialLifecycleVocabularyV2 {
  return withCommercialContractV2Boundary('LIFECYCLE', () => {
    const lifecycle = materializeCommercialContractV2Json<CommercialLifecycleVocabularyV2>(value)
    assertCommercialContractVersionsV2('LIFECYCLE', lifecycle)
    validateLifecycleSemantics(lifecycle)
    assertCommercialContractSchemaV2('LIFECYCLE', lifecycle)
    return lifecycle
  })
}
