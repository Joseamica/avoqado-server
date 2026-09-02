import { createHash, timingSafeEqual } from 'node:crypto'
import Ajv, { type ErrorObject } from 'ajv'

import quoteV2Schema from '@/contracts/commercial/commercial-quote-v2.schema.json'
import quoteV3Schema from '@/contracts/commercial/commercial-quote-v3.schema.json'
import resolutionSchema from '@/contracts/commercial/commercial-offer-resolution-v2.schema.json'
import { COMMERCIAL_V2_DOMAINS } from '@/contracts/commercial/commercialContractV2.constants'
import { canonicalJsonBytesV2 } from '@/services/commercial/commercialCanonicalJsonV2.service'
import {
  assertEmittedCommercialCatalogV2,
  assertVerifiedStoredCommercialCatalogV2,
} from '@/services/commercial/commercialArtifactCodecRegistry.service'
import { validateCommercialCatalogV2 } from '@/services/commercial/commercialContractV2.service'
import {
  commercialActivationMatchesV2,
  compareCommercialOriginsV2,
  validateCommercialOriginsV2,
} from '@/services/commercial/commercialContractV2Validation.shared'
import {
  assertCommercialMoneyLimitV2,
  parseCommercialMoneyV2,
  roundCommercialBasisPointsV2,
  type CommercialMoneyLimitKindV2,
} from '@/services/commercial/commercialMoneyV2.service'
import {
  resolveCommercialOfferV3WithRegistry,
  validateCommercialOfferResolutionV2,
} from '@/services/commercial/offers/commercialOfferResolutionRegistry.service'
import { decodeAndVerifyStoredCommercialOfferV3 } from '@/services/commercial/offers/commercialOfferV3.service'
import type {
  CommercialCampaignRuleV2,
  CommercialCapabilityBindingV2,
  CommercialCatalogSnapshotV2,
  CommercialEntitlementOriginV2,
} from '@/types/commercialV2'
import type { CommercialBenefitV3, CommercialOfferSnapshotV3, CommercialRateBlockerV3 } from '@/types/commercialOfferV3'
import type {
  CommercialMoneyBreakdownV3,
  CommercialQuoteHardwareLineV3,
  CommercialQuoteSaasLineV3,
  CommercialQuoteSnapshotV3,
  CommercialQuoteV3Authorities,
  CommercialQuoteV3DecodeInput,
  EmittedCommercialQuoteV3,
  VerifiedStoredCommercialQuoteV3,
} from '@/types/commercialQuoteV3'

import { commercialQuoteV3RuleTargetsLine } from './commercialQuoteV3RuleMatcher.service'

const COMMERCIAL_QUOTE_V3_HASH_DOMAIN = 'avoqado.commercial.quote@3\0'
export const COMMERCIAL_QUOTE_V3_MAX_CANONICAL_BYTES = 3_145_728

// Task 2 has no PostgreSQL authority. This is a conservative design ceiling for later JSONB text
// verification; Task 4 must measure octet_length(snapshot::text) and enforce the independent 4 MiB CHECK.
export const COMMERCIAL_QUOTE_V3_JSONB_TEXT_UPPER_BOUND_ESTIMATE_BYTES = 4_194_304

const ajv = new Ajv({ allErrors: true, jsonPointers: true })
ajv.addSchema(quoteV2Schema as object)
ajv.addSchema(resolutionSchema as object)
const schemaValidator = ajv.compile(quoteV3Schema as object)

export class CommercialQuoteV3Error extends Error {
  constructor(
    readonly code: 'COMMERCIAL_QUOTE_V3_INVALID' | 'COMMERCIAL_QUOTE_V3_CHECKSUM_MISMATCH' | 'COMMERCIAL_QUOTE_V3_IDENTITY_MISMATCH',
    readonly rule: string,
    readonly diagnostic?: ReadonlyArray<{ path: string; keyword: string; message: string }>,
  ) {
    super(`${code}:${rule}`)
    this.name = 'CommercialQuoteV3Error'
  }
}

function invalid(rule: string, diagnostic?: ReadonlyArray<{ path: string; keyword: string; message: string }>): never {
  throw new CommercialQuoteV3Error('COMMERCIAL_QUOTE_V3_INVALID', rule, diagnostic)
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const nested of Object.values(value)) deepFreeze(nested)
  return Object.freeze(value)
}

function materializeQuote(input: unknown): CommercialQuoteSnapshotV3 {
  // Quote v3 intentionally owns a 3 MiB canonical budget. Persistence readers must call this
  // decoder directly; the general v2 controlled-JSON parser has a separate frozen 1 MiB budget.
  let bytes: Buffer
  try {
    bytes = canonicalJsonBytesV2(input)
  } catch {
    return invalid('MATERIALIZATION')
  }
  if (bytes.byteLength > COMMERCIAL_QUOTE_V3_MAX_CANONICAL_BYTES) invalid('CANONICAL_SIZE')
  try {
    return deepFreeze(JSON.parse(bytes.toString('utf8')) as CommercialQuoteSnapshotV3)
  } catch {
    return invalid('MATERIALIZATION')
  }
}

