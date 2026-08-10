import { BusinessType, CatalogItemKind, CatalogItemPriceKind, CatalogReferenceStatus, ProductType } from '@prisma/client'
import type { ParsedMasterCatalogWorkbook, ParsedWorkbookRow } from '../../workers/masterCatalogXlsx.worker'
import type { CatalogImportCooperativeCheckpoint } from './catalogImportCanonical.service'
import type { CatalogReferenceProposal } from './catalogItem.types'
import { isCatalogUnicodeScalarTextV1, normalizeCatalogCorporateSkuV1 } from './identifierNormalization.service'
import {
  addCatalogImportFinding,
  addCatalogImportFindingOnce,
  readCatalogImportDecimal,
  readCatalogImportRevision,
  readCatalogImportText,
  validateCatalogImportCurrencyCell,
  validateCatalogImportMoneyCell,
} from './catalogImportFieldValidation.service'
import { normalizeCatalogReferenceNameV1 } from './catalogReference.service'
import { validateCatalogProductTypeV1 } from './catalogProductType.service'
import { resolveCatalogRequiredFieldsV1 } from './catalogValidation.service'
import { catalogImportProposalMarkerV1 } from './catalogImportStagedPayload.service'
import { findIncompleteCatalogImportCurrencyPairsV1 } from './catalogImportStagedCollections.service'
import type { CatalogImportDependencySnapshotV1, CatalogImportRowError } from './catalogImport.types'

export type { CatalogImportCooperativeCheckpoint } from './catalogImportCanonical.service'

interface CatalogImportCanonicalLineSource {
  sourceSheet: string
  sourceRow: number
  status: string
  payload: unknown
  errors?: unknown
  catalogItemId?: unknown
}

const CATALOG_IMPORT_FINDING_SHEETS = new Set(['Metadata', 'Items', 'OrganizationValues', 'BusinessTypes', 'VenueBindingRequests'])

function isClosedCatalogImportFinding(value: unknown): value is CatalogImportRowError {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const finding = value as Record<string, unknown>
  const keys = Object.keys(finding).sort()
  const expected = [
    'column',
    'error_code',
    'message',
    ...(Object.prototype.hasOwnProperty.call(finding, 'rejected_value') ? ['rejected_value'] : []),
    'source_row',
    'source_sheet',
    'suggestion',
  ].sort()
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index]) &&
    typeof finding.source_sheet === 'string' &&
    CATALOG_IMPORT_FINDING_SHEETS.has(finding.source_sheet) &&
    Number.isInteger(finding.source_row) &&
    (finding.source_row as number) >= 1 &&
    (finding.source_row as number) <= 2_147_483_647 &&
    typeof finding.column === 'string' &&
    finding.column.trim().length > 0 &&
    finding.column.length <= 128 &&
    typeof finding.error_code === 'string' &&
    /^[A-Z0-9_]{1,128}$/u.test(finding.error_code) &&
    typeof finding.message === 'string' &&
    finding.message.trim().length > 0 &&
    finding.message.length <= 512 &&
    typeof finding.suggestion === 'string' &&
    finding.suggestion.trim().length > 0 &&
    finding.suggestion.length <= 512 &&
    (!Object.prototype.hasOwnProperty.call(finding, 'rejected_value') ||
      (typeof finding.rejected_value === 'string' && isCatalogUnicodeScalarTextV1(finding.rejected_value, 128)))
  )
}

export function projectCatalogImportCanonicalLineV1(value: unknown): Record<string, unknown> {
  // WHY: Preview and confirm hash the same bounded staged projection even
  // though Prisma reads a JSON null where preview holds an empty error array.
  const line = value as CatalogImportCanonicalLineSource
  const errors = line.errors === null || line.errors === undefined ? [] : line.errors
  if (!Array.isArray(errors) || errors.length > 128 || errors.some(error => !isClosedCatalogImportFinding(error))) {
    throw new Error('CATALOG_IMPORT_STAGING_INVALID')
  }
  if ((line.status === 'READY' || line.status === 'APPLIED') && errors.length !== 0) {
    // WHY: A matching target hash cannot legitimize malformed findings on an
    // executable line; READY/APPLIED authority is necessarily error-free.
    throw new Error('CATALOG_IMPORT_STAGING_INVALID')
  }
  if (line.status === 'INVALID' && errors.length === 0) throw new Error('CATALOG_IMPORT_STAGING_INVALID')
  if (!['READY', 'INVALID', 'APPLIED'].includes(line.status)) throw new Error('CATALOG_IMPORT_STAGING_INVALID')
  return {
    sourceSheet: line.sourceSheet,
    sourceRow: line.sourceRow,
    status: line.status,
    payload: line.payload,
    errors,
    catalogItemId: typeof line.catalogItemId === 'string' ? line.catalogItemId : null,
  }
}

