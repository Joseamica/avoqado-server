import { CatalogIepsMode, CatalogItemKind, Unit } from '@prisma/client'
import type { ParsedWorkbookRow } from '../../workers/masterCatalogXlsx.worker'
import type { CatalogImportCooperativeCheckpoint } from './catalogImportCanonical.service'
import {
  addCatalogImportFinding,
  addCatalogImportFindingOnce,
  addCatalogImportItemFieldFindings,
  readCatalogImportDecimal,
  readCatalogImportRevision,
  readCatalogImportText,
} from './catalogImportFieldValidation.service'
import type { CatalogImportItemLookupRow, CatalogImportLookup } from './catalogImportLookup.service'
import type { CatalogImportDependencySnapshotV1, CatalogImportRowError } from './catalogImport.types'
import { normalizeCatalogCorporateSkuV1 } from './identifierNormalization.service'

export interface CatalogImportItemScalarFieldsV1 {
  kind: CatalogItemKind
  name: string
  description: string
  imageUrl: string
  brandName: string
  manufacturerName: string
  familyName: string
  subfamilyName: string
  presentationLabel: string
  unit: Unit
  productTypeRaw: string
  taxRate: string
  satProductKey: string
  satUnitKey: string
  objetoImp: string
  iepsMode: CatalogIepsMode
  iepsRate: string | null
  iepsQuota: string | null
  iepsQuotaUnit: Unit | null
}

export interface CatalogImportItemRowV1 {
  operation: 'CREATE' | 'UPDATE' | 'RETIRE'
  operationIsValid: boolean
  sku: string
  normalizedSku: string
  catalogItemId: string | null
  expectedRevision: number | null
  expectedRevisionProvided: boolean
  scalar: CatalogImportItemScalarFieldsV1 | null
}

export interface CatalogImportItemIdentityStateV1 {
  seenSkus: Set<string>
  seenTargetIds: Set<string>
  capturedItemIds: Set<string>
  capturedPriceItemIds: Set<string>
}

export interface CatalogImportItemIdentityResultV1 {
  current: CatalogImportItemLookupRow | undefined
  duplicateSku: boolean
}

