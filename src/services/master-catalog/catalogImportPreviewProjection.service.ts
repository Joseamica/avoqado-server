import { createHmac, timingSafeEqual } from 'node:crypto'
import AppError from '../../errors/AppError'
import {
  projectCatalogImportPreviewCanonicalLocalSkuProofV1,
  projectCatalogImportPreviewCorporateSkuProofV1,
  projectCatalogImportPreviewReferenceProofV1,
} from './catalogImportPreviewReferenceProjection.service'
import {
  catalogImportProjectedBindingSemanticsValid,
  catalogImportProjectedBusinessTypeValid,
  catalogImportProjectedItemDetailSemanticsValid,
  catalogImportProjectedItemIdentityValid,
  catalogImportProjectedItemSemanticsValid,
  catalogImportProjectedValueSemanticsValid,
} from './catalogImportReadValidation.service'

// WHY: Preview endpoints use one small fixed envelope regardless of a 20k-row
// sheet; callers opt into subsequent pages explicitly.
export const CATALOG_IMPORT_PREVIEW_DEFAULT_PAGE_SIZE = 25 as const
export const CATALOG_IMPORT_PREVIEW_MAX_PAGE_SIZE = 50 as const
export const CATALOG_IMPORT_PREVIEW_CURSOR_MAX_BYTES = 2_048 as const

export type CatalogImportPreviewSection =
  | 'ITEMS'
  | 'ORGANIZATION_VALUES'
  | 'BUSINESS_TYPES'
  | 'REFERENCE_PROPOSALS'
  | 'VENUE_BINDING_REQUESTS'
  | 'ERRORS'

export interface CatalogImportPreviewCursorPositionV1 {
  sourceSheet: string
  sourceRow: number
  ordinal: number
}

export interface CatalogImportPreviewCursorV1 extends CatalogImportPreviewCursorPositionV1 {
  schemaVersion: 1
  batchId: string
  section: CatalogImportPreviewSection
  targetHash: string
}

export interface CatalogImportPreviewProjectedRowV1 extends CatalogImportPreviewCursorPositionV1 {
  section: CatalogImportPreviewSection
  status: string | null
  truncatedFields: string[]
  [key: string]: string | number | null | string[]
}

export interface CatalogImportPreviewItemDetailV1 extends CatalogImportPreviewCursorPositionV1 {
  status: string
  operation: string | null
  catalogItemId: string | null
  corporateSku: string | null
  itemKind: string | null
  name: string | null
  description: string | null
  imageUrl: string | null
  brandId: string | null
  manufacturerId: string | null
  familyId: string | null
  presentationLabel: string | null
  unit: string | null
  productType: string | null
  taxRate: string | null
  satProductKey: string | null
  satUnitKey: string | null
  objetoImp: string | null
  iepsMode: string | null
  iepsRate: string | null
  iepsQuota: string | null
  iepsQuotaUnit: string | null
  counts: {
    organizationValues: number
    businessTypes: number
    referenceProposals: number
    venueBindingRequests: number
    errors: number
  }
  truncatedFields: string[]
}

interface CursorExpectation {
  batchId: string
  section: CatalogImportPreviewSection
  targetHash: string
}

const SHA256_HEX = /^[a-f0-9]{64}$/u
const BASE64URL = /^[A-Za-z0-9_-]+$/u
const SECTIONS = new Set<CatalogImportPreviewSection>([
  'ITEMS',
  'ORGANIZATION_VALUES',
  'BUSINESS_TYPES',
  'REFERENCE_PROPOSALS',
  'VENUE_BINDING_REQUESTS',
  'ERRORS',
])
const SOURCE_SHEETS = new Set(['Metadata', 'Items', 'OrganizationValues', 'BusinessTypes', 'VenueBindingRequests'])
const POSTGRES_INT_MAX = 2_147_483_647

function failData(message = 'El preview durable contiene datos inválidos.'): never {
  throw new AppError(message, 409, true, 'CATALOG_IMPORT_PREVIEW_DATA_INVALID')
}

