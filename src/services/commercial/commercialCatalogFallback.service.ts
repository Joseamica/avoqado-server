import { CommercialArtifactCodecError, decodeAndVerifyCommercialArtifact } from './commercialArtifactCodecRegistry.service'
import { deepFreezeCommercialArtifact } from './commercialArtifactCodecBoundary.service'
import {
  captureActivationEventsValue,
  captureCatalogResolutionCore,
  catalogDecodeInput,
  verifyFutureCatalogRow,
} from './commercialCatalogFallbackBoundary.service'
import { proveCatalogActivationChain } from './commercialCatalogFallbackProvenance.service'
import type {
  CommercialCatalogPersistedRow,
  CommercialCatalogResolutionInput,
  DecodedCommercialCatalog,
  PublicCommercialCatalogResolution,
} from '@/types/commercialCodec'

export { CommercialCatalogFallbackError } from './commercialCatalogFallbackBoundary.service'

function isFutureContractError(error: unknown): error is CommercialArtifactCodecError {
  return error instanceof CommercialArtifactCodecError && error.code === 'COMMERCIAL_CATALOG_CONTRACT_UNSUPPORTED'
}

function decodeCatalogRow(row: CommercialCatalogPersistedRow): DecodedCommercialCatalog {
  const decoded = decodeAndVerifyCommercialArtifact(catalogDecodeInput(row))
  if (decoded.kind !== 'CATALOG') throw new Error('COMMERCIAL_CATALOG_CODEC_INVARIANT')
  return decoded
}

function classifyPredecessor(row: CommercialCatalogPersistedRow): DecodedCommercialCatalog | null {
  try {
    const decoded = decodeCatalogRow(row)
    return decoded.schemaVersion === 2 ? decoded : null
  } catch (error) {
    if (!isFutureContractError(error)) throw error
    verifyFutureCatalogRow(row)
    return null
  }
}

export function resolvePublicCommercialCatalog(input: CommercialCatalogResolutionInput): PublicCommercialCatalogResolution {
  const core = captureCatalogResolutionCore(input)
  let unsupported: CommercialArtifactCodecError
  try {
    const catalog = decodeCatalogRow(core.activePublication)
    return deepFreezeCommercialArtifact({ catalog, fallback: null })
  } catch (error) {
    if (!isFutureContractError(error)) throw error
    unsupported = error
  }

  verifyFutureCatalogRow(core.activePublication)
  if (core.activePointer.environment !== 'PRODUCTION') throw unsupported
  const chain = proveCatalogActivationChain({
    activePublication: core.activePublication,
    pointerRevision: core.activePointer.revision,
    activationEvents: captureActivationEventsValue(core.envelope),
  })
  for (let index = chain.length - 2; index >= 0; index -= 1) {
    const catalog = classifyPredecessor(chain[index])
    if (!catalog) continue
    return deepFreezeCommercialArtifact({
      catalog,
      fallback: {
        fallbackUsed: true,
        activePublicationId: core.activePublication.id,
        fallbackPublicationId: chain[index].id,
        incidentCode: 'COMMERCIAL_CATALOG_CONTRACT_UNSUPPORTED',
      },
    })
  }
  throw unsupported
}