export function parseCatalogImportItemRowV1(row: ParsedWorkbookRow, errors: CatalogImportRowError[]): CatalogImportItemRowV1 {
  // WHY: Every Items row receives one complete scalar/identity pass before an
  // aggregate join decision; duplicate SKUs can skip children without hiding
  // independent repairable cells.
  const operationValue = readCatalogImportText(errors, 'Items', row, 'operation')
  const operationIsValid = operationValue === 'CREATE' || operationValue === 'UPDATE' || operationValue === 'RETIRE'
  if (!operationIsValid) {
    addCatalogImportFinding(errors, 'Items', row.sourceRow, 'operation', 'CATALOG_IMPORT_OPERATION_INVALID', row.values.operation)
  }
  const operation: CatalogImportItemRowV1['operation'] = operationIsValid ? operationValue : 'CREATE'
  const skuValue = readCatalogImportText(errors, 'Items', row, 'corporate_sku')
  const sku = skuValue ?? `@invalid-row-${row.sourceRow}`
  let normalizedSku = sku
  if (skuValue) {
    try {
      normalizedSku = normalizeCatalogCorporateSkuV1({ code: skuValue, format: 'SKU' }).normalizedCode
    } catch {
      addCatalogImportFinding(errors, 'Items', row.sourceRow, 'corporate_sku', 'CATALOG_IDENTIFIER_INVALID', row.values.corporate_sku)
    }
  }
  const catalogItemId = readCatalogImportText(errors, 'Items', row, 'catalog_item_id', true)
  const expectedRevision = readCatalogImportRevision(errors, 'Items', row, 'expected_revision', true)
  const expectedRevisionProvided = row.values.expected_revision !== undefined && row.values.expected_revision.kind !== 'BLANK'
  if (operation === 'RETIRE') {
    return {
      operation,
      operationIsValid,
      sku,
      normalizedSku,
      catalogItemId,
      expectedRevision,
      expectedRevisionProvided,
      scalar: null,
    }
  }

  const kindRaw = readCatalogImportText(errors, 'Items', row, 'item_kind')
  const kind = Object.values(CatalogItemKind).includes(kindRaw as CatalogItemKind)
    ? (kindRaw as CatalogItemKind)
    : CatalogItemKind.RETAIL_PRODUCT
  if (kindRaw !== kind) {
    addCatalogImportFinding(errors, 'Items', row.sourceRow, 'item_kind', 'CATALOG_ITEM_KIND_INVALID', row.values.item_kind)
  }
  const scalar: CatalogImportItemScalarFieldsV1 = {
    kind,
    name: readCatalogImportText(errors, 'Items', row, 'name') ?? '',
    description: readCatalogImportText(errors, 'Items', row, 'description') ?? '',
    imageUrl: readCatalogImportText(errors, 'Items', row, 'image_url') ?? '',
    brandName: readCatalogImportText(errors, 'Items', row, 'brand') ?? '@invalid',
    manufacturerName: readCatalogImportText(errors, 'Items', row, 'manufacturer') ?? '@invalid',
    familyName: readCatalogImportText(errors, 'Items', row, 'family') ?? '@invalid',
    subfamilyName: readCatalogImportText(errors, 'Items', row, 'subfamily') ?? '@invalid',
    presentationLabel: readCatalogImportText(errors, 'Items', row, 'presentation') ?? '',
    unit: (readCatalogImportText(errors, 'Items', row, 'unit') ?? Unit.UNIT) as Unit,
    productTypeRaw: readCatalogImportText(errors, 'Items', row, 'product_type') ?? '@invalid',
    taxRate: readCatalogImportDecimal(errors, 'Items', row, 'iva_rate') ?? '0',
    satProductKey: readCatalogImportText(errors, 'Items', row, 'sat_product_key') ?? '',
    satUnitKey: readCatalogImportText(errors, 'Items', row, 'sat_unit_key') ?? '',
    objetoImp: readCatalogImportText(errors, 'Items', row, 'objeto_imp') ?? '',
    iepsMode: (readCatalogImportText(errors, 'Items', row, 'ieps_mode') ?? CatalogIepsMode.NONE) as CatalogIepsMode,
    iepsRate: readCatalogImportDecimal(errors, 'Items', row, 'ieps_rate', true),
    iepsQuota: readCatalogImportDecimal(errors, 'Items', row, 'ieps_quota', true),
    iepsQuotaUnit: readCatalogImportText(errors, 'Items', row, 'ieps_quota_unit', true) as Unit | null,
  }
  addCatalogImportItemFieldFindings(scalar, row, errors)
  return {
    operation,
    operationIsValid,
    sku,
    normalizedSku,
    catalogItemId,
    expectedRevision,
    expectedRevisionProvided,
    scalar,
  }
}

function captureCurrentItem(
  current: CatalogImportItemLookupRow | undefined,
  operation: CatalogImportItemRowV1['operation'],
  snapshot: CatalogImportDependencySnapshotV1,
  state: CatalogImportItemIdentityStateV1,
): void {
  if (!current || state.capturedItemIds.has(current.id)) return
  state.capturedItemIds.add(current.id)
  snapshot.items.push({
    id: current.id,
    revision: current.revision,
    invariantVersion: current.invariantVersion.toString(),
    status: current.status as 'ACTIVE' | 'RETIRED',
    businessTypes: current.businessTypes.map(value => value.businessType).sort(),
  })
  if (operation === 'UPDATE' && !state.capturedPriceItemIds.has(current.id)) {
    // WHY: An UPDATE with an empty captured value set must still detect a new
    // active rule, while RETIRE remains independent from price evolution.
    state.capturedPriceItemIds.add(current.id)
    snapshot.priceDependentItemIds.push(current.id)
  }
}

