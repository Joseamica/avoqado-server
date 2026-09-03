import AppError from '@/errors/AppError'
import {
  assertEmittedCommercialCatalogV2,
  assertVerifiedStoredCommercialCatalogV2,
} from '@/services/commercial/commercialArtifactCodecRegistry.service'
import { validateCommercialCatalogV2 } from '@/services/commercial/commercialContractV2.service'
import { evaluateCommercialQuoteV2, type CommercialQuoteSelectionV2 } from '@/services/commercial/commercialQuoteEngineV2.service'
import { parseCommercialMoneyV2 } from '@/services/commercial/commercialMoneyV2.service'
import {
  evaluateCommercialQuoteV3,
  type CommercialQuoteEvaluationV3,
} from '@/services/commercial/quotes-v3/commercialQuoteV3Engine.service'
import type {
  CommercialBillingUnit,
  CommercialProductKind,
  CommercialSalesMode,
} from '@/types/commercial'
import type {
  CommercialCatalogPriceV2,
  CommercialCatalogProductV2,
  CommercialCatalogSnapshotV2,
  CommercialEntitlementGrantV2,
  CommercialQuoteLineV2,
} from '@/types/commercialV2'
import type {
  CommercialMoneyBreakdownV3,
  CommercialQuoteSaasLineV3,
  CommercialQuoteV3CatalogAuthority,
  CommercialQuoteV3OfferAuthority,
} from '@/types/commercialQuoteV3'

export type CommercialConfiguratorSelection =
  | {
      mode: 'PACKAGE'
      packageCode: string
      billingUnit: 'VENUE_MONTH' | 'VENUE_YEAR'
    }
  | {
      mode: 'CUSTOM'
      moduleCodes: string[]
      billingUnit: 'VENUE_MONTH'
    }

export interface CommercialConfiguratorPreviewInput {
  catalogAuthority: CommercialQuoteV3CatalogAuthority
  offerAuthority: CommercialQuoteV3OfferAuthority | null
  selection: CommercialConfiguratorSelection
  resolvedAt: Date
}

export interface CommercialConfiguratorOptionPrice {
  code: string
  billingUnit: 'VENUE_MONTH' | 'VENUE_YEAR'
  listUnitAmountMinor: string
  taxRateBasisPoints: 0 | 1600
}

export interface CommercialConfiguratorOption {
  code: string
  name: string
  description: string
  kind: CommercialProductKind
  salesMode: CommercialSalesMode
  capabilityCodes: string[]
  prices: CommercialConfiguratorOptionPrice[]
}

export interface CommercialConfiguratorQuoteLine {
  lineKey: string
  targetType: 'PRODUCT' | 'BUNDLE'
  targetCode: string
  priceCode: string
  productKind: CommercialProductKind | 'BUNDLE'
  name: string
  billingUnit: CommercialBillingUnit
  listSubtotalMinor: string
  discountMinor: string
  subtotalMinor: string
  taxMinor: string
  totalMinor: string
  promotionalCycles: number | null
  renewalSubtotalMinor: string
  renewalTaxMinor: string
  renewalTotalMinor: string
  appliedDiscounts: Array<{
    type: 'FIXED_PRICE' | 'PERCENT_OFF' | 'AMOUNT_OFF' | 'FREE_PERIOD' | 'BUNDLE_PRICE'
    cycles: number
    discountMinor: string
  }>
}

export interface CommercialConfiguratorQuote {
  lines: CommercialConfiguratorQuoteLine[]
  today: CommercialMoneyBreakdownV3
  renewal: CommercialMoneyBreakdownV3
  entitlementCodes: string[]
}

export interface CommercialConfiguratorPreview {
  schemaVersion: 1
  catalogPublicationId: string
  offer: { offerVersionId: string; offerCode: string } | null
  selection: CommercialConfiguratorSelection
  options: {
    packages: CommercialConfiguratorOption[]
    customBase: CommercialConfiguratorOption
    modules: CommercialConfiguratorOption[]
  }
  quote: CommercialConfiguratorQuote
  recommendation: null | {
    reason: 'CHEAPER_TODAY_AND_RENEWAL' | 'LOWER_RENEWAL'
    selection: Extract<CommercialConfiguratorSelection, { mode: 'PACKAGE' }>
    quote: CommercialConfiguratorQuote
    savingsTodayMinor: string
    savingsRenewalMinor: string
  }
}

const CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/

