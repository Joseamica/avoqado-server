import AppError from '@/errors/AppError'
import type { CommercialCatalogPriceV1, CommercialCatalogSnapshotV1, CommercialProductKind } from '@/types/commercial'
import type {
  CommercialCampaignRuleV1,
  CommercialCampaignTargetV1,
  CommercialCampaignVersionV1,
  CommercialQuoteAdjustmentV1,
  CommercialQuoteLineV1,
  CommercialQuoteSelectionV1,
  CommercialQuoteV1,
  EvaluateCommercialQuoteInput,
} from '@/types/commercialQuote'

function quoteError(code: string, message: string): AppError {
  return new AppError(message, 422, true, code)
}

function addSafe(left: number, right: number): number {
  const result = left + right
  if (!Number.isSafeInteger(result)) throw quoteError('COMMERCIAL_QUOTE_MONEY_OVERFLOW', 'El importe excede el límite permitido.')
  return result
}

function multiplySafe(left: number, right: number): number {
  const result = left * right
  if (!Number.isSafeInteger(result)) throw quoteError('COMMERCIAL_QUOTE_MONEY_OVERFLOW', 'El importe excede el límite permitido.')
  return result
}

function roundBasisPoints(amountMinor: number, basisPoints: number): number {
  return Math.floor((multiplySafe(amountMinor, basisPoints) + 5_000) / 10_000)
}

function assertCampaignActive(campaign: CommercialCampaignVersionV1, now: Date): void {
  const startsAt = Date.parse(campaign.startsAt)
  const endsAt = Date.parse(campaign.endsAt)
  if (
    campaign.status !== 'ACTIVE' ||
    !Number.isFinite(startsAt) ||
    !Number.isFinite(endsAt) ||
    startsAt >= endsAt ||
    now.getTime() < startsAt ||
    now.getTime() >= endsAt
  ) {
    throw quoteError('COMMERCIAL_CAMPAIGN_NOT_ACTIVE', 'La campaña reclamada no está activa para este momento.')
  }
}

interface ResolvedSelection {
  selection: CommercialQuoteSelectionV1
  name: string
  productKind: CommercialProductKind | 'BUNDLE'
  price: CommercialCatalogPriceV1
}

function resolveSelection(catalog: CommercialCatalogSnapshotV1, selection: CommercialQuoteSelectionV1): ResolvedSelection {
  if (!Number.isInteger(selection.quantity) || selection.quantity < 1 || selection.quantity > 1_000) {
    throw quoteError('COMMERCIAL_QUOTE_INVALID_QUANTITY', 'La cantidad debe ser un entero entre 1 y 1000.')
  }
  const target =
    selection.targetType === 'PRODUCT'
      ? catalog.products.find(product => product.code === selection.targetCode)
      : catalog.bundles.find(bundle => bundle.code === selection.targetCode)
  const price = target?.prices.find(candidate => candidate.code === selection.priceCode)
  if (!target || !price || price.currency !== 'MXN') {
    throw quoteError('COMMERCIAL_QUOTE_PRICE_NOT_FOUND', 'La selección no corresponde a un precio publicado vigente.')
  }
  return {
    selection,
    name: target.name,
    productKind:
      selection.targetType === 'PRODUCT' ? catalog.products.find(product => product.code === selection.targetCode)!.kind : 'BUNDLE',
    price,
  }
}

function matchesTarget(resolved: ResolvedSelection, target: CommercialCampaignTargetV1): boolean {
  if (resolved.selection.targetType === 'BUNDLE') return target.bundleCodes?.includes(resolved.selection.targetCode) ?? false
  return (
    (target.productCodes?.includes(resolved.selection.targetCode) ?? false) ||
    (target.productKinds?.includes(resolved.productKind as CommercialProductKind) ?? false)
  )
}

function orderedRules(rules: CommercialCampaignRuleV1[]): CommercialCampaignRuleV1[] {
  return [...rules].sort((left, right) => right.priority - left.priority || left.code.localeCompare(right.code))
}

function selectRules(campaign: CommercialCampaignVersionV1 | undefined, resolved: ResolvedSelection): CommercialCampaignRuleV1[] {
  if (!campaign) return []
  const eligible = orderedRules(campaign.rules.filter(rule => matchesTarget(resolved, rule.target)))
  if (eligible.length < 2) return eligible
  const byCode = new Map(eligible.map(rule => [rule.code, rule]))
  const stacks = campaign.allowedRuleCodeGroups
    .map(group => [...new Set(group)])
    .filter(group => group.length > 1 && group.every(code => byCode.has(code)))
    .sort((left, right) => right.length - left.length || left.join(':').localeCompare(right.join(':')))
  if (stacks.length === 0) return [eligible[0]]
  return orderedRules(stacks[0].map(code => byCode.get(code)!))
}

function applyRule(currentMinor: number, quantity: number, rule: CommercialCampaignRuleV1): number {
  switch (rule.type) {
    case 'FIXED_PRICE':
    case 'BUNDLE_PRICE': {
      const fixedMinor = multiplySafe(rule.amountMinor, quantity)
      if (fixedMinor > currentMinor) {
        throw quoteError('COMMERCIAL_CAMPAIGN_INCREASES_PRICE', `La regla ${rule.code} aumentaría el precio publicado.`)
      }
      return fixedMinor
    }
    case 'PERCENT_OFF':
      return Math.max(0, currentMinor - roundBasisPoints(currentMinor, rule.percentBasisPoints))
    case 'AMOUNT_OFF':
      return Math.max(0, currentMinor - multiplySafe(rule.amountMinor, quantity))
    case 'FREE_PERIOD':
      return 0
  }
}