function failCursor(): never {
  throw new AppError('El cursor del preview no es válido.', 400, true, 'CATALOG_IMPORT_CURSOR_INVALID')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 256
}

function sourceSheetMatchesSection(section: CatalogImportPreviewSection, sourceSheet: string): boolean {
  // WHY: Organization-value UPSERTs retain their workbook coordinate, while
  // synthesized UPDATE tombstones are reviewable at their hash-bound Items row.
  if (section === 'ORGANIZATION_VALUES') return sourceSheet === 'OrganizationValues' || sourceSheet === 'Items'
  if (section === 'BUSINESS_TYPES') return sourceSheet === 'BusinessTypes'
  if (section === 'VENUE_BINDING_REQUESTS') return sourceSheet === 'VenueBindingRequests'
  if (section === 'ERRORS') return true
  return sourceSheet === 'Items'
}

function readPosition(
  row: Record<string, unknown>,
  section?: CatalogImportPreviewSection,
  cursorPosition = false,
): CatalogImportPreviewCursorPositionV1 {
  const sourceSheet = cursorPosition ? (row.cursorSourceSheet ?? row.sourceSheet) : row.sourceSheet
  const rawSourceRow = cursorPosition ? (row.cursorSourceRow ?? row.sourceRow) : row.sourceRow
  const sourceRow = typeof rawSourceRow === 'string' && /^[1-9][0-9]{0,9}$/u.test(rawSourceRow) ? Number(rawSourceRow) : rawSourceRow
  const rawOrdinal = row.ordinal
  const ordinal = typeof rawOrdinal === 'bigint' && rawOrdinal <= BigInt(POSTGRES_INT_MAX) ? Number(rawOrdinal) : rawOrdinal
  if (
    typeof sourceSheet !== 'string' ||
    !SOURCE_SHEETS.has(sourceSheet) ||
    !Number.isInteger(sourceRow) ||
    (sourceRow as number) < 1 ||
    (sourceRow as number) > POSTGRES_INT_MAX ||
    !Number.isInteger(ordinal) ||
    (ordinal as number) < 0 ||
    (ordinal as number) > POSTGRES_INT_MAX ||
    (section !== undefined && !sourceSheetMatchesSection(section, sourceSheet))
  ) {
    return failData()
  }
  return { sourceSheet, sourceRow: sourceRow as number, ordinal: ordinal as number }
}

function readCount(value: unknown): number {
  const normalized = typeof value === 'bigint' && value <= BigInt(50_000) ? Number(value) : value
  if (!Number.isInteger(normalized) || (normalized as number) < 0 || (normalized as number) > 50_000) return failData()
  return normalized as number
}

function readNullableInt(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const normalized = typeof value === 'string' && /^[1-9][0-9]{0,9}$/u.test(value) ? Number(value) : value
  if (!Number.isInteger(normalized) || (normalized as number) < 1 || (normalized as number) > POSTGRES_INT_MAX) return failData()
  return normalized as number
}

function excerpt(row: Record<string, unknown>, field: string, truncatedFields: string[], maximum = 256): string | null {
  const value = row[field]
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') return failData()
  const codePoints = Array.from(value)
  if (codePoints.length <= maximum) return value
  // WHY: JavaScript slice counts UTF-16 units and can emit a lone surrogate;
  // display excerpts are bounded by complete Unicode code points instead.
  truncatedFields.push(field)
  return codePoints.slice(0, maximum).join('')
}

function common(row: Record<string, unknown>, section: CatalogImportPreviewSection) {
  // WHY: The batch-wide integrity preflight and this per-row flag are both
  // required so no malformed durable JSON can be rendered as an empty DTO.
  if (row.durableShapeValid !== true) return failData()
  const position = readPosition(row, section)
  const truncatedFields: string[] = []
  const status = excerpt(row, 'status', truncatedFields, 32)
  if (status !== 'READY' && status !== 'INVALID' && status !== 'APPLIED') return failData()
  return { position, truncatedFields, status }
}

