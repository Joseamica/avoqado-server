import AppError from '@/errors/AppError'
import { canonicalJsonBytesV2 } from '@/services/commercial/commercialCanonicalJsonV2.service'
import {
  assertEmittedCommercialCatalogV2,
  assertVerifiedStoredCommercialCatalogV2,
} from '@/services/commercial/commercialArtifactCodecRegistry.service'
import { validateCommercialCatalogV2 } from '@/services/commercial/commercialContractV2.service'
import { compareCommercialOriginsV2 } from '@/services/commercial/commercialContractV2Validation.shared'
import { evaluateCommercialQuoteV2, type CommercialQuoteSelectionV2 } from '@/services/commercial/commercialQuoteEngineV2.service'
import {
  assertCommercialMoneyLimitV2,
  parseCommercialMoneyV2,
  roundCommercialBasisPointsV2,
  type CommercialMoneyLimitKindV2,
} from '@/services/commercial/commercialMoneyV2.service'
import { decodeAndVerifyStoredCommercialOfferV3 } from '@/services/commercial/offers/commercialOfferV3.service'
import {
  CommercialOfferResolutionError,
  resolveCommercialOfferV3WithRegistry,
} from '@/services/commercial/offers/commercialOfferResolutionRegistry.service'
import type { CommercialCampaignRuleV2, CommercialEntitlementGrantV2 } from '@/types/commercialV2'
import type { CommercialBenefitV3, CommercialRateBlockerV3 } from '@/types/commercialOfferV3'
import type {
  CommercialMoneyBreakdownV3,
  CommercialQuoteHardwareLineV3,
  CommercialQuoteSaasLineV3,
  CommercialQuoteSnapshotV3,
  CommercialQuoteV3CatalogAuthority,
  CommercialQuoteV3OfferAuthority,
} from '@/types/commercialQuoteV3'

import { commercialQuoteV3RuleTargetsLine } from './commercialQuoteV3RuleMatcher.service'

export interface CommercialHardwareSelectionV3 {
  catalogKey: string
  quantity: number
}

export interface EvaluateCommercialQuoteV3Input {
  authorities: {
    catalog: CommercialQuoteV3CatalogAuthority
    offer: CommercialQuoteV3OfferAuthority
  }
  saasSelections: readonly CommercialQuoteSelectionV2[]
  hardwareSelections: readonly CommercialHardwareSelectionV3[]
  rateBlockers: readonly CommercialRateBlockerV3[]
  resolvedAt: Date
}

export type CommercialQuoteEvaluationV3 = Pick<
  CommercialQuoteSnapshotV3,
  | 'catalogPublicationId'
  | 'catalogChecksum'
  | 'offerVersionId'
  | 'offerCode'
  | 'offerChecksum'
  | 'saasLines'
  | 'hardwareLines'
  | 'entitlementGrants'
  | 'resolution'
  | 'totals'
  | 'renewal'
>

const CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/
const RATE_BLOCKERS = new Set<CommercialRateBlockerV3>(['NEGOTIATED_RATE', 'ENTERPRISE_RATE', 'PRIOR_PROMOTION', 'CHANNEL_AGREEMENT'])