function invalid(details?: Readonly<Record<string, string>>): never {
  throw new AppError(
    'La selección del configurador comercial no es válida.',
    422,
    true,
    'COMMERCIAL_CONFIGURATOR_SELECTION_INVALID',
    details,
  )
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const nested of Object.values(value)) deepFreeze(nested)
  return Object.freeze(value)
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index])
}

function verifiedCatalog(authority: CommercialQuoteV3CatalogAuthority): CommercialCatalogSnapshotV2 {
  try {
    try {
      assertEmittedCommercialCatalogV2(authority)
    } catch {
      assertVerifiedStoredCommercialCatalogV2(authority)
    }
    return validateCommercialCatalogV2(authority.snapshot)
  } catch {
    throw new AppError(
      'El catálogo comercial publicado no pudo verificarse.',
      422,
      true,
      'COMMERCIAL_CONFIGURATOR_CATALOG_AUTHORITY_INVALID',
    )
  }
}

function normalizeSelection(value: unknown): CommercialConfiguratorSelection {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid()
  const selection = value as Record<string, unknown>
  if (selection.mode === 'PACKAGE') {
    if (
      !exactKeys(selection, ['mode', 'packageCode', 'billingUnit']) ||
      typeof selection.packageCode !== 'string' ||
      !CODE_PATTERN.test(selection.packageCode) ||
      (selection.billingUnit !== 'VENUE_MONTH' && selection.billingUnit !== 'VENUE_YEAR')
    ) {
      return invalid()
    }
    return {
      mode: 'PACKAGE',
      packageCode: selection.packageCode,
      billingUnit: selection.billingUnit,
    }
  }
  if (selection.mode === 'CUSTOM') {
    if (
      !exactKeys(selection, ['mode', 'moduleCodes', 'billingUnit']) ||
      selection.billingUnit !== 'VENUE_MONTH' ||
      !Array.isArray(selection.moduleCodes) ||
      selection.moduleCodes.length > 49 ||
      selection.moduleCodes.some(code => typeof code !== 'string' || !CODE_PATTERN.test(code)) ||
      new Set(selection.moduleCodes).size !== selection.moduleCodes.length
    ) {
      return invalid()
    }
    return {
      mode: 'CUSTOM',
      moduleCodes: [...selection.moduleCodes].sort(),
      billingUnit: 'VENUE_MONTH',
    }
  }
  return invalid()
}

function publishedPrice(product: CommercialCatalogProductV2, billingUnit: CommercialBillingUnit): CommercialCatalogPriceV2 {
  const price = product.prices.find(candidate => candidate.billingUnit === billingUnit)
  if (!price || price.currency !== 'MXN') return invalid({ productCode: product.code, billingUnit })
  return price
}

function selectionsFor(
  catalog: CommercialCatalogSnapshotV2,
  selection: CommercialConfiguratorSelection,
): CommercialQuoteSelectionV2[] {
  if (selection.mode === 'PACKAGE') {
    const product = catalog.products.find(candidate => candidate.code === selection.packageCode)
    if (!product || product.kind !== 'PLAN' || product.salesMode !== 'SELF_SERVICE') {
      return invalid({ packageCode: selection.packageCode })
    }
    const price = publishedPrice(product, selection.billingUnit)
    return [{ targetType: 'PRODUCT', targetCode: product.code, priceCode: price.code, quantity: 1 }]
  }

  const pos = catalog.products.find(candidate => candidate.code === 'POS')
  if (!pos || pos.kind !== 'POS' || pos.salesMode !== 'SELF_SERVICE') return invalid({ productCode: 'POS' })
  const products = selection.moduleCodes.map(code => {
    const product = catalog.products.find(candidate => candidate.code === code)
    if (!product || product.kind !== 'MODULE' || product.salesMode !== 'SELF_SERVICE') return invalid({ moduleCode: code })
    return product
  })
  return [pos, ...products].map(product => ({
    targetType: 'PRODUCT',
    targetCode: product.code,
    priceCode: publishedPrice(product, 'VENUE_MONTH').code,
    quantity: 1,
  }))
}

function minor(value: string): string {
  return parseCommercialMoneyV2(value).toString()
}

