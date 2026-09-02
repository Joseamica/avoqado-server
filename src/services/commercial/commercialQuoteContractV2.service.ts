import { types as utilTypes } from 'node:util'
import { materializeCommercialContractV2Json } from './commercialContractV2Materialization.service'
import { canonicalJsonV2 } from './commercialCanonicalJsonV2.service'
import { roundCommercialBasisPointsV2 } from './commercialMoneyV2.service'
import {
  assertCommercialAsciiCodesV2,
  assertCommercialCapabilityV2,
  assertCommercialContractSchemaV2,
  assertCommercialContractVersionsV2,
  assertCommercialOrderedV2,
  assertCommercialUniqueByV2,
  commercialActivationMatchesV2,
  compareCommercialOriginsV2,
  failCommercialContractV2,
  parseCommercialContractMoneyV2,
  validateCommercialOriginsV2,
  withCommercialContractV2Boundary,
} from './commercialContractV2Validation.shared'
import type {
  CommercialCampaignRuleTypeV2,
  CommercialCampaignSnapshotV2,
  CommercialCapabilityBindingV2,
  CommercialCatalogSnapshotV2,
  CommercialEntitlementOriginV2,
  CommercialQuoteLineV2,
  CommercialQuoteSnapshotV2,
} from '@/types/commercialV2'

export interface CommercialQuoteValidationAuthoritiesV2 {
  catalog: CommercialCatalogSnapshotV2
  campaign: CommercialCampaignSnapshotV2 | null
}

const STACK_TYPE_RANK: Record<CommercialCampaignRuleTypeV2, number> = {
  FIXED_PRICE: 0,
  BUNDLE_PRICE: 0,
  PERCENT_OFF: 1,
  AMOUNT_OFF: 2,
  FREE_PERIOD: 3,
}

const intrinsicQuoteSnapshots = new WeakSet<object>()

function assertMaterializedAuthorityGraph(value: unknown, seen: WeakSet<object>): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return
  if (typeof value !== 'object' || utilTypes.isProxy(value) || !Object.isFrozen(value) || seen.has(value)) {
    failCommercialContractV2('QUOTE', 'BOUNDARY')
  }
  seen.add(value)
  const array = Array.isArray(value)
  const prototype = Object.getPrototypeOf(value)
  if ((array && prototype !== Array.prototype) || (!array && prototype !== Object.prototype && prototype !== null)) {
    failCommercialContractV2('QUOTE', 'BOUNDARY')
  }
  const keys = Reflect.ownKeys(value)
  if (keys.some(key => typeof key === 'symbol')) failCommercialContractV2('QUOTE', 'BOUNDARY')
  if (array) {
    for (const key of keys) {
      if (key === 'length') continue
      const index = Number(key)
      if (!Number.isInteger(index) || index < 0 || String(index) !== key || index >= value.length) {
        failCommercialContractV2('QUOTE', 'BOUNDARY')
      }
    }
  }
  for (const key of keys) {
    if (key === 'length') continue
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) failCommercialContractV2('QUOTE', 'BOUNDARY')
    assertMaterializedAuthorityGraph(descriptor.value, seen)
  }
}

function captureMaterializedAuthorities(authorities: CommercialQuoteValidationAuthoritiesV2): CommercialQuoteValidationAuthoritiesV2 {
  if (typeof authorities !== 'object' || authorities === null || utilTypes.isProxy(authorities) || Array.isArray(authorities)) {
    return failCommercialContractV2('QUOTE', 'BOUNDARY')
  }
  const prototype = Object.getPrototypeOf(authorities)
  if (prototype !== Object.prototype && prototype !== null) return failCommercialContractV2('QUOTE', 'BOUNDARY')
  const keys = Reflect.ownKeys(authorities)
  if (keys.length !== 2 || !keys.includes('catalog') || !keys.includes('campaign')) {
    return failCommercialContractV2('QUOTE', 'BOUNDARY')
  }
  const catalog = Object.getOwnPropertyDescriptor(authorities, 'catalog')
  const campaign = Object.getOwnPropertyDescriptor(authorities, 'campaign')
  if (
    !catalog?.enumerable ||
    !('value' in catalog) ||
    !campaign?.enumerable ||
    !('value' in campaign) ||
    (campaign.value !== null && typeof campaign.value !== 'object')
  ) {
    return failCommercialContractV2('QUOTE', 'BOUNDARY')
  }
  const seen = new WeakSet<object>()
  assertMaterializedAuthorityGraph(catalog.value, seen)
  if (campaign.value !== null) assertMaterializedAuthorityGraph(campaign.value, seen)
  return { catalog: catalog.value as CommercialCatalogSnapshotV2, campaign: campaign.value as CommercialCampaignSnapshotV2 | null }
}