function engineError(code: string, details?: Readonly<Record<string, string>>): never {
  throw new AppError('No fue posible evaluar la cotización comercial.', 422, true, code, details)
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const nested of Object.values(value)) deepFreeze(nested)
  return Object.freeze(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

export function materializeCommercialQuoteV3Selections(
  input: Pick<EvaluateCommercialQuoteV3Input, 'saasSelections' | 'hardwareSelections' | 'rateBlockers'>,
): {
  saasSelections: CommercialQuoteSelectionV2[]
  hardwareSelections: CommercialHardwareSelectionV3[]
  rateBlockers: CommercialRateBlockerV3[]
} {
  let value: unknown
  try {
    value = JSON.parse(
      canonicalJsonBytesV2({
        saasSelections: input.saasSelections,
        hardwareSelections: input.hardwareSelections,
        rateBlockers: input.rateBlockers,
      }).toString('utf8'),
    )
  } catch {
    return engineError('COMMERCIAL_QUOTE_V3_INPUT_INVALID')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return engineError('COMMERCIAL_QUOTE_V3_INPUT_INVALID')
  }
  const candidate = value as Record<string, unknown>
  if (
    !exactKeys(candidate, ['saasSelections', 'hardwareSelections', 'rateBlockers']) ||
    !Array.isArray(candidate.saasSelections) ||
    !Array.isArray(candidate.hardwareSelections) ||
    !Array.isArray(candidate.rateBlockers)
  ) {
    return engineError('COMMERCIAL_QUOTE_V3_INPUT_INVALID')
  }

  const saasSelections = candidate.saasSelections.map(raw => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) engineError('COMMERCIAL_QUOTE_V3_INPUT_INVALID')
    const selection = raw as Record<string, unknown>
    if (
      !exactKeys(selection, ['targetType', 'targetCode', 'priceCode', 'quantity']) ||
      (selection.targetType !== 'PRODUCT' && selection.targetType !== 'BUNDLE') ||
      typeof selection.targetCode !== 'string' ||
      !CODE_PATTERN.test(selection.targetCode) ||
      typeof selection.priceCode !== 'string' ||
      !CODE_PATTERN.test(selection.priceCode) ||
      !Number.isInteger(selection.quantity) ||
      (selection.quantity as number) < 1 ||
      (selection.quantity as number) > 1_000 ||
      `${selection.targetType}:${selection.targetCode}:${selection.priceCode}`.length > 128
    ) {
      engineError('COMMERCIAL_QUOTE_V3_INPUT_INVALID')
    }
    return {
      targetType: selection.targetType,
      targetCode: selection.targetCode,
      priceCode: selection.priceCode,
      quantity: selection.quantity,
    } as CommercialQuoteSelectionV2
  })

  const hardwareSelections = candidate.hardwareSelections.map(raw => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) engineError('COMMERCIAL_QUOTE_V3_INPUT_INVALID')
    const selection = raw as Record<string, unknown>
    if (
      !exactKeys(selection, ['catalogKey', 'quantity']) ||
      typeof selection.catalogKey !== 'string' ||
      !CODE_PATTERN.test(selection.catalogKey) ||
      !Number.isInteger(selection.quantity) ||
      (selection.quantity as number) < 1 ||
      (selection.quantity as number) > 1_000
    ) {
      engineError('COMMERCIAL_QUOTE_V3_INPUT_INVALID')
    }
    return { catalogKey: selection.catalogKey, quantity: selection.quantity as number }
  })
  if (new Set(hardwareSelections.map(selection => selection.catalogKey)).size !== hardwareSelections.length) {
    engineError('COMMERCIAL_QUOTE_V3_INPUT_INVALID')
  }

  const rateBlockers = candidate.rateBlockers as unknown[]
  if (
    rateBlockers.some(blocker => typeof blocker !== 'string' || !RATE_BLOCKERS.has(blocker as CommercialRateBlockerV3)) ||
    new Set(rateBlockers).size !== rateBlockers.length
  ) {
    engineError('COMMERCIAL_QUOTE_V3_INPUT_INVALID')
  }
  if (saasSelections.length + hardwareSelections.length < 1 || saasSelections.length + hardwareSelections.length > 50) {
    engineError('COMMERCIAL_QUOTE_V3_INPUT_INVALID')
  }
  return {
    saasSelections,
    hardwareSelections,
    rateBlockers: rateBlockers as CommercialRateBlockerV3[],
  }
}

function verifiedCatalog(authority: CommercialQuoteV3CatalogAuthority) {
  try {
    try {
      assertEmittedCommercialCatalogV2(authority)
    } catch {
      assertVerifiedStoredCommercialCatalogV2(authority)
    }
    return validateCommercialCatalogV2(authority.snapshot)
  } catch {
    return engineError('COMMERCIAL_QUOTE_V3_CATALOG_AUTHORITY_INVALID')
  }
}

