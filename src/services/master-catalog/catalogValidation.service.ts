import { BusinessType, VenueOperationalRole } from '@prisma/client'
import { ValidationError } from '../../errors/AppError'
import type {
  CatalogCommandContext,
  CatalogValidationBaselineFieldV1,
  CatalogValidationProfilePreview,
  CatalogValidationProfilePreviewInput,
  CatalogValidationProfileRuleV1,
} from '../../types/master-catalog'
import { previewCatalogValidationProfileCommand } from './catalogValidationProfile.service'

export const CATALOG_VALIDATION_BASELINE_V1: readonly CatalogValidationBaselineFieldV1[] = [
  'sku',
  'imageUrl',
  'name',
  'description',
  'brandId',
  'manufacturerId',
  'familyId',
  'subfamily',
  'presentationLabel',
  'unit',
  'kind',
  'productType',
  'organizationSalePrice',
  'organizationPurchaseCost',
  'currency',
  'taxRate',
  'ieps',
  'satProductKey',
  'satUnitKey',
  'objetoImp',
  'createdById',
  'createdAt',
  'updatedById',
  'updatedAt',
  'businessTypes',
]

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function normalizeRequiredFields(fields: readonly string[]): string[] {
  // WHY: Both persisted profiles and request-time rules cross an untyped JSON/
  // String[] boundary; malformed names must fail as validation, never TypeError.
  if (!Array.isArray(fields) || fields.some(field => typeof field !== 'string')) {
    throw new ValidationError('requiredFields debe ser una lista de texto')
  }
  const normalized = fields.map(field => field.normalize('NFC').trim())
  if (normalized.some(field => field.length === 0 || field.length > 128)) {
    throw new ValidationError('requiredFields contiene un campo inválido')
  }
  return [...new Set(normalized)].sort(compareOrdinal)
}

function profileApplies(
  profile: CatalogValidationProfileRuleV1 & { active?: boolean },
  businessTypes: readonly BusinessType[],
  operationalRole: VenueOperationalRole | null,
): boolean {
  if (profile.active === false) return false
  const businessMatches = profile.businessType === null || businessTypes.includes(profile.businessType)
  const roleMatches = profile.operationalRole === null || profile.operationalRole === operationalRole
  return businessMatches && roleMatches
}

/** Profiles can only union requirements onto the immutable H1 baseline. */
export function resolveCatalogRequiredFieldsV1(input: {
  businessTypes: readonly BusinessType[]
  operationalRole: VenueOperationalRole | null
  profiles: ReadonlyArray<CatalogValidationProfileRuleV1 & { active?: boolean }>
}): string[] {
  const required = new Set<string>(CATALOG_VALIDATION_BASELINE_V1)
  for (const profile of input.profiles) {
    if (profile.rulesSchemaVersion !== 1) throw new Error('CATALOG_VALIDATION_RULES_SCHEMA_UNSUPPORTED')
    if (!profileApplies(profile, input.businessTypes, input.operationalRole)) continue
    for (const field of normalizeRequiredFields(profile.requiredFields)) required.add(field)
  }

  // WHY: Baseline order is stable for UI/export while additive fields sort so
  // profile query order cannot change preview hashes or human diffs.
  const extras = [...required]
    .filter(field => !CATALOG_VALIDATION_BASELINE_V1.includes(field as CatalogValidationBaselineFieldV1))
    .sort(compareOrdinal)
  return [...CATALOG_VALIDATION_BASELINE_V1, ...extras]
}

export async function previewCatalogValidationProfile(
  context: CatalogCommandContext,
  input: CatalogValidationProfilePreviewInput,
): Promise<CatalogValidationProfilePreview> {
  // WHY: This facade keeps one public validation API while profile persistence
  // is split below 500 lines and receives the non-relaxable baseline resolver.
  return previewCatalogValidationProfileCommand(context, input, requiredFields =>
    resolveCatalogRequiredFieldsV1({
      businessTypes: [],
      operationalRole: null,
      profiles: [{ rulesSchemaVersion: 1, businessType: null, operationalRole: null, requiredFields }],
    }),
  )
}

// WHY: Consumers retain the approved Task 6 import path even though immutable
// preview-confirm persistence lives in its own bounded implementation module.
export { confirmCatalogValidationProfile } from './catalogValidationProfile.service'