function assertQuoteLineage(value: CommercialQuoteSnapshotV2): void {
  const subject = value.subject
  const validPreview =
    subject.kind === 'ACQUISITION_CONTEXT' &&
    typeof value.acquisitionContextId === 'string' &&
    subject.acquisitionContextId === value.acquisitionContextId &&
    value.derivedFromPreview === null
  const validDirect = subject.kind === 'VENUE' && value.acquisitionContextId === null && value.derivedFromPreview === null
  const validDerived =
    subject.kind === 'VENUE' &&
    typeof value.acquisitionContextId === 'string' &&
    typeof value.derivedFromPreview === 'object' &&
    value.derivedFromPreview !== null
  if (!validPreview && !validDirect && !validDerived) failCommercialContractV2('QUOTE', 'QUOTE_LINEAGE')
}

function validateQuoteLine(value: CommercialQuoteLineV2): void {
  if (value.lineKey !== `${value.targetType}:${value.targetCode}:${value.priceCode}`) {
    failCommercialContractV2('QUOTE', 'QUOTE_LINE_KEY')
  }
  const unit = parseCommercialContractMoneyV2('QUOTE', value.unitAmount, 'UNIT_AMOUNT')
  const list = parseCommercialContractMoneyV2('QUOTE', value.listSubtotal, 'LINE_LIST_SUBTOTAL')
  const discount = parseCommercialContractMoneyV2('QUOTE', value.discount)
  const subtotal = parseCommercialContractMoneyV2('QUOTE', value.subtotal)
  const tax = parseCommercialContractMoneyV2('QUOTE', value.tax)
  const total = parseCommercialContractMoneyV2('QUOTE', value.total)
  const renewalSubtotal = parseCommercialContractMoneyV2('QUOTE', value.renewalSubtotal, 'RENEWAL_SUBTOTAL')
  const renewalTax = parseCommercialContractMoneyV2('QUOTE', value.renewalTax, 'RENEWAL_TAX')
  const renewalTotal = parseCommercialContractMoneyV2('QUOTE', value.renewalTotal, 'RENEWAL_TOTAL')
  if (unit * BigInt(value.quantity) !== list || list - discount !== subtotal) {
    failCommercialContractV2('QUOTE', 'QUOTE_LINE_ARITHMETIC')
  }

  assertCommercialUniqueByV2('QUOTE', value.appliedCampaigns, step => step.ruleCode, 'QUOTE_CAMPAIGN_RULE_UNIQUE')
  assertCommercialOrderedV2(
    'QUOTE',
    value.appliedCampaigns,
    (left, right) => STACK_TYPE_RANK[left.type] - STACK_TYPE_RANK[right.type],
    'QUOTE_CAMPAIGN_TYPE_ORDER',
  )
  const baseCount = value.appliedCampaigns.filter(step => step.type === 'FIXED_PRICE' || step.type === 'BUNDLE_PRICE').length
  if (baseCount > 1) failCommercialContractV2('QUOTE', 'QUOTE_CAMPAIGN_BASE_CONFLICT')
  if (value.appliedCampaigns.length > 1 && value.appliedCampaigns.some(step => step.type === 'FREE_PERIOD')) {
    failCommercialContractV2('QUOTE', 'QUOTE_CAMPAIGN_FREE_PERIOD')
  }

  let running = list
  for (const [index, step] of value.appliedCampaigns.entries()) {
    if (step.position !== index + 1) failCommercialContractV2('QUOTE', 'QUOTE_CAMPAIGN_POSITION')
    const input = parseCommercialContractMoneyV2('QUOTE', step.inputAmount)
    const stepDiscount = parseCommercialContractMoneyV2('QUOTE', step.discountAmount)
    const output = parseCommercialContractMoneyV2('QUOTE', step.outputAmount)
    if (input !== running || input - stepDiscount !== output) failCommercialContractV2('QUOTE', 'QUOTE_CAMPAIGN_CHAIN')
    running = output
  }
  if (value.appliedCampaigns.length > 0 && running !== subtotal) failCommercialContractV2('QUOTE', 'QUOTE_CAMPAIGN_CHAIN')
  const expectedCycles = value.appliedCampaigns[0]?.cycles ?? null
  if (value.appliedCampaigns.some(step => step.cycles !== expectedCycles) || value.promotionalCycles !== expectedCycles) {
    failCommercialContractV2('QUOTE', 'QUOTE_CAMPAIGN_CYCLES')
  }
  if (roundCommercialBasisPointsV2(subtotal, value.taxRateBasisPoints) !== tax || subtotal + tax !== total) {
    failCommercialContractV2('QUOTE', 'QUOTE_LINE_TAX')
  }
  if (
    renewalSubtotal !== list ||
    roundCommercialBasisPointsV2(renewalSubtotal, value.taxRateBasisPoints) !== renewalTax ||
    renewalSubtotal + renewalTax !== renewalTotal
  ) {
    failCommercialContractV2('QUOTE', 'QUOTE_RENEWAL_ARITHMETIC')
  }
}

