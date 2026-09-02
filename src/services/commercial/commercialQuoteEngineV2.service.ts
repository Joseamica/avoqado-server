import AppError from '@/errors/AppError'
import type {
  CommercialActivationRequirementV2,
  CommercialAppliedCampaignV2,
  CommercialCampaignRuleV2,
  CommercialCampaignSnapshotV2,
  CommercialCapabilityBindingV2,
  CommercialCatalogPriceV2,
  CommercialCatalogSnapshotV2,
  CommercialEntitlementGrantV2,
  CommercialEntitlementOriginV2,
  CommercialQuoteLineV2,
  CommercialQuoteSnapshotV2,
} from '@/types/commercialV2'
import {
  assertCommercialMoneyLimitV2,
  formatCommercialMoneyV2,
  parseCommercialMoneyV2,
  roundCommercialBasisPointsV2,
} from './commercialMoneyV2.service'
import { compareCommercialAsciiV2, compareCommercialOriginsV2 } from './commercialContractV2Validation.shared'

export interface CommercialQuoteSelectionV2 {
  targetType: 'PRODUCT' | 'BUNDLE'
  targetCode: string
  priceCode: string
  quantity: number
}

export interface EvaluateCommercialQuoteInputV2 {
  catalog: CommercialCatalogSnapshotV2
  campaign: CommercialCampaignSnapshotV2 | null
  lines: readonly CommercialQuoteSelectionV2[]
  now: Date
}

export interface CommercialQuoteEvaluationV2 {
  catalogPublicationId: string
  campaignVersionId: string | null
  campaignCode: string | null
  lines: CommercialQuoteLineV2[]
  entitlementGrants: CommercialEntitlementGrantV2[]
  totals: CommercialQuoteSnapshotV2['totals']
  renewal: CommercialQuoteSnapshotV2['renewal']
}

function quoteError(code: string, message: string): AppError {
  return new AppError(message, 422, true, code)
}

const COMMERCIAL_MONEY_PRIMITIVE_ERRORS = new Set([
  'COMMERCIAL_MONEY_V2_INVALID',
  'COMMERCIAL_MONEY_V2_LIMIT_EXCEEDED',
  'COMMERCIAL_BASIS_POINTS_V2_INVALID',
])

function moneyBoundary<T>(operation: () => T): T {
  try {
    return operation()
  } catch (error) {
    if (error instanceof AppError) throw error
    if (!(error instanceof Error) || !COMMERCIAL_MONEY_PRIMITIVE_ERRORS.has(error.message)) throw error
    throw quoteError('COMMERCIAL_QUOTE_MONEY_OVERFLOW', 'El importe excede el límite permitido.')
  }
}

interface ResolvedGrantSource {
  binding: CommercialCapabilityBindingV2
  origin: Exclude<CommercialEntitlementOriginV2, { kind: 'CAMPAIGN' | 'TRIAL' | 'GRANDFATHERED' | 'CONTRACT' | 'MANUAL' }>
}

interface ResolvedSelectionV2 {
  selection: CommercialQuoteSelectionV2
  lineKey: string
  name: string
  productKind: CommercialQuoteLineV2['productKind']
  price: CommercialCatalogPriceV2
  grantSources: ResolvedGrantSource[]
}

function validateQuantity(selection: CommercialQuoteSelectionV2): void {
  if (!Number.isInteger(selection.quantity) || selection.quantity < 1 || selection.quantity > 1_000) {
    throw quoteError('COMMERCIAL_QUOTE_INVALID_QUANTITY', 'La cantidad debe ser un entero entre 1 y 1000.')
  }
}

function materializeSelection(selection: CommercialQuoteSelectionV2): CommercialQuoteSelectionV2 {
  const targetType = selection.targetType
  const targetCode = selection.targetCode
  const priceCode = selection.priceCode
  const quantity = selection.quantity
  return { targetType, targetCode, priceCode, quantity }
}