export interface CatalogImportReferenceRow {
  id: string
  name: string
  normalizedName: string
  status: CatalogReferenceStatus
  revision: number
  parentId?: string | null
}

export interface CatalogImportReferenceResolutionState {
  capturedReferences: Set<string>
  proposedReferences: Set<string>
  familyParentByNormalizedName: Map<string, string | null>
}

export async function validateCatalogImportMetadata(
  workbook: ParsedMasterCatalogWorkbook,
  organizationId: string,
  checkpoint: CatalogImportCooperativeCheckpoint,
): Promise<CatalogImportRowError[]> {
  const errors: CatalogImportRowError[] = []
  const rows = workbook.sheets.Metadata?.rows ?? []
  const metadata = new Map<string, { value: string; row: ParsedWorkbookRow }>()
  for (const row of rows) {
    await checkpoint()
    const key = readCatalogImportText(errors, 'Metadata', row, 'key')
    const value = readCatalogImportText(errors, 'Metadata', row, 'value')
    if (!key || value === null) continue
    if (metadata.has(key)) addCatalogImportFinding(errors, 'Metadata', row.sourceRow, 'key', 'CATALOG_WORKBOOK_DUPLICATE', row.values.key)
    else metadata.set(key, { value, row })
  }
  const required = {
    documentType: 'catalog-master-import',
    schemaVersion: '1',
    organizationId,
    timezone: 'America/Mexico_City',
  }
  for (const [key, expected] of Object.entries(required)) {
    const actual = metadata.get(key)
    if (actual?.value === expected) continue
    const code = key === 'schemaVersion' ? 'CATALOG_WORKBOOK_SCHEMA_UNSUPPORTED' : 'CATALOG_WORKBOOK_METADATA_INVALID'
    addCatalogImportFinding(errors, 'Metadata', actual?.row.sourceRow ?? 1, 'value', code, actual?.row.values.value)
  }
  return errors
}

export async function groupCatalogImportRows(
  workbook: ParsedMasterCatalogWorkbook,
  sheet: 'OrganizationValues' | 'BusinessTypes' | 'VenueBindingRequests',
  errors: CatalogImportRowError[],
  checkpoint: CatalogImportCooperativeCheckpoint,
): Promise<Map<string, ParsedWorkbookRow[]>> {
  const grouped = new Map<string, ParsedWorkbookRow[]>()
  for (const row of workbook.sheets[sheet]?.rows ?? []) {
    await checkpoint()
    const sku = readCatalogImportText(errors, sheet, row, 'corporate_sku')
    let identity = `@invalid-row:${sheet}:${row.sourceRow}`
    if (sku) {
      try {
        identity = normalizeCatalogCorporateSkuV1({ code: sku, format: 'SKU' }).normalizedCode
      } catch {
        addCatalogImportFindingOnce(errors, sheet, row.sourceRow, 'corporate_sku', 'CATALOG_IDENTIFIER_INVALID', row.values.corporate_sku)
      }
    }
    // WHY: All workbook sheets join through Task 5's single NFKC/trim/uppercase
    // corporate-SKU identity; raw spelling is retained only in diagnostics.
    const rows = grouped.get(identity) ?? []
    rows.push(row)
    grouped.set(identity, rows)
  }
  return grouped
}