function verifiedOffer(authority: CommercialQuoteV3OfferAuthority) {
  try {
    return decodeAndVerifyStoredCommercialOfferV3(authority)
  } catch {
    return engineError('COMMERCIAL_QUOTE_V3_OFFER_AUTHORITY_INVALID')
  }
}

function resolvedAtIso(value: Date): string {
  try {
    const time = Date.prototype.getTime.call(value)
    if (!Number.isFinite(time)) return engineError('COMMERCIAL_QUOTE_V3_RESOLVED_AT_INVALID')
    return Date.prototype.toISOString.call(value)
  } catch {
    return engineError('COMMERCIAL_QUOTE_V3_RESOLVED_AT_INVALID')
  }
}

function evaluateBaseSaas(
  catalog: Parameters<typeof evaluateCommercialQuoteV2>[0]['catalog'],
  selections: CommercialQuoteSelectionV2[],
  resolvedAt: Date,
): ReturnType<typeof evaluateCommercialQuoteV2> {
  try {
    return evaluateCommercialQuoteV2({ catalog, campaign: null, lines: selections, now: resolvedAt })
  } catch (error) {
    if (!(error instanceof AppError)) return engineError('COMMERCIAL_QUOTE_V3_BASE_EVALUATION_INVALID')
    const mappedCode: Readonly<Record<string, string>> = {
      COMMERCIAL_QUOTE_PRICE_NOT_FOUND: 'COMMERCIAL_QUOTE_V3_SELECTION_NOT_FOUND',
      COMMERCIAL_QUOTE_DUPLICATE_LINE: 'COMMERCIAL_QUOTE_V3_DUPLICATE_LINE',
      COMMERCIAL_QUOTE_MONEY_OVERFLOW: 'COMMERCIAL_QUOTE_V3_MONEY_OVERFLOW',
      COMMERCIAL_QUOTE_INVALID_WINDOW: 'COMMERCIAL_QUOTE_V3_RESOLVED_AT_INVALID',
      COMMERCIAL_QUOTE_TOO_MANY_ORIGINS: 'COMMERCIAL_QUOTE_V3_TOO_MANY_ENTITLEMENT_ORIGINS',
    }
    return engineError(mappedCode[error.code ?? ''] ?? 'COMMERCIAL_QUOTE_V3_INPUT_INVALID', {
      causeCode: error.code ?? 'COMMERCIAL_QUOTE_V2_UNKNOWN',
    })
  }
}

function resolutionError(error: unknown): never {
  if (!(error instanceof CommercialOfferResolutionError)) {
    return engineError('COMMERCIAL_QUOTE_V3_RESOLUTION_INVALID')
  }
  const mappedCode: Readonly<Record<string, string>> = {
    OFFER_INACTIVE: 'COMMERCIAL_QUOTE_V3_OFFER_NOT_CLAIMABLE',
    OFFER_CLAIM_WINDOW: 'COMMERCIAL_QUOTE_V3_OFFER_NOT_CLAIMABLE',
    SAAS_STACKING_MATCH_AMBIGUOUS: 'COMMERCIAL_QUOTE_V3_OFFER_STACKING_AMBIGUOUS',
    SAAS_PRIORITY_TIE: 'COMMERCIAL_QUOTE_V3_OFFER_PRIORITY_AMBIGUOUS',
    HARDWARE_SKU_NOT_IN_OFFER: 'COMMERCIAL_QUOTE_V3_HARDWARE_NOT_OFFERED',
  }
  return engineError(mappedCode[error.rule] ?? 'COMMERCIAL_QUOTE_V3_RESOLUTION_INVALID', {
    causeRule: error.rule,
  })
}

function limit(value: bigint, kind: CommercialMoneyLimitKindV2): bigint {
  try {
    return assertCommercialMoneyLimitV2(kind, value)
  } catch {
    return engineError('COMMERCIAL_QUOTE_V3_MONEY_OVERFLOW')
  }
}