function assertRepresentableLineKeys(value: CommercialQuoteSnapshotV3): void {
  const collections = [(value as { saasLines?: unknown }).saasLines, (value as { hardwareLines?: unknown }).hardwareLines]
  for (const collection of collections) {
    if (!Array.isArray(collection)) continue
    for (const line of collection) {
      if (
        typeof line === 'object' &&
        line !== null &&
        typeof (line as { lineKey?: unknown }).lineKey === 'string' &&
        (line as { lineKey: string }).lineKey.length > 128
      ) {
        invalid('QUOTE_LINE_KEY_LENGTH')
      }
    }
  }
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  return Buffer.compare(canonicalJsonBytesV2(left), canonicalJsonBytesV2(right)) === 0
}

function parseMinor(value: string, ...limits: CommercialMoneyLimitKindV2[]): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) invalid('QUOTE_ARITHMETIC')
  let minor: bigint
  try {
    minor = BigInt(value)
    for (const limit of limits) assertCommercialMoneyLimitV2(limit, minor)
  } catch {
    return invalid('QUOTE_ARITHMETIC')
  }
  return minor
}

function parsePublishedPeso(value: string, ...limits: CommercialMoneyLimitKindV2[]): bigint {
  try {
    const minor = parseCommercialMoneyV2(value)
    for (const limit of limits) assertCommercialMoneyLimitV2(limit, minor)
    return minor
  } catch {
    return invalid('QUOTE_ARITHMETIC')
  }
}

function assertLimit(value: bigint, ...limits: CommercialMoneyLimitKindV2[]): bigint {
  try {
    for (const limit of limits) assertCommercialMoneyLimitV2(limit, value)
    return value
  } catch {
    return invalid('QUOTE_ARITHMETIC')
  }
}

function assertExact(actual: bigint, expected: bigint): void {
  if (actual !== expected) invalid('QUOTE_ARITHMETIC')
}

function assertCatalogAuthority(authorities: CommercialQuoteV3Authorities): CommercialCatalogSnapshotV2 {
  let verified = false
  try {
    assertEmittedCommercialCatalogV2(authorities.catalog)
    verified = true
  } catch {
    try {
      assertVerifiedStoredCommercialCatalogV2(authorities.catalog)
      verified = true
    } catch {
      verified = false
    }
  }
  if (!verified) invalid('CATALOG_AUTHORITY')
  return validateCommercialCatalogV2(authorities.catalog.snapshot)
}

function assertOfferAuthority(authorities: CommercialQuoteV3Authorities): CommercialOfferSnapshotV3 {
  try {
    return decodeAndVerifyStoredCommercialOfferV3(authorities.offer).snapshot
  } catch (error) {
    if (error instanceof CommercialQuoteV3Error) throw error
    return invalid('OFFER_AUTHORITY')
  }
}

function acquisitionCreatedAtIso(value: string | Date): string | null {
  if (typeof value !== 'string') return dateIso(value)
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return null
  return new Date(timestamp).toISOString() === value ? value : null
}

function validateLineage(value: CommercialQuoteSnapshotV3, authorities: CommercialQuoteV3Authorities): void {
  const acquisition = authorities.acquisitionContext
  if (value.subject.kind === 'ACQUISITION_CONTEXT') {
    if (
      value.derivedFromPreview !== null ||
      value.acquisitionContextId === null ||
      value.subject.acquisitionContextId !== value.acquisitionContextId
    ) {
      invalid('QUOTE_LINEAGE')
    }
    if (!acquisition || acquisition.id !== value.acquisitionContextId) invalid('ACQUISITION_AUTHORITY')
    const createdAt = acquisitionCreatedAtIso(acquisition.createdAt)
    if (createdAt === null) invalid('ACQUISITION_AUTHORITY')
    if (value.resolution.resolvedAt !== createdAt) invalid('QUOTE_LINEAGE')
    return
  }

  if (value.acquisitionContextId === null) {
    if (value.derivedFromPreview !== null || acquisition !== null || value.resolution.resolvedAt !== value.quotedAt) {
      invalid('QUOTE_LINEAGE')
    }
    return
  }

  if (value.derivedFromPreview === null) invalid('QUOTE_LINEAGE')
  if (!acquisition || acquisition.id !== value.acquisitionContextId) invalid('ACQUISITION_AUTHORITY')
  const createdAt = acquisitionCreatedAtIso(acquisition.createdAt)
  if (createdAt === null) invalid('ACQUISITION_AUTHORITY')
  if (value.resolution.resolvedAt !== createdAt) invalid('QUOTE_LINEAGE')
}

function findOfferRule(
  offer: CommercialOfferSnapshotV3,
  benefitCode: string,
  ruleCode: string,
): { benefit: Extract<CommercialBenefitV3, { kind: 'SAAS_PRICE' }>; rule: CommercialCampaignRuleV2 } {
  const benefit = offer.benefits.find(candidate => candidate.kind === 'SAAS_PRICE' && candidate.benefitCode === benefitCode)
  if (!benefit || benefit.kind !== 'SAAS_PRICE') invalid('OFFER_RULE_AUTHORITY')
  const rule = benefit.rules.find(candidate => candidate.code === ruleCode)
  if (!rule) invalid('OFFER_RULE_AUTHORITY')
  return { benefit, rule }
}