export function resolveCatalogImportReference(
  type: 'BRAND' | 'MANUFACTURER' | 'FAMILY',
  name: string,
  rowsByNormalizedName: ReadonlyMap<string, readonly CatalogImportReferenceRow[]>,
  row: ParsedWorkbookRow,
  column: string,
  errors: CatalogImportRowError[],
  proposals: CatalogReferenceProposal[],
  dependencies: CatalogImportDependencySnapshotV1,
  state: CatalogImportReferenceResolutionState,
  parentId?: string | null,
): string {
  let normalized: { name: string; normalizedName: string }
  try {
    normalized = normalizeCatalogReferenceNameV1(name)
  } catch {
    addCatalogImportFindingOnce(errors, 'Items', row.sourceRow, column, 'CATALOG_REFERENCE_NAME_INVALID', row.values[column])
    return `@invalid:${type}:${row.sourceRow}:${column}`
  }
  const matches = rowsByNormalizedName.get(normalized.normalizedName) ?? []
  if (matches.length > 1) {
    addCatalogImportFinding(errors, 'Items', row.sourceRow, column, 'CATALOG_REFERENCE_AMBIGUOUS', row.values[column])
    return `@invalid:${type}:${normalized.normalizedName}`
  }
  const match = matches[0]
  if (match) {
    if (match.status !== CatalogReferenceStatus.ACTIVE) {
      addCatalogImportFinding(errors, 'Items', row.sourceRow, column, 'CATALOG_REFERENCE_RETIRED', row.values[column])
    } else if (type === 'FAMILY' && parentId !== undefined && (match.parentId ?? null) !== parentId) {
      // WHY: An active globally unique FAMILY under another parent is a
      // hierarchy collision, not a lifecycle error the user could “activate”.
      addCatalogImportFindingOnce(errors, 'Items', row.sourceRow, column, 'CATALOG_FAMILY_HIERARCHY_CONFLICT', row.values[column])
    }
    const dependencyKey = `${type}:${match.id}`
    if (!state.capturedReferences.has(dependencyKey)) {
      state.capturedReferences.add(dependencyKey)
      dependencies.references.push({ type, id: match.id, revision: match.revision })
    }
    return match.id
  }
  const proposal = {
    operation: 'CREATE' as const,
    referenceType: type,
    name,
    ...(type === 'FAMILY' ? { parentId: parentId ?? null } : {}),
  }
  const marker = catalogImportProposalMarkerV1(proposal)
  const proposalKey = `${type}:${normalized.normalizedName}`
  if (type === 'FAMILY') {
    const parentIdentity = parentId ?? null
    const capturedParent = state.familyParentByNormalizedName.get(normalized.normalizedName)
    if (state.familyParentByNormalizedName.has(normalized.normalizedName) && capturedParent !== parentIdentity) {
      // WHY: CatalogFamily is globally unique by normalized name inside an org;
      // one name cannot be reviewed under two parents or as its own leaf.
      addCatalogImportFindingOnce(errors, 'Items', row.sourceRow, column, 'CATALOG_FAMILY_HIERARCHY_CONFLICT', row.values[column])
    } else {
      state.familyParentByNormalizedName.set(normalized.normalizedName, parentIdentity)
    }
  }
  state.proposedReferences.add(proposalKey)
  if (!proposals.some(existing => catalogImportProposalMarkerV1(existing as typeof proposal) === marker)) proposals.push(proposal)
  return marker
}

export function resolveCatalogImportProductType(
  raw: string,
  kind: CatalogItemKind,
  mappingsByAlias: ReadonlyMap<string, readonly Record<string, unknown>[]>,
  row: ParsedWorkbookRow,
  errors: CatalogImportRowError[],
  dependencies: CatalogImportDependencySnapshotV1,
  capturedMappings: Set<string>,
): ProductType {
  if (Object.values(ProductType).includes(raw as ProductType)) {
    const canonical = raw as ProductType
    try {
      return validateCatalogProductTypeV1({ kind, productType: canonical })
    } catch {
      addCatalogImportFinding(errors, 'Items', row.sourceRow, 'product_type', 'CATALOG_PRODUCT_TYPE_INVALID', row.values.product_type)
      return ProductType.REGULAR
    }
  }
  const matches = (mappingsByAlias.get(raw) ?? []).filter(mapping => mapping.active !== false)
  if (matches.length !== 1) {
    addCatalogImportFinding(
      errors,
      'Items',
      row.sourceRow,
      'product_type',
      matches.length ? 'CATALOG_PRODUCT_TYPE_MAPPING_AMBIGUOUS' : 'CATALOG_PRODUCT_TYPE_MAPPING_MISSING',
      row.values.product_type,
    )
    return ProductType.REGULAR
  }
  const mapping = matches[0] as {
    id: string
    catalogProductType: string
    productType: ProductType
    mappingVersion: number
    active: true
  }
  if (!capturedMappings.has(mapping.id)) {
    // WHY: Mapping aliases have no immutable DB guard, so preview captures the
    // full materialized interpretation rather than trusting version etiquette.
    capturedMappings.add(mapping.id)
    dependencies.mappings.push({
      id: mapping.id,
      catalogProductType: mapping.catalogProductType,
      productType: mapping.productType,
      mappingVersion: mapping.mappingVersion,
      active: true,
    })
  }
  try {
    return validateCatalogProductTypeV1({ kind, productType: mapping.productType })
  } catch {
    addCatalogImportFinding(errors, 'Items', row.sourceRow, 'product_type', 'CATALOG_PRODUCT_TYPE_INVALID', row.values.product_type)
    return ProductType.REGULAR
  }
}

