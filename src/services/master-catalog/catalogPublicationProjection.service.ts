import { CatalogItemKind } from '@prisma/client'
import type { CatalogValidationBaselineFieldV1, CatalogManagedFieldV1 } from '../../types/master-catalog'
import { CATALOG_PREPARED_DISH_MANAGED_FIELD_MASK_V1, CATALOG_RETAIL_MANAGED_FIELD_MASK_V1 } from '../../types/master-catalog'
import { CATALOG_VALIDATION_BASELINE_V1 } from './catalogValidation.service'
import { canonicalJsonV1, hashCanonicalJsonV1 } from './catalogHash.service'
import type {
  CatalogPublicationItemRecord,
  CatalogPublicationJson,
  CatalogPublicationProfileRecord,
  CatalogPublicationProjection,
  CatalogPublicationProjectionInput,
} from './catalogPublication.types'

const MAX_DIAGNOSTIC_LENGTH = 256
const IMPLEMENTED_PROFILE_FIELDS = new Set<string>(CATALOG_VALIDATION_BASELINE_V1)

function boundedDiagnostic(value: string): string {
  return [...value].slice(0, MAX_DIAGNOSTIC_LENGTH).join('')
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function jsonEquals(left: CatalogPublicationJson, right: CatalogPublicationJson): boolean {
  return canonicalJsonV1(left) === canonicalJsonV1(right)
}

function managedValueFromItem(input: CatalogPublicationProjectionInput, field: CatalogManagedFieldV1): CatalogPublicationJson {
  const item = input.item
  if (field === 'cost') {
    const price = item.prices.find(
      candidate =>
        candidate.active &&
        candidate.kind === 'PURCHASE_COST' &&
        candidate.scope === 'ORGANIZATION' &&
        candidate.currency === input.venue.currency,
    )
    return price?.amount.toFixed(2) ?? null
  }
  if (field === 'taxRate') return item.taxRate.toFixed(4)
  if (field === 'type') return item.productType
  return item[field]
}

function managedValueFromProduct(input: CatalogPublicationProjectionInput, field: CatalogManagedFieldV1): CatalogPublicationJson {
  const product = input.product
  if (field === 'cost') return product.cost?.toFixed(2) ?? null
  if (field === 'taxRate') return product.taxRate.toFixed(4)
  return product[field]
}

export function catalogPublicationProfileApplies(
  input: Pick<CatalogPublicationProjectionInput, 'item' | 'venue'>,
  profile: CatalogPublicationProfileRecord,
): boolean {
  if (!profile.active) return false
  const itemBusinessTypes = input.item.businessTypes.map(row => row.businessType)
  const businessMatches = profile.businessType === null || itemBusinessTypes.includes(profile.businessType)
  const roleMatches = profile.operationalRole === null || profile.operationalRole === input.venue.operationalRole
  return businessMatches && roleMatches
}

export function hashApplicableCatalogProfilesV1(input: Pick<CatalogPublicationProjectionInput, 'item' | 'venue' | 'profiles'>): string {
  return hashCanonicalJsonV1(
    'catalog-publication-applicable-profiles',
    input.profiles
      .filter(profile => catalogPublicationProfileApplies(input, profile))
      .map(profile => ({
        id: profile.id,
        profileVersion: profile.profileVersion ?? null,
        updatedAt: profile.updatedAt instanceof Date ? profile.updatedAt.toISOString() : null,
        businessType: profile.businessType,
        operationalRole: profile.operationalRole,
        rulesSchemaVersion: profile.rulesSchemaVersion,
        requiredFields: profile.requiredFields,
        additionalRules: profile.additionalRules as never,
      })),
  )
}

function profileFieldValue(input: CatalogPublicationProjectionInput, field: CatalogValidationBaselineFieldV1): unknown {
  const item = input.item
  if (field === 'organizationSalePrice') {
    return item.prices.find(
      price => price.active && price.scope === 'ORGANIZATION' && price.kind === 'SALE_PRICE' && price.currency === input.venue.currency,
    )?.amount
  }
  if (field === 'organizationPurchaseCost') {
    return item.prices.find(
      price => price.active && price.scope === 'ORGANIZATION' && price.kind === 'PURCHASE_COST' && price.currency === input.venue.currency,
    )?.amount
  }
  if (field === 'currency') return input.venue.currency
  if (field === 'businessTypes') return item.businessTypes.length > 0 ? item.businessTypes : null
  if (field === 'subfamily') return item.family.parentId === null ? null : item.familyId
  if (field === 'ieps') return item.iepsMode
  if (field === 'kind') return item.kind
  if (field === 'productType') return item.productType
  return item[field as keyof CatalogPublicationItemRecord]
}

function unsupportedProfile(input: CatalogPublicationProjectionInput): { code: string; diagnostic: string } | null {
  // WHY: Task 6's baseline is non-relaxable and remains required even when an
  // organization has no active profile rows for this target.
  const requiredFields = new Set<string>(CATALOG_VALIDATION_BASELINE_V1)
  for (const profile of input.profiles) {
    if (!catalogPublicationProfileApplies(input, profile)) continue
    if (profile.rulesSchemaVersion !== 1) {
      return {
        code: 'CATALOG_PROFILE_RULES_VERSION_UNSUPPORTED',
        diagnostic: boundedDiagnostic(`El perfil ${profile.id} usa rulesSchemaVersion no soportada.`),
      }
    }
    const unsupportedField = profile.requiredFields.find(field => !IMPLEMENTED_PROFILE_FIELDS.has(field))
    if (unsupportedField) {
      return {
        code: 'CATALOG_PROFILE_REQUIRED_FIELD_UNSUPPORTED',
        diagnostic: boundedDiagnostic(`El perfil ${profile.id} requiere el campo no soportado ${unsupportedField}.`),
      }
    }
    if (profile.additionalRules != null && (!isPlainObject(profile.additionalRules) || Object.keys(profile.additionalRules).length > 0)) {
      return {
        code: 'CATALOG_PROFILE_ADDITIONAL_RULE_UNSUPPORTED',
        diagnostic: boundedDiagnostic(`El perfil ${profile.id} contiene reglas adicionales sin evaluador H1A.`),
      }
    }
    for (const field of profile.requiredFields) requiredFields.add(field)
  }
  const missingField = [...requiredFields].find(field => {
    const value = profileFieldValue(input, field as CatalogValidationBaselineFieldV1)
    return value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0)
  })
  if (missingField) {
    return {
      code: 'CATALOG_PROFILE_REQUIRED_FIELD_MISSING',
      diagnostic: boundedDiagnostic(`El artículo no cumple el campo requerido ${missingField}.`),
    }
  }
  return null
}