function publishedPeso(value: string, kind: CommercialMoneyLimitKindV2): bigint {
  try {
    return assertCommercialMoneyLimitV2(kind, parseCommercialMoneyV2(value))
  } catch {
    return engineError('COMMERCIAL_QUOTE_V3_MONEY_OVERFLOW')
  }
}

function minor(value: string, kind: CommercialMoneyLimitKindV2): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) return engineError('COMMERCIAL_QUOTE_V3_MONEY_OVERFLOW')
  try {
    return assertCommercialMoneyLimitV2(kind, BigInt(value))
  } catch {
    return engineError('COMMERCIAL_QUOTE_V3_MONEY_OVERFLOW')
  }
}

function findSaasRule(offerBenefits: CommercialBenefitV3[], benefitCode: string, ruleCode: string) {
  const benefit = offerBenefits.find(candidate => candidate.kind === 'SAAS_PRICE' && candidate.benefitCode === benefitCode)
  if (!benefit || benefit.kind !== 'SAAS_PRICE') return engineError('COMMERCIAL_QUOTE_V3_RESOLUTION_INVALID')
  const rule = benefit.rules.find(candidate => candidate.code === ruleCode)
  if (!rule) return engineError('COMMERCIAL_QUOTE_V3_RESOLUTION_INVALID')
  return rule
}

function applyRule(input: bigint, quantity: number, rule: CommercialCampaignRuleV2): bigint {
  if (rule.type === 'PERCENT_OFF') return input - roundCommercialBasisPointsV2(input, rule.percentBasisPoints)
  if (rule.type === 'FREE_PERIOD') return 0n
  const published = limit(publishedPeso(rule.amount, 'UNIT_AMOUNT') * BigInt(quantity), 'LINE_LIST_SUBTOTAL')
  if (rule.type === 'AMOUNT_OFF') return input - (published < input ? published : input)
  if (published > input) return engineError('COMMERCIAL_QUOTE_V3_OFFER_INCREASES_PRICE')
  return published
}

function evaluateSaasLines(
  baseLines: ReturnType<typeof evaluateCommercialQuoteV2>['lines'],
  offerBenefits: CommercialBenefitV3[],
  resolution: CommercialQuoteSnapshotV3['resolution'],
): CommercialQuoteSaasLineV3[] {
  return baseLines.map(line => {
    const unit = publishedPeso(line.unitAmount, 'UNIT_AMOUNT')
    const list = limit(unit * BigInt(line.quantity), 'LINE_LIST_SUBTOTAL')
    let current = list
    const resolved = resolution.applied.filter(item => item.subjectKind === 'SAAS_LINE' && item.subjectKey === line.lineKey)
    const steps = resolved.map((item, index) => {
      if (!('ruleCode' in item)) return engineError('COMMERCIAL_QUOTE_V3_RESOLUTION_INVALID')
      const rule = findSaasRule(offerBenefits, item.benefitCode, item.ruleCode)
      if (!commercialQuoteV3RuleTargetsLine(rule, line)) return engineError('COMMERCIAL_QUOTE_V3_RESOLUTION_INVALID')
      const input = current
      current = applyRule(current, line.quantity, rule)
      return {
        benefitCode: item.benefitCode,
        ruleCode: rule.code,
        type: rule.type,
        position: index + 1,
        inputAmountMinor: input.toString(),
        discountAmountMinor: (input - current).toString(),
        outputAmountMinor: current.toString(),
        cycles: rule.cycles,
      }
    })
    const cycles = new Set(steps.map(step => step.cycles))
    if (cycles.size > 1) engineError('COMMERCIAL_QUOTE_V3_STACK_CYCLE_MISMATCH')
    const discount = list - current
    const tax = limit(roundCommercialBasisPointsV2(current, line.taxRateBasisPoints), 'QUOTE_TAX')
    const total = limit(current + tax, 'QUOTE_TOTAL')
    const renewalTax = limit(roundCommercialBasisPointsV2(list, line.taxRateBasisPoints), 'RENEWAL_TAX')
    const renewalTotal = limit(list + renewalTax, 'RENEWAL_TOTAL')
    return {
      lineKey: line.lineKey,
      targetType: line.targetType,
      targetCode: line.targetCode,
      priceCode: line.priceCode,
      quantity: line.quantity,
      productKind: line.productKind,
      name: line.name,
      billingUnit: line.billingUnit,
      currency: 'MXN',
      taxRateBasisPoints: line.taxRateBasisPoints,
      listUnitAmountMinor: unit.toString(),
      listSubtotalMinor: list.toString(),
      appliedOfferSteps: steps,
      discountMinor: discount.toString(),
      subtotalMinor: current.toString(),
      taxMinor: tax.toString(),
      totalMinor: total.toString(),
      promotionalCycles: steps[0]?.cycles ?? null,
      renewalSubtotalMinor: list.toString(),
      renewalTaxMinor: renewalTax.toString(),
      renewalTotalMinor: renewalTotal.toString(),
    }
  })
}