function resolveSelection(catalog: CommercialCatalogSnapshotV2, selection: CommercialQuoteSelectionV2): ResolvedSelectionV2 {
  const lineKey = `${selection.targetType}:${selection.targetCode}:${selection.priceCode}`
  if (selection.targetType === 'PRODUCT') {
    const product = catalog.products.find(candidate => candidate.code === selection.targetCode)
    const price = product?.prices.find(candidate => candidate.code === selection.priceCode)
    if (!product || product.salesMode === 'CONTACT' || !price || price.currency !== 'MXN') {
      throw quoteError('COMMERCIAL_QUOTE_PRICE_NOT_FOUND', 'La selección no corresponde a un precio publicado vigente.')
    }
    return {
      selection,
      lineKey,
      name: product.name,
      productKind: product.kind,
      price,
      grantSources: product.capabilityBindings.map(binding => ({
        binding,
        origin: {
          kind: product.code === 'FREE' ? 'FREE' : 'PRODUCT',
          sourceCode: product.code,
          lineKey,
        },
      })),
    }
  }

  const bundle = catalog.bundles.find(candidate => candidate.code === selection.targetCode)
  const price = bundle?.prices.find(candidate => candidate.code === selection.priceCode)
  if (!bundle || !price || price.currency !== 'MXN') {
    throw quoteError('COMMERCIAL_QUOTE_PRICE_NOT_FOUND', 'La selección no corresponde a un precio publicado vigente.')
  }
  const grantSources = bundle.items.flatMap(item => {
    const product = catalog.products.find(candidate => candidate.code === item.productCode)
    if (!product) throw quoteError('COMMERCIAL_QUOTE_PRICE_NOT_FOUND', 'El paquete publicado contiene un producto desconocido.')
    return product.capabilityBindings.map(binding => ({
      binding,
      origin: {
        kind: 'BUNDLE_COMPONENT' as const,
        sourceCode: product.code,
        parentSourceCode: bundle.code,
        lineKey,
      },
    }))
  })
  return { selection, lineKey, name: bundle.name, productKind: 'BUNDLE', price, grantSources }
}

function assertCampaignActive(campaign: CommercialCampaignSnapshotV2, nowTime: number): void {
  const startsAt = Date.parse(campaign.startsAt)
  const endsAt = Date.parse(campaign.endsAt)
  if (
    campaign.status !== 'ACTIVE' ||
    !Number.isFinite(startsAt) ||
    !Number.isFinite(endsAt) ||
    startsAt >= endsAt ||
    nowTime < startsAt ||
    nowTime >= endsAt
  ) {
    throw quoteError('COMMERCIAL_CAMPAIGN_NOT_ACTIVE', 'La campaña reclamada no está activa para este momento.')
  }
}

function ruleTargetsLine(rule: CommercialCampaignRuleV2, resolved: ResolvedSelectionV2): boolean {
  return Boolean(
    (resolved.selection.targetType === 'PRODUCT' && rule.target.productCodes?.includes(resolved.selection.targetCode)) ||
      (resolved.selection.targetType === 'BUNDLE' && rule.target.bundleCodes?.includes(resolved.selection.targetCode)) ||
      (resolved.productKind !== 'BUNDLE' && rule.target.productKinds?.includes(resolved.productKind)),
  )
}

function selectRules(campaign: CommercialCampaignSnapshotV2 | null, resolved: ResolvedSelectionV2): CommercialCampaignRuleV2[] {
  if (!campaign) return []
  const targeting = campaign.rules
    .filter(rule => ruleTargetsLine(rule, resolved))
    .sort((left, right) => right.priority - left.priority || compareCommercialAsciiV2(left.code, right.code))
  const anchor = targeting[0]
  if (!anchor) return []
  if (anchor.type === 'FREE_PERIOD') return [anchor]

  const targetingByCode = new Map(targeting.map(rule => [rule.code, rule]))
  const completeGroups = campaign.stackingGroups
    .filter(
      group =>
        group.steps.some(step => step.ruleCode === anchor.code) &&
        group.steps.every(step => targetingByCode.has(step.ruleCode)) &&
        group.steps.every(step => targetingByCode.get(step.ruleCode)?.type !== 'FREE_PERIOD'),
    )
    .sort((left, right) => right.steps.length - left.steps.length || compareCommercialAsciiV2(left.code, right.code))
  const group = completeGroups[0]
  return group ? group.steps.map(step => targetingByCode.get(step.ruleCode)!) : [anchor]
}

function applyRule(current: bigint, quantity: number, rule: CommercialCampaignRuleV2): bigint {
  if (rule.type === 'PERCENT_OFF') return current - roundCommercialBasisPointsV2(current, rule.percentBasisPoints)
  if (rule.type === 'FREE_PERIOD') return 0n
  const unit = assertCommercialMoneyLimitV2('UNIT_AMOUNT', parseCommercialMoneyV2(rule.amount))
  const published = assertCommercialMoneyLimitV2('LINE_LIST_SUBTOTAL', unit * BigInt(quantity))
  if (rule.type === 'AMOUNT_OFF') return current - (published < current ? published : current)
  if (published > current) {
    throw quoteError('COMMERCIAL_CAMPAIGN_INCREASES_PRICE', `La regla ${rule.code} aumentaría el precio publicado.`)
  }
  return published
}