function validateQuoteSemantics(value: CommercialQuoteSnapshotV2): void {
  if ((value.campaignVersionId === null) !== (value.campaignCode === null)) {
    failCommercialContractV2('QUOTE', 'QUOTE_CAMPAIGN_PAIR')
  }
  if (value.expiresAt <= value.quotedAt) failCommercialContractV2('QUOTE', 'QUOTE_TIMESTAMP_ORDER')
  assertCommercialAsciiCodesV2('QUOTE', value.lines, line => line.lineKey, 'QUOTE_LINE_UNIQUE', 'QUOTE_LINE_ORDER')
  for (const line of value.lines) {
    for (const step of line.appliedCampaigns) {
      if (step.campaignVersionId !== value.campaignVersionId || step.campaignCode !== value.campaignCode) {
        failCommercialContractV2('QUOTE', 'QUOTE_CAMPAIGN_STEP_ROOT')
      }
    }
    if (value.campaignVersionId === null && line.appliedCampaigns.length > 0) {
      failCommercialContractV2('QUOTE', 'QUOTE_CAMPAIGN_STEP_ROOT')
    }
    validateQuoteLine(line)
  }

  assertCommercialAsciiCodesV2('QUOTE', value.entitlementGrants, grant => grant.capabilityCode, 'CAPABILITY_UNIQUE', 'CAPABILITY_ORDER')
  for (const grant of value.entitlementGrants) {
    assertCommercialCapabilityV2('QUOTE', grant)
    validateCommercialOriginsV2('QUOTE', grant.origins)
    for (const origin of grant.origins) {
      if (origin.kind === 'CAMPAIGN' && (origin.sourceId !== value.campaignVersionId || origin.sourceCode !== value.campaignCode)) {
        failCommercialContractV2('QUOTE', 'ORIGIN_CAMPAIGN_MISMATCH')
      }
    }
  }

  const sum = (field: keyof CommercialQuoteLineV2) =>
    value.lines.reduce((total, line) => total + parseCommercialContractMoneyV2('QUOTE', line[field] as string), 0n)
  const totals = {
    listSubtotal: parseCommercialContractMoneyV2('QUOTE', value.totals.listSubtotal, 'QUOTE_LIST_SUBTOTAL'),
    discount: parseCommercialContractMoneyV2('QUOTE', value.totals.discount, 'QUOTE_DISCOUNT'),
    subtotal: parseCommercialContractMoneyV2('QUOTE', value.totals.subtotal, 'QUOTE_LIST_SUBTOTAL'),
    tax: parseCommercialContractMoneyV2('QUOTE', value.totals.tax, 'QUOTE_TAX'),
    total: parseCommercialContractMoneyV2('QUOTE', value.totals.total, 'QUOTE_TOTAL'),
  }
  if (
    totals.listSubtotal !== sum('listSubtotal') ||
    totals.discount !== sum('discount') ||
    totals.subtotal !== sum('subtotal') ||
    totals.tax !== sum('tax') ||
    totals.total !== sum('total') ||
    totals.listSubtotal - totals.discount !== totals.subtotal ||
    totals.subtotal + totals.tax !== totals.total
  ) {
    failCommercialContractV2('QUOTE', 'QUOTE_TOTALS')
  }
  const renewalSubtotal = parseCommercialContractMoneyV2('QUOTE', value.renewal.subtotal, 'RENEWAL_SUBTOTAL')
  const renewalTax = parseCommercialContractMoneyV2('QUOTE', value.renewal.tax, 'RENEWAL_TAX')
  const renewalTotal = parseCommercialContractMoneyV2('QUOTE', value.renewal.total, 'RENEWAL_TOTAL')
  if (
    renewalSubtotal !== sum('renewalSubtotal') ||
    renewalTax !== sum('renewalTax') ||
    renewalTotal !== sum('renewalTotal') ||
    renewalSubtotal + renewalTax !== renewalTotal
  ) {
    failCommercialContractV2('QUOTE', 'QUOTE_RENEWAL_TOTALS')
  }
}