function evaluateHardwareLines(
  selections: CommercialHardwareSelectionV3[],
  offerBenefits: CommercialBenefitV3[],
  resolution: CommercialQuoteSnapshotV3['resolution'],
): CommercialQuoteHardwareLineV3[] {
  return [...selections]
    .sort((left, right) => (left.catalogKey < right.catalogKey ? -1 : left.catalogKey > right.catalogKey ? 1 : 0))
    .map(selection => {
      const benefits = offerBenefits.filter(
        (benefit): benefit is Extract<CommercialBenefitV3, { kind: 'HARDWARE_PERCENT_OFF' | 'HARDWARE_FIXED_PRICE' }> =>
          (benefit.kind === 'HARDWARE_PERCENT_OFF' || benefit.kind === 'HARDWARE_FIXED_PRICE') &&
          benefit.skuSnapshot.catalogKey === selection.catalogKey,
      )
      if (benefits.length === 0) return engineError('COMMERCIAL_QUOTE_V3_HARDWARE_AUTHORITY_INVALID')
      const applied = resolution.applied.filter(item => item.subjectKind === 'HARDWARE_SKU' && item.subjectKey === selection.catalogKey)
      if (applied.length > 1) return engineError('COMMERCIAL_QUOTE_V3_RESOLUTION_INVALID')
      const skuSnapshot = benefits[0].skuSnapshot
      const listUnit = minor(skuSnapshot.listUnitAmountMinor, 'UNIT_AMOUNT')
      const list = limit(listUnit * BigInt(selection.quantity), 'LINE_LIST_SUBTOTAL')
      let subtotal = list
      let benefitedQuantity = 0
      let appliedBenefit: CommercialQuoteHardwareLineV3['appliedBenefit'] = null
      if (applied.length === 1) {
        if (!('appliedQuantity' in applied[0])) return engineError('COMMERCIAL_QUOTE_V3_RESOLUTION_INVALID')
        const benefit = benefits.find(candidate => candidate.benefitCode === applied[0].benefitCode)
        if (!benefit) return engineError('COMMERCIAL_QUOTE_V3_RESOLUTION_INVALID')
        benefitedQuantity = applied[0].appliedQuantity
        if (benefit.kind === 'HARDWARE_PERCENT_OFF') {
          const benefitedList = limit(listUnit * BigInt(benefitedQuantity), 'LINE_LIST_SUBTOTAL')
          subtotal = list - roundCommercialBasisPointsV2(benefitedList, benefit.percentBasisPoints)
          appliedBenefit = {
            kind: 'HARDWARE_PERCENT_OFF',
            benefitCode: benefit.benefitCode,
            percentBasisPoints: benefit.percentBasisPoints,
            appliedQuantity: benefitedQuantity,
          }
        } else {
          const fixed = minor(benefit.unitAmountMinor, 'UNIT_AMOUNT')
          subtotal = fixed * BigInt(benefitedQuantity) + listUnit * BigInt(selection.quantity - benefitedQuantity)
          appliedBenefit = {
            kind: 'HARDWARE_FIXED_PRICE',
            benefitCode: benefit.benefitCode,
            unitAmountMinor: fixed.toString(),
            appliedQuantity: benefitedQuantity,
          }
        }
        subtotal = limit(subtotal, 'LINE_LIST_SUBTOTAL')
      }
      const discount = list - subtotal
      const tax = limit(roundCommercialBasisPointsV2(subtotal, 1600), 'QUOTE_TAX')
      const total = limit(subtotal + tax, 'QUOTE_TOTAL')
      return {
        lineKey: `HARDWARE_SKU:${selection.catalogKey}`,
        catalogKey: selection.catalogKey,
        skuSnapshot,
        quantity: selection.quantity,
        benefitedQuantity,
        listPriceQuantity: selection.quantity - benefitedQuantity,
        appliedBenefit,
        currency: 'MXN',
        taxRateBasisPoints: 1600,
        listSubtotalMinor: list.toString(),
        discountMinor: discount.toString(),
        subtotalMinor: subtotal.toString(),
        taxMinor: tax.toString(),
        totalMinor: total.toString(),
      }
    })
}