function expectedRuleOutput(rule: CommercialCampaignRuleV2, input: bigint, quantity: number): bigint {
  if (rule.type === 'PERCENT_OFF') return input - roundCommercialBasisPointsV2(input, rule.percentBasisPoints)
  if (rule.type === 'FREE_PERIOD') return 0n
  const published = assertLimit(parsePublishedPeso(rule.amount, 'UNIT_AMOUNT') * BigInt(quantity), 'LINE_LIST_SUBTOTAL')
  if (rule.type === 'AMOUNT_OFF') return input - (published < input ? published : input)
  if (published > input) invalid('OFFER_INCREASES_PRICE')
  return published
}

function catalogTarget(
  catalog: CommercialCatalogSnapshotV2,
  line: CommercialQuoteSaasLineV3,
): {
  name: string
  productKind: CommercialQuoteSaasLineV3['productKind']
  price: CommercialCatalogSnapshotV2['products'][number]['prices'][number]
  grants: Array<{
    binding: CommercialCapabilityBindingV2
    origin: Exclude<CommercialEntitlementOriginV2, { kind: 'CAMPAIGN' | 'TRIAL' | 'GRANDFATHERED' | 'CONTRACT' | 'MANUAL' }>
  }>
} {
  if (line.targetType === 'PRODUCT') {
    const product = catalog.products.find(candidate => candidate.code === line.targetCode)
    const price = product?.prices.find(candidate => candidate.code === line.priceCode)
    if (!product || product.salesMode === 'CONTACT' || !price) invalid('CATALOG_LINE_AUTHORITY')
    return {
      name: product.name,
      productKind: product.kind,
      price,
      grants: product.capabilityBindings.map(binding => ({
        binding,
        origin: {
          kind: product.code === 'FREE' ? ('FREE' as const) : ('PRODUCT' as const),
          sourceCode: product.code,
          lineKey: line.lineKey,
        },
      })),
    }
  }

  const bundle = catalog.bundles.find(candidate => candidate.code === line.targetCode)
  const price = bundle?.prices.find(candidate => candidate.code === line.priceCode)
  if (!bundle || !price) invalid('CATALOG_LINE_AUTHORITY')
  const grants = bundle.items.flatMap(item => {
    const product = catalog.products.find(candidate => candidate.code === item.productCode)
    if (!product) invalid('CATALOG_LINE_AUTHORITY')
    return product.capabilityBindings.map(binding => ({
      binding,
      origin: {
        kind: 'BUNDLE_COMPONENT' as const,
        sourceCode: product.code,
        parentSourceCode: bundle.code,
        lineKey: line.lineKey,
      },
    }))
  })
  return { name: bundle.name, productKind: 'BUNDLE', price, grants }
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
  if (!grant.origins.some(candidate => canonicalEqual(candidate, origin))) grant.origins.push(origin)
  expected.set(binding.capabilityCode, grant)
}

function validateSaasLine(
  line: CommercialQuoteSaasLineV3,
  catalog: CommercialCatalogSnapshotV2,
  offer: CommercialOfferSnapshotV3,
  expectedGrants: Map<string, ExpectedGrant>,
): void {
  if (line.lineKey !== `${line.targetType}:${line.targetCode}:${line.priceCode}`) invalid('QUOTE_LINE_KEY')
  const target = catalogTarget(catalog, line)
  const publishedUnit = parsePublishedPeso(target.price.amount, 'UNIT_AMOUNT')
  if (
    target.name !== line.name ||
    target.productKind !== line.productKind ||
    target.price.billingUnit !== line.billingUnit ||
    target.price.currency !== line.currency ||
    target.price.taxRateBasisPoints !== line.taxRateBasisPoints ||
    parseMinor(line.listUnitAmountMinor, 'UNIT_AMOUNT') !== publishedUnit
  ) {
    invalid('CATALOG_LINE_AUTHORITY')
  }

  const unit = parseMinor(line.listUnitAmountMinor, 'UNIT_AMOUNT')
  const list = parseMinor(line.listSubtotalMinor, 'LINE_LIST_SUBTOTAL')
  const discount = parseMinor(line.discountMinor, 'QUOTE_DISCOUNT', 'LINE_LIST_SUBTOTAL')
  const subtotal = parseMinor(line.subtotalMinor, 'LINE_LIST_SUBTOTAL')
  const tax = parseMinor(line.taxMinor, 'QUOTE_TAX')
  const total = parseMinor(line.totalMinor, 'QUOTE_TOTAL')
  assertExact(list, assertLimit(unit * BigInt(line.quantity), 'LINE_LIST_SUBTOTAL'))
  if (discount > list) invalid('QUOTE_ARITHMETIC')
  assertExact(subtotal, list - discount)

  let running = list
  for (const [index, step] of line.appliedOfferSteps.entries()) {
    if (step.position !== index + 1) invalid('QUOTE_ARITHMETIC')
    const { rule } = findOfferRule(offer, step.benefitCode, step.ruleCode)
    if (rule.type !== step.type || rule.cycles !== step.cycles || !commercialQuoteV3RuleTargetsLine(rule, line)) {
      invalid('OFFER_RULE_AUTHORITY')
    }
    const input = parseMinor(step.inputAmountMinor, 'LINE_LIST_SUBTOTAL')
    const stepDiscount = parseMinor(step.discountAmountMinor, 'LINE_LIST_SUBTOTAL', 'QUOTE_DISCOUNT')
    const output = parseMinor(step.outputAmountMinor, 'LINE_LIST_SUBTOTAL')
    assertExact(input, running)
    if (stepDiscount > input) invalid('QUOTE_ARITHMETIC')
    assertExact(output, input - stepDiscount)
    assertExact(output, expectedRuleOutput(rule, input, line.quantity))
    running = output
  }
  if (line.appliedOfferSteps.length === 0) {
    if (discount !== 0n || subtotal !== list || line.promotionalCycles !== null) invalid('QUOTE_ARITHMETIC')
  } else {
    assertExact(running, subtotal)
    assertExact(discount, list - running)
    const cycles = line.appliedOfferSteps[0].cycles
    if (line.promotionalCycles !== cycles || line.appliedOfferSteps.some(step => step.cycles !== cycles)) invalid('QUOTE_ARITHMETIC')
  }
  assertExact(tax, assertLimit(roundCommercialBasisPointsV2(subtotal, line.taxRateBasisPoints), 'QUOTE_TAX'))
  assertExact(total, assertLimit(subtotal + tax, 'QUOTE_TOTAL'))

  const renewalSubtotal = parseMinor(line.renewalSubtotalMinor, 'RENEWAL_SUBTOTAL', 'LINE_LIST_SUBTOTAL')
  const renewalTax = parseMinor(line.renewalTaxMinor, 'RENEWAL_TAX')
  const renewalTotal = parseMinor(line.renewalTotalMinor, 'RENEWAL_TOTAL')
  assertExact(renewalSubtotal, list)
  assertExact(renewalTax, assertLimit(roundCommercialBasisPointsV2(renewalSubtotal, line.taxRateBasisPoints), 'RENEWAL_TAX'))
  assertExact(renewalTotal, assertLimit(renewalSubtotal + renewalTax, 'RENEWAL_TOTAL'))

  const campaignOrigin: CommercialEntitlementOriginV2 | null =
    discount > 0n
      ? {
          kind: 'CAMPAIGN',
          sourceCode: offer.campaignCode,
          sourceId: offer.campaignVersionId,
          lineKey: line.lineKey,
        }
      : null
  for (const source of target.grants) {
    addExpectedOrigin(expectedGrants, source.binding, source.origin)
    if (campaignOrigin) addExpectedOrigin(expectedGrants, source.binding, campaignOrigin)
  }
}

