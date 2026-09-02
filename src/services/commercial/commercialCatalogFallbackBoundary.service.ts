import { types as utilTypes } from 'node:util'
import { COMMERCIAL_V2_DOMAINS } from '@/contracts/commercial/commercialContractV2.constants'
import { hashCanonicalJsonV2 } from './commercialCanonicalJsonV2.service'
import { materializeArtifactSnapshot, toValidIso, verifyArtifactChecksum } from './commercialArtifactCodecBoundary.service'
import { failCommercialArtifactCodec } from './commercialArtifactCodecErrors.service'
import type { CommercialCatalogDecodeInput, CommercialCatalogPersistedRow, CommercialCatalogResolutionInput } from '@/types/commercialCodec'

export const COMMERCIAL_CATALOG_FALLBACK_PROVENANCE_INVALID = 'COMMERCIAL_CATALOG_FALLBACK_PROVENANCE_INVALID' as const

const ARRAY_CONSTRUCTOR = Array
const ARRAY_IS_ARRAY = Array.isArray
const IS_PROXY = utilTypes.isProxy
const NUMBER_CONSTRUCTOR = Number
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger
const OBJECT_CONSTRUCTOR = Object
const OBJECT_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf
const OBJECT_PROTOTYPE = Object.prototype
const REFLECT_APPLY = Reflect.apply

export class CommercialCatalogFallbackError extends Error {
  readonly code: typeof COMMERCIAL_CATALOG_FALLBACK_PROVENANCE_INVALID

  constructor(code: typeof COMMERCIAL_CATALOG_FALLBACK_PROVENANCE_INVALID) {
    super('Commercial catalog fallback provenance is invalid.')
    this.name = 'CommercialCatalogFallbackError'
    this.code = code
  }
}

export function failCatalogFallbackProvenance(): never {
  throw new CommercialCatalogFallbackError(COMMERCIAL_CATALOG_FALLBACK_PROVENANCE_INVALID)
}

function ownData(value: object, key: string): unknown {
  try {
    const descriptor = REFLECT_APPLY(OBJECT_GET_OWN_PROPERTY_DESCRIPTOR, OBJECT_CONSTRUCTOR, [value, key])
    return descriptor?.enumerable === true && 'value' in descriptor ? descriptor.value : undefined
  } catch {
    return undefined
  }
}

function isPlainFallbackRecord(value: unknown): value is Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    REFLECT_APPLY(IS_PROXY, utilTypes, [value]) ||
    REFLECT_APPLY(ARRAY_IS_ARRAY, ARRAY_CONSTRUCTOR, [value])
  ) {
    return false
  }
  try {
    const prototype = REFLECT_APPLY(OBJECT_GET_PROTOTYPE_OF, OBJECT_CONSTRUCTOR, [value])
    return prototype === OBJECT_PROTOTYPE || prototype === null
  } catch {
    return false
  }
}

function pointerData(value: unknown): CommercialCatalogResolutionInput['activePointer'] {
  if (!isPlainFallbackRecord(value)) return failCatalogFallbackProvenance()
  const environment = ownData(value, 'environment')
  const publicationId = ownData(value, 'publicationId')
  const revision = ownData(value, 'revision')
  if (
    (environment !== 'PRODUCTION' && environment !== 'PREVIEW') ||
    typeof publicationId !== 'string' ||
    publicationId.length === 0 ||
    !REFLECT_APPLY(NUMBER_IS_SAFE_INTEGER, NUMBER_CONSTRUCTOR, [revision]) ||
    (revision as number) <= 0
  ) {
    return failCatalogFallbackProvenance()
  }
  return { environment, publicationId, revision: revision as number }
}

export function captureCatalogResolutionCore(input: unknown): {
  envelope: Record<string, unknown>
  activePointer: CommercialCatalogResolutionInput['activePointer']
  activePublication: CommercialCatalogPersistedRow
} {
  if (!isPlainFallbackRecord(input)) return failCatalogFallbackProvenance()
  const activePointer = pointerData(ownData(input, 'activePointer'))
  const activePublicationValue = ownData(input, 'activePublication')
  if (!isPlainFallbackRecord(activePublicationValue)) return failCatalogFallbackProvenance()
  const id = ownData(activePublicationValue, 'id')
  if (typeof id !== 'string' || id.length === 0 || id !== activePointer.publicationId) {
    return failCatalogFallbackProvenance()
  }
  return {
    envelope: input,
    activePointer,
    activePublication: activePublicationValue as unknown as CommercialCatalogPersistedRow,
  }
}

