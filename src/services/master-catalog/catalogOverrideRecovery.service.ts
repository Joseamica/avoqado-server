import { Prisma } from '@prisma/client'
import { ConflictError } from '../../errors/AppError'
import type { CatalogManagedFieldV1, CatalogOverrideRequestResult, CatalogVenueContext } from '../../types/master-catalog'
import { CATALOG_RETAIL_MANAGED_FIELD_MASK_V1 } from '../../types/master-catalog'
import { canonicalJsonV1, hashCanonicalJsonV1 } from './catalogHash.service'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const UNIQUE_FIELDS_BY_CONSTRAINT: Readonly<Record<string, readonly string[]>> = {
  CatalogIdempotencyRecord_organizationId_operation_idemp_key: ['organizationId', 'operation', 'idempotencyKey'],
  CatalogVenueOverride_one_requested_field_key: ['organizationId', 'bindingId', 'field'],
}

const DEPENDENCY_KEYS = ['bindingId', 'bindingRevision', 'catalogItemId', 'productId', 'requests', 'schemaVersion', 'venueId'] as const
const REQUEST_KEYS = ['corporateValue', 'field', 'localValue', 'reason'] as const
const SHA256_HEX = /^[0-9a-f]{64}$/u

export interface CatalogOverrideCapturedRequestV1 {
  field: CatalogManagedFieldV1
  reason: string
  localValue: Prisma.JsonValue
  corporateValue: Prisma.JsonValue
}

export interface CatalogOverrideDependenciesV1 {
  schemaVersion: 1
  bindingId: string
  bindingRevision: number
  venueId: string
  productId: string
  catalogItemId: string
  requests: CatalogOverrideCapturedRequestV1[]
}

function invalidDependencies(): never {
  throw new ConflictError('Preview de override inválido', 'CATALOG_OVERRIDE_PREVIEW_INVALID')
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.length && expected.every(key => Object.prototype.hasOwnProperty.call(value, key))
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next < 0xdc00 || next > 0xdfff) return true
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) return true
  }
  return false
}

function isStoredId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /\S/u.test(value) &&
    !value.includes('\0') &&
    !hasLoneSurrogate(value) &&
    Buffer.byteLength(value, 'utf8') <= 256
  )
}

function isStoredReason(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value === value.normalize('NFC').trim() &&
    /\S/u.test(value) &&
    !value.includes('\0') &&
    !hasLoneSurrogate(value) &&
    Array.from(value).length <= 500 &&
    Buffer.byteLength(value, 'utf8') <= 2_000
  )
}

export function parseCatalogOverrideDependencies(value: unknown, targetHash: string | null): CatalogOverrideDependenciesV1 {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, DEPENDENCY_KEYS) ||
    value.schemaVersion !== 1 ||
    !isStoredId(value.bindingId) ||
    !Number.isSafeInteger(value.bindingRevision) ||
    (value.bindingRevision as number) < 1 ||
    !isStoredId(value.venueId) ||
    !isStoredId(value.productId) ||
    !isStoredId(value.catalogItemId) ||
    !Array.isArray(value.requests) ||
    value.requests.length < 1 ||
    value.requests.length > 25
  ) {
    return invalidDependencies()
  }
  let previousField: string | null = null
  const seen = new Set<string>()
  for (const line of value.requests) {
    if (
      !isPlainRecord(line) ||
      !hasExactKeys(line, REQUEST_KEYS) ||
      typeof line.field !== 'string' ||
      !CATALOG_RETAIL_MANAGED_FIELD_MASK_V1.includes(line.field as CatalogManagedFieldV1) ||
      seen.has(line.field) ||
      (previousField !== null && line.field <= previousField) ||
      !isStoredReason(line.reason)
    ) {
      return invalidDependencies()
    }
    seen.add(line.field)
    previousField = line.field
  }
  try {
    if (!SHA256_HEX.test(targetHash ?? '') || hashCanonicalJsonV1('catalog-override-target', value) !== targetHash) {
      return invalidDependencies()
    }
  } catch {
    return invalidDependencies()
  }
  return value as unknown as CatalogOverrideDependenciesV1
}

/** Prisma may expose a named PostgreSQL unique through target or constraint. */
export function isCatalogOverrideUniqueConstraint(error: unknown, constraint: string): boolean {
  if (!isRecord(error) || error.code !== 'P2002' || !isRecord(error.meta)) return false
  const descriptor = error.meta.constraint ?? error.meta.target
  if (descriptor === constraint || (Array.isArray(descriptor) && descriptor.length === 1 && descriptor[0] === constraint)) return true
  const expectedFields = UNIQUE_FIELDS_BY_CONSTRAINT[constraint]
  return (
    expectedFields !== undefined &&
    Array.isArray(descriptor) &&
    descriptor.length === expectedFields.length &&
    descriptor.every((field, index) => field === expectedFields[index])
  )
}

export function isCatalogOverrideSerializationFailure(error: unknown): boolean {
  return isRecord(error) && error.code === 'P2034'
}

const REQUEST_DERIVED_STATES = new Set(['REQUESTED', 'APPROVED', 'REJECTED', 'SUPERSEDED'])

export async function recoverCatalogOverrideApplied(
  tx: Prisma.TransactionClient,
  context: CatalogVenueContext,
  record: { id: string },
  dependencies: CatalogOverrideDependenciesV1,
): Promise<CatalogOverrideRequestResult> {
  const rows = await tx.catalogVenueOverride.findMany({
    where: {
      organizationId: context.organizationId,
      venueId: context.venueId,
      bindingId: dependencies.bindingId,
      requestBatchId: record.id,
    },
    orderBy: [{ field: 'asc' }, { id: 'asc' }],
  })
  const expected = [...dependencies.requests].sort((left, right) => (left.field < right.field ? -1 : left.field > right.field ? 1 : 0))
  const actorId = context.actor.type === 'HUMAN' ? context.actor.staffId : null
  if (
    rows.length !== expected.length ||
    rows.some(
      (row, index) =>
        !REQUEST_DERIVED_STATES.has(row.status) ||
        row.requestedById !== actorId ||
        row.field !== expected[index].field ||
        row.reason !== expected[index].reason ||
        canonicalJsonV1(row.localValue) !== canonicalJsonV1(expected[index].localValue),
    )
  ) {
    throw new ConflictError('Resultado aplicado no coincide con su provenance', 'CATALOG_OVERRIDE_RESULT_INVALID')
  }
  return { requestBatchId: record.id, state: 'APPLIED', overrideIds: rows.map(row => row.id) }
}
