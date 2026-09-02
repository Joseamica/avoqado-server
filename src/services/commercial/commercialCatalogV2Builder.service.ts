import { ConflictError } from '@/errors/AppError'
import type { CommercialCatalogPriceV2, CommercialCatalogSnapshotV2 } from '@/types/commercialV2'
import type { CommercialDraftView } from '@/types/commercial'
import { emitCommercialArtifactV2, type CatalogV2Result } from './commercialArtifactCodecRegistry.service'
import { getCommercialCapabilityDefinition } from './commercialCapabilityRegistry'
import { compareCommercialAsciiV2 } from './commercialContractV2Validation.shared'
import { canonicalizeCommercialDraftMoneyV2, validateCommercialDraftForCatalogV2 } from './commercialValidation.service'

export interface CommercialCatalogBuildInputV2 {
  draft: CommercialDraftView
  publicationId: string
  publishedAt: Date
}

const BILLING_UNIT_RANK = { VENUE_MONTH: 0, VENUE_YEAR: 1 } as const

function priceV2(price: CommercialDraftView['prices'][number]): CommercialCatalogPriceV2 {
  return {
    code: price.code,
    billingUnit: price.billingUnit,
    amount: canonicalizeCommercialDraftMoneyV2(price.amount),
    currency: 'MXN',
    taxBehavior: price.taxBehavior,
    taxRateBasisPoints: price.taxBehavior === 'EXCLUSIVE' ? 1600 : 0,
  }
}

function comparePrice(left: CommercialDraftView['prices'][number], right: CommercialDraftView['prices'][number]): number {
  return BILLING_UNIT_RANK[left.billingUnit] - BILLING_UNIT_RANK[right.billingUnit] || compareCommercialAsciiV2(left.code, right.code)
}

export function buildCommercialCatalogV2(input: CommercialCatalogBuildInputV2): CatalogV2Result {
  const draft = input.draft
  const validation = validateCommercialDraftForCatalogV2({
    name: draft.name,
    description: draft.description,
    products: draft.products,
    pricebooks: draft.pricebooks,
    prices: draft.prices,
    bundles: draft.bundles,
    bundleItems: draft.bundleItems,
    featureBindings: draft.featureBindings,
  })
  if (!validation.valid) {
    throw new ConflictError('El borrador comercial contiene errores y no puede publicarse.', 'COMMERCIAL_DRAFT_INVALID', {
      errors: validation.errors,
      warnings: validation.warnings,
    })
  }

  const activePricebooks = new Set(draft.pricebooks.filter(pricebook => pricebook.active).map(pricebook => pricebook.code))
  const activePrices = draft.prices.filter(price => price.active && activePricebooks.has(price.pricebookCode))
  const domainValue = {
    schemaVersion: 2,
    contractVersion: '2.0.0',
    publicationId: input.publicationId,
    publishedAt: input.publishedAt.toISOString(),
    market: {
      country: 'MX',
      currency: 'MXN',
      timezone: 'America/Mexico_City',
      taxLabel: 'IVA',
      taxRateBasisPoints: 1600,
    },
    products: draft.products
      .filter(product => product.active)
      .sort((left, right) => left.sortOrder - right.sortOrder || compareCommercialAsciiV2(left.code, right.code))
      .map(product => ({
        code: product.code,
        slug: product.slug,
        kind: product.kind,
        name: product.name,
        description: product.description,
        salesMode: product.salesMode,
        sortOrder: product.sortOrder,
        capabilityBindings: draft.featureBindings
          .filter(binding => binding.productCode === product.code)
          .sort((left, right) => compareCommercialAsciiV2(left.capabilityCode, right.capabilityCode))
          .map(binding => {
            const definition = getCommercialCapabilityDefinition(binding.capabilityCode)
            if (!definition) {
              throw new ConflictError('El borrador comercial contiene una capacidad desconocida.', 'COMMERCIAL_DRAFT_INVALID')
            }
            return {
              capabilityCode: binding.capabilityCode,
              capabilityKind: definition.capabilityKind,
              activationRequirement:
                definition.activationRequirement.mode === 'NOT_REQUIRED'
                  ? { mode: 'NOT_REQUIRED' as const }
                  : {
                      mode: 'VENUE_SETTING' as const,
                      settingKey: definition.activationRequirement.settingKey,
                      defaultState: definition.activationRequirement.defaultState,
                    },
            }
          }),
        prices: activePrices
          .filter(price => price.productCode === product.code)
          .sort(comparePrice)
          .map(priceV2),
        ...(product.limits ? { limits: product.limits } : {}),
      })),
    bundles: draft.bundles
      .filter(bundle => bundle.active)
      .sort((left, right) => left.sortOrder - right.sortOrder || compareCommercialAsciiV2(left.code, right.code))
      .map(bundle => ({
        code: bundle.code,
        slug: bundle.slug,
        name: bundle.name,
        description: bundle.description,
        sortOrder: bundle.sortOrder,
        items: draft.bundleItems
          .filter(item => item.bundleCode === bundle.code)
          .sort((left, right) => left.sortOrder - right.sortOrder || compareCommercialAsciiV2(left.productCode, right.productCode))
          .map(item => ({ productCode: item.productCode, quantity: 1 as const, sortOrder: item.sortOrder })),
        prices: activePrices
          .filter(price => price.bundleCode === bundle.code)
          .sort(comparePrice)
          .map(priceV2),
      })),
  } satisfies CommercialCatalogSnapshotV2

  return emitCommercialArtifactV2({ kind: 'CATALOG', schemaVersion: 2, domainValue })
}