function validateHardwareLine(line: CommercialQuoteHardwareLineV3, offer: CommercialOfferSnapshotV3, resolvedAt: string): void {
  if (line.lineKey !== `HARDWARE_SKU:${line.catalogKey}` || line.skuSnapshot.catalogKey !== line.catalogKey) invalid('QUOTE_LINE_KEY')
  const offerBenefits = offer.benefits.filter(
    (benefit): benefit is Extract<CommercialBenefitV3, { kind: 'HARDWARE_PERCENT_OFF' | 'HARDWARE_FIXED_PRICE' }> =>
      (benefit.kind === 'HARDWARE_PERCENT_OFF' || benefit.kind === 'HARDWARE_FIXED_PRICE') &&
      benefit.skuSnapshot.catalogKey === line.catalogKey,
  )
  if (offerBenefits.length === 0 || !offerBenefits.every(benefit => canonicalEqual(benefit.skuSnapshot, line.skuSnapshot))) {
    invalid('HARDWARE_AUTHORITY')
  }
  const listUnit = parseMinor(line.skuSnapshot.listUnitAmountMinor, 'UNIT_AMOUNT')
  const list = parseMinor(line.listSubtotalMinor, 'LINE_LIST_SUBTOTAL')
  const discount = parseMinor(line.discountMinor, 'QUOTE_DISCOUNT', 'LINE_LIST_SUBTOTAL')
  const subtotal = parseMinor(line.subtotalMinor, 'LINE_LIST_SUBTOTAL')
  const tax = parseMinor(line.taxMinor, 'QUOTE_TAX')
  const total = parseMinor(line.totalMinor, 'QUOTE_TOTAL')
  assertExact(list, assertLimit(listUnit * BigInt(line.quantity), 'LINE_LIST_SUBTOTAL'))
  if (line.benefitedQuantity + line.listPriceQuantity !== line.quantity || discount > list) invalid('QUOTE_ARITHMETIC')

  if (line.appliedBenefit === null) {
    if (line.benefitedQuantity !== 0 || line.listPriceQuantity !== line.quantity || discount !== 0n || subtotal !== list) {
      invalid('QUOTE_ARITHMETIC')
    }
  } else {
    const benefit = offerBenefits.find(candidate => candidate.benefitCode === line.appliedBenefit?.benefitCode)
    if (!benefit || benefit.kind !== line.appliedBenefit.kind) invalid('HARDWARE_AUTHORITY')
    const resolvedAtTime = Date.parse(resolvedAt)
    if (resolvedAtTime < Date.parse(benefit.benefitStartsAt) || resolvedAtTime >= Date.parse(benefit.benefitEndsAt)) {
      invalid('HARDWARE_AUTHORITY')
    }
    if (
      line.appliedBenefit.appliedQuantity !== line.benefitedQuantity ||
      line.benefitedQuantity !== Math.min(line.quantity, benefit.quantityLimit)
    ) {
      invalid('QUOTE_ARITHMETIC')
    }
    let expectedSubtotal: bigint
    if (benefit.kind === 'HARDWARE_PERCENT_OFF' && line.appliedBenefit.kind === 'HARDWARE_PERCENT_OFF') {
      if (line.appliedBenefit.percentBasisPoints !== benefit.percentBasisPoints) invalid('HARDWARE_AUTHORITY')
      const benefitedList = assertLimit(listUnit * BigInt(line.benefitedQuantity), 'LINE_LIST_SUBTOTAL')
      expectedSubtotal = list - roundCommercialBasisPointsV2(benefitedList, benefit.percentBasisPoints)
    } else if (benefit.kind === 'HARDWARE_FIXED_PRICE' && line.appliedBenefit.kind === 'HARDWARE_FIXED_PRICE') {
      const fixed = parseMinor(line.appliedBenefit.unitAmountMinor, 'UNIT_AMOUNT')
      if (fixed.toString() !== benefit.unitAmountMinor) invalid('HARDWARE_AUTHORITY')
      expectedSubtotal = fixed * BigInt(line.benefitedQuantity) + listUnit * BigInt(line.listPriceQuantity)
    } else {
      return invalid('HARDWARE_AUTHORITY')
    }
    assertExact(subtotal, assertLimit(expectedSubtotal, 'LINE_LIST_SUBTOTAL'))
    assertExact(discount, list - subtotal)
  }
  assertExact(tax, assertLimit(roundCommercialBasisPointsV2(subtotal, 1600), 'QUOTE_TAX'))
  assertExact(total, assertLimit(subtotal + tax, 'QUOTE_TOTAL'))
}

