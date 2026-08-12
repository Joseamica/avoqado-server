import { CatalogItemKind, ProductType } from '@prisma/client'
import type { CatalogBindingResultLine } from '../../types/master-catalog'
import { CATALOG_ORGANIZATION_VALUE_MAX_V1 } from './catalogItemValidation.service'
import { validateCatalogProductTypeV1 } from './catalogProductType.service'

const MAX_LINES = 100
const ID_MAX = 200
const TEXT_MAX = 4096
const HASH_PATTERN = /^[a-f0-9]{64}$/u
const DECIMAL_2_PATTERN = /^-?\d+\.\d{2}$/u
const DECIMAL_4_PATTERN = /^-?\d+\.\d{4}$/u
const LINE_KEYS = [
  'schemaVersion',
  'catalogItem',
  'venue',
  'candidates',
  'productBindings',
  'existingBinding',
  'category',
  'reservations',
  'decision',
  'readiness',
  'readinessDependency',
] as const
const ITEM_KEYS = [
  'id',
  'sku',
  'kind',
  'revision',
  'status',
  'name',
  'description',
  'imageUrl',
  'unit',
  'taxRate',
  'satProductKey',
  'satUnitKey',
  'objetoImp',
  'productType',
  'purchaseCosts',
] as const
const CANDIDATE_KEYS = [
  'id',
  'sku',
  'gtin',
  'name',
  'categoryId',
  'active',
  'deletedAt',
  'updatedAt',
  'description',
  'type',
  'price',
  'cost',
  'taxRate',
  'satProductKey',
  'satUnitKey',
  'objetoImp',
  'imageUrl',
  'unit',
] as const
const PROSPECTIVE_KEYS = [
  'schemaVersion',
  'state',
  'productId',
  'recipeId',
  'recipeUpdatedAt',
  'recipeLineHash',
  'portionYield',
  'prepTime',
  'totalCost',
] as const
const FINDING_CODES = new Set([
  'PRODUCT_TYPE_INVALID',
  'MISSING_RECIPE',
  'INVALID_PORTION_YIELD',
  'MISSING_PREP_TIME',
  'EMPTY_LINES',
  'INVALID_RECIPE_LINE',
  'RECIPE_COST_STALE',
])

export interface CatalogBindingDependencyAuthorityV1 {
  catalogItemId: string
  venueId: string
  kind: string
  revision: number
  decision: Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const sorted = [...expected].sort()
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index])
}

function boundedString(value: unknown, max = TEXT_MAX): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

function textString(value: unknown): value is string {
  return typeof value === 'string'
}

function nullableText(value: unknown): boolean {
  return value === null || textString(value)
}

function isoInstant(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 40) return false
  try {
    return new Date(value).toISOString() === value
  } catch {
    return false
  }
}

function nullableInstant(value: unknown): boolean {
  return value === null || isoInstant(value)
}

function revision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1
}

function validPurchaseCost(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['id', 'amount', 'currency', 'revision', 'updatedAt']) &&
    boundedString(value.id, ID_MAX) &&
    typeof value.amount === 'string' &&
    DECIMAL_2_PATTERN.test(value.amount) &&
    boundedString(value.currency, 16) &&
    revision(value.revision) &&
    isoInstant(value.updatedAt)
  )
}

function validItem(value: unknown): value is Record<string, unknown> {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ITEM_KEYS) ||
    !boundedString(value.id, ID_MAX) ||
    !textString(value.sku) ||
    !['RETAIL_PRODUCT', 'PREPARED_DISH'].includes(value.kind as string) ||
    !revision(value.revision) ||
    value.status !== 'ACTIVE' ||
    !textString(value.name) ||
    !nullableText(value.description) ||
    !nullableText(value.imageUrl) ||
    !(value.unit === null || boundedString(value.unit, 64)) ||
    typeof value.taxRate !== 'string' ||
    !DECIMAL_4_PATTERN.test(value.taxRate) ||
    !nullableText(value.satProductKey) ||
    !nullableText(value.satUnitKey) ||
    !textString(value.objetoImp) ||
    !boundedString(value.productType, 64) ||
    !Array.isArray(value.purchaseCosts) ||
    value.purchaseCosts.length > CATALOG_ORGANIZATION_VALUE_MAX_V1 ||
    !value.purchaseCosts.every(validPurchaseCost)
  ) {
    return false
  }
  try {
    validateCatalogProductTypeV1({ kind: value.kind as CatalogItemKind, productType: value.productType as ProductType })
    return true
  } catch {
    return false
  }
}

