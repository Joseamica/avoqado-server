import Ajv from 'ajv'

import { loadCommercialContractControlledJsonV2 } from '@/services/commercial/commercialContractV2Materialization.service'
import type { CommercialCampaignRuleV2 } from '@/types/commercialV2'
import type {
  CommercialAppliedBenefitV3,
  CommercialExcludedBenefitV3,
  CommercialExcludedPaymentsRateBenefitV3,
  CommercialOfferResolutionInputV3,
  CommercialOfferResolutionV3,
  CommercialRateBlockerV3,
  CommercialSaasPriceBenefitV3,
} from '@/types/commercialOfferV3'

import { validateCommercialOfferV3 } from './commercialOfferV3.service'

const RESOLVED_AT_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/
export const COMMERCIAL_OFFER_RESOLUTION_V2_LIMITS = Object.freeze({
  maxSaasMatches: 50,
  maxRuleCodesPerMatch: 100,
  maxHardwareSelections: 50,
  maxRateBlockers: 4,
  maxAppliedItems: 600,
  maxExcludedItems: 5050,
})
const MAX_SAAS_MATCHES = COMMERCIAL_OFFER_RESOLUTION_V2_LIMITS.maxSaasMatches
const MAX_RULE_CODES_PER_MATCH = COMMERCIAL_OFFER_RESOLUTION_V2_LIMITS.maxRuleCodesPerMatch
const MAX_HARDWARE_SELECTIONS = COMMERCIAL_OFFER_RESOLUTION_V2_LIMITS.maxHardwareSelections
const MAX_RATE_BLOCKERS = COMMERCIAL_OFFER_RESOLUTION_V2_LIMITS.maxRateBlockers
const MAX_APPLIED_RESOLUTION_ITEMS = COMMERCIAL_OFFER_RESOLUTION_V2_LIMITS.maxAppliedItems
const MAX_EXCLUDED_RESOLUTION_ITEMS = COMMERCIAL_OFFER_RESOLUTION_V2_LIMITS.maxExcludedItems
const resolutionSchema = loadCommercialContractControlledJsonV2(
  require.resolve('../../../contracts/commercial/commercial-offer-resolution-v2.schema.json'),
)
const resolutionValidator = new Ajv({ allErrors: true, jsonPointers: true }).compile(resolutionSchema as object)
const RATE_BLOCKER_REASON: Readonly<Record<CommercialRateBlockerV3, CommercialExcludedPaymentsRateBenefitV3['reasonCode']>> = Object.freeze(
  {
    NEGOTIATED_RATE: 'NEGOTIATED_RATE_PRESENT',
    ENTERPRISE_RATE: 'ENTERPRISE_RATE_PRESENT',
    PRIOR_PROMOTION: 'PRIOR_PROMOTION_PRESENT',
    CHANNEL_AGREEMENT: 'CHANNEL_AGREEMENT_PRESENT',
  },
)
const RATE_BLOCKER_ORDER: readonly CommercialRateBlockerV3[] = Object.freeze([
  'NEGOTIATED_RATE',
  'ENTERPRISE_RATE',
  'PRIOR_PROMOTION',
  'CHANNEL_AGREEMENT',
])

export class CommercialOfferResolutionError extends Error {
  readonly code = 'COMMERCIAL_OFFER_RESOLUTION_INVALID'

  constructor(
    readonly rule: string = 'INPUT',
    readonly diagnostics: readonly string[] = [],
  ) {
    super('COMMERCIAL_OFFER_RESOLUTION_INVALID')
    this.name = 'CommercialOfferResolutionError'
  }
}

function invalid(rule?: string, diagnostics?: readonly string[]): never {
  throw new CommercialOfferResolutionError(rule, diagnostics)
}

export function validateCommercialOfferResolutionV2(value: unknown): asserts value is CommercialOfferResolutionV3 {
  if (resolutionValidator(value)) return
  invalid(
    'RESOLUTION_SCHEMA',
    (resolutionValidator.errors ?? []).map(error => `${error.dataPath || '/'}:${error.keyword}`),
  )
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const nested of Object.values(value)) deepFreeze(nested)
  return Object.freeze(value)
}