function readCorporateSkuProof(row: Record<string, unknown>, canonical: boolean, truncatedFields: string[]): string | null {
  const proof = row.proofCorporateSku
  if (proof === null || proof === undefined) return null
  const projected = projectCatalogImportPreviewCorporateSkuProofV1(proof, canonical)
  if (projected === null) return failData()
  if (projected.truncated) truncatedFields.push('corporateSku')
  return projected.corporateSku
}

export function normalizeCatalogImportPreviewPageSize(value: unknown): number {
  const pageSize = value ?? CATALOG_IMPORT_PREVIEW_DEFAULT_PAGE_SIZE
  if (!Number.isInteger(pageSize) || (pageSize as number) < 1 || (pageSize as number) > CATALOG_IMPORT_PREVIEW_MAX_PAGE_SIZE) {
    throw new AppError('pageSize debe estar entre 1 y 50.', 422, true, 'CATALOG_IMPORT_PAGE_SIZE_INVALID')
  }
  return pageSize as number
}

function validateCursorPayload(value: unknown): CatalogImportPreviewCursorV1 {
  if (!isRecord(value) || !exactKeys(value, ['schemaVersion', 'batchId', 'section', 'targetHash', 'sourceSheet', 'sourceRow', 'ordinal'])) {
    return failCursor()
  }
  if (
    value.schemaVersion !== 1 ||
    !validId(value.batchId) ||
    typeof value.section !== 'string' ||
    !SECTIONS.has(value.section as CatalogImportPreviewSection) ||
    typeof value.targetHash !== 'string' ||
    !SHA256_HEX.test(value.targetHash)
  ) {
    return failCursor()
  }
  let position: CatalogImportPreviewCursorPositionV1
  try {
    position = readPosition(value, value.section as CatalogImportPreviewSection)
  } catch {
    return failCursor()
  }
  return {
    schemaVersion: 1,
    batchId: value.batchId,
    section: value.section as CatalogImportPreviewSection,
    targetHash: value.targetHash,
    ...position,
  }
}

function signingKeyBytes(signingKey: string): Buffer {
  if (!SHA256_HEX.test(signingKey)) return failCursor()
  return Buffer.from(signingKey, 'hex')
}

export function encodeCatalogImportPreviewCursorV1(payload: CatalogImportPreviewCursorV1, signingKey: string): string {
  const validated = validateCursorPayload(payload)
  const encoded = Buffer.from(JSON.stringify(validated), 'utf8').toString('base64url')
  const signature = createHmac('sha256', signingKeyBytes(signingKey)).update(encoded, 'ascii').digest('hex')
  return `${encoded}.${signature}`
}

export function decodeCatalogImportPreviewCursorV1(
  cursor: string,
  expected: CursorExpectation,
  signingKey: string,
): CatalogImportPreviewCursorPositionV1 {
  if (typeof cursor !== 'string' || cursor.length < 1 || cursor.length > CATALOG_IMPORT_PREVIEW_CURSOR_MAX_BYTES) return failCursor()
  const pieces = cursor.split('.')
  if (pieces.length !== 2 || !BASE64URL.test(pieces[0] ?? '') || !SHA256_HEX.test(pieces[1] ?? '')) return failCursor()
  const [encoded, suppliedHex] = pieces as [string, string]
  if (Buffer.from(encoded, 'base64url').toString('base64url') !== encoded) return failCursor()
  const expectedSignature = createHmac('sha256', signingKeyBytes(signingKey)).update(encoded, 'ascii').digest()
  if (!timingSafeEqual(Buffer.from(suppliedHex, 'hex'), expectedSignature)) return failCursor()
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  } catch {
    return failCursor()
  }
  const payload = validateCursorPayload(parsed)
  if (payload.batchId !== expected.batchId || payload.section !== expected.section || payload.targetHash !== expected.targetHash) {
    return failCursor()
  }
  return { sourceSheet: payload.sourceSheet, sourceRow: payload.sourceRow, ordinal: payload.ordinal }
}