function validCandidate(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, CANDIDATE_KEYS) &&
    boundedString(value.id, ID_MAX) &&
    textString(value.sku) &&
    nullableText(value.gtin) &&
    textString(value.name) &&
    boundedString(value.categoryId, ID_MAX) &&
    typeof value.active === 'boolean' &&
    nullableInstant(value.deletedAt) &&
    isoInstant(value.updatedAt) &&
    nullableText(value.description) &&
    boundedString(value.type, 64) &&
    typeof value.price === 'string' &&
    DECIMAL_2_PATTERN.test(value.price) &&
    (value.cost === null || (typeof value.cost === 'string' && DECIMAL_2_PATTERN.test(value.cost))) &&
    typeof value.taxRate === 'string' &&
    DECIMAL_4_PATTERN.test(value.taxRate) &&
    nullableText(value.satProductKey) &&
    nullableText(value.satUnitKey) &&
    textString(value.objetoImp) &&
    nullableText(value.imageUrl) &&
    (value.unit === null || boundedString(value.unit, 64))
  )
}

function validBinding(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['id', 'catalogItemId', 'productId', 'revision', 'status']) &&
    boundedString(value.id, ID_MAX) &&
    boundedString(value.catalogItemId, ID_MAX) &&
    boundedString(value.productId, ID_MAX) &&
    revision(value.revision) &&
    boundedString(value.status, 64)
  )
}

function validExistingBinding(value: unknown): boolean {
  return (
    value === null ||
    (isRecord(value) &&
      hasExactKeys(value, ['id', 'productId', 'revision', 'status', 'updatedAt']) &&
      boundedString(value.id, ID_MAX) &&
      (value.productId === null || boundedString(value.productId, ID_MAX)) &&
      revision(value.revision) &&
      boundedString(value.status, 64) &&
      isoInstant(value.updatedAt))
  )
}

function validCategory(value: unknown, venueId: string): boolean {
  return (
    value === null ||
    (isRecord(value) &&
      hasExactKeys(value, ['id', 'venueId', 'updatedAt']) &&
      boundedString(value.id, ID_MAX) &&
      value.venueId === venueId &&
      isoInstant(value.updatedAt))
  )
}

function parseDecision(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value) || typeof value.decision !== 'string') return null
  if (value.decision === 'SKIP' && hasExactKeys(value, ['decision'])) return value
  if (value.decision === 'LINK' && hasExactKeys(value, ['decision', 'productId']) && boundedString(value.productId, ID_MAX)) return value
  if (
    value.decision === 'CREATE' &&
    hasExactKeys(value, ['decision', 'create']) &&
    isRecord(value.create) &&
    hasExactKeys(value.create, ['categoryId', 'localSku', 'initialPrice']) &&
    boundedString(value.create.categoryId, ID_MAX) &&
    boundedString(value.create.localSku) &&
    typeof value.create.initialPrice === 'string' &&
    DECIMAL_2_PATTERN.test(value.create.initialPrice)
  ) {
    return value
  }
  return null
}

function validProspective(value: unknown, item: Record<string, unknown>, decision: Record<string, unknown>): boolean {
  if (!isRecord(value) || !hasExactKeys(value, PROSPECTIVE_KEYS) || value.schemaVersion !== 1) return false
  if (!['NOT_REQUIRED', 'READY', 'MISSING_RECIPE', 'INVALID', 'STALE'].includes(value.state as string)) return false
  if (
    !(value.productId === null || boundedString(value.productId, ID_MAX)) ||
    !(value.recipeId === null || boundedString(value.recipeId, ID_MAX)) ||
    !nullableInstant(value.recipeUpdatedAt) ||
    (value.recipeLineHash !== null && (typeof value.recipeLineHash !== 'string' || !HASH_PATTERN.test(value.recipeLineHash))) ||
    (value.portionYield !== null && !Number.isSafeInteger(value.portionYield)) ||
    (value.prepTime !== null && !Number.isSafeInteger(value.prepTime)) ||
    (value.totalCost !== null && (typeof value.totalCost !== 'string' || !DECIMAL_4_PATTERN.test(value.totalCost)))
  ) {
    return false
  }
  const expectedProductId = decision.decision === 'LINK' ? decision.productId : null
  if (value.productId !== expectedProductId) return false
  const absentRecipe =
    value.recipeId === null &&
    value.recipeUpdatedAt === null &&
    value.recipeLineHash === null &&
    value.portionYield === null &&
    value.prepTime === null &&
    value.totalCost === null
  if (item.kind !== 'PREPARED_DISH') return value.state === 'NOT_REQUIRED' && absentRecipe
  if (decision.decision === 'CREATE') return value.state === 'MISSING_RECIPE' && absentRecipe
  if (decision.decision === 'SKIP') return value.state === 'NOT_REQUIRED' && absentRecipe
  return absentRecipe || (value.recipeId !== null && value.recipeUpdatedAt !== null && value.recipeLineHash !== null)
}

