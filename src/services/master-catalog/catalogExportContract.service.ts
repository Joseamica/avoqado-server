import { BusinessType } from '@prisma/client'
import AppError from '@/errors/AppError'
import { CATALOG_VALIDATION_BASELINE_V1 } from './catalogValidation.service'
import {
  CATALOG_EXPORT_WORKBOOK_LIMITS_V1,
  type CatalogWorkbookCellTypeV1,
  type CatalogWorkbookColumnV1,
  type CatalogWorkbookSheetV1,
  type CatalogWorkbookValueV1,
} from './catalogExportWorkbook.service'

export const CATALOG_EXPORT_HYDRATED_ROW_CAP_V1 = 5_000 as const

export interface CatalogExportProfileV1 {
  id: string
  profileVersion: number
  rulesSchemaVersion: number
  businessType: BusinessType | null
  operationalRole: string | null
  requiredFields: string[]
  active: boolean
}

type DecimalCellTypeV1 = Extract<CatalogWorkbookCellTypeV1, `decimal${number}`>
type NonDecimalCellTypeV1 = Exclude<CatalogWorkbookCellTypeV1, DecimalCellTypeV1>
const column = (key: string, type: NonDecimalCellTypeV1): CatalogWorkbookColumnV1 => ({ key, type })
const decimal = (key: string, type: DecimalCellTypeV1, precision: number): CatalogWorkbookColumnV1 => ({ key, type, precision })
export const catalogExportTextColumnV1 = (key: string): CatalogWorkbookColumnV1 => column(key, 'text')
const enumCell = (key: string) => column(key, 'enum')
const integer = (key: string) => column(key, 'integer')

const EXPORT_COLUMNS = {
  Items: [
    catalogExportTextColumnV1('corporate_sku'),
    enumCell('item_kind'),
    catalogExportTextColumnV1('name'),
    catalogExportTextColumnV1('description'),
    catalogExportTextColumnV1('image_url'),
    catalogExportTextColumnV1('brand'),
    catalogExportTextColumnV1('manufacturer'),
    catalogExportTextColumnV1('family'),
    catalogExportTextColumnV1('subfamily'),
    catalogExportTextColumnV1('presentation'),
    enumCell('unit'),
    enumCell('product_type'),
    decimal('iva_rate', 'decimal4', 5),
    catalogExportTextColumnV1('sat_product_key'),
    catalogExportTextColumnV1('sat_unit_key'),
    catalogExportTextColumnV1('objeto_imp'),
    enumCell('ieps_mode'),
    decimal('ieps_rate', 'decimal6', 7),
    decimal('ieps_quota', 'decimal4', 12),
    catalogExportTextColumnV1('ieps_quota_unit'),
    enumCell('status'),
    catalogExportTextColumnV1('created_by'),
    column('created_at', 'timestamp'),
    catalogExportTextColumnV1('updated_by'),
    column('updated_at', 'timestamp'),
  ],
  OrganizationValues: [
    catalogExportTextColumnV1('corporate_sku'),
    enumCell('value_type'),
    decimal('amount', 'decimal2', 10),
    catalogExportTextColumnV1('currency'),
    integer('revision'),
  ],
  BusinessTypes: [catalogExportTextColumnV1('corporate_sku'), enumCell('business_type')],
  VenueBindings: [
    catalogExportTextColumnV1('corporate_sku'),
    catalogExportTextColumnV1('venue_id'),
    catalogExportTextColumnV1('venue_name'),
    catalogExportTextColumnV1('product_id'),
    catalogExportTextColumnV1('local_sku'),
    enumCell('binding_status'),
    catalogExportTextColumnV1('category_id'),
    integer('last_published_revision'),
  ],
  PreparedDishDetails: [
    catalogExportTextColumnV1('corporate_sku'),
    catalogExportTextColumnV1('venue_id'),
    catalogExportTextColumnV1('product_id'),
    catalogExportTextColumnV1('recipe_id'),
    integer('portion_yield'),
    integer('prep_time_minutes'),
    decimal('total_recipe_cost', 'decimal4', 10),
    decimal('cost_per_portion', 'decimal4', 10),
    catalogExportTextColumnV1('currency'),
    enumCell('recipe_status'),
  ],
  Identifiers: [
    catalogExportTextColumnV1('corporate_sku'),
    catalogExportTextColumnV1('code'),
    enumCell('format'),
    enumCell('status'),
    catalogExportTextColumnV1('created_by'),
    column('created_at', 'timestamp'),
  ],
  Regions: [
    catalogExportTextColumnV1('price_region_id'),
    catalogExportTextColumnV1('price_region_name'),
    catalogExportTextColumnV1('venue_id'),
    catalogExportTextColumnV1('venue_name'),
    integer('priority'),
    column('active', 'boolean'),
  ],
  RegionalValues: [
    catalogExportTextColumnV1('corporate_sku'),
    enumCell('value_type'),
    catalogExportTextColumnV1('venue_id'),
    enumCell('source_scope'),
    catalogExportTextColumnV1('source_region_id'),
    catalogExportTextColumnV1('source_region_name'),
    integer('region_priority'),
    decimal('amount', 'decimal2', 10),
    catalogExportTextColumnV1('currency'),
  ],
  RequiredFields: [
    integer('profile_version'),
    enumCell('business_type'),
    catalogExportTextColumnV1('field'),
    column('required', 'boolean'),
    enumCell('source'),
  ],
} satisfies Record<string, CatalogWorkbookColumnV1[]>