export function catalogImportPreviewPositionV1(
  row: Record<string, unknown>,
  section: CatalogImportPreviewSection,
): CatalogImportPreviewCursorPositionV1 {
  // WHY: Error display coordinates come from the closed finding, while the
  // cursor follows its durable line+ordinal key and never trusts display text.
  return readPosition(row, section, true)
}

export function projectCatalogImportPreviewRowV1(
  section: CatalogImportPreviewSection,
  row: Record<string, unknown>,
): CatalogImportPreviewProjectedRowV1 {
  const { position, truncatedFields, status } = common(row, section)
  const text = (field: string, maximum?: number) => excerpt(row, field, truncatedFields, maximum)
  const base = { section, ...position, status, truncatedFields }
  if (section === 'ITEMS') {
    const operation = text('operation', 16)
    const itemKind = text('itemKind', 64)
    const catalogItemId = text('catalogItemId')
    const corporateSku = readCorporateSkuProof(row, false, truncatedFields)
    const name = text('name')
    // WHY: Minimal INVALID lines may omit command leaves; every present or
    // confirmable operation/kind remains a closed catalog enum.
    if (!catalogImportProjectedItemIdentityValid({ status, operation, catalogItemId, corporateSku, name, itemKind })) return failData()
    return {
      ...base,
      operation,
      catalogItemId,
      corporateSku,
      name,
      itemKind,
      organizationValueCount: readCount(row.organizationValueCount),
      businessTypeCount: readCount(row.businessTypeCount),
      referenceProposalCount: readCount(row.referenceProposalCount),
      venueBindingRequestCount: readCount(row.venueBindingRequestCount),
      errorCount: readCount(row.errorCount),
    }
  }
  if (section === 'ORGANIZATION_VALUES') {
    const action = text('action', 16)
    const corporateSku = readCorporateSkuProof(row, action === 'UPSERT', truncatedFields)
    const kind = text('kind', 64)
    const currency = text('currency', 16)
    const amount = text('amount', 64)
    const expectedRuleRevision = readNullableInt(row.expectedRuleRevision)
    // WHY: The dual-source section is closed by action as well as sheet;
    // this prevents a tampered row from disguising one mutation as the other.
    if (
      (position.sourceSheet === 'Items' && action !== 'DEACTIVATE') ||
      (position.sourceSheet === 'OrganizationValues' && action !== 'UPSERT') ||
      !catalogImportProjectedValueSemanticsValid(kind, currency, amount) ||
      (status !== 'INVALID' && (corporateSku === null || kind === null || currency === null)) ||
      (action === 'UPSERT' && status !== 'INVALID' && amount === null) ||
      (action === 'DEACTIVATE' && (amount !== null || expectedRuleRevision === null))
    )
      return failData()
    return {
      ...base,
      action,
      corporateSku,
      kind,
      currency,
      amount,
      expectedRuleRevision,
    }
  }
  if (section === 'BUSINESS_TYPES') {
    const corporateSku = readCorporateSkuProof(row, true, truncatedFields)
    const businessType = text('businessType', 64)
    if (
      !catalogImportProjectedBusinessTypeValid(businessType) ||
      (status !== 'INVALID' && (corporateSku === null || businessType === null))
    )
      return failData()
    return { ...base, corporateSku, businessType }
  }
  if (section === 'REFERENCE_PROPOSALS') {
    const reference = projectCatalogImportPreviewReferenceProofV1(row)
    if (reference === null) return failData()
    truncatedFields.push(...reference.truncatedFields)
    return {
      ...base,
      operation: reference.operation,
      referenceType: reference.referenceType,
      name: reference.name,
      parentId: reference.parentId,
    }
  }
  if (section === 'VENUE_BINDING_REQUESTS') {
    const corporateSku = readCorporateSkuProof(row, true, truncatedFields)
    const venueId = text('venueId')
    const requestedAction = text('requestedAction', 16)
    const productId = text('productId')
    const localSkuProof = row.proofLocalSku
    const localSku =
      localSkuProof === null || localSkuProof === undefined ? null : projectCatalogImportPreviewCanonicalLocalSkuProofV1(localSkuProof)
    if (localSkuProof !== null && localSkuProof !== undefined && localSku === null) return failData()
    const categoryId = text('categoryId')
    const initialPrice = text('initialPrice', 64)
    const currency = text('currency', 16)
    const bindingValid = catalogImportProjectedBindingSemanticsValid({
      action: requestedAction,
      productId,
      localSku,
      categoryId,
      price: initialPrice,
      currency,
    })
    if (
      !catalogImportProjectedValueSemanticsValid(null, currency, initialPrice) ||
      (status !== 'INVALID' && (corporateSku === null || venueId === null || !bindingValid)) ||
      (status === 'INVALID' && requestedAction !== null && !['LINK', 'CREATE', 'SKIP'].includes(requestedAction))
    )
      return failData()
    return {
      ...base,
      corporateSku,
      venueId,
      requestedAction,
      productId,
      localSku,
      categoryId,
      initialPrice,
      currency,
    }
  }
  if (status !== 'INVALID') return failData()
  return {
    ...base,
    column: text('column', 128),
    errorCode: text('errorCode', 128),
    message: text('message', 512),
    rejectedValue: text('rejectedValue'),
    suggestion: text('suggestion', 512),
  }
}