function validateGrantAuthority(value: CommercialQuoteSnapshotV3, expected: Map<string, ExpectedGrant>): void {
  if (value.saasLines.length === 0) {
    if (value.entitlementGrants.length !== 0) invalid('ENTITLEMENT_AUTHORITY')
    return
  }
  if (expected.size === 0) invalid('COMMERCIAL_QUOTE_V3_SAAS_ENTITLEMENT_EMPTY')
  if (value.entitlementGrants.length !== expected.size) invalid('ENTITLEMENT_AUTHORITY')
  const orderedCodes = value.entitlementGrants.map(grant => grant.capabilityCode)
  if (orderedCodes.some((code, index) => index > 0 && compareAscii(orderedCodes[index - 1], code) >= 0)) {
    invalid('ENTITLEMENT_AUTHORITY')
  }
  for (const grant of value.entitlementGrants) {
    let expectedGrant: ExpectedGrant | undefined
    try {
      validateCommercialOriginsV2('QUOTE', grant.origins)
      expectedGrant = expected.get(grant.capabilityCode)
    } catch {
      invalid('ENTITLEMENT_AUTHORITY')
    }
    if (
      !expectedGrant ||
      expectedGrant.binding.capabilityKind !== grant.capabilityKind ||
      !commercialActivationMatchesV2(expectedGrant.binding.activationRequirement, grant.activationRequirement)
    ) {
      invalid('ENTITLEMENT_AUTHORITY')
    }
    expectedGrant.origins.sort(compareCommercialOriginsV2)
    if (!canonicalEqual(expectedGrant.origins, grant.origins)) invalid('ENTITLEMENT_AUTHORITY')
  }
}