function deriveEntitlements(
  grants: CommercialEntitlementGrantV2[],
  lines: CommercialQuoteSaasLineV3[],
  offer: { campaignCode: string; campaignVersionId: string },
): CommercialEntitlementGrantV2[] {
  const discounted = new Set(lines.filter(line => BigInt(line.discountMinor) > 0n).map(line => line.lineKey))
  return grants.map(grant => {
    const origins = [...grant.origins]
    for (const lineKey of discounted) {
      if (!origins.some(origin => 'lineKey' in origin && origin.lineKey === lineKey)) continue
      const campaignOrigin = {
        kind: 'CAMPAIGN' as const,
        sourceCode: offer.campaignCode,
        sourceId: offer.campaignVersionId,
        lineKey,
      }
      if (!origins.some(origin => JSON.stringify(origin) === JSON.stringify(campaignOrigin))) origins.push(campaignOrigin)
    }
    if (origins.length > 32) return engineError('COMMERCIAL_QUOTE_V3_TOO_MANY_ENTITLEMENT_ORIGINS')
    return { ...grant, origins: origins.sort(compareCommercialOriginsV2) }
  })
}

const BREAKDOWN_FIELDS = ['listSubtotalMinor', 'discountMinor', 'subtotalMinor', 'taxMinor', 'totalMinor'] as const

function sumBreakdown(lines: Array<Record<(typeof BREAKDOWN_FIELDS)[number], string>>): CommercialMoneyBreakdownV3 {
  const sums = Object.fromEntries(
    BREAKDOWN_FIELDS.map(field => {
      const kind: CommercialMoneyLimitKindV2 =
        field === 'discountMinor'
          ? 'QUOTE_DISCOUNT'
          : field === 'taxMinor'
            ? 'QUOTE_TAX'
            : field === 'totalMinor'
              ? 'QUOTE_TOTAL'
              : 'QUOTE_LIST_SUBTOTAL'
      const sum = lines.reduce((total, line) => limit(total + minor(line[field], kind), kind), 0n)
      return [field, sum.toString()]
    }),
  ) as unknown as CommercialMoneyBreakdownV3
  return sums
}

function addBreakdowns(left: CommercialMoneyBreakdownV3, right: CommercialMoneyBreakdownV3): CommercialMoneyBreakdownV3 {
  return Object.fromEntries(
    BREAKDOWN_FIELDS.map(field => {
      const kind: CommercialMoneyLimitKindV2 =
        field === 'discountMinor'
          ? 'QUOTE_DISCOUNT'
          : field === 'taxMinor'
            ? 'QUOTE_TAX'
            : field === 'totalMinor'
              ? 'QUOTE_TOTAL'
              : 'QUOTE_LIST_SUBTOTAL'
      return [field, limit(minor(left[field], kind) + minor(right[field], kind), kind).toString()]
    }),
  ) as unknown as CommercialMoneyBreakdownV3
}