export async function parseCatalogImportOrganizationValues(
  rows: readonly ParsedWorkbookRow[],
  operation: 'CREATE' | 'UPDATE',
  errors: CatalogImportRowError[],
  checkpoint: CatalogImportCooperativeCheckpoint,
): Promise<Array<{ kind: CatalogItemPriceKind; amount: string; currency: string; expectedRuleRevision?: number }>> {
  const errorsBeforeRows = errors.length
  const result: Array<{ kind: CatalogItemPriceKind; amount: string; currency: string; expectedRuleRevision?: number }> = []
  const keys = new Set<string>()
  const rowByCurrency = new Map<string, ParsedWorkbookRow>()
  for (const row of rows) {
    await checkpoint()
    const kind = readCatalogImportText(errors, 'OrganizationValues', row, 'value_type')
    const amount = readCatalogImportDecimal(errors, 'OrganizationValues', row, 'amount')
    const currency = readCatalogImportText(errors, 'OrganizationValues', row, 'currency')
    const revision = readCatalogImportRevision(errors, 'OrganizationValues', row, 'expected_rule_revision', true)
    const validKind = kind === 'SALE_PRICE' || kind === 'PURCHASE_COST'
    if (kind && !validKind) {
      addCatalogImportFindingOnce(
        errors,
        'OrganizationValues',
        row.sourceRow,
        'value_type',
        'CATALOG_VALUE_KIND_INVALID',
        row.values.value_type,
      )
    }
    const currencyValid = currency ? validateCatalogImportCurrencyCell(errors, 'OrganizationValues', row, 'currency', currency) : false
    const canonicalAmount = amount ? validateCatalogImportMoneyCell(errors, 'OrganizationValues', row, 'amount', amount) : null
    if (operation === 'CREATE' && revision !== null) {
      addCatalogImportFindingOnce(
        errors,
        'OrganizationValues',
        row.sourceRow,
        'expected_rule_revision',
        'CATALOG_VALUE_REVISION_INVALID',
        row.values.expected_rule_revision,
      )
    }
    if (!validKind || !canonicalAmount || !currency || !currencyValid) continue
    const key = `${kind}:${currency}`
    if (keys.has(key))
      addCatalogImportFinding(
        errors,
        'OrganizationValues',
        row.sourceRow,
        'value_type',
        'CATALOG_WORKBOOK_DUPLICATE',
        row.values.value_type,
      )
    keys.add(key)
    result.push({
      kind,
      amount: canonicalAmount,
      currency,
      ...(operation === 'UPDATE' && revision !== null ? { expectedRuleRevision: revision } : {}),
    })
    if (!rowByCurrency.has(currency)) rowByCurrency.set(currency, row)
  }
  if (rowByCurrency.size === 0 && errors.length === errorsBeforeRows) {
    const source = rows[0]
    // WHY: Many Items may all miss the same ancillary sheet; the shared
    // synthetic coordinate carries one actionable finding, not one duplicate
    // per Item that could exceed the closed 128-findings line envelope.
    addCatalogImportFindingOnce(
      errors,
      'OrganizationValues',
      source?.sourceRow ?? 1,
      'value_type',
      'CATALOG_VALUE_PAIR_REQUIRED',
      source?.values.value_type,
    )
  }
  for (const counts of findIncompleteCatalogImportCurrencyPairsV1(result)) {
    await checkpoint()
    const row = rowByCurrency.get(counts.currency)
    if (!row) continue
    const missing = counts.saleCount === 0 ? 'SALE_PRICE' : counts.purchaseCount === 0 ? 'PURCHASE_COST' : 'una sola fila por tipo'
    // WHY: Each incomplete currency points to one row in that currency rather
    // than blaming the first valid pair from another currency.
    addCatalogImportFinding(
      errors,
      'OrganizationValues',
      row.sourceRow,
      'currency',
      'CATALOG_VALUE_PAIR_REQUIRED',
      row.values.currency,
      `Agrega ${missing} para ${counts.currency}.`,
    )
  }
  return result
}

