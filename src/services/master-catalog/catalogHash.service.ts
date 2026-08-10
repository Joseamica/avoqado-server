import { createHash } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { canonicalCatalogDecimal } from './catalogMoney.service'

export interface CatalogManagedFieldHashInput {
  hashVersion: number
  fieldMask: readonly string[]
  values: Readonly<Record<string, unknown>>
  decimalScales?: Readonly<Record<string, number>>
}

export interface CatalogManagedFieldHashV1 {
  hashVersion: 1
  fieldMask: string[]
  hash: string
}

function invalidCanonicalJson(): never {
  throw new Error('CATALOG_CANONICAL_JSON_INVALID')
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function compareOrdinal(left: string, right: string): number {
  // WHY: Relational string comparison is UTF-16 ordinal and ignores host ICU
  // collation, keeping managed hashes identical across supported Node hosts.
  return left < right ? -1 : left > right ? 1 : 0
}

function quoteJsonString(value: string): string {
  // WHY: Native JSON quoting remains authoritative for escapes; this helper
  // narrows its optional return because a string always has a JSON encoding.
  return JSON.stringify(value) ?? invalidCanonicalJson()
}

function serializeCanonicalValue(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'string') return quoteJsonString(value.normalize('NFC'))
  if (typeof value === 'number') return Number.isSafeInteger(value) ? String(value) : invalidCanonicalJson()

  // WHY: Arrays keep business-significant order, but a missing own slot is not a
  // JSON value and must not collide with an explicit null after serialization.
  if (Array.isArray(value)) {
    const serialized: string[] = []
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) return invalidCanonicalJson()
      serialized.push(serializeCanonicalValue(value[index]))
    }
    return `[${serialized.join(',')}]`
  }
  if (!isPlainObject(value)) return invalidCanonicalJson()

  // WHY: NFC-normalized keys are sorted before insertion; collisions after Unicode
  // normalization are rejected instead of making the chosen value order-dependent.
  const normalizedEntries = Object.entries(value).map(([key, nested]) => [key.normalize('NFC'), nested] as const)
  const uniqueKeys = new Set(normalizedEntries.map(([key]) => key))
  if (uniqueKeys.size !== normalizedEntries.length) return invalidCanonicalJson()

  // WHY: Emit sorted pairs directly. Rebuilding an object and then calling
  // JSON.stringify would reorder integer-index keys numerically and violate the
  // cross-runtime ordinal contract; direct emission also preserves magic keys.
  return `{${normalizedEntries
    .sort(([left], [right]) => compareOrdinal(left, right))
    .map(([key, nested]) => `${quoteJsonString(key)}:${serializeCanonicalValue(nested)}`)
    .join(',')}}`
}

/**
 * WHY: Produces a deterministic JSON representation without Date/Decimal coercion.
 * Decimal callers must first provide an explicitly scaled string.
 */
export function canonicalJsonV1(value: unknown): string {
  return serializeCanonicalValue(value)
}

/**
 * WHY: The namespace and version prefix prevent one canonical payload from being
 * replayed as a different H1 hash domain after future serializer revisions.
 */
export function hashCanonicalJsonV1(namespace: string, value: unknown): string {
  if (!/^[a-z0-9][a-z0-9:_-]*$/.test(namespace)) throw new Error('CATALOG_HASH_NAMESPACE_INVALID')
  return createHash('sha256')
    .update(`${namespace}:v1\n${canonicalJsonV1(value)}`, 'utf8')
    .digest('hex')
}

/**
 * WHY: Hashes only the ordered managed-field subset. Unrelated Product state must
 * never invalidate a catalog publication preview.
 */
export function hashCatalogManagedFieldsV1(input: CatalogManagedFieldHashInput): CatalogManagedFieldHashV1 {
  if (input.hashVersion !== 1) throw new Error('CATALOG_HASH_VERSION_UNSUPPORTED')

  const uniqueRawFields = [...new Set(input.fieldMask)]
  const normalizedToRawField = new Map(uniqueRawFields.map(field => [field.normalize('NFC'), field] as const))
  const fieldMask = [...normalizedToRawField.keys()].sort(compareOrdinal)
  if (fieldMask.length === 0 || fieldMask.some(field => field.length === 0) || normalizedToRawField.size !== uniqueRawFields.length) {
    throw new Error('CATALOG_HASH_FIELD_MASK_INVALID')
  }

  // WHY: The managed-field accumulator needs the same magic-key safety as the
  // recursive canonicalizer; field masks may legitimately contain any JSON key.
  const selectedValues = Object.create(null) as Record<string, unknown>
  for (const field of fieldMask) {
    const rawField = normalizedToRawField.get(field) as string
    const valueKey = Object.prototype.hasOwnProperty.call(input.values, rawField) ? rawField : field
    if (!Object.prototype.hasOwnProperty.call(input.values, valueKey)) throw new Error('CATALOG_HASH_FIELD_MISSING')
    const value = input.values[valueKey]
    // WHY: Decimal scale maps are also untrusted dictionaries; inherited
    // Object.prototype keys must never reinterpret a managed string as money.
    const decimalScale =
      input.decimalScales && Object.prototype.hasOwnProperty.call(input.decimalScales, rawField)
        ? input.decimalScales?.[rawField]
        : input.decimalScales && Object.prototype.hasOwnProperty.call(input.decimalScales, field)
          ? input.decimalScales?.[field]
          : undefined
    selectedValues[field] = decimalScale === undefined ? value : canonicalCatalogDecimal(value as string | Prisma.Decimal, decimalScale)
  }

  return {
    hashVersion: 1,
    fieldMask,
    hash: hashCanonicalJsonV1('catalog-managed-fields', { fieldMask, hashVersion: 1, values: selectedValues }),
  }
}