function ruleTargetsLine(rule: CommercialCampaignSnapshotV2['rules'][number], line: CommercialQuoteLineV2): boolean {
  return Boolean(
    (line.targetType === 'PRODUCT' && rule.target.productCodes?.includes(line.targetCode)) ||
      (line.targetType === 'BUNDLE' && rule.target.bundleCodes?.includes(line.targetCode)) ||
      (line.productKind !== 'BUNDLE' && rule.target.productKinds?.includes(line.productKind)),
  )
}

function expectedStepOutput(rule: CommercialCampaignSnapshotV2['rules'][number], input: bigint, quantity: number): bigint {
  if (rule.type === 'PERCENT_OFF') return input - roundCommercialBasisPointsV2(input, rule.percentBasisPoints)
  if (rule.type === 'FREE_PERIOD') return 0n
  const published = parseCommercialContractMoneyV2('QUOTE', rule.amount, 'UNIT_AMOUNT') * BigInt(quantity)
  if (rule.type === 'AMOUNT_OFF') return input - (published < input ? published : input)
  if (published > input) failCommercialContractV2('QUOTE', 'QUOTE_CAMPAIGN_CALCULATION')
  return published
}

function assertExactCampaignCalculation(line: CommercialQuoteLineV2, campaign: CommercialCampaignSnapshotV2 | null): void {
  const list = parseCommercialContractMoneyV2('QUOTE', line.listSubtotal)
  const declaredDiscount = parseCommercialContractMoneyV2('QUOTE', line.discount)
  const declaredSubtotal = parseCommercialContractMoneyV2('QUOTE', line.subtotal)
  if (line.appliedCampaigns.length === 0) {
    if (declaredDiscount !== 0n || declaredSubtotal !== list || line.promotionalCycles !== null) {
      failCommercialContractV2('QUOTE', 'QUOTE_CAMPAIGN_CALCULATION')
    }
    return
  }

  let running = list
  for (const step of line.appliedCampaigns) {
    const rule = campaign?.rules.find(candidate => candidate.code === step.ruleCode)
    if (!rule || rule.type !== step.type || rule.cycles !== step.cycles || !ruleTargetsLine(rule, line)) {
      failCommercialContractV2('QUOTE', 'QUOTE_CAMPAIGN_RULE_MISMATCH')
    }
    const expectedOutput = expectedStepOutput(rule, running, line.quantity)
    const expectedDiscount = running - expectedOutput
    if (
      parseCommercialContractMoneyV2('QUOTE', step.inputAmount) !== running ||
      parseCommercialContractMoneyV2('QUOTE', step.discountAmount) !== expectedDiscount ||
      parseCommercialContractMoneyV2('QUOTE', step.outputAmount) !== expectedOutput
    ) {
      failCommercialContractV2('QUOTE', 'QUOTE_CAMPAIGN_CALCULATION')
    }
    running = expectedOutput
  }
  if (declaredDiscount !== list - running || declaredSubtotal !== running) {
    failCommercialContractV2('QUOTE', 'QUOTE_CAMPAIGN_CALCULATION')
  }
  if (line.appliedCampaigns.length >= 2) {
    const ruleCodes = line.appliedCampaigns.map(step => step.ruleCode)
    const exactGroup = campaign?.stackingGroups.some(
      group => group.steps.length === ruleCodes.length && group.steps.every((step, index) => step.ruleCode === ruleCodes[index]),
    )
    if (!exactGroup) failCommercialContractV2('QUOTE', 'QUOTE_CAMPAIGN_STACK')
  }
}