function quoteLine(resolved: ResolvedSelection, campaign?: CommercialCampaignVersionV1): CommercialQuoteLineV1 {
  const { selection, price } = resolved
  const listSubtotalMinor = multiplySafe(price.amountMinor, selection.quantity)
  const rules = selectRules(campaign, resolved)
  const cycles = new Set(rules.map(rule => rule.cycles))
  if (cycles.size > 1) {
    throw quoteError('COMMERCIAL_CAMPAIGN_STACK_CYCLE_MISMATCH', 'Las promociones apiladas deben tener la misma duración.')
  }
  let subtotalMinor = listSubtotalMinor
  const adjustments: CommercialQuoteAdjustmentV1[] = []
  for (const rule of rules) {
    const beforeMinor = subtotalMinor
    subtotalMinor = applyRule(subtotalMinor, selection.quantity, rule)
    adjustments.push({
      ruleCode: rule.code,
      type: rule.type,
      beforeMinor,
      afterMinor: subtotalMinor,
      discountMinor: beforeMinor - subtotalMinor,
      cycles: rule.cycles,
    })
  }
  const taxMinor = roundBasisPoints(subtotalMinor, price.taxRateBasisPoints)
  const renewalTaxMinor = roundBasisPoints(listSubtotalMinor, price.taxRateBasisPoints)
  return {
    ...selection,
    productKind: resolved.productKind,
    name: resolved.name,
    billingUnit: price.billingUnit,
    currency: 'MXN',
    taxRateBasisPoints: price.taxRateBasisPoints,
    unitAmountMinor: price.amountMinor,
    listSubtotalMinor,
    adjustments,
    discountMinor: listSubtotalMinor - subtotalMinor,
    subtotalMinor,
    taxMinor,
    totalMinor: addSafe(subtotalMinor, taxMinor),
    promotionalCycles: rules.length > 0 ? rules[0].cycles : null,
    renewalSubtotalMinor: listSubtotalMinor,
    renewalTaxMinor,
    renewalTotalMinor: addSafe(listSubtotalMinor, renewalTaxMinor),
  }
}

function total(lines: CommercialQuoteLineV1[], field: keyof CommercialQuoteLineV1): number {
  return lines.reduce((sum, line) => addSafe(sum, line[field] as number), 0)
}

export function evaluateCommercialQuote(input: EvaluateCommercialQuoteInput): CommercialQuoteV1 {
  if (input.request.market !== 'MX' || input.request.currency !== 'MXN') {
    throw quoteError('COMMERCIAL_QUOTE_MARKET_UNSUPPORTED', 'La cotización debe usar el mercado México y moneda MXN.')
  }
  if (!input.quoteId || input.expiresAt.getTime() <= input.now.getTime()) {
    throw quoteError('COMMERCIAL_QUOTE_INVALID_WINDOW', 'La vigencia de la cotización es inválida.')
  }
  if (input.campaign) assertCampaignActive(input.campaign, input.now)

  const sortedSelections = [...input.request.lines].sort(
    (left, right) =>
      left.targetType.localeCompare(right.targetType) ||
      left.targetCode.localeCompare(right.targetCode) ||
      left.priceCode.localeCompare(right.priceCode),
  )
  const selectionKeys = sortedSelections.map(selection => `${selection.targetType}:${selection.targetCode}:${selection.priceCode}`)
  if (new Set(selectionKeys).size !== selectionKeys.length) {
    throw quoteError('COMMERCIAL_QUOTE_DUPLICATE_LINE', 'Una selección comercial no puede repetirse en la misma cotización.')
  }
  if (sortedSelections.length === 0) throw quoteError('COMMERCIAL_QUOTE_EMPTY', 'La cotización necesita al menos una selección.')

  const lines = sortedSelections.map(selection => quoteLine(resolveSelection(input.catalog, selection), input.campaign))
  const promotionalCycles = new Set(lines.map(line => line.promotionalCycles).filter((cycles): cycles is number => cycles !== null))
  if (promotionalCycles.size > 1) {
    throw quoteError('COMMERCIAL_CAMPAIGN_QUOTE_CYCLE_MISMATCH', 'Todas las promociones de una cotización deben tener la misma duración.')
  }
  return {
    schemaVersion: 1,
    quoteId: input.quoteId,
    catalogPublicationId: input.catalog.publicationId,
    campaignVersionId: input.campaign?.campaignVersionId ?? null,
    campaignCode: input.campaign?.campaignCode ?? null,
    market: 'MX',
    currency: 'MXN',
    quotedAt: input.now.toISOString(),
    expiresAt: input.expiresAt.toISOString(),
    lines,
    totals: {
      listSubtotalMinor: total(lines, 'listSubtotalMinor'),
      discountMinor: total(lines, 'discountMinor'),
      subtotalMinor: total(lines, 'subtotalMinor'),
      taxMinor: total(lines, 'taxMinor'),
      totalMinor: total(lines, 'totalMinor'),
    },
    renewal: {
      subtotalMinor: total(lines, 'renewalSubtotalMinor'),
      taxMinor: total(lines, 'renewalTaxMinor'),
      totalMinor: total(lines, 'renewalTotalMinor'),
    },
  }
}