function resultOrder(
  left: CommercialAppliedBenefitV3 | CommercialExcludedBenefitV3,
  right: CommercialAppliedBenefitV3 | CommercialExcludedBenefitV3,
): number {
  const leftQuantity = 'appliedQuantity' in left ? left.appliedQuantity : 'excludedQuantity' in left ? left.excludedQuantity : 0
  const rightQuantity = 'appliedQuantity' in right ? right.appliedQuantity : 'excludedQuantity' in right ? right.excludedQuantity : 0
  const leftRuleCode = 'reasonCode' in left && 'ruleCode' in left ? left.ruleCode : ''
  const rightRuleCode = 'reasonCode' in right && 'ruleCode' in right ? right.ruleCode : ''
  return (
    compareAscii(left.subjectKind, right.subjectKind) ||
    compareAscii(left.subjectKey, right.subjectKey) ||
    compareAscii(left.benefitCode, right.benefitCode) ||
    compareAscii('reasonCode' in left ? left.reasonCode : '', 'reasonCode' in right ? right.reasonCode : '') ||
    compareAscii(leftRuleCode, rightRuleCode) ||
    (leftQuantity ?? 0) - (rightQuantity ?? 0)
  )
}

function sameCodes(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false
  const leftSet = new Set(left)
  return leftSet.size === left.length && right.every(code => leftSet.has(code))
}

interface SaasRuleCandidate {
  benefit: CommercialSaasPriceBenefitV3
  rule: CommercialCampaignRuleV2
}

function resolveSaas(
  input: CommercialOfferResolutionInputV3,
  applied: CommercialAppliedBenefitV3[],
  exclusions: CommercialExcludedBenefitV3[],
): void {
  const benefits = input.offer.benefits.filter((benefit): benefit is CommercialSaasPriceBenefitV3 => benefit.kind === 'SAAS_PRICE')
  const rules = new Map<string, SaasRuleCandidate>()
  for (const benefit of benefits) {
    for (const rule of benefit.rules) {
      if (rules.has(rule.code)) invalid()
      rules.set(rule.code, { benefit, rule })
    }
  }

  const lineKeys: string[] = []
  for (const match of input.saasMatches) {
    if (typeof match !== 'object' || match === null || Array.isArray(match)) invalid()
    if (typeof match.lineKey !== 'string' || match.lineKey.trim().length === 0 || match.lineKey.length > 128) invalid()
    if (
      !Array.isArray(match.ruleCodes) ||
      match.ruleCodes.length < 1 ||
      match.ruleCodes.length > MAX_RULE_CODES_PER_MATCH ||
      match.ruleCodes.some(code => typeof code !== 'string') ||
      new Set(match.ruleCodes).size !== match.ruleCodes.length
    ) {
      invalid()
    }
    lineKeys.push(match.lineKey)
  }
  if (new Set(lineKeys).size !== lineKeys.length) invalid()
  for (const match of input.saasMatches) {
    const candidates = match.ruleCodes.map(code => rules.get(code) ?? invalid())

    const commonBenefit = candidates.every(candidate => candidate.benefit.benefitCode === candidates[0].benefit.benefitCode)
      ? candidates[0].benefit
      : null
    const exactStackingGroups =
      commonBenefit?.stackingGroups.filter(group =>
        sameCodes(
          group.steps.map(step => step.ruleCode),
          match.ruleCodes,
        ),
      ) ?? []
    if (exactStackingGroups.length > 1) invalid('SAAS_STACKING_MATCH_AMBIGUOUS')
    if (exactStackingGroups.length === 1) {
      const stackingGroup = exactStackingGroups[0]
      for (const step of stackingGroup.steps) {
        const candidate = rules.get(step.ruleCode) ?? invalid()
        applied.push({
          subjectKind: 'SAAS_LINE',
          subjectKey: match.lineKey,
          benefitCode: candidate.benefit.benefitCode,
          ruleCode: candidate.rule.code,
        })
      }
      continue
    }

    const matchedRuleCodes = new Set(match.ruleCodes)
    if (
      benefits.some(benefit =>
        benefit.stackingGroups.some(
          group => group.steps.length < match.ruleCodes.length && group.steps.every(step => matchedRuleCodes.has(step.ruleCode)),
        ),
      )
    ) {
      invalid('SAAS_STACKING_MATCH_AMBIGUOUS')
    }

    const ordered = [...candidates].sort(
      (left, right) => right.rule.priority - left.rule.priority || compareAscii(left.rule.code, right.rule.code),
    )
    if (ordered.length > 1 && ordered[0].rule.priority === ordered[1].rule.priority) {
      invalid('SAAS_PRIORITY_TIE')
    }
    const winner = ordered[0]
    applied.push({
      subjectKind: 'SAAS_LINE',
      subjectKey: match.lineKey,
      benefitCode: winner.benefit.benefitCode,
      ruleCode: winner.rule.code,
    })
    for (const excluded of ordered.slice(1)) {
      exclusions.push({
        subjectKind: 'SAAS_LINE',
        subjectKey: match.lineKey,
        benefitCode: excluded.benefit.benefitCode,
        ruleCode: excluded.rule.code,
        accountingEffect: 'EXPLANATORY',
        reasonCode: commonBenefit === null ? 'SAAS_STACKING_NOT_ALLOWED' : 'LOWER_PRIORITY_SAAS_RULE',
      })
    }
  }
}