interface ExpectedGrant {
  binding: CommercialCapabilityBindingV2
  origins: CommercialEntitlementOriginV2[]
}

function addExpectedOrigin(
  expected: Map<string, ExpectedGrant>,
  binding: CommercialCapabilityBindingV2,
  origin: CommercialEntitlementOriginV2,
): void {
  const grant = expected.get(binding.capabilityCode) ?? { binding, origins: [] }
  if (!grant.origins.some(candidate => JSON.stringify(candidate) === JSON.stringify(origin))) grant.origins.push(origin)
  expected.set(binding.capabilityCode, grant)
}

function addLineOrigins(
  expected: Map<string, ExpectedGrant>,
  line: CommercialQuoteLineV2,
  catalog: CommercialCatalogSnapshotV2,
  campaign: CommercialCampaignSnapshotV2 | null,
): void {
  const campaignOrigin =
    parseCommercialContractMoneyV2('QUOTE', line.discount) > 0n && campaign
      ? ({ kind: 'CAMPAIGN', sourceCode: campaign.campaignCode, sourceId: campaign.campaignVersionId, lineKey: line.lineKey } as const)
      : null
  if (line.targetType === 'PRODUCT') {
    const product = catalog.products.find(candidate => candidate.code === line.targetCode)!
    for (const binding of product.capabilityBindings) {
      addExpectedOrigin(expected, binding, {
        kind: product.code === 'FREE' ? 'FREE' : 'PRODUCT',
        sourceCode: product.code,
        lineKey: line.lineKey,
      })
      if (campaignOrigin) addExpectedOrigin(expected, binding, campaignOrigin)
    }
    return
  }

  const bundle = catalog.bundles.find(candidate => candidate.code === line.targetCode)!
  for (const item of bundle.items) {
    const product = catalog.products.find(candidate => candidate.code === item.productCode)!
    for (const binding of product.capabilityBindings) {
      addExpectedOrigin(expected, binding, {
        kind: 'BUNDLE_COMPONENT',
        sourceCode: product.code,
        parentSourceCode: bundle.code,
        lineKey: line.lineKey,
      })
      if (campaignOrigin) addExpectedOrigin(expected, binding, campaignOrigin)
    }
  }
}