const EXPORT_GRAINS = {
  Items: ['corporate_sku'],
  OrganizationValues: ['corporate_sku', 'value_type', 'currency'],
  BusinessTypes: ['corporate_sku', 'business_type'],
  VenueBindings: ['corporate_sku', 'venue_id'],
  PreparedDishDetails: ['corporate_sku', 'venue_id'],
  Identifiers: ['corporate_sku', 'code'],
  Regions: ['price_region_id', 'venue_id'],
  RegionalValues: ['corporate_sku', 'value_type', 'venue_id'],
  RequiredFields: ['profile_version', 'business_type', 'field'],
} satisfies Record<keyof typeof EXPORT_COLUMNS, string[]>

export function failCatalogExportCapacityV1(details?: unknown): never {
  throw new AppError(
    `La exportación excede el límite de ${CATALOG_EXPORT_HYDRATED_ROW_CAP_V1} filas; reduce el filtro y vuelve a intentar.`,
    413,
    true,
    'CATALOG_EXPORT_CAP_EXCEEDED',
    details,
  )
}

export function failCatalogExportDataV1(message: string, code = 'CATALOG_EXPORT_DATA_INVALID'): never {
  throw new AppError(message, 409, true, code)
}

export function catalogExportProfileVersionsV1(profiles: ReadonlyArray<{ profileVersion: number }>): string {
  const versions = [...new Set(profiles.map(profile => profile.profileVersion))]
  if (versions.some(version => !Number.isSafeInteger(version) || version < 1 || version > 2_147_483_647)) {
    return failCatalogExportDataV1('La versión de un perfil activo no es válida.', 'CATALOG_EXPORT_PROFILE_INVALID')
  }
  versions.sort((left, right) => left - right)
  const value = versions.length ? versions.join(',') : '1'
  if (value.length > CATALOG_EXPORT_WORKBOOK_LIMITS_V1.maxTextLength) {
    return failCatalogExportCapacityV1({ grain: 'Metadata.profileVersion' })
  }
  return value
}

function normalizeProfileFields(fields: string[]): string[] {
  if (!Array.isArray(fields) || fields.some(field => typeof field !== 'string')) {
    return failCatalogExportDataV1('Los campos de un perfil activo no son válidos.', 'CATALOG_EXPORT_PROFILE_INVALID')
  }
  if (fields.length > CATALOG_EXPORT_WORKBOOK_LIMITS_V1.maxDataRows) failCatalogExportCapacityV1({ grain: 'RequiredFields' })
  const normalized = fields.map(field => field.normalize('NFC').trim())
  if (normalized.some(field => !field || field.length > 128)) {
    return failCatalogExportDataV1('Los campos de un perfil activo no son válidos.', 'CATALOG_EXPORT_PROFILE_INVALID')
  }
  return [...new Set(normalized)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
}

export function catalogExportRequiredFieldRowsV1(
  businessType: BusinessType,
  profiles: ReadonlyArray<{ profileVersion: number; rulesSchemaVersion: number; requiredFields: string[] }>,
): Array<Record<string, CatalogWorkbookValueV1>> {
  const rows = new Map<string, Record<string, CatalogWorkbookValueV1>>()
  const insert = (version: number, field: string, source: 'CONTRACT' | 'PROFILE') => {
    const key = `${version}\u0000${businessType}\u0000${field}`
    const existing = rows.get(key)
    if (existing?.source === 'CONTRACT' || (existing && existing.source === source)) return
    if (existing && source !== 'CONTRACT') {
      return failCatalogExportDataV1('Los perfiles activos contienen un grano contradictorio.', 'CATALOG_EXPORT_PROFILE_INVALID')
    }
    if (rows.size >= CATALOG_EXPORT_WORKBOOK_LIMITS_V1.maxDataRows) failCatalogExportCapacityV1({ grain: 'RequiredFields' })
    rows.set(key, { profile_version: version, business_type: businessType, field, required: true, source })
  }
  for (const field of CATALOG_VALIDATION_BASELINE_V1) insert(1, field, 'CONTRACT')
  for (const profile of profiles) {
    if (profile.rulesSchemaVersion !== 1) {
      return failCatalogExportDataV1('Un perfil activo usa una versión de reglas no soportada.', 'CATALOG_EXPORT_PROFILE_INVALID')
    }
    for (const field of normalizeProfileFields(profile.requiredFields)) insert(profile.profileVersion, field, 'PROFILE')
  }
  return [...rows.values()]
}

export function catalogExportSheetV1(
  name: keyof typeof EXPORT_COLUMNS,
  rows: Array<Record<string, CatalogWorkbookValueV1>>,
): CatalogWorkbookSheetV1 {
  return { name, grain: EXPORT_GRAINS[name], columns: EXPORT_COLUMNS[name], rows }
}