function v2Line(line: CommercialQuoteLineV2): CommercialConfiguratorQuoteLine {
  return {
    lineKey: line.lineKey,
    targetType: line.targetType,
    targetCode: line.targetCode,
    priceCode: line.priceCode,
    productKind: line.productKind,
    name: line.name,
    billingUnit: line.billingUnit,
    listSubtotalMinor: minor(line.listSubtotal),
    discountMinor: minor(line.discount),
    subtotalMinor: minor(line.subtotal),
    taxMinor: minor(line.tax),
    totalMinor: minor(line.total),
    promotionalCycles: line.promotionalCycles,
    renewalSubtotalMinor: minor(line.renewalSubtotal),
    renewalTaxMinor: minor(line.renewalTax),
    renewalTotalMinor: minor(line.renewalTotal),
    appliedDiscounts: line.appliedCampaigns.map(campaign => ({
      type: campaign.type,
      cycles: campaign.cycles,
      discountMinor: minor(campaign.discountAmount),
    })),
  }
}

function v3Line(line: CommercialQuoteSaasLineV3): CommercialConfiguratorQuoteLine {
  return {
    lineKey: line.lineKey,
    targetType: line.targetType,
    targetCode: line.targetCode,
    priceCode: line.priceCode,
    productKind: line.productKind,
    name: line.name,
    billingUnit: line.billingUnit,
    listSubtotalMinor: line.listSubtotalMinor,
    discountMinor: line.discountMinor,
    subtotalMinor: line.subtotalMinor,
    taxMinor: line.taxMinor,
    totalMinor: line.totalMinor,
    promotionalCycles: line.promotionalCycles,
    renewalSubtotalMinor: line.renewalSubtotalMinor,
    renewalTaxMinor: line.renewalTaxMinor,
    renewalTotalMinor: line.renewalTotalMinor,
    appliedDiscounts: line.appliedOfferSteps.map(step => ({
      type: step.type,
      cycles: step.cycles,
      discountMinor: step.discountAmountMinor,
    })),
  }
}

function quoteFromV3(evaluation: CommercialQuoteEvaluationV3): CommercialConfiguratorQuote {
  return {
    lines: evaluation.saasLines.map(v3Line),
    today: evaluation.totals.recurringCurrent,
    renewal: evaluation.renewal,
    entitlementCodes: evaluation.entitlementGrants.map(grant => grant.capabilityCode).sort(),
  }
}

function evaluate(
  input: CommercialConfiguratorPreviewInput,
  catalog: CommercialCatalogSnapshotV2,
  selection: CommercialConfiguratorSelection,
): CommercialConfiguratorQuote {
  const saasSelections = selectionsFor(catalog, selection)
  if (input.offerAuthority) {
    return quoteFromV3(
      evaluateCommercialQuoteV3({
        authorities: { catalog: input.catalogAuthority, offer: input.offerAuthority },
        saasSelections,
        hardwareSelections: [],
        rateBlockers: [],
        resolvedAt: input.resolvedAt,
      }),
    )
  }
  const evaluation = evaluateCommercialQuoteV2({ catalog, campaign: null, lines: saasSelections, now: input.resolvedAt })
  return {
    lines: evaluation.lines.map(v2Line),
    today: {
      listSubtotalMinor: minor(evaluation.totals.listSubtotal),
      discountMinor: minor(evaluation.totals.discount),
      subtotalMinor: minor(evaluation.totals.subtotal),
      taxMinor: minor(evaluation.totals.tax),
      totalMinor: minor(evaluation.totals.total),
    },
    renewal: {
      listSubtotalMinor: minor(evaluation.renewal.subtotal),
      discountMinor: '0',
      subtotalMinor: minor(evaluation.renewal.subtotal),
      taxMinor: minor(evaluation.renewal.tax),
      totalMinor: minor(evaluation.renewal.total),
    },
    entitlementCodes: evaluation.entitlementGrants.map(grant => grant.capabilityCode).sort(),
  }
}

function entitlementKey(grant: CommercialEntitlementGrantV2): string {
  const activation =
    grant.activationRequirement.mode === 'NOT_REQUIRED'
      ? 'NOT_REQUIRED'
      : `VENUE_SETTING:${grant.activationRequirement.settingKey}:${grant.activationRequirement.defaultState}`
  return `${grant.capabilityCode}:${grant.capabilityKind}:${activation}`
}

