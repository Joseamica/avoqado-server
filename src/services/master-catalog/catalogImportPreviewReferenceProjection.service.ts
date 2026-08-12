import { createHash } from 'node:crypto'
import { catalogImportProposalMarkerV1 } from './catalogImportStagedPayload.service'
import {
  CATALOG_INDEXED_TEXT_MAX_SCALARS_V1,
  CATALOG_INDEXED_TEXT_MAX_UTF8_BYTES_V1,
  CATALOG_WORKBOOK_TEXT_MAX_SCALARS_V1,
  isCatalogIndexedTextV1,
  isCatalogWorkbookTextV1,
  normalizeCatalogCorporateSkuV1,
  normalizeCatalogVenueLocalSkuV1,
} from './identifierNormalization.service'

export const CATALOG_IMPORT_REFERENCE_RAW_NAME_MAX_SCALARS_V1 = CATALOG_WORKBOOK_TEXT_MAX_SCALARS_V1
export const CATALOG_IMPORT_REFERENCE_NAME_PROOF_MAX_SCALARS_V1 = CATALOG_WORKBOOK_TEXT_MAX_SCALARS_V1 + 1

const FAMILY_PREFIX = '@proposal:FAMILY:'
const PARENT_SEPARATOR = ':PARENT:'
const ROOT_IDENTITY = 'ROOT'

// WHY: A FAMILY child can bind only to a live bounded ID or a root FAMILY
// marker. The root marker is the larger case, so it freezes the SQL proof cap.
export const CATALOG_IMPORT_REFERENCE_PARENT_MAX_SCALARS_V1 =
  FAMILY_PREFIX.length + CATALOG_INDEXED_TEXT_MAX_SCALARS_V1 + PARENT_SEPARATOR.length + ROOT_IDENTITY.length
export const CATALOG_IMPORT_REFERENCE_PARENT_MAX_UTF8_BYTES_V1 =
  Buffer.byteLength(FAMILY_PREFIX, 'utf8') +
  CATALOG_INDEXED_TEXT_MAX_UTF8_BYTES_V1 +
  Buffer.byteLength(PARENT_SEPARATOR, 'utf8') +
  Buffer.byteLength(ROOT_IDENTITY, 'utf8')

// WHY: A child marker contains one normalized child key and, at most, the
// longest root marker above. These exact derived caps keep hostile JSON out of
// the read DTO without inventing a second normalization limit.
export const CATALOG_IMPORT_REFERENCE_MARKER_MAX_SCALARS_V1 =
  FAMILY_PREFIX.length + CATALOG_INDEXED_TEXT_MAX_SCALARS_V1 + PARENT_SEPARATOR.length + CATALOG_IMPORT_REFERENCE_PARENT_MAX_SCALARS_V1
export const CATALOG_IMPORT_REFERENCE_MARKER_MAX_UTF8_BYTES_V1 =
  Buffer.byteLength(FAMILY_PREFIX, 'utf8') +
  CATALOG_INDEXED_TEXT_MAX_UTF8_BYTES_V1 +
  Buffer.byteLength(PARENT_SEPARATOR, 'utf8') +
  CATALOG_IMPORT_REFERENCE_PARENT_MAX_UTF8_BYTES_V1

const SHA256_HEX = /^[0-9a-f]{64}$/u
const REFERENCE_TYPES = new Set(['BRAND', 'MANUFACTURER', 'FAMILY'])

export interface CatalogImportPreviewReferenceProjectionV1 {
  operation: 'CREATE'
  referenceType: 'BRAND' | 'MANUFACTURER' | 'FAMILY'
  name: string
  parentId: string | null
  truncatedFields: string[]
}

export interface CatalogImportPreviewCorporateSkuProjectionV1 {
  corporateSku: string
  truncated: boolean
}

export function projectCatalogImportPreviewCanonicalLocalSkuProofV1(proofLocalSku: unknown): string | null {
  if (typeof proofLocalSku !== 'string' || !isCatalogIndexedTextV1(proofLocalSku)) return null
  try {
    const normalized = normalizeCatalogVenueLocalSkuV1({ code: proofLocalSku, format: 'SKU' })
    // WHY: Binding review staging stores its canonical local join key. The read
    // DTO must reject case/space drift instead of canonizing corrupted staging.
    return normalized.normalizedCode === proofLocalSku ? proofLocalSku : null
  } catch {
    return null
  }
}