function invalidProjection(
  input: CatalogPublicationProjectionInput,
  fieldMask: readonly CatalogManagedFieldV1[],
  code: string,
  diagnostic: string,
  status: 'INVALID' | 'RECIPE_COST_STALE' = 'INVALID',
): CatalogPublicationProjection {
  const before: Partial<Record<CatalogManagedFieldV1, CatalogPublicationJson>> = {}
  const proposed: Partial<Record<CatalogManagedFieldV1, CatalogPublicationJson>> = {}
  const published = isPlainObject(input.binding.lastPublishedManagedSnapshot) ? input.binding.lastPublishedManagedSnapshot : null
  const fields = fieldMask.map(field => {
    const currentValue = managedValueFromProduct(input, field)
    const proposedValue = managedValueFromItem(input, field)
    before[field] = currentValue
    proposed[field] = proposedValue
    const changed = !jsonEquals(currentValue, proposedValue)
    const priorValue = published?.[field]
    const diverged =
      changed && published !== null && !jsonEquals(currentValue, priorValue === undefined ? null : (priorValue as CatalogPublicationJson))
    return { field, before: currentValue, proposed: proposedValue, changed, diverged }
  })
  // WHY: Invalid lines still receive an operation-namespaced target identity,
  // and one decision slot per field, but never mutable Product side effects.
  return {
    fieldMask: [...fieldMask],
    before,
    proposed,
    fields,
    status,
    diagnosticCode: code,
    diagnostic: boundedDiagnostic(diagnostic),
    canonicalTargetHash: hashCanonicalJsonV1('catalog-publication-target', {
      operation: input.operation,
      organizationId: input.organizationId,
      catalogItemId: input.item.id,
      venueId: input.venue.id,
      productId: input.product.id,
      fieldMask,
      values: before,
      applicableProfilesHash: hashApplicableCatalogProfilesV1(input),
    }),
  }
}