function validateQuoteAuthorities(value: CommercialQuoteSnapshotV2, authorities: CommercialQuoteValidationAuthoritiesV2): void {
  const { catalog, campaign } = authorities
  if (catalog.publicationId !== value.catalogPublicationId) failCommercialContractV2('QUOTE', 'QUOTE_CATALOG_MISMATCH')
  if ((campaign?.campaignVersionId ?? null) !== value.campaignVersionId || (campaign?.campaignCode ?? null) !== value.campaignCode) {
    failCommercialContractV2('QUOTE', 'QUOTE_CAMPAIGN_MISMATCH')
  }

  const products = new Map(catalog.products.map(product => [product.code, product]))
  const bundles = new Map(catalog.bundles.map(bundle => [bundle.code, bundle]))
  const expectedGrants = new Map<string, ExpectedGrant>()
  for (const line of value.lines) {
    const product = line.targetType === 'PRODUCT' ? products.get(line.targetCode) : undefined
    const bundle = line.targetType === 'BUNDLE' ? bundles.get(line.targetCode) : undefined
    const target = product ?? bundle
    if (!target) failCommercialContractV2('QUOTE', 'QUOTE_CATALOG_LINE_MISMATCH')
    const price = target.prices.find(candidate => candidate.code === line.priceCode)
    if (
      !price ||
      price.billingUnit !== line.billingUnit ||
      price.amount !== line.unitAmount ||
      price.currency !== line.currency ||
      price.taxRateBasisPoints !== line.taxRateBasisPoints ||
      target.name !== line.name ||
      (product?.kind ?? 'BUNDLE') !== line.productKind
    ) {
      failCommercialContractV2('QUOTE', 'QUOTE_CATALOG_LINE_MISMATCH')
    }
    assertExactCampaignCalculation(line, campaign)
    addLineOrigins(expectedGrants, line, catalog, campaign)
  }

  const quoteCycles = new Set(value.lines.map(line => line.promotionalCycles).filter((cycles): cycles is number => cycles !== null))
  if (quoteCycles.size > 1) failCommercialContractV2('QUOTE', 'QUOTE_CAMPAIGN_CYCLES')
  if (value.entitlementGrants.length !== expectedGrants.size) {
    failCommercialContractV2('QUOTE', 'QUOTE_CATALOG_GRANT_MISMATCH')
  }
  for (const grant of value.entitlementGrants) {
    const expected = expectedGrants.get(grant.capabilityCode)
    if (
      !expected ||
      expected.binding.capabilityKind !== grant.capabilityKind ||
      !commercialActivationMatchesV2(expected.binding.activationRequirement, grant.activationRequirement)
    ) {
      failCommercialContractV2('QUOTE', 'QUOTE_CATALOG_GRANT_MISMATCH')
    }
    expected.origins.sort(compareCommercialOriginsV2)
    if (canonicalJsonV2(expected.origins) !== canonicalJsonV2(grant.origins)) {
      failCommercialContractV2('QUOTE', 'QUOTE_CATALOG_ORIGIN_MISMATCH')
    }
  }
}

export function validateCommercialQuoteIntrinsicV2(value: unknown): CommercialQuoteSnapshotV2 {
  return withCommercialContractV2Boundary('QUOTE', () => {
    const quote = materializeCommercialContractV2Json<CommercialQuoteSnapshotV2>(value)
    assertCommercialContractVersionsV2('QUOTE', quote)
    assertQuoteLineage(quote)
    assertCommercialContractSchemaV2('QUOTE', quote)
    validateQuoteSemantics(quote)
    intrinsicQuoteSnapshots.add(quote)
    return quote
  })
}

export function reconcileCommercialQuoteAuthoritiesV2(
  quote: CommercialQuoteSnapshotV2,
  authorities: CommercialQuoteValidationAuthoritiesV2,
): CommercialQuoteSnapshotV2 {
  return withCommercialContractV2Boundary('QUOTE', () => {
    if (typeof quote !== 'object' || quote === null || utilTypes.isProxy(quote) || !intrinsicQuoteSnapshots.has(quote)) {
      failCommercialContractV2('QUOTE', 'BOUNDARY')
    }
    validateQuoteAuthorities(quote, captureMaterializedAuthorities(authorities))
    return quote
  })
}