function validateResolutionCompleteness(value: CommercialQuoteSnapshotV3, offer: CommercialOfferSnapshotV3): void {
  assertResolutionShape(value.resolution)
  const rateReasons = new Set(value.resolution.exclusions.filter(item => item.subjectKind === 'PAYMENTS_RATE').map(item => item.reasonCode))
  if (rateReasons.size > 1) invalid('RESOLUTION_COMPLETENESS')
  const rateReason = [...rateReasons][0]
  const rateBlockerByReason: Partial<Record<string, CommercialRateBlockerV3>> = {
    NEGOTIATED_RATE_PRESENT: 'NEGOTIATED_RATE',
    ENTERPRISE_RATE_PRESENT: 'ENTERPRISE_RATE',
    PRIOR_PROMOTION_PRESENT: 'PRIOR_PROMOTION',
    CHANNEL_AGREEMENT_PRESENT: 'CHANNEL_AGREEMENT',
  }
  const rateBlockers = rateReason && rateReason !== 'RATE_SCHEDULE_AUTHORITY_UNAVAILABLE' ? [rateBlockerByReason[rateReason]] : []
  if (rateBlockers.some(blocker => blocker === undefined)) invalid('RESOLUTION_COMPLETENESS')

  let expected: ReturnType<typeof resolveCommercialOfferV3WithRegistry>
  try {
    expected = resolveCommercialOfferV3WithRegistry({
      resolutionVersion: value.resolution.resolutionVersion,
      offer,
      resolvedAt: value.resolution.resolvedAt,
      saasMatches: value.saasLines
        .map(line => ({
          lineKey: line.lineKey,
          ruleCodes: offer.benefits
            .filter((benefit): benefit is Extract<CommercialBenefitV3, { kind: 'SAAS_PRICE' }> => benefit.kind === 'SAAS_PRICE')
            .flatMap(benefit => benefit.rules.filter(rule => commercialQuoteV3RuleTargetsLine(rule, line)).map(rule => rule.code)),
        }))
        .filter(match => match.ruleCodes.length > 0),
      hardwareSelections: value.hardwareLines.map(line => ({ catalogKey: line.catalogKey, quantity: line.quantity })),
      rateBlockers: rateBlockers as CommercialRateBlockerV3[],
    })
  } catch (error) {
    if (error instanceof CommercialQuoteV3Error) throw error
    return invalid('RESOLUTION_RECONSTRUCTION')
  }
  if (!canonicalEqual(expected, value.resolution)) invalid('RESOLUTION_COMPLETENESS')

  for (const line of value.saasLines) {
    const resolvedRules = value.resolution.applied
      .filter(item => item.subjectKind === 'SAAS_LINE' && item.subjectKey === line.lineKey)
      .flatMap(item => ('ruleCode' in item ? [{ benefitCode: item.benefitCode, ruleCode: item.ruleCode }] : []))
    const storedRules = line.appliedOfferSteps.map(step => ({ benefitCode: step.benefitCode, ruleCode: step.ruleCode }))
    if (!canonicalEqual(resolvedRules, storedRules)) invalid('RESOLUTION_COMPLETENESS')
  }
  for (const line of value.hardwareLines) {
    const applied = value.resolution.applied.filter(item => item.subjectKind === 'HARDWARE_SKU' && item.subjectKey === line.catalogKey)
    if (line.appliedBenefit === null) {
      if (applied.length !== 0) invalid('RESOLUTION_COMPLETENESS')
      continue
    }
    if (
      applied.length !== 1 ||
      applied[0].benefitCode !== line.appliedBenefit.benefitCode ||
      !('appliedQuantity' in applied[0]) ||
      applied[0].appliedQuantity !== line.benefitedQuantity
    ) {
      invalid('RESOLUTION_COMPLETENESS')
    }
    const excess = value.resolution.exclusions.filter(
      item =>
        item.subjectKind === 'HARDWARE_SKU' &&
        item.subjectKey === line.catalogKey &&
        item.benefitCode === line.appliedBenefit?.benefitCode &&
        item.reasonCode === 'HARDWARE_QUANTITY_EXCEEDED' &&
        item.accountingEffect === 'LIST_PRICE_EXCESS',
    )
    const expectedExcess = line.listPriceQuantity
    if (
      (expectedExcess === 0 && excess.length !== 0) ||
      (expectedExcess > 0 && (excess.length !== 1 || !('excludedQuantity' in excess[0]) || excess[0].excludedQuantity !== expectedExcess))
    ) {
      invalid('RESOLUTION_COMPLETENESS')
    }
  }
}

function assertResolutionShape(value: unknown): void {
  try {
    validateCommercialOfferResolutionV2(value)
  } catch {
    invalid('RESOLUTION_SCHEMA')
  }
}

const BREAKDOWN_FIELDS = ['listSubtotalMinor', 'discountMinor', 'subtotalMinor', 'taxMinor', 'totalMinor'] as const

function sumLines(
  lines: ReadonlyArray<Record<string, unknown>>,
  field: (typeof BREAKDOWN_FIELDS)[number],
  limit: CommercialMoneyLimitKindV2,
): bigint {
  return lines.reduce((sum, line) => assertLimit(sum + parseMinor(line[field] as string, limit), limit), 0n)
}

function validateBreakdown(
  actual: CommercialMoneyBreakdownV3,
  expected: Readonly<Record<(typeof BREAKDOWN_FIELDS)[number], bigint>>,
): void {
  for (const field of BREAKDOWN_FIELDS) {
    const limit: CommercialMoneyLimitKindV2 =
      field === 'discountMinor'
        ? 'QUOTE_DISCOUNT'
        : field === 'taxMinor'
          ? 'QUOTE_TAX'
          : field === 'totalMinor'
            ? 'QUOTE_TOTAL'
            : 'QUOTE_LIST_SUBTOTAL'
    assertExact(parseMinor(actual[field], limit), expected[field])
  }
  const list = parseMinor(actual.listSubtotalMinor, 'QUOTE_LIST_SUBTOTAL')
  const discount = parseMinor(actual.discountMinor, 'QUOTE_DISCOUNT')
  const subtotal = parseMinor(actual.subtotalMinor, 'QUOTE_LIST_SUBTOTAL')
  const tax = parseMinor(actual.taxMinor, 'QUOTE_TAX')
  const total = parseMinor(actual.totalMinor, 'QUOTE_TOTAL')
  if (discount > list) invalid('QUOTE_ARITHMETIC')
  assertExact(subtotal, list - discount)
  assertExact(total, subtotal + tax)
}