function evaluateLine(resolved: ResolvedSelectionV2, campaign: CommercialCampaignSnapshotV2 | null): CommercialQuoteLineV2 {
  return moneyBoundary(() => {
    const unit = assertCommercialMoneyLimitV2('UNIT_AMOUNT', parseCommercialMoneyV2(resolved.price.amount))
    const list = assertCommercialMoneyLimitV2('LINE_LIST_SUBTOTAL', unit * BigInt(resolved.selection.quantity))
    const rules = selectRules(campaign, resolved)
    const cycles = new Set(rules.map(rule => rule.cycles))
    if (cycles.size > 1) {
      throw quoteError('COMMERCIAL_CAMPAIGN_STACK_CYCLE_MISMATCH', 'Las promociones apiladas deben tener la misma duración.')
    }

    let current = list
    const appliedCampaigns: CommercialAppliedCampaignV2[] = []
    for (const [index, rule] of rules.entries()) {
      const input = current
      current = applyRule(current, resolved.selection.quantity, rule)
      appliedCampaigns.push({
        campaignVersionId: campaign!.campaignVersionId,
        campaignCode: campaign!.campaignCode,
        ruleCode: rule.code,
        type: rule.type,
        position: index + 1,
        inputAmount: formatCommercialMoneyV2(input),
        discountAmount: formatCommercialMoneyV2(input - current),
        outputAmount: formatCommercialMoneyV2(current),
        cycles: rule.cycles,
      })
    }

    const discount = list - current
    const tax = assertCommercialMoneyLimitV2('QUOTE_TAX', roundCommercialBasisPointsV2(current, resolved.price.taxRateBasisPoints))
    const total = assertCommercialMoneyLimitV2('QUOTE_TOTAL', current + tax)
    const renewalTax = assertCommercialMoneyLimitV2('RENEWAL_TAX', roundCommercialBasisPointsV2(list, resolved.price.taxRateBasisPoints))
    const renewalTotal = assertCommercialMoneyLimitV2('RENEWAL_TOTAL', list + renewalTax)
    return {
      lineKey: resolved.lineKey,
      targetType: resolved.selection.targetType,
      targetCode: resolved.selection.targetCode,
      priceCode: resolved.price.code,
      quantity: resolved.selection.quantity,
      productKind: resolved.productKind,
      name: resolved.name,
      billingUnit: resolved.price.billingUnit,
      currency: 'MXN',
      taxRateBasisPoints: resolved.price.taxRateBasisPoints,
      unitAmount: resolved.price.amount,
      listSubtotal: formatCommercialMoneyV2(list),
      appliedCampaigns,
      discount: formatCommercialMoneyV2(discount),
      subtotal: formatCommercialMoneyV2(current),
      tax: formatCommercialMoneyV2(tax),
      total: formatCommercialMoneyV2(total),
      promotionalCycles: rules[0]?.cycles ?? null,
      renewalSubtotal: formatCommercialMoneyV2(list),
      renewalTax: formatCommercialMoneyV2(renewalTax),
      renewalTotal: formatCommercialMoneyV2(renewalTotal),
    }
  })
}

interface PendingGrant {
  capabilityKind: CommercialEntitlementGrantV2['capabilityKind']
  activationRequirement: CommercialActivationRequirementV2
  origins: CommercialEntitlementOriginV2[]
}

function deriveGrants(
  resolvedLines: ResolvedSelectionV2[],
  lines: CommercialQuoteLineV2[],
  campaign: CommercialCampaignSnapshotV2 | null,
): CommercialEntitlementGrantV2[] {
  const byCapability = new Map<string, PendingGrant>()
  for (const [index, resolved] of resolvedLines.entries()) {
    const line = lines[index]
    const campaignOrigin: CommercialEntitlementOriginV2 | null =
      parseCommercialMoneyV2(line.discount) > 0n && campaign
        ? { kind: 'CAMPAIGN', sourceCode: campaign.campaignCode, sourceId: campaign.campaignVersionId, lineKey: line.lineKey }
        : null
    for (const source of resolved.grantSources) {
      const pending = byCapability.get(source.binding.capabilityCode) ?? {
        capabilityKind: source.binding.capabilityKind,
        activationRequirement: source.binding.activationRequirement,
        origins: [],
      }
      for (const origin of campaignOrigin ? [source.origin, campaignOrigin] : [source.origin]) {
        const key = JSON.stringify(origin)
        if (!pending.origins.some(candidate => JSON.stringify(candidate) === key)) pending.origins.push(origin)
      }
      if (pending.origins.length > 32) {
        throw quoteError('COMMERCIAL_QUOTE_TOO_MANY_ORIGINS', 'Una capacidad no puede tener más de 32 orígenes en la misma cotización.')
      }
      byCapability.set(source.binding.capabilityCode, pending)
    }
  }
  return [...byCapability.entries()]
    .sort(([left], [right]) => compareCommercialAsciiV2(left, right))
    .map(([capabilityCode, pending]) => ({
      capabilityCode,
      capabilityKind: pending.capabilityKind,
      activationRequirement: pending.activationRequirement,
      origins: pending.origins.sort(compareCommercialOriginsV2),
    }))
}