function option(product: CommercialCatalogProductV2): CommercialConfiguratorOption {
  return {
    code: product.code,
    name: product.name,
    description: product.description,
    kind: product.kind,
    salesMode: product.salesMode,
    capabilityCodes: product.capabilityBindings.map(binding => binding.capabilityCode).sort(),
    prices: product.prices
      .filter(
        (price): price is CommercialCatalogPriceV2 & { billingUnit: 'VENUE_MONTH' | 'VENUE_YEAR' } =>
          price.billingUnit === 'VENUE_MONTH' || price.billingUnit === 'VENUE_YEAR',
      )
      .map(price => ({
        code: price.code,
        billingUnit: price.billingUnit,
        listUnitAmountMinor: minor(price.amount),
        taxRateBasisPoints: price.taxRateBasisPoints,
      })),
  }
}

function recommendationFor(
  input: CommercialConfiguratorPreviewInput,
  catalog: CommercialCatalogSnapshotV2,
  selection: CommercialConfiguratorSelection,
  quote: CommercialConfiguratorQuote,
): CommercialConfiguratorPreview['recommendation'] {
  if (selection.mode !== 'CUSTOM') return null
  const selectedEntitlements = new Set<string>()
  const selectedProductCodes = ['POS', ...selection.moduleCodes]
  for (const productCode of selectedProductCodes) {
    const product = catalog.products.find(candidate => candidate.code === productCode)
    if (!product) return invalid({ productCode })
    for (const binding of product.capabilityBindings) {
      selectedEntitlements.add(
        entitlementKey({ ...binding, origins: [] }),
      )
    }
  }

  const candidates = catalog.products
    .filter(product => product.kind === 'PLAN' && product.salesMode === 'SELF_SERVICE')
    .filter(product => {
      const monthly = product.prices.find(price => price.billingUnit === selection.billingUnit)
      return monthly ? parseCommercialMoneyV2(monthly.amount) > 0n : false
    })
    .filter(product => {
      const candidate = new Set(product.capabilityBindings.map(binding => entitlementKey({ ...binding, origins: [] })))
      return [...selectedEntitlements].every(required => candidate.has(required))
    })
    .map(product => {
      const packageSelection: Extract<CommercialConfiguratorSelection, { mode: 'PACKAGE' }> = {
        mode: 'PACKAGE',
        packageCode: product.code,
        billingUnit: selection.billingUnit,
      }
      const candidateQuote = evaluate(input, catalog, packageSelection)
      const todayDifference = BigInt(quote.today.totalMinor) - BigInt(candidateQuote.today.totalMinor)
      const renewalDifference = BigInt(quote.renewal.totalMinor) - BigInt(candidateQuote.renewal.totalMinor)
      if (renewalDifference <= 0n) return null
      const candidateToday = BigInt(candidateQuote.today.totalMinor)
      const selectedToday = BigInt(quote.today.totalMinor)
      return {
        reason: candidateToday < selectedToday ? ('CHEAPER_TODAY_AND_RENEWAL' as const) : ('LOWER_RENEWAL' as const),
        selection: packageSelection,
        quote: candidateQuote,
        savingsTodayMinor: todayDifference > 0n ? todayDifference.toString() : '0',
        savingsRenewalMinor: renewalDifference.toString(),
      }
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
    .sort((left, right) => {
      const leftRenewal = BigInt(left.quote.renewal.totalMinor)
      const rightRenewal = BigInt(right.quote.renewal.totalMinor)
      if (leftRenewal !== rightRenewal) return leftRenewal < rightRenewal ? -1 : 1
      return left.selection.packageCode < right.selection.packageCode
        ? -1
        : left.selection.packageCode > right.selection.packageCode
          ? 1
          : 0
    })

  return candidates[0] ?? null
}

export function previewCommercialConfigurator(input: CommercialConfiguratorPreviewInput): CommercialConfiguratorPreview {
  const catalog = verifiedCatalog(input.catalogAuthority)
  const selection = normalizeSelection(input.selection)
  const quote = evaluate(input, catalog, selection)
  const customBase = catalog.products.find(product => product.code === 'POS')
  if (!customBase) return invalid({ productCode: 'POS' })
  return deepFreeze({
    schemaVersion: 1,
    catalogPublicationId: catalog.publicationId,
    offer: input.offerAuthority
      ? {
          offerVersionId: input.offerAuthority.snapshot.campaignVersionId,
          offerCode: input.offerAuthority.snapshot.campaignCode,
        }
      : null,
    selection,
    options: {
      packages: catalog.products.filter(product => product.kind === 'PLAN').map(option),
      customBase: option(customBase),
      modules: catalog.products.filter(product => product.kind === 'MODULE').map(option),
    },
    quote,
    recommendation: recommendationFor(input, catalog, selection, quote),
  })
}