function validateTotals(value: CommercialQuoteSnapshotV3): void {
  const recurringLines = value.saasLines as unknown as Array<Record<string, unknown>>
  const oneTimeLines = value.hardwareLines as unknown as Array<Record<string, unknown>>
  const expectedFor = (lines: Array<Record<string, unknown>>) => ({
    listSubtotalMinor: sumLines(lines, 'listSubtotalMinor', 'QUOTE_LIST_SUBTOTAL'),
    discountMinor: sumLines(lines, 'discountMinor', 'QUOTE_DISCOUNT'),
    subtotalMinor: sumLines(lines, 'subtotalMinor', 'QUOTE_LIST_SUBTOTAL'),
    taxMinor: sumLines(lines, 'taxMinor', 'QUOTE_TAX'),
    totalMinor: sumLines(lines, 'totalMinor', 'QUOTE_TOTAL'),
  })
  const recurring = expectedFor(recurringLines)
  const oneTime = expectedFor(oneTimeLines)
  validateBreakdown(value.totals.recurringCurrent, recurring)
  validateBreakdown(value.totals.oneTime, oneTime)
  validateBreakdown(value.totals.dueNow, {
    listSubtotalMinor: assertLimit(recurring.listSubtotalMinor + oneTime.listSubtotalMinor, 'QUOTE_LIST_SUBTOTAL'),
    discountMinor: assertLimit(recurring.discountMinor + oneTime.discountMinor, 'QUOTE_DISCOUNT'),
    subtotalMinor: assertLimit(recurring.subtotalMinor + oneTime.subtotalMinor, 'QUOTE_LIST_SUBTOTAL'),
    taxMinor: assertLimit(recurring.taxMinor + oneTime.taxMinor, 'QUOTE_TAX'),
    totalMinor: assertLimit(recurring.totalMinor + oneTime.totalMinor, 'QUOTE_TOTAL'),
  })

  const renewalSubtotal = value.saasLines.reduce(
    (sum, line) => assertLimit(sum + parseMinor(line.renewalSubtotalMinor, 'RENEWAL_SUBTOTAL'), 'RENEWAL_SUBTOTAL'),
    0n,
  )
  const renewalTax = value.saasLines.reduce(
    (sum, line) => assertLimit(sum + parseMinor(line.renewalTaxMinor, 'RENEWAL_TAX'), 'RENEWAL_TAX'),
    0n,
  )
  const renewalTotal = value.saasLines.reduce(
    (sum, line) => assertLimit(sum + parseMinor(line.renewalTotalMinor, 'RENEWAL_TOTAL'), 'RENEWAL_TOTAL'),
    0n,
  )
  if (
    parseMinor(value.renewal.listSubtotalMinor, 'RENEWAL_SUBTOTAL') !== renewalSubtotal ||
    value.renewal.discountMinor !== '0' ||
    parseMinor(value.renewal.subtotalMinor, 'RENEWAL_SUBTOTAL') !== renewalSubtotal ||
    parseMinor(value.renewal.taxMinor, 'RENEWAL_TAX') !== renewalTax ||
    parseMinor(value.renewal.totalMinor, 'RENEWAL_TOTAL') !== renewalTotal ||
    renewalSubtotal + renewalTax !== renewalTotal
  ) {
    invalid('QUOTE_ARITHMETIC')
  }
}

function validateSemantics(
  value: CommercialQuoteSnapshotV3,
  catalog: CommercialCatalogSnapshotV2,
  offer: CommercialOfferSnapshotV3,
  authorities: CommercialQuoteV3Authorities,
): void {
  if (Date.parse(value.quotedAt) >= Date.parse(value.expiresAt)) invalid('QUOTE_TIMESTAMP_ORDER')
  if (offer.status !== 'ACTIVE') invalid('OFFER_AUTHORITY')
  if (value.catalogPublicationId !== catalog.publicationId || value.catalogChecksum !== authorities.catalog.checksum) {
    invalid('CATALOG_AUTHORITY')
  }
  if (
    value.offerVersionId !== offer.campaignVersionId ||
    value.offerCode !== offer.campaignCode ||
    value.offerChecksum !== authorities.offer.checksum ||
    value.resolution.campaignVersionId !== offer.campaignVersionId
  ) {
    invalid('OFFER_AUTHORITY')
  }

  validateLineage(value, authorities)
  if (value.saasLines.length + value.hardwareLines.length < 1 || value.saasLines.length + value.hardwareLines.length > 50) {
    invalid('QUOTE_LINE_COUNT')
  }
  const ordered = (lines: Array<{ lineKey: string }>) =>
    lines.every((line, index) => index === 0 || compareAscii(lines[index - 1].lineKey, line.lineKey) < 0)
  const keys = [...value.saasLines, ...value.hardwareLines].map(line => line.lineKey)
  if (new Set(keys).size !== keys.length) invalid('QUOTE_LINE_UNIQUE')
  if (!ordered(value.saasLines) || !ordered(value.hardwareLines)) invalid('QUOTE_LINE_ORDER')

  const expectedGrants = new Map<string, ExpectedGrant>()
  for (const line of value.saasLines) validateSaasLine(line, catalog, offer, expectedGrants)
  for (const line of value.hardwareLines) validateHardwareLine(line, offer, value.resolution.resolvedAt)
  validateResolutionCompleteness(value, offer)
  const promotionalCycles = new Set(
    value.saasLines.filter(line => parseMinor(line.discountMinor, 'QUOTE_DISCOUNT') > 0n).map(line => line.promotionalCycles),
  )
  if (promotionalCycles.size > 1 || promotionalCycles.has(null)) invalid('QUOTE_ARITHMETIC')
  validateGrantAuthority(value, expectedGrants)
  validateTotals(value)
}

