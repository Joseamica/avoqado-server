import { hashCanonicalJsonV1 } from '@/services/master-catalog/catalogHash.service'
import { ConflictError } from '@/errors/AppError'
import type { CommercialCatalogSnapshotV1, CommercialDraftView } from '@/types/commercial'
import { normalizeAndValidateCommercialDraft } from './commercialValidation.service'
import { assertCommercialContractV1 } from './commercialContract.service'

export interface CommercialSnapshotContext {
  publicationId: string
  publishedAt: Date
}

export interface BuiltCommercialSnapshot {
  snapshot: CommercialCatalogSnapshotV1
  checksum: string
}

export function buildCommercialSnapshot(draft: CommercialDraftView, context: CommercialSnapshotContext): BuiltCommercialSnapshot {
  // Draft persistence metadata is intentionally not part of the public
  // contract. Passing an explicit allowlist also keeps future internal fields
  // from reaching the snapshot by accident.
  const validation = normalizeAndValidateCommercialDraft({
    name: draft.name,
    description: draft.description,
    products: draft.products,
    pricebooks: draft.pricebooks,
    prices: draft.prices,
    bundles: draft.bundles,
    bundleItems: draft.bundleItems,
    featureBindings: draft.featureBindings,
  })
  if (!validation.valid || !validation.normalizedSnapshot) {
    throw new ConflictError('El borrador comercial contiene errores y no puede publicarse.', 'COMMERCIAL_DRAFT_INVALID', {
      errors: validation.errors,
      warnings: validation.warnings,
    })
  }
  const snapshot: CommercialCatalogSnapshotV1 = {
    ...validation.normalizedSnapshot,
    publicationId: context.publicationId,
    publishedAt: context.publishedAt.toISOString(),
  }
  assertCommercialContractV1(snapshot)
  return {
    snapshot,
    checksum: hashCanonicalJsonV1('commercial-catalog-snapshot-v1', snapshot),
  }
}