function boundedUnicode(value: string, maximumScalars: number, maximumBytes: number): boolean {
  let scalars = 0
  for (const scalar of value) {
    const codePoint = scalar.codePointAt(0) as number
    if (codePoint === 0 || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return false
    scalars += 1
    if (scalars > maximumScalars) return false
  }
  return Buffer.byteLength(value, 'utf8') <= maximumBytes
}

function validParentIdentity(referenceType: string, parentId: unknown, parentName: unknown): parentId is string | null {
  if (referenceType !== 'FAMILY') return parentId === null && parentName === null
  if (parentId === null) return parentName === null
  if (typeof parentId !== 'string' || parentId.trim().length === 0) return false
  if (parentId.startsWith('@proposal:')) {
    if (
      typeof parentName !== 'string' ||
      !isCatalogWorkbookTextV1(parentName) ||
      !boundedUnicode(parentId, CATALOG_IMPORT_REFERENCE_PARENT_MAX_SCALARS_V1, CATALOG_IMPORT_REFERENCE_PARENT_MAX_UTF8_BYTES_V1)
    ) {
      return false
    }
    try {
      // WHY: A marker parent must identify an actual root FAMILY sibling. SQL
      // proves existence; this shared normalizer proof closes its raw name/key.
      return (
        catalogImportProposalMarkerV1({ operation: 'CREATE', referenceType: 'FAMILY', name: parentName, parentId: null } as never) ===
        parentId
      )
    } catch {
      return false
    }
  }
  // WHY: Non-marker parents are durable database IDs and share the closed ID
  // envelope used by the staged parser; marker parents use the derived cap.
  return parentName === null && parentId.length <= 256 && boundedUnicode(parentId, 256, CATALOG_INDEXED_TEXT_MAX_UTF8_BYTES_V1)
}

function excerpt(value: string, field: string, truncatedFields: string[], canonicalIdentity?: string): string {
  const scalars = Array.from(value)
  if (scalars.length <= CATALOG_INDEXED_TEXT_MAX_SCALARS_V1) return value
  truncatedFields.push(field)
  if (canonicalIdentity !== undefined) return canonicalIdentity
  // WHY: Truncated workbook text uses its bounded canonical identity so padding
  // cannot hide the meaningful key; marker IDs fall back to balanced ends.
  const head = CATALOG_INDEXED_TEXT_MAX_SCALARS_V1 / 2
  return `${scalars.slice(0, head).join('')}${scalars.slice(-head).join('')}`
}

export function projectCatalogImportPreviewCorporateSkuProofV1(
  proofCorporateSku: unknown,
  canonical: boolean,
): CatalogImportPreviewCorporateSkuProjectionV1 | null {
  if (typeof proofCorporateSku !== 'string' || proofCorporateSku.trim().length === 0 || !isCatalogWorkbookTextV1(proofCorporateSku)) {
    return null
  }
  let normalizedCode: string
  try {
    normalizedCode = normalizeCatalogCorporateSkuV1({ code: proofCorporateSku, format: 'SKU' }).normalizedCode
  } catch {
    return null
  }
  // WHY: Ancillary review lines are staged with the normalized join key, while
  // Items/deactivations intentionally preserve the raw display SKU.
  if (canonical && normalizedCode !== proofCorporateSku) return null
  const truncatedFields: string[] = []
  return {
    corporateSku: excerpt(proofCorporateSku, 'corporateSku', truncatedFields, normalizedCode),
    truncated: truncatedFields.length > 0,
  }
}

export function projectCatalogImportPreviewReferenceProofV1(
  row: Record<string, unknown>,
): CatalogImportPreviewReferenceProjectionV1 | null {
  const { operation, referenceType, proofName, proofParentId, proofParentName, proofMarkerBaseHash, proofParentBindingValid } = row
  if (
    operation !== 'CREATE' ||
    typeof referenceType !== 'string' ||
    !REFERENCE_TYPES.has(referenceType) ||
    typeof proofName !== 'string' ||
    proofName.trim().length === 0 ||
    !isCatalogWorkbookTextV1(proofName) ||
    proofParentBindingValid !== true ||
    !validParentIdentity(referenceType, proofParentId, proofParentName) ||
    typeof proofMarkerBaseHash !== 'string' ||
    !SHA256_HEX.test(proofMarkerBaseHash)
  ) {
    return null
  }

  let expectedMarker: string
  try {
    expectedMarker = catalogImportProposalMarkerV1({
      operation,
      referenceType,
      name: proofName,
      parentId: proofParentId,
    } as never)
  } catch {
    return null
  }
  const suffix = referenceType === 'FAMILY' ? `${PARENT_SEPARATOR}${proofParentId ?? ROOT_IDENTITY}` : ''
  const expectedBase = suffix ? expectedMarker.slice(0, -suffix.length) : expectedMarker
  const markerPrefix = `@proposal:${referenceType}:`
  if (!expectedBase.startsWith(markerPrefix)) return null
  const normalizedName = expectedBase.slice(markerPrefix.length)
  const expectedHash = createHash('sha256').update(expectedBase, 'utf8').digest('hex')
  if (proofMarkerBaseHash !== expectedHash) return null

  const truncatedFields: string[] = []
  return {
    operation,
    referenceType: referenceType as CatalogImportPreviewReferenceProjectionV1['referenceType'],
    name: excerpt(proofName, 'name', truncatedFields, normalizedName),
    parentId: proofParentId === null ? null : excerpt(proofParentId, 'parentId', truncatedFields),
    truncatedFields,
  }
}