export function projectCatalogPublicationTarget(input: CatalogPublicationProjectionInput): CatalogPublicationProjection {
  const fieldMask =
    input.item.kind === CatalogItemKind.RETAIL_PRODUCT ? CATALOG_RETAIL_MANAGED_FIELD_MASK_V1 : CATALOG_PREPARED_DISH_MANAGED_FIELD_MASK_V1

  // WHY: Cost has no FX/fallback authority; a compatible retail target needs
  // one ACTIVE ORGANIZATION PURCHASE_COST in exactly Venue.currency.
  if (input.item.kind === CatalogItemKind.RETAIL_PRODUCT && managedValueFromItem(input, 'cost') === null) {
    return invalidProjection(
      input,
      fieldMask,
      'CATALOG_PURCHASE_COST_MISSING',
      'No existe costo corporativo activo en la moneda del venue.',
    )
  }

  // WHY: Prepared-dish publication consumes Task 6 readiness as an immutable
  // dependency and never substitutes Recipe cost with corporate purchase cost.
  if (input.item.kind === CatalogItemKind.PREPARED_DISH && input.readiness.state !== 'READY') {
    return invalidProjection(
      input,
      fieldMask,
      'CATALOG_RECIPE_NOT_READY',
      'La receta local no está lista para publicación.',
      'RECIPE_COST_STALE',
    )
  }

  const profileProblem = unsupportedProfile(input)
  if (profileProblem) return invalidProjection(input, fieldMask, profileProblem.code, profileProblem.diagnostic)

  const published = isPlainObject(input.binding.lastPublishedManagedSnapshot) ? input.binding.lastPublishedManagedSnapshot : null
  const before: Partial<Record<CatalogManagedFieldV1, CatalogPublicationJson>> = {}
  const proposed: Partial<Record<CatalogManagedFieldV1, CatalogPublicationJson>> = {}
  const fields = fieldMask.map(field => {
    const currentValue = managedValueFromProduct(input, field)
    const proposedValue = managedValueFromItem(input, field)
    before[field] = currentValue
    proposed[field] = proposedValue
    const changed = !jsonEquals(currentValue, proposedValue)
    const priorValue = published?.[field]
    const priorJson = priorValue === undefined ? null : (priorValue as CatalogPublicationJson)
    const diverged = changed && published !== null && !jsonEquals(currentValue, priorJson)
    return { field, before: currentValue, proposed: proposedValue, changed, diverged }
  })

  // WHY: Target hashing includes only ordered managed current values plus the
  // operation namespace; Product.updatedAt/category/price/active cannot stale it.
  const canonicalTargetHash = hashCanonicalJsonV1('catalog-publication-target', {
    operation: input.operation,
    organizationId: input.organizationId,
    catalogItemId: input.item.id,
    venueId: input.venue.id,
    productId: input.product.id,
    fieldMask,
    values: before,
    applicableProfilesHash: hashApplicableCatalogProfilesV1(input),
  })
  const status = fields.some(field => field.diverged) ? 'LOCAL_DIVERGENCE' : fields.some(field => field.changed) ? 'READY' : 'NO_CHANGE'
  return {
    fieldMask: [...fieldMask],
    before,
    proposed,
    fields,
    status,
    diagnosticCode: null,
    diagnostic: null,
    canonicalTargetHash,
  }
}