/** Parses only the exact v1 dependency shape emitted by the binding preview. */
export function parseCatalogBindingDependencyAuthorityV1(
  value: unknown,
  organizationId: string,
): CatalogBindingDependencyAuthorityV1 | null {
  if (!isRecord(value) || !hasExactKeys(value, LINE_KEYS) || value.schemaVersion !== 1) return null
  const decision = parseDecision(value.decision)
  if (!decision || !validItem(value.catalogItem) || !isRecord(value.venue)) return null
  const venueId = value.venue.id
  if (
    !hasExactKeys(value.venue, ['id', 'organizationId', 'currency', 'updatedAt']) ||
    !boundedString(venueId, ID_MAX) ||
    value.venue.organizationId !== organizationId ||
    !boundedString(value.venue.currency, 16) ||
    !isoInstant(value.venue.updatedAt) ||
    !Array.isArray(value.candidates) ||
    value.candidates.length > MAX_LINES ||
    !value.candidates.every(validCandidate) ||
    !Array.isArray(value.productBindings) ||
    value.productBindings.length > MAX_LINES ||
    !value.productBindings.every(validBinding) ||
    !validExistingBinding(value.existingBinding) ||
    !validCategory(value.category, venueId) ||
    !Array.isArray(value.reservations) ||
    value.reservations.length > 2 ||
    !value.reservations.every(validCandidate) ||
    value.readiness !== (isRecord(value.readinessDependency) ? value.readinessDependency.state : undefined) ||
    !validProspective(value.readinessDependency, value.catalogItem, decision)
  ) {
    return null
  }
  const candidateIds = new Set(value.candidates.map(candidate => (candidate as Record<string, unknown>).id))
  if (
    (decision.decision === 'LINK' && (!candidateIds.has(decision.productId) || value.existingBinding !== null)) ||
    (decision.decision === 'CREATE' &&
      (!isRecord(value.category) ||
        value.category.id !== (decision.create as Record<string, unknown>).categoryId ||
        value.reservations.length > 0 ||
        value.existingBinding !== null))
  ) {
    return null
  }
  return {
    catalogItemId: value.catalogItem.id as string,
    venueId,
    kind: value.catalogItem.kind as string,
    revision: value.catalogItem.revision as number,
    decision,
  }
}

function validFinding(value: unknown): boolean {
  if (!isRecord(value)) return false
  const keys = Object.keys(value)
  if (!['code', 'code,lineId', 'code,reason', 'code,lineId,reason'].includes([...keys].sort().join(','))) return false
  return (
    FINDING_CODES.has(value.code as string) &&
    (value.lineId === undefined || boundedString(value.lineId, ID_MAX)) &&
    (value.reason === undefined || boundedString(value.reason, 200))
  )
}

function validCosts(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['batchCost', 'costPerPortion', 'storedCostPerPortion']) &&
    [value.batchCost, value.costPerPortion, value.storedCostPerPortion].every(
      cost => typeof cost === 'string' && DECIMAL_4_PATTERN.test(cost),
    )
  )
}

export function isCatalogBindingRecoveredReadinessV1(
  value: unknown,
  line: CatalogBindingResultLine,
  authority: CatalogBindingDependencyAuthorityV1,
): boolean {
  if (authority.kind !== 'PREPARED_DISH') return value === null
  if (!isRecord(value)) return false
  const hasCosts = Object.prototype.hasOwnProperty.call(value, 'costs')
  if (!hasExactKeys(value, hasCosts ? ['state', 'findings', 'dependencies', 'costs'] : ['state', 'findings', 'dependencies'])) return false
  if (
    !['READY', 'INVALID', 'STALE'].includes(value.state as string) ||
    !Array.isArray(value.findings) ||
    !value.findings.every(validFinding)
  )
    return false
  const dependency = value.dependencies
  if (
    !isRecord(dependency) ||
    !hasExactKeys(dependency, [
      'bindingId',
      'bindingRevision',
      'catalogItemId',
      'catalogItemRevision',
      'productId',
      'recipeId',
      'recipeUpdatedAt',
      'recipeLineHash',
    ]) ||
    dependency.bindingId !== line.bindingId ||
    dependency.catalogItemId !== line.catalogItemId ||
    dependency.catalogItemRevision !== authority.revision ||
    dependency.productId !== line.productId ||
    dependency.bindingRevision !== 1 ||
    !(dependency.recipeId === null || boundedString(dependency.recipeId, ID_MAX)) ||
    !nullableInstant(dependency.recipeUpdatedAt) ||
    (dependency.recipeLineHash !== null &&
      (typeof dependency.recipeLineHash !== 'string' || !HASH_PATTERN.test(dependency.recipeLineHash))) ||
    (dependency.recipeId === null) !== (dependency.recipeUpdatedAt === null && dependency.recipeLineHash === null)
  ) {
    return false
  }
  if (value.state === 'READY') return hasCosts && validCosts(value.costs) && value.findings.length === 0 && dependency.recipeId !== null
  if (value.state === 'STALE') {
    return (
      hasCosts &&
      validCosts(value.costs) &&
      value.findings.length === 1 &&
      (value.findings[0] as Record<string, unknown>).code === 'RECIPE_COST_STALE' &&
      dependency.recipeId !== null
    )
  }
  return (
    !hasCosts &&
    value.findings.length > 0 &&
    value.findings.every(finding => (finding as Record<string, unknown>).code !== 'RECIPE_COST_STALE')
  )
}