export function validateCatalogImportItemIdentityV1(
  row: ParsedWorkbookRow,
  parsed: CatalogImportItemRowV1,
  lookup: CatalogImportLookup,
  snapshot: CatalogImportDependencySnapshotV1,
  state: CatalogImportItemIdentityStateV1,
  errors: CatalogImportRowError[],
): CatalogImportItemIdentityResultV1 {
  // WHY: Identity/status/revision diagnostics run for every physical Items
  // row before duplicate aggregates are cut, preserving the complete repair set.
  const duplicateSku = state.seenSkus.has(parsed.normalizedSku)
  if (duplicateSku) {
    addCatalogImportFindingOnce(errors, 'Items', row.sourceRow, 'corporate_sku', 'CATALOG_WORKBOOK_DUPLICATE', row.values.corporate_sku)
  }
  state.seenSkus.add(parsed.normalizedSku)

  const current = parsed.catalogItemId ? lookup.itemById.get(parsed.catalogItemId) : undefined
  if (parsed.catalogItemId && parsed.operation !== 'CREATE') {
    if (state.seenTargetIds.has(parsed.catalogItemId)) {
      addCatalogImportFindingOnce(
        errors,
        'Items',
        row.sourceRow,
        'catalog_item_id',
        'CATALOG_WORKBOOK_DUPLICATE',
        row.values.catalog_item_id,
      )
    }
    state.seenTargetIds.add(parsed.catalogItemId)
  }

  if (parsed.operation === 'CREATE') {
    if (parsed.catalogItemId) {
      addCatalogImportFindingOnce(
        errors,
        'Items',
        row.sourceRow,
        'catalog_item_id',
        'CATALOG_IMPORT_IDENTITY_INVALID',
        row.values.catalog_item_id,
      )
    }
    if (parsed.expectedRevisionProvided) {
      addCatalogImportFindingOnce(
        errors,
        'Items',
        row.sourceRow,
        'expected_revision',
        'CATALOG_IMPORT_IDENTITY_INVALID',
        row.values.expected_revision,
      )
    }
    if (lookup.itemByNormalizedSku.has(parsed.normalizedSku)) {
      addCatalogImportFindingOnce(errors, 'Items', row.sourceRow, 'corporate_sku', 'CATALOG_VALUE_ALREADY_EXISTS', row.values.corporate_sku)
    }
    return { current, duplicateSku }
  }

  if (!parsed.catalogItemId || !current) {
    addCatalogImportFindingOnce(errors, 'Items', row.sourceRow, 'catalog_item_id', 'CATALOG_TARGET_NOT_FOUND', row.values.catalog_item_id)
  }
  if (parsed.expectedRevision === null) {
    addCatalogImportFindingOnce(
      errors,
      'Items',
      row.sourceRow,
      'expected_revision',
      'CATALOG_REVISION_INVALID',
      row.values.expected_revision,
    )
  } else if (current && current.revision !== parsed.expectedRevision) {
    addCatalogImportFindingOnce(
      errors,
      'Items',
      row.sourceRow,
      'expected_revision',
      'CATALOG_REVISION_CONFLICT',
      row.values.expected_revision,
    )
  }
  if (current && current.status !== 'ACTIVE') {
    addCatalogImportFindingOnce(errors, 'Items', row.sourceRow, 'catalog_item_id', 'CATALOG_ITEM_RETIRED', row.values.catalog_item_id)
  }
  if (parsed.operation === 'RETIRE' && current && current.normalizedSku !== parsed.normalizedSku) {
    addCatalogImportFindingOnce(
      errors,
      'Items',
      row.sourceRow,
      'corporate_sku',
      'CATALOG_TARGET_IDENTITY_MISMATCH',
      row.values.corporate_sku,
    )
  }
  if (parsed.operation === 'UPDATE') {
    const skuOwner = lookup.itemByNormalizedSku.get(parsed.normalizedSku)
    if (skuOwner && skuOwner.id !== current?.id) {
      addCatalogImportFindingOnce(errors, 'Items', row.sourceRow, 'corporate_sku', 'CATALOG_VALUE_ALREADY_EXISTS', row.values.corporate_sku)
    }
  }
  captureCurrentItem(current, parsed.operation, snapshot, state)
  return { current, duplicateSku }
}

export async function addCatalogImportRetireAncillaryFindingsV1(
  normalizedSku: string,
  groupedRows: ReadonlyArray<
    readonly ['OrganizationValues' | 'BusinessTypes' | 'VenueBindingRequests', ReadonlyMap<string, readonly ParsedWorkbookRow[]>]
  >,
  errors: CatalogImportRowError[],
  checkpoint: CatalogImportCooperativeCheckpoint,
): Promise<void> {
  // WHY: RETIRE is identity-only; each original ancillary coordinate remains
  // reviewable and blocks the bearer instead of being silently discarded.
  for (const [sheet, rowsBySku] of groupedRows) {
    for (const ancillaryRow of rowsBySku.get(normalizedSku) ?? []) {
      addCatalogImportFindingOnce(
        errors,
        sheet,
        ancillaryRow.sourceRow,
        'corporate_sku',
        'CATALOG_RETIRE_ANCILLARY_FORBIDDEN',
        ancillaryRow.values.corporate_sku,
        'Elimina esta fila ancillary para retirar el artículo.',
      )
      const pause = checkpoint()
      if (pause) await pause
    }
  }
}