export async function addCatalogImportOrganizationRevisionFindings(
  rows: readonly ParsedWorkbookRow[],
  values: readonly { kind: CatalogItemPriceKind; currency: string; expectedRuleRevision?: number }[],
  currentPrices: readonly { kind: string; currency: string; revision: number }[],
  errors: CatalogImportRowError[],
  checkpoint: CatalogImportCooperativeCheckpoint,
): Promise<void> {
  const currentByKey = new Map<string, (typeof currentPrices)[number]>()
  for (const value of currentPrices) {
    currentByKey.set(`${value.kind}:${value.currency}`, value)
    await checkpoint()
  }
  const rowByKey = new Map<string, ParsedWorkbookRow>()
  for (const row of rows) {
    const kind = row.values.value_type
    const currency = row.values.currency
    if (kind?.kind === 'TEXT' && currency?.kind === 'TEXT') rowByKey.set(`${kind.value}:${currency.value}`, row)
    await checkpoint()
  }
  // WHY: Retained value CAS belongs to its exact (kind,currency) ancillary row;
  // missing/stale revisions never collapse into an Items/name finding.
  for (const value of values) {
    await checkpoint()
    const key = `${value.kind}:${value.currency}`
    const current = currentByKey.get(key)
    const revisionMatches = current ? value.expectedRuleRevision === current.revision : value.expectedRuleRevision === undefined
    if (revisionMatches) continue
    const row = rowByKey.get(key)
    addCatalogImportFindingOnce(
      errors,
      'OrganizationValues',
      row?.sourceRow ?? rows[0]?.sourceRow ?? 1,
      'expected_rule_revision',
      'CATALOG_VALUE_REVISION_CONFLICT',
      row?.values.expected_rule_revision,
    )
  }
}

export async function parseCatalogImportBusinessTypes(
  rows: readonly ParsedWorkbookRow[],
  errors: CatalogImportRowError[],
  checkpoint: CatalogImportCooperativeCheckpoint,
): Promise<BusinessType[]> {
  const values: BusinessType[] = []
  for (const row of rows) {
    await checkpoint()
    const value = readCatalogImportText(errors, 'BusinessTypes', row, 'business_type')
    if (!value || !Object.values(BusinessType).includes(value as BusinessType)) {
      addCatalogImportFinding(
        errors,
        'BusinessTypes',
        row.sourceRow,
        'business_type',
        'CATALOG_BUSINESS_TYPE_INVALID',
        row.values.business_type,
      )
      continue
    }
    if (values.includes(value as BusinessType))
      addCatalogImportFinding(
        errors,
        'BusinessTypes',
        row.sourceRow,
        'business_type',
        'CATALOG_WORKBOOK_DUPLICATE',
        row.values.business_type,
      )
    else values.push(value as BusinessType)
  }
  if (!values.length) {
    addCatalogImportFindingOnce(errors, 'BusinessTypes', rows[0]?.sourceRow ?? 1, 'business_type', 'CATALOG_BUSINESS_TYPE_INVALID')
  }
  return values
}

export function addCatalogImportProfileFindings(
  profiles: Array<Record<string, unknown>>,
  businessTypes: BusinessType[],
  availableFields: ReadonlySet<string>,
  row: ParsedWorkbookRow,
  errors: CatalogImportRowError[],
): void {
  const activeProfiles = profiles.filter(profile => profile.active !== false)
  const applicable = activeProfiles.filter(
    profile =>
      (profile.businessType === null || businessTypes.includes(profile.businessType as BusinessType)) && profile.operationalRole === null,
  )
  const unsupported = applicable.some(profile => profile.rulesSchemaVersion !== 1 || (profile.additionalRules ?? null) !== null)
  if (unsupported) {
    // WHY: Task 7 cannot silently ignore future rule schemas or arbitrary
    // additionalRules; the human preview stays fail-closed until an evaluator exists.
    addCatalogImportFindingOnce(errors, 'Items', row.sourceRow, 'business_type', 'CATALOG_VALIDATION_RULE_UNSUPPORTED')
    return
  }
  let required: string[]
  try {
    required = resolveCatalogRequiredFieldsV1({ businessTypes, operationalRole: null, profiles: applicable as never })
  } catch {
    addCatalogImportFindingOnce(errors, 'Items', row.sourceRow, 'business_type', 'CATALOG_VALIDATION_RULE_UNSUPPORTED')
    return
  }
  for (const field of required) {
    if (!availableFields.has(field)) addCatalogImportFinding(errors, 'Items', row.sourceRow, field, 'CATALOG_PROFILE_FIELD_MISSING')
  }
}
