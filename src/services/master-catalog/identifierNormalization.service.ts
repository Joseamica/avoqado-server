export type H1aIdentifierFormat = 'SKU'

export interface NormalizeIdentifierV1Input {
  code: string
  format: H1aIdentifierFormat
}

export interface NormalizedIdentifierV1 {
  code: string
  normalizedCode: string
  normalizationVersion: 1
}

export const CATALOG_INDEXED_TEXT_MAX_SCALARS_V1 = 256
export const CATALOG_INDEXED_TEXT_MAX_UTF8_BYTES_V1 = 1_024
export const CATALOG_WORKBOOK_TEXT_MAX_SCALARS_V1 = 4_096
export const CATALOG_WORKBOOK_TEXT_MAX_UTF8_BYTES_V1 = 16_384

function isCatalogUnicodeTextWithinV1(value: string, maximumScalars: number, maximumBytes: number): boolean {
  let scalars = 0
  for (const scalar of value) {
    const codePoint = scalar.codePointAt(0) as number
    // WHY: PostgreSQL text never accepts NUL, and the human review contract
    // accepts Unicode scalars rather than lone UTF-16 surrogate replacements.
    if (codePoint === 0 || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return false
    scalars += 1
    if (scalars > maximumScalars) return false
  }
  return Buffer.byteLength(value, 'utf8') <= maximumBytes
}

export function isCatalogUnicodeScalarTextV1(value: string, maximumScalars: number): boolean {
  return isCatalogUnicodeTextWithinV1(value, maximumScalars, maximumScalars * 4)
}

export function isCatalogIndexedTextV1(value: string): boolean {
  return isCatalogUnicodeTextWithinV1(value, CATALOG_INDEXED_TEXT_MAX_SCALARS_V1, CATALOG_INDEXED_TEXT_MAX_UTF8_BYTES_V1)
}

export function isCatalogWorkbookTextV1(value: string): boolean {
  // WHY: Worker, durable JSON, and read proofs all count Unicode scalars. JS
  // UTF-16 length would reject legal astral text after a successful preview.
  return isCatalogUnicodeTextWithinV1(value, CATALOG_WORKBOOK_TEXT_MAX_SCALARS_V1, CATALOG_WORKBOOK_TEXT_MAX_UTF8_BYTES_V1)
}

/**
 * WHY: Normalization-v1 stays byte-compatible for every SKU consumer. The
 * persisted corporate/venue wrappers add limits without changing the generic transform.
 */
export function normalizeIdentifierV1(input: NormalizeIdentifierV1Input): NormalizedIdentifierV1 {
  if (input.format !== 'SKU') throw new Error('CATALOG_IDENTIFIER_FORMAT_UNSUPPORTED')
  if (typeof input.code !== 'string') throw new Error('CATALOG_IDENTIFIER_INVALID')

  const normalizedCode = input.code.normalize('NFKC').trim().toUpperCase()
  if (normalizedCode.length === 0) throw new Error('CATALOG_IDENTIFIER_INVALID')

  return {
    code: input.code,
    normalizedCode,
    normalizationVersion: 1,
  }
}

export function normalizeCatalogCorporateSkuV1(input: NormalizeIdentifierV1Input): NormalizedIdentifierV1 {
  if (typeof input.code !== 'string' || !isCatalogWorkbookTextV1(input.code)) throw new Error('CATALOG_IDENTIFIER_INVALID')
  const normalized = normalizeIdentifierV1(input)
  // WHY: Corporate SKU is persisted in the organization-wide btree key;
  // display-only/generic identifiers retain normalization-v1 compatibility.
  if (!isCatalogIndexedTextV1(normalized.normalizedCode)) throw new Error('CATALOG_IDENTIFIER_INVALID')
  return normalized
}

export function normalizeCatalogVenueLocalSkuV1(input: NormalizeIdentifierV1Input): NormalizedIdentifierV1 {
  if (typeof input.code !== 'string' || !isCatalogWorkbookTextV1(input.code)) throw new Error('CATALOG_IDENTIFIER_INVALID')
  const normalized = normalizeIdentifierV1(input)
  // WHY: Task 8 publishes this key into Product(venueId, sku), so preview must
  // enforce the same btree-safe budget while generic/local normalization stays unchanged.
  if (!isCatalogIndexedTextV1(normalized.normalizedCode)) throw new Error('CATALOG_IDENTIFIER_INVALID')
  return normalized
}