export function validateCommercialQuoteV3(input: unknown, authorities: CommercialQuoteV3Authorities): CommercialQuoteSnapshotV3 {
  const value = materializeQuote(input)
  assertRepresentableLineKeys(value)
  assertResolutionShape((value as { resolution?: unknown }).resolution)
  if (!schemaValidator(value)) {
    const diagnostic = (schemaValidator.errors ?? []).map((issue: ErrorObject) => ({
      path: issue.dataPath || '/',
      keyword: issue.keyword,
      message: issue.message ?? 'Valor inválido',
    }))
    return invalid('SCHEMA', diagnostic)
  }
  const catalog = assertCatalogAuthority(authorities)
  const offer = assertOfferAuthority(authorities)
  validateSemantics(value, catalog, offer, authorities)
  return value
}

function checksumCommercialQuoteV3(snapshot: CommercialQuoteSnapshotV3): string {
  return createHash('sha256')
    .update(Buffer.concat([Buffer.from(COMMERCIAL_QUOTE_V3_HASH_DOMAIN, 'ascii'), canonicalJsonBytesV2(snapshot)]))
    .digest('hex')
}

export function emitCommercialQuoteV3(input: unknown, authorities: CommercialQuoteV3Authorities): EmittedCommercialQuoteV3 {
  const snapshot = validateCommercialQuoteV3(input, authorities)
  return deepFreeze({
    kind: 'COMMERCIAL_QUOTE' as const,
    schemaVersion: 3 as const,
    mode: 'READ_WRITE' as const,
    snapshot,
    checksum: checksumCommercialQuoteV3(snapshot),
  })
}

function exactChecksum(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string' || !/^[0-9a-f]{64}$/.test(provided)) return false
  const left = Buffer.from(provided, 'hex')
  const right = Buffer.from(expected, 'hex')
  return left.length === right.length && timingSafeEqual(left, right)
}

function dateIso(value: Date): string | null {
  try {
    const time = Date.prototype.getTime.call(value)
    return Number.isFinite(time) ? Date.prototype.toISOString.call(value) : null
  } catch {
    return null
  }
}

export function decodeAndVerifyStoredCommercialQuoteV3(input: CommercialQuoteV3DecodeInput): VerifiedStoredCommercialQuoteV3 {
  if (input.rowSchemaVersion !== 3 || input.rowContext.schemaVersion !== 3) invalid('SCHEMA_VERSION')
  const snapshot = validateCommercialQuoteV3(input.snapshot, input.authorities)
  if (snapshot.subject.kind !== 'VENUE') invalid('STORED_SUBJECT')
  const checksum = checksumCommercialQuoteV3(snapshot)
  if (!exactChecksum(input.checksum, checksum)) {
    throw new CommercialQuoteV3Error('COMMERCIAL_QUOTE_V3_CHECKSUM_MISMATCH', 'CHECKSUM')
  }
  const rowMoney = [
    input.rowContext.listSubtotalMinor,
    input.rowContext.discountMinor,
    input.rowContext.subtotalMinor,
    input.rowContext.taxMinor,
    input.rowContext.totalMinor,
    input.rowContext.renewalSubtotalMinor,
    input.rowContext.renewalTaxMinor,
    input.rowContext.renewalTotalMinor,
  ]
  const snapshotMoney = [
    snapshot.totals.dueNow.listSubtotalMinor,
    snapshot.totals.dueNow.discountMinor,
    snapshot.totals.dueNow.subtotalMinor,
    snapshot.totals.dueNow.taxMinor,
    snapshot.totals.dueNow.totalMinor,
    snapshot.renewal.subtotalMinor,
    snapshot.renewal.taxMinor,
    snapshot.renewal.totalMinor,
  ]
  if (
    input.rowContext.id !== snapshot.quoteId ||
    input.rowContext.catalogPublicationId !== snapshot.catalogPublicationId ||
    input.rowContext.offerVersionId !== snapshot.offerVersionId ||
    input.rowContext.acquisitionContextId !== snapshot.acquisitionContextId ||
    input.rowContext.organizationId !== snapshot.subject.organizationId ||
    input.rowContext.venueId !== snapshot.subject.venueId ||
    input.rowContext.createdById !== snapshot.subject.actorId ||
    input.rowContext.venueOrganizationId !== snapshot.subject.organizationId ||
    input.rowContext.market !== snapshot.market ||
    input.rowContext.currency !== snapshot.currency ||
    dateIso(input.rowContext.quotedAt) !== snapshot.quotedAt ||
    dateIso(input.rowContext.expiresAt) !== snapshot.expiresAt ||
    rowMoney.some((value, index) => typeof value !== 'bigint' || value.toString() !== snapshotMoney[index])
  ) {
    throw new CommercialQuoteV3Error('COMMERCIAL_QUOTE_V3_IDENTITY_MISMATCH', 'ROW_CONTEXT')
  }
  return deepFreeze({
    kind: 'COMMERCIAL_QUOTE' as const,
    schemaVersion: 3 as const,
    mode: 'READ_WRITE' as const,
    snapshot,
    checksum,
    verified: true as const,
  })
}

export const COMMERCIAL_QUOTE_V3_CHECKSUM_DOMAIN = COMMERCIAL_QUOTE_V3_HASH_DOMAIN
export const COMMERCIAL_QUOTE_V3_CATALOG_CHECKSUM_DOMAIN = COMMERCIAL_V2_DOMAINS.CATALOG_SNAPSHOT
