import { BusinessType, CatalogItemPriceKind, ProductType, VenueOperationalRole } from '@prisma/client'
import { ConflictError } from '../../errors/AppError'
import type { CatalogImportDependencySnapshotV1 } from './catalogImport.types'
import { parseCatalogImportConfirmCapacityV1 } from './catalogImportCapacity.service'
import { validateCatalogCurrencyV1 } from './catalogItemValidation.service'
import { walkCatalogValidationRuleJsonV1 } from './catalogValidationRuleJson.service'
import type { CatalogImportCooperativeCheckpoint } from './catalogImportCanonical.service'
import { isCatalogWorkbookTextV1 } from './identifierNormalization.service'

const POSTGRES_INT_MAX = 2_147_483_647
const MAX_ITEMS = 20_000
const MAX_ORGANIZATION_VALUES = 20_000
const MAX_REFERENCES = 80_000
const MAX_MAPPINGS = 20_000
export const CATALOG_IMPORT_PROFILE_SNAPSHOT_CAP_V1 = 20_000 as const
const MAX_REQUIRED_FIELDS = 64
const MAX_ID_LENGTH = 256

export type CatalogImportDependencyCheckpoint = CatalogImportCooperativeCheckpoint
export type CatalogImportProfileDependencyV1 = CatalogImportDependencySnapshotV1['profiles'][number]

function failStale(): never {
  throw new ConflictError('Las dependencias del preview cambiaron.', 'STALE_PREVIEW')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.length && keys.every(key => expected.includes(key))
}

function boundedText(value: unknown, maximum = MAX_ID_LENGTH): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= POSTGRES_INT_MAX
}

async function validateBoundedRuleJson(value: unknown, checkpoint: CatalogImportDependencyCheckpoint): Promise<boolean> {
  try {
    // WHY: Dependency parsing consumes the exact Task 6 producer policy but
    // checkpoints every node so a maximum legal profile cannot block confirm.
    for (const _ of walkCatalogValidationRuleJsonV1(value)) {
      const pause = checkpoint()
      if (pause) await pause
    }
    return true
  } catch {
    return false
  }
}

export async function parseCatalogImportProfileDependencyV1(
  value: unknown,
  checkpoint: CatalogImportDependencyCheckpoint,
): Promise<CatalogImportProfileDependencyV1> {
  // WHY: Profile JSON may be non-null for an unrelated active scope. Its open
  // rule vocabulary remains exact, but traversal is bounded and cooperative.
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'id',
      'profileVersion',
      'rulesSchemaVersion',
      'businessType',
      'operationalRole',
      'requiredFields',
      'additionalRules',
    ]) ||
    !boundedText(value.id) ||
    !positiveInteger(value.profileVersion) ||
    !positiveInteger(value.rulesSchemaVersion) ||
    (value.businessType !== null && !Object.values(BusinessType).includes(value.businessType as BusinessType)) ||
    (value.operationalRole !== null && !Object.values(VenueOperationalRole).includes(value.operationalRole as VenueOperationalRole)) ||
    !Array.isArray(value.requiredFields) ||
    value.requiredFields.length > MAX_REQUIRED_FIELDS ||
    value.requiredFields.some(field => !boundedText(field, 128)) ||
    new Set(value.requiredFields).size !== value.requiredFields.length ||
    !(await validateBoundedRuleJson(value.additionalRules, checkpoint))
  ) {
    return failStale()
  }
  return value as unknown as CatalogImportProfileDependencyV1
}