function renewalBreakdown(lines: CommercialQuoteSaasLineV3[]): CommercialMoneyBreakdownV3 {
  const subtotal = lines.reduce((sum, line) => limit(sum + minor(line.renewalSubtotalMinor, 'RENEWAL_SUBTOTAL'), 'RENEWAL_SUBTOTAL'), 0n)
  const tax = lines.reduce((sum, line) => limit(sum + minor(line.renewalTaxMinor, 'RENEWAL_TAX'), 'RENEWAL_TAX'), 0n)
  const total = lines.reduce((sum, line) => limit(sum + minor(line.renewalTotalMinor, 'RENEWAL_TOTAL'), 'RENEWAL_TOTAL'), 0n)
  return {
    listSubtotalMinor: subtotal.toString(),
    discountMinor: '0',
    subtotalMinor: subtotal.toString(),
    taxMinor: tax.toString(),
    totalMinor: total.toString(),
  }
}

export function evaluateCommercialQuoteV3(input: EvaluateCommercialQuoteV3Input): CommercialQuoteEvaluationV3 {
  const catalog = verifiedCatalog(input.authorities.catalog)
  const offerArtifact = verifiedOffer(input.authorities.offer)
  const offer = offerArtifact.snapshot
  const selections = materializeCommercialQuoteV3Selections(input)
  const resolvedAt = resolvedAtIso(input.resolvedAt)
  const base =
    selections.saasSelections.length > 0
      ? evaluateBaseSaas(catalog, selections.saasSelections, input.resolvedAt)
      : { lines: [], entitlementGrants: [] }
  const saasMatches = base.lines
    .map(line => ({
      lineKey: line.lineKey,
      ruleCodes: offer.benefits
        .filter((benefit): benefit is Extract<CommercialBenefitV3, { kind: 'SAAS_PRICE' }> => benefit.kind === 'SAAS_PRICE')
        .flatMap(benefit => benefit.rules.filter(rule => commercialQuoteV3RuleTargetsLine(rule, line)).map(rule => rule.code)),
    }))
    .filter(match => match.ruleCodes.length > 0)
  let resolution: CommercialQuoteSnapshotV3['resolution']
  try {
    resolution = resolveCommercialOfferV3WithRegistry({
      resolutionVersion: 2,
      offer,
      resolvedAt,
      saasMatches,
      hardwareSelections: selections.hardwareSelections,
      rateBlockers: selections.rateBlockers,
    })
  } catch (error) {
    return resolutionError(error)
  }
  const saasLines = evaluateSaasLines(base.lines, offer.benefits, resolution)
  const promotionalCycles = new Set(saasLines.filter(line => BigInt(line.discountMinor) > 0n).map(line => line.promotionalCycles))
  if (promotionalCycles.size > 1 || promotionalCycles.has(null)) {
    engineError('COMMERCIAL_QUOTE_V3_PROMOTIONAL_CYCLE_MISMATCH')
  }
  const hardwareLines = evaluateHardwareLines(selections.hardwareSelections, offer.benefits, resolution)
  const entitlementGrants = deriveEntitlements(base.entitlementGrants, saasLines, offer)
  if (saasLines.length > 0 && entitlementGrants.length === 0) engineError('COMMERCIAL_QUOTE_V3_SAAS_ENTITLEMENT_EMPTY')
  const recurringCurrent = sumBreakdown(saasLines)
  const oneTime = sumBreakdown(hardwareLines)
  return deepFreeze({
    catalogPublicationId: catalog.publicationId,
    catalogChecksum: input.authorities.catalog.checksum,
    offerVersionId: offer.campaignVersionId,
    offerCode: offer.campaignCode,
    offerChecksum: offerArtifact.checksum,
    saasLines,
    hardwareLines,
    entitlementGrants,
    resolution,
    totals: {
      recurringCurrent,
      oneTime,
      dueNow: addBreakdowns(recurringCurrent, oneTime),
    },
    renewal: renewalBreakdown(saasLines),
  })
}