function resolveHardware(
  input: CommercialOfferResolutionInputV3,
  resolvedAtTime: number,
  applied: CommercialAppliedBenefitV3[],
  exclusions: CommercialExcludedBenefitV3[],
): void {
  const selections = new Map<string, number>()
  for (const selection of input.hardwareSelections) {
    if (
      typeof selection !== 'object' ||
      selection === null ||
      Array.isArray(selection) ||
      typeof selection.catalogKey !== 'string' ||
      !/^[A-Z][A-Z0-9_]{1,63}$/.test(selection.catalogKey) ||
      !Number.isInteger(selection.quantity) ||
      selection.quantity < 1 ||
      selection.quantity > 1000 ||
      selections.has(selection.catalogKey)
    ) {
      invalid()
    }
    selections.set(selection.catalogKey, selection.quantity)
  }

  const offeredHardwareKeys = new Set(
    input.offer.benefits
      .filter(benefit => benefit.kind === 'HARDWARE_PERCENT_OFF' || benefit.kind === 'HARDWARE_FIXED_PRICE')
      .map(benefit => benefit.skuSnapshot.catalogKey),
  )
  if ([...selections.keys()].some(catalogKey => !offeredHardwareKeys.has(catalogKey))) {
    invalid('HARDWARE_SKU_NOT_IN_OFFER')
  }

  for (const benefit of input.offer.benefits) {
    if (benefit.kind !== 'HARDWARE_PERCENT_OFF' && benefit.kind !== 'HARDWARE_FIXED_PRICE') continue
    const subjectKey = benefit.skuSnapshot.catalogKey
    const quantity = selections.get(subjectKey)
    if (quantity === undefined) {
      exclusions.push({
        subjectKind: 'HARDWARE_SKU',
        subjectKey,
        benefitCode: benefit.benefitCode,
        accountingEffect: 'EXPLANATORY',
        reasonCode: 'HARDWARE_SKU_NOT_SELECTED',
      })
      continue
    }
    if (resolvedAtTime < Date.parse(benefit.benefitStartsAt) || resolvedAtTime >= Date.parse(benefit.benefitEndsAt)) {
      exclusions.push({
        subjectKind: 'HARDWARE_SKU',
        subjectKey,
        benefitCode: benefit.benefitCode,
        accountingEffect: 'EXPLANATORY',
        reasonCode: 'HARDWARE_WINDOW_INACTIVE',
      })
      continue
    }
    const appliedQuantity = Math.min(quantity, benefit.quantityLimit)
    applied.push({ subjectKind: 'HARDWARE_SKU', subjectKey, benefitCode: benefit.benefitCode, appliedQuantity })
    const excludedQuantity = quantity - appliedQuantity
    if (excludedQuantity > 0) {
      exclusions.push({
        subjectKind: 'HARDWARE_SKU',
        subjectKey,
        benefitCode: benefit.benefitCode,
        excludedQuantity,
        accountingEffect: 'LIST_PRICE_EXCESS',
        reasonCode: 'HARDWARE_QUANTITY_EXCEEDED',
      })
    }
  }
}