export function catalogDecodeInput(row: CommercialCatalogPersistedRow): CommercialCatalogDecodeInput {
  const value = row as unknown as object
  const schemaVersion = ownData(value, 'schemaVersion')
  return {
    kind: 'CATALOG',
    rowSchemaVersion: schemaVersion as number,
    snapshot: ownData(value, 'snapshot'),
    checksum: ownData(value, 'checksum'),
    rowContext: {
      kind: 'CATALOG',
      id: ownData(value, 'id') as string,
      schemaVersion: schemaVersion as number,
      publishedAt: ownData(value, 'publishedAt') as Date,
    },
  }
}

function requiredFutureData(value: object, key: string): unknown {
  const descriptor = REFLECT_APPLY(OBJECT_GET_OWN_PROPERTY_DESCRIPTOR, OBJECT_CONSTRUCTOR, [value, key])
  if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
    failCommercialArtifactCodec('COMMERCIAL_CATALOG_SHAPE_INVALID')
  }
  return descriptor.value
}

function assertFixedMarket(value: unknown): void {
  if (!isPlainFallbackRecord(value)) failCommercialArtifactCodec('COMMERCIAL_CATALOG_IDENTITY_MISMATCH')
  if (
    requiredFutureData(value, 'country') !== 'MX' ||
    requiredFutureData(value, 'currency') !== 'MXN' ||
    requiredFutureData(value, 'timezone') !== 'America/Mexico_City' ||
    requiredFutureData(value, 'taxLabel') !== 'IVA' ||
    requiredFutureData(value, 'taxRateBasisPoints') !== 1600
  ) {
    failCommercialArtifactCodec('COMMERCIAL_CATALOG_IDENTITY_MISMATCH')
  }
}

export function verifyFutureCatalogRow(row: CommercialCatalogPersistedRow): Readonly<Record<string, unknown>> {
  const decodeInput = catalogDecodeInput(row)
  if (decodeInput.rowSchemaVersion !== 2) failCommercialArtifactCodec('COMMERCIAL_CATALOG_SCHEMA_UNSUPPORTED')
  const snapshot = materializeArtifactSnapshot<Record<string, unknown>>('CATALOG', 2, decodeInput.snapshot)
  if (!isPlainFallbackRecord(snapshot)) failCommercialArtifactCodec('COMMERCIAL_CATALOG_SHAPE_INVALID')
  const schemaVersion = requiredFutureData(snapshot, 'schemaVersion')
  const contractVersion = requiredFutureData(snapshot, 'contractVersion')
  const publicationId = requiredFutureData(snapshot, 'publicationId')
  const publishedAt = requiredFutureData(snapshot, 'publishedAt')
  const market = requiredFutureData(snapshot, 'market')
  if (schemaVersion !== 2) failCommercialArtifactCodec('COMMERCIAL_CATALOG_IDENTITY_MISMATCH')
  if (typeof contractVersion !== 'string' || contractVersion.length === 0) {
    failCommercialArtifactCodec('COMMERCIAL_CATALOG_SHAPE_INVALID')
  }
  if (contractVersion === '2.0.0') failCommercialArtifactCodec('COMMERCIAL_CATALOG_CONTRACT_UNSUPPORTED')
  if (typeof publicationId !== 'string' || typeof publishedAt !== 'string') {
    failCommercialArtifactCodec('COMMERCIAL_CATALOG_SHAPE_INVALID')
  }
  assertFixedMarket(market)
  const expectedChecksum = hashCanonicalJsonV2(COMMERCIAL_V2_DOMAINS.CATALOG_SNAPSHOT, snapshot)
  verifyArtifactChecksum('CATALOG', decodeInput.checksum, expectedChecksum)
  if (
    publicationId !== decodeInput.rowContext.id ||
    decodeInput.rowContext.schemaVersion !== 2 ||
    toValidIso(decodeInput.rowContext.publishedAt) !== publishedAt
  ) {
    failCommercialArtifactCodec('COMMERCIAL_CATALOG_IDENTITY_MISMATCH')
  }
  return snapshot
}

export function captureActivationEventsValue(envelope: Record<string, unknown>): unknown {
  return ownData(envelope, 'activationEvents')
}