export async function parseCatalogImportDependencySnapshotV1(
  value: unknown,
  checkpoint: CatalogImportDependencyCheckpoint,
): Promise<CatalogImportDependencySnapshotV1> {
  // WHY: Durable dependency JSON is an untrusted query plan at confirm time;
  // close and cap every collection before deriving any tenant `IN` clause.
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'capacity',
      'items',
      'priceDependentItemIds',
      'organizationValues',
      'references',
      'mappings',
      'profiles',
    ]) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.items) ||
    value.items.length > MAX_ITEMS ||
    !Array.isArray(value.priceDependentItemIds) ||
    value.priceDependentItemIds.length > MAX_ITEMS ||
    !Array.isArray(value.organizationValues) ||
    value.organizationValues.length > MAX_ORGANIZATION_VALUES ||
    !Array.isArray(value.references) ||
    value.references.length > MAX_REFERENCES ||
    !Array.isArray(value.mappings) ||
    value.mappings.length > MAX_MAPPINGS ||
    !Array.isArray(value.profiles) ||
    value.profiles.length > CATALOG_IMPORT_PROFILE_SNAPSHOT_CAP_V1
  ) {
    return failStale()
  }

  try {
    // WHY: Capacity is part of the hash-bound dependency authority. Both exact
    // previews and a FAILED early-overflow lower bound retain one closed V1 DTO.
    parseCatalogImportConfirmCapacityV1(value.capacity, ['EXACT', 'LOWER_BOUND'])
  } catch {
    return failStale()
  }

  const snapshot = value as unknown as CatalogImportDependencySnapshotV1
  const itemIds = new Set<string>()
  for (const item of snapshot.items) {
    if (
      !isRecord(item) ||
      !hasExactKeys(item, ['id', 'revision', 'invariantVersion', 'status', 'businessTypes']) ||
      !boundedText(item.id) ||
      itemIds.has(item.id) ||
      !positiveInteger(item.revision) ||
      typeof item.invariantVersion !== 'string' ||
      !/^\d{1,20}$/u.test(item.invariantVersion) ||
      (item.status !== 'ACTIVE' && item.status !== 'RETIRED') ||
      !Array.isArray(item.businessTypes) ||
      item.businessTypes.length === 0 ||
      item.businessTypes.length > Object.values(BusinessType).length ||
      item.businessTypes.some(type => !Object.values(BusinessType).includes(type as BusinessType)) ||
      new Set(item.businessTypes).size !== item.businessTypes.length
    ) {
      return failStale()
    }
    itemIds.add(item.id)
    const pause = checkpoint()
    if (pause) await pause
  }

  const priceIds = new Set<string>()
  const priceKeys = new Set<string>()
  const priceDependentItemIds = new Set<string>()
  for (const itemId of snapshot.priceDependentItemIds) {
    if (!boundedText(itemId) || !itemIds.has(itemId) || priceDependentItemIds.has(itemId)) return failStale()
    priceDependentItemIds.add(itemId)
    const pause = checkpoint()
    if (pause) await pause
  }
  for (const price of snapshot.organizationValues) {
    if (!isRecord(price)) return failStale()
    if (
      !hasExactKeys(price, ['id', 'catalogItemId', 'kind', 'scope', 'currency', 'revision', 'active']) ||
      !boundedText(price.id) ||
      !boundedText(price.catalogItemId) ||
      !priceDependentItemIds.has(price.catalogItemId) ||
      priceIds.has(price.id) ||
      !Object.values(CatalogItemPriceKind).includes(price.kind as CatalogItemPriceKind) ||
      price.scope !== 'ORGANIZATION' ||
      !positiveInteger(price.revision) ||
      typeof price.active !== 'boolean'
    ) {
      return failStale()
    }
    try {
      validateCatalogCurrencyV1(price.currency)
    } catch {
      return failStale()
    }
    // WHY: Derive composite keys only after every component is a validated
    // primitive; unknown durable values never reach implicit string coercion.
    const key = `${price.catalogItemId}:${price.kind}:${price.currency}`
    if (priceKeys.has(key)) return failStale()
    priceIds.add(price.id as string)
    priceKeys.add(key)
    const pause = checkpoint()
    if (pause) await pause
  }

  const referenceKeys = new Set<string>()
  for (const reference of snapshot.references) {
    if (!isRecord(reference)) return failStale()
    if (
      !hasExactKeys(reference, ['type', 'id', 'revision']) ||
      typeof reference.type !== 'string' ||
      !['BRAND', 'MANUFACTURER', 'FAMILY'].includes(reference.type) ||
      !boundedText(reference.id) ||
      !positiveInteger(reference.revision)
    ) {
      return failStale()
    }
    const key = `${reference.type}:${reference.id}`
    if (referenceKeys.has(key)) return failStale()
    referenceKeys.add(key)
    const pause = checkpoint()
    if (pause) await pause
  }

  const mappingIds = new Set<string>()
  for (const mapping of snapshot.mappings) {
    if (
      !isRecord(mapping) ||
      !hasExactKeys(mapping, ['id', 'catalogProductType', 'productType', 'mappingVersion', 'active']) ||
      !boundedText(mapping.id) ||
      mappingIds.has(mapping.id) ||
      typeof mapping.catalogProductType !== 'string' ||
      !mapping.catalogProductType.trim() ||
      !isCatalogWorkbookTextV1(mapping.catalogProductType) ||
      !Object.values(ProductType).includes(mapping.productType as ProductType) ||
      !positiveInteger(mapping.mappingVersion) ||
      mapping.active !== true
    ) {
      return failStale()
    }
    mappingIds.add(mapping.id)
    const pause = checkpoint()
    if (pause) await pause
  }

  const profileIds = new Set<string>()
  for (const rawProfile of snapshot.profiles) {
    const profile = await parseCatalogImportProfileDependencyV1(rawProfile, checkpoint)
    if (profileIds.has(profile.id)) return failStale()
    profileIds.add(profile.id)
    const pause = checkpoint()
    if (pause) await pause
  }
  return snapshot
}

export async function exactCatalogImportJsonEqualsV1(
  left: unknown,
  right: unknown,
  checkpoint: CatalogImportDependencyCheckpoint,
): Promise<boolean> {
  const pause = checkpoint()
  if (pause) await pause
  if (left === right) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    for (let index = 0; index < left.length; index += 1) {
      if (!(await exactCatalogImportJsonEqualsV1(left[index], right[index], checkpoint))) return false
    }
    return true
  }
  if (!isRecord(left) || !isRecord(right)) return false
  const leftKeys = Object.keys(left)
  if (leftKeys.length !== Object.keys(right).length) return false
  for (const key of leftKeys) {
    if (!Object.prototype.hasOwnProperty.call(right, key) || !(await exactCatalogImportJsonEqualsV1(left[key], right[key], checkpoint))) {
      return false
    }
  }
  return true
}