function resolveRates(input: CommercialOfferResolutionInputV3, exclusions: CommercialExcludedBenefitV3[]): void {
  if (
    input.rateBlockers.length > MAX_RATE_BLOCKERS ||
    input.rateBlockers.some(blocker => typeof blocker !== 'string') ||
    new Set(input.rateBlockers).size !== input.rateBlockers.length
  ) {
    invalid()
  }
  if (input.rateBlockers.some(blocker => !Object.prototype.hasOwnProperty.call(RATE_BLOCKER_REASON, blocker))) invalid()
  const strongest = RATE_BLOCKER_ORDER.find(blocker => input.rateBlockers.includes(blocker))
  for (const benefit of input.offer.benefits) {
    if (benefit.kind !== 'PAYMENTS_RATE_SCHEDULE') continue
    exclusions.push({
      subjectKind: 'PAYMENTS_RATE',
      subjectKey: benefit.paymentsRateScheduleVersionId,
      benefitCode: benefit.benefitCode,
      accountingEffect: 'EXPLANATORY',
      reasonCode: strongest ? RATE_BLOCKER_REASON[strongest] : 'RATE_SCHEDULE_AUTHORITY_UNAVAILABLE',
    })
  }
}

export function resolveCommercialOfferV3(rawInput: CommercialOfferResolutionInputV3): CommercialOfferResolutionV3 {
  if (typeof rawInput !== 'object' || rawInput === null) invalid()
  if (typeof rawInput.resolvedAt !== 'string') invalid()
  const resolvedAtTime = Date.parse(rawInput.resolvedAt)
  if (!RESOLVED_AT_PATTERN.test(rawInput.resolvedAt) || !Number.isFinite(resolvedAtTime)) invalid()
  if (
    !Array.isArray(rawInput.saasMatches) ||
    rawInput.saasMatches.length > MAX_SAAS_MATCHES ||
    !Array.isArray(rawInput.hardwareSelections) ||
    rawInput.hardwareSelections.length > MAX_HARDWARE_SELECTIONS ||
    !Array.isArray(rawInput.rateBlockers)
  )
    invalid()
  const offer = validateCommercialOfferV3(rawInput.offer)
  if (offer.status !== 'ACTIVE') invalid('OFFER_INACTIVE')
  if (resolvedAtTime < Date.parse(offer.claimStartsAt) || resolvedAtTime >= Date.parse(offer.claimEndsAt)) {
    invalid('OFFER_CLAIM_WINDOW')
  }
  const input = { ...rawInput, offer }
  const applied: CommercialAppliedBenefitV3[] = []
  const exclusions: CommercialExcludedBenefitV3[] = []

  resolveSaas(input, applied, exclusions)
  resolveHardware(input, resolvedAtTime, applied, exclusions)
  resolveRates(input, exclusions)

  if (applied.length > MAX_APPLIED_RESOLUTION_ITEMS || exclusions.length > MAX_EXCLUDED_RESOLUTION_ITEMS) {
    invalid()
  }
  const resolution: CommercialOfferResolutionV3 = {
    schemaVersion: 3 as const,
    resolutionVersion: 2 as const,
    campaignVersionId: offer.campaignVersionId,
    resolvedAt: rawInput.resolvedAt,
    applied: applied.sort(resultOrder),
    exclusions: exclusions.sort(resultOrder),
  }
  validateCommercialOfferResolutionV2(resolution)
  return deepFreeze(resolution)
}