export function projectCatalogImportPreviewItemDetailV1(row: Record<string, unknown>): CatalogImportPreviewItemDetailV1 {
  // WHY: Detail is a separate query boundary and must consume the same closed
  // SQL shape proof as list rows before accepting scalar excerpts or counts.
  if (row.durableShapeValid !== true) return failData()
  const position = readPosition(row, 'ITEMS')
  const truncatedFields: string[] = []
  const text = (field: string, maximum?: number) => excerpt(row, field, truncatedFields, maximum)
  const status = text('status', 32)
  const operation = text('operation', 16)
  const itemKind = text('itemKind', 64)
  const corporateSku = readCorporateSkuProof(row, false, truncatedFields)
  const projected = {
    status: status ?? '',
    operation,
    catalogItemId: text('catalogItemId'),
    corporateSku,
    itemKind,
    name: text('name'),
    description: text('description', 512),
    imageUrl: text('imageUrl'),
    brandId: text('brandId'),
    manufacturerId: text('manufacturerId'),
    familyId: text('familyId'),
    presentationLabel: text('presentationLabel'),
    unit: text('unit', 64),
    productType: text('productType', 64),
    taxRate: text('taxRate', 64),
    satProductKey: text('satProductKey', 64),
    satUnitKey: text('satUnitKey', 64),
    objetoImp: text('objetoImp', 64),
    iepsMode: text('iepsMode', 64),
    iepsRate: text('iepsRate', 64),
    iepsQuota: text('iepsQuota', 64),
    iepsQuotaUnit: text('iepsQuotaUnit', 64),
  }
  if (
    status === null ||
    !['READY', 'INVALID', 'APPLIED'].includes(status) ||
    !catalogImportProjectedItemSemanticsValid(status, operation, itemKind) ||
    !catalogImportProjectedItemDetailSemanticsValid(projected)
  )
    return failData()
  // WHY: Item detail is scalar-only. Nested collections are navigated through
  // their own pages, while exact bounded counts tell the UI what remains.
  return {
    ...position,
    ...projected,
    status,
    counts: {
      organizationValues: readCount(row.organizationValueCount),
      businessTypes: readCount(row.businessTypeCount),
      referenceProposals: readCount(row.referenceProposalCount),
      venueBindingRequests: readCount(row.venueBindingRequestCount),
      errors: readCount(row.errorCount),
    },
    truncatedFields,
  }
}