type CommercialQuoteMoneyLineField =
  | 'listSubtotal'
  | 'discount'
  | 'subtotal'
  | 'tax'
  | 'total'
  | 'renewalSubtotal'
  | 'renewalTax'
  | 'renewalTotal'

function sumLineMoney(
  lines: CommercialQuoteLineV2[],
  field: CommercialQuoteMoneyLineField,
  limit: Parameters<typeof assertCommercialMoneyLimitV2>[0],
): bigint {
  return moneyBoundary(() =>
    lines.reduce((sum, line) => assertCommercialMoneyLimitV2(limit, sum + parseCommercialMoneyV2(line[field])), 0n),
  )
}

export function evaluateCommercialQuoteV2(input: EvaluateCommercialQuoteInputV2): CommercialQuoteEvaluationV2 {
  let nowTime: number
  try {
    nowTime = Date.prototype.getTime.call(input.now)
  } catch {
    nowTime = Number.NaN
  }
  if (!Number.isFinite(nowTime)) throw quoteError('COMMERCIAL_QUOTE_INVALID_WINDOW', 'El momento de la cotización es inválido.')
  if (input.lines.length === 0) throw quoteError('COMMERCIAL_QUOTE_EMPTY', 'La cotización necesita al menos una selección.')
  if (input.lines.length > 50) throw quoteError('COMMERCIAL_QUOTE_TOO_MANY_LINES', 'La cotización admite como máximo 50 selecciones.')
  const selections = input.lines.map(materializeSelection)
  selections.forEach(validateQuantity)
  if (input.campaign) assertCampaignActive(input.campaign, nowTime)

  selections.sort((left, right) =>
    compareCommercialAsciiV2(
      `${left.targetType}:${left.targetCode}:${left.priceCode}`,
      `${right.targetType}:${right.targetCode}:${right.priceCode}`,
    ),
  )
  const keys = selections.map(selection => `${selection.targetType}:${selection.targetCode}:${selection.priceCode}`)
  if (new Set(keys).size !== keys.length) {
    throw quoteError('COMMERCIAL_QUOTE_DUPLICATE_LINE', 'Una selección comercial no puede repetirse en la misma cotización.')
  }

  const resolvedLines = selections.map(selection => resolveSelection(input.catalog, selection))
  const lines = resolvedLines.map(resolved => evaluateLine(resolved, input.campaign))
  const quoteCycles = new Set(lines.map(line => line.promotionalCycles).filter((cycles): cycles is number => cycles !== null))
  if (quoteCycles.size > 1) {
    throw quoteError('COMMERCIAL_CAMPAIGN_QUOTE_CYCLE_MISMATCH', 'Todas las promociones de una cotización deben tener la misma duración.')
  }

  const listSubtotal = sumLineMoney(lines, 'listSubtotal', 'QUOTE_LIST_SUBTOTAL')
  const discount = sumLineMoney(lines, 'discount', 'QUOTE_DISCOUNT')
  const subtotal = moneyBoundary(() => assertCommercialMoneyLimitV2('QUOTE_LIST_SUBTOTAL', listSubtotal - discount))
  const tax = sumLineMoney(lines, 'tax', 'QUOTE_TAX')
  const total = moneyBoundary(() => assertCommercialMoneyLimitV2('QUOTE_TOTAL', subtotal + tax))
  const renewalSubtotal = sumLineMoney(lines, 'renewalSubtotal', 'RENEWAL_SUBTOTAL')
  const renewalTax = sumLineMoney(lines, 'renewalTax', 'RENEWAL_TAX')
  const renewalTotal = moneyBoundary(() => assertCommercialMoneyLimitV2('RENEWAL_TOTAL', renewalSubtotal + renewalTax))
  return {
    catalogPublicationId: input.catalog.publicationId,
    campaignVersionId: input.campaign?.campaignVersionId ?? null,
    campaignCode: input.campaign?.campaignCode ?? null,
    lines,
    entitlementGrants: deriveGrants(resolvedLines, lines, input.campaign),
    totals: {
      listSubtotal: formatCommercialMoneyV2(listSubtotal),
      discount: formatCommercialMoneyV2(discount),
      subtotal: formatCommercialMoneyV2(subtotal),
      tax: formatCommercialMoneyV2(tax),
      total: formatCommercialMoneyV2(total),
    },
    renewal: {
      subtotal: formatCommercialMoneyV2(renewalSubtotal),
      tax: formatCommercialMoneyV2(renewalTax),
      total: formatCommercialMoneyV2(renewalTotal),
    },
  }
}
