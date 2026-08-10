import { BusinessType, CatalogItemPriceKind } from '@prisma/client'
import AppError from '../../errors/AppError'
import type { ParsedMasterCatalogWorkbook, ParsedWorkbookRow } from '../../workers/masterCatalogXlsx.worker'
import { validateCatalogCurrencyV1, validateCatalogExpectedRevision } from './catalogItemValidation.service'
import { parseCatalogMoney } from './catalogMoney.service'
import { createCatalogImportCooperativeCheckpoint, type CatalogImportCooperativeCheckpoint } from './catalogImportCanonical.service'
import type { CatalogOrganizationValueInput } from './catalogItem.types'
import { isCatalogWorkbookTextV1, normalizeCatalogCorporateSkuV1, normalizeCatalogVenueLocalSkuV1 } from './identifierNormalization.service'
import type { CatalogImportStagedLine, CatalogVenueBindingRequestV1 } from './catalogImport.types'
import type { CatalogImportLineRowV1, CatalogImportStagedPayloadV1 } from './catalogImportStagedPayload.service'

const MAX_INTERNAL_ID_LENGTH = 256
const POSTGRES_INT_MAX = 2_147_483_647
const MAX_REVIEW_LINES = 50_000

export interface CatalogImportOrganizationValueReviewV1 {
  schemaVersion: 1
  section: 'ORGANIZATION_VALUES'
  corporateSku: string | null
  kind: CatalogItemPriceKind | null
  amount: string | null
  currency: string | null
  expectedRuleRevision: number | null
}

export interface CatalogImportBusinessTypeReviewV1 {
  schemaVersion: 1
  section: 'BUSINESS_TYPES'
  corporateSku: string | null
  businessType: BusinessType | null
}

export interface CatalogImportVenueBindingReviewV1 {
  schemaVersion: 1
  section: 'VENUE_BINDING_REQUESTS'
  corporateSku: string | null
  venueId: string | null
  requestedAction: CatalogVenueBindingRequestV1['requestedAction'] | null
  productId: string | null
  localSku: string | null
  categoryId: string | null
  initialPrice: string | null
  currency: string | null
}

export type CatalogImportReviewPayloadV1 =
  | CatalogImportOrganizationValueReviewV1
  | CatalogImportBusinessTypeReviewV1
  | CatalogImportVenueBindingReviewV1

function invalidReview(message: string): never {
  throw new AppError(message, 409, true, 'CATALOG_IMPORT_STAGING_INVALID')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort()
  const closed = [...expected].sort()
  return keys.length === closed.length && keys.every((key, index) => key === closed[index])
}

function textCell(row: ParsedWorkbookRow, column: string, maximum?: number): string | null {
  const cell = row.values[column]
  if (cell?.kind !== 'TEXT') return null
  if (maximum === undefined && !isCatalogWorkbookTextV1(cell.value)) return null
  const value = cell.value.trim()
  return value && (maximum === undefined || value.length <= maximum) ? value : null
}

function identifierCell(row: ParsedWorkbookRow, column: string, corporate = false): string | null {
  const raw = textCell(row, column)
  if (!raw) return null
  try {
    const normalize = corporate ? normalizeCatalogCorporateSkuV1 : normalizeCatalogVenueLocalSkuV1
    return normalize({ code: raw, format: 'SKU' }).normalizedCode
  } catch {
    return null
  }
}

function moneyCell(row: ParsedWorkbookRow, column: string): string | null {
  const cell = row.values[column]
  if (cell?.kind !== 'NUMBER') return null
  try {
    return parseCatalogMoney(cell.value)
  } catch {
    return null
  }
}

function currencyCell(row: ParsedWorkbookRow, column: string): string | null {
  const raw = textCell(row, column)
  if (!raw) return null
  try {
    return validateCatalogCurrencyV1(raw)
  } catch {
    return null
  }
}

function revisionCell(row: ParsedWorkbookRow, column: string): number | null {
  const cell = row.values[column]
  if (cell?.kind === 'BLANK') return null
  if (cell?.kind !== 'NUMBER' || !/^\d+$/u.test(cell.value)) return null
  const value = Number(cell.value)
  try {
    return validateCatalogExpectedRevision(value, column)
  } catch {
    return null
  }
}

function optionalTextCell(row: ParsedWorkbookRow, column: string, maximum = MAX_INTERNAL_ID_LENGTH): string | null {
  const cell = row.values[column]
  return cell?.kind === 'BLANK' ? null : textCell(row, column, maximum)
}

function projectReviewPayload(sheet: string, row: ParsedWorkbookRow): CatalogImportReviewPayloadV1 {
  // WHY: Review rows contain only normalized, closed fields. Invalid workbook
  // cells become null while their bounded diagnostic remains on the same line;
  // no raw commercial payload is copied into a secondary durable surface.
  if (sheet === 'OrganizationValues') {
    const kind = textCell(row, 'value_type')
    return {
      schemaVersion: 1,
      section: 'ORGANIZATION_VALUES',
      corporateSku: identifierCell(row, 'corporate_sku', true),
      kind: kind && Object.values(CatalogItemPriceKind).includes(kind as CatalogItemPriceKind) ? (kind as CatalogItemPriceKind) : null,
      amount: moneyCell(row, 'amount'),
      currency: currencyCell(row, 'currency'),
      expectedRuleRevision: revisionCell(row, 'expected_rule_revision'),
    }
  }
  if (sheet === 'BusinessTypes') {
    const businessType = textCell(row, 'business_type')
    return {
      schemaVersion: 1,
      section: 'BUSINESS_TYPES',
      corporateSku: identifierCell(row, 'corporate_sku', true),
      businessType:
        businessType && Object.values(BusinessType).includes(businessType as BusinessType) ? (businessType as BusinessType) : null,
    }
  }
  if (sheet !== 'VenueBindingRequests') return invalidReview('La sección de revisión no pertenece a V1.')
  const requestedAction = textCell(row, 'requested_action')
  return {
    schemaVersion: 1,
    section: 'VENUE_BINDING_REQUESTS',
    corporateSku: identifierCell(row, 'corporate_sku', true),
    venueId: textCell(row, 'venue_id', MAX_INTERNAL_ID_LENGTH),
    requestedAction: requestedAction === 'LINK' || requestedAction === 'CREATE' || requestedAction === 'SKIP' ? requestedAction : null,
    productId: optionalTextCell(row, 'product_id'),
    localSku: row.values.local_sku?.kind === 'BLANK' ? null : identifierCell(row, 'local_sku'),
    categoryId: optionalTextCell(row, 'category_id'),
    initialPrice: row.values.initial_price?.kind === 'BLANK' ? null : moneyCell(row, 'initial_price'),
    currency: row.values.currency?.kind === 'BLANK' ? null : currencyCell(row, 'currency'),
  }
}

export async function buildCatalogImportReviewLinesV1(
  workbook: ParsedMasterCatalogWorkbook,
  errors: readonly CatalogImportStagedLine['errors'][number][],
  checkpoint: CatalogImportCooperativeCheckpoint,
): Promise<CatalogImportStagedLine[]> {
  const findingsByCoordinate = new Map<string, CatalogImportStagedLine['errors']>()
  for (const finding of errors) {
    const key = `${finding.source_sheet}:${finding.source_row}`
    const findings = findingsByCoordinate.get(key) ?? []
    findings.push(finding)
    findingsByCoordinate.set(key, findings)
    await checkpoint()
  }
  const lines: CatalogImportStagedLine[] = []
  // WHY: The database uniqueness grain is the original sheet coordinate, so
  // every ancillary row is reviewable and hash-bound even when it is valid.
  for (const sheet of ['OrganizationValues', 'BusinessTypes', 'VenueBindingRequests'] as const) {
    for (const row of workbook.sheets[sheet]?.rows ?? []) {
      const findings = findingsByCoordinate.get(`${sheet}:${row.sourceRow}`) ?? []
      lines.push({
        sourceSheet: sheet,
        sourceRow: row.sourceRow,
        status: findings.length ? 'INVALID' : 'READY',
        payload: projectReviewPayload(sheet, row) as unknown as CatalogImportStagedLine['payload'],
        errors: findings,
        catalogItemId: null,
      })
      await checkpoint()
    }
  }
  return lines
}

function closedText(value: unknown, maximum?: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim() === value &&
    value.length > 0 &&
    (maximum === undefined ? isCatalogWorkbookTextV1(value) : value.length <= maximum)
  )
}

function canonicalLocalSku(value: unknown): value is string {
  if (!closedText(value)) return false
  try {
    return normalizeCatalogVenueLocalSkuV1({ code: value, format: 'SKU' }).normalizedCode === value
  } catch {
    return false
  }
}

function isCanonicalMoney(value: unknown): value is string {
  try {
    return typeof value === 'string' && parseCatalogMoney(value) === value
  } catch {
    return false
  }
}

function isCanonicalCurrency(value: unknown): value is string {
  try {
    return typeof value === 'string' && validateCatalogCurrencyV1(value) === value
  } catch {
    return false
  }
}

function isValidRevision(value: unknown): value is number {
  try {
    return validateCatalogExpectedRevision(value, 'expectedRuleRevision') === value
  } catch {
    return false
  }
}

function parseReviewPayload(value: unknown): CatalogImportReviewPayloadV1 {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.section !== 'string') {
    return invalidReview('La línea de revisión no conserva el shape V1.')
  }
  if (value.section === 'ORGANIZATION_VALUES') {
    if (
      !hasExactKeys(value, ['schemaVersion', 'section', 'corporateSku', 'kind', 'amount', 'currency', 'expectedRuleRevision']) ||
      !closedText(value.corporateSku) ||
      !Object.values(CatalogItemPriceKind).includes(value.kind as CatalogItemPriceKind) ||
      !isCanonicalMoney(value.amount) ||
      !isCanonicalCurrency(value.currency)
    )
      return invalidReview('La fila OrganizationValues staged no es canónica.')
    if (value.expectedRuleRevision !== null && !isValidRevision(value.expectedRuleRevision)) {
      return invalidReview('La revisión OrganizationValues staged no es válida.')
    }
    return { ...value } as unknown as CatalogImportOrganizationValueReviewV1
  }
  if (value.section === 'BUSINESS_TYPES') {
    if (
      !hasExactKeys(value, ['schemaVersion', 'section', 'corporateSku', 'businessType']) ||
      !closedText(value.corporateSku) ||
      !Object.values(BusinessType).includes(value.businessType as BusinessType)
    )
      return invalidReview('La fila BusinessTypes staged no es canónica.')
    return { ...value } as unknown as CatalogImportBusinessTypeReviewV1
  }
  if (value.section !== 'VENUE_BINDING_REQUESTS') return invalidReview('La sección durable no pertenece a V1.')
  const keys = [
    'schemaVersion',
    'section',
    'corporateSku',
    'venueId',
    'requestedAction',
    'productId',
    'localSku',
    'categoryId',
    'initialPrice',
    'currency',
  ]
  if (
    !hasExactKeys(value, keys) ||
    !closedText(value.corporateSku) ||
    !closedText(value.venueId, MAX_INTERNAL_ID_LENGTH) ||
    !['LINK', 'CREATE', 'SKIP'].includes(value.requestedAction as string)
  )
    return invalidReview('La fila VenueBindingRequests staged no es canónica.')
  for (const key of ['productId', 'categoryId'] as const) {
    if (value[key] !== null && !closedText(value[key], MAX_INTERNAL_ID_LENGTH))
      return invalidReview('La fila binding contiene un ID inválido.')
  }
  if (value.localSku !== null && !canonicalLocalSku(value.localSku)) return invalidReview('La fila binding contiene un SKU inválido.')
  if (value.initialPrice !== null && !isCanonicalMoney(value.initialPrice)) {
    return invalidReview('La fila binding contiene dinero inválido.')
  }
  if (value.currency !== null && !isCanonicalCurrency(value.currency)) {
    return invalidReview('La fila binding contiene moneda inválida.')
  }
  return { ...value } as unknown as CatalogImportVenueBindingReviewV1
}

export async function parseCatalogImportReviewLinesV1(
  lines: readonly CatalogImportLineRowV1[],
  checkpoint = createCatalogImportCooperativeCheckpoint(4),
): Promise<CatalogImportReviewPayloadV1[]> {
  if (lines.length > MAX_REVIEW_LINES) return invalidReview('El staging excede las filas de revisión V1.')
  const reviews: CatalogImportReviewPayloadV1[] = []
  // WHY: Confirm treats JSONB as untrusted input and may receive fifty
  // thousand review rows, so closed-shape parsing yields per coordinate.
  for (let index = 0; index < lines.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(lines, index)) return invalidReview('Las filas de revisión no son densas.')
    const line = lines[index] as CatalogImportLineRowV1
    // WHY: Prisma may round-trip an empty JSON finding list as SQL/JSON null,
    // while deterministic fixtures may retain `[]`; both mean error-free.
    const hasNoFindings = line.errors === null || line.errors === undefined || (Array.isArray(line.errors) && line.errors.length === 0)
    if (
      typeof line.id !== 'string' ||
      !line.id.trim() ||
      line.id.length > MAX_INTERNAL_ID_LENGTH ||
      line.status !== 'READY' ||
      !Number.isSafeInteger(line.sourceRow) ||
      line.sourceRow < 1 ||
      line.sourceRow > POSTGRES_INT_MAX ||
      !hasNoFindings ||
      line.catalogItemId !== null
    )
      return invalidReview('La coordenada de revisión staged no es válida.')
    const payload = parseReviewPayload(line.payload)
    const expectedSheet =
      payload.section === 'ORGANIZATION_VALUES'
        ? 'OrganizationValues'
        : payload.section === 'BUSINESS_TYPES'
          ? 'BusinessTypes'
          : 'VenueBindingRequests'
    if (line.sourceSheet !== expectedSheet) return invalidReview('La sección staged no coincide con su hoja.')
    reviews.push(payload)
    await checkpoint()
  }
  return reviews
}

async function valuesMatch(
  actual: readonly CatalogImportOrganizationValueReviewV1[],
  expected: readonly CatalogOrganizationValueInput[],
  sku: string,
  checkpoint: CatalogImportCooperativeCheckpoint,
): Promise<boolean> {
  if (actual.length !== expected.length) return false
  for (let index = 0; index < actual.length; index += 1) {
    const left = actual[index] as CatalogImportOrganizationValueReviewV1
    const right = expected[index] as (typeof expected)[number]
    if (
      left.corporateSku !== sku ||
      left.kind !== right.kind ||
      left.amount !== right.amount ||
      left.currency !== right.currency ||
      left.expectedRuleRevision !== (right.expectedRuleRevision ?? null)
    )
      return false
    await checkpoint()
  }
  return true
}

async function businessTypesMatch(
  actual: readonly CatalogImportBusinessTypeReviewV1[],
  expected: readonly BusinessType[],
  sku: string,
  checkpoint: CatalogImportCooperativeCheckpoint,
): Promise<boolean> {
  if (actual.length !== expected.length) return false
  for (let index = 0; index < actual.length; index += 1) {
    if (actual[index]?.corporateSku !== sku || actual[index]?.businessType !== expected[index]) return false
    await checkpoint()
  }
  return true
}

async function bindingsMatch(
  actual: readonly CatalogImportVenueBindingReviewV1[],
  expected: readonly CatalogVenueBindingRequestV1[],
  sku: string,
  checkpoint: CatalogImportCooperativeCheckpoint,
): Promise<boolean> {
  if (actual.length !== expected.length) return false
  for (let index = 0; index < actual.length; index += 1) {
    const left = actual[index] as CatalogImportVenueBindingReviewV1
    const right = expected[index] as CatalogVenueBindingRequestV1
    if (
      left.corporateSku !== sku ||
      left.venueId !== right.venueId ||
      left.requestedAction !== right.requestedAction ||
      left.productId !== right.productId ||
      left.localSku !== right.localSku ||
      left.categoryId !== right.categoryId ||
      left.initialPrice !== right.initialPrice ||
      left.currency !== right.currency
    )
      return false
    await checkpoint()
  }
  return true
}

export async function assertCatalogImportReviewLinesMatchItemsV1(
  items: readonly CatalogImportStagedPayloadV1[],
  reviews: readonly CatalogImportReviewPayloadV1[],
  checkpoint = createCatalogImportCooperativeCheckpoint(4),
): Promise<void> {
  if (items.length > 20_000 || reviews.length > MAX_REVIEW_LINES) {
    return invalidReview('El staging excede el envelope V1.')
  }
  const actualBySku = new Map<
    string,
    {
      values: CatalogImportOrganizationValueReviewV1[]
      types: CatalogImportBusinessTypeReviewV1[]
      bindings: CatalogImportVenueBindingReviewV1[]
    }
  >()
  for (const review of reviews) {
    if (!review.corporateSku) return invalidReview('Una fila READY no conserva SKU canónico.')
    const group = actualBySku.get(review.corporateSku) ?? { values: [], types: [], bindings: [] }
    if (review.section === 'ORGANIZATION_VALUES') group.values.push(review)
    else if (review.section === 'BUSINESS_TYPES') group.types.push(review)
    else group.bindings.push(review)
    actualBySku.set(review.corporateSku, group)
    await checkpoint()
  }
  const seen = new Set<string>()
  for (const item of items) {
    if (item.command.operation === 'RETIRE') {
      await checkpoint()
      continue
    }
    let sku: string
    try {
      // WHY: Task 5 preserves display SKU while exposing normalizedSku only
      // internally; review joins use the same NFKC/trim/uppercase authority.
      sku = normalizeCatalogCorporateSkuV1({ code: item.command.input.sku, format: 'SKU' }).normalizedCode
    } catch {
      return invalidReview('El Item staged no conserva SKU canónico comparable.')
    }
    if (seen.has(sku)) return invalidReview('El staging contiene Items con SKU duplicado.')
    seen.add(sku)
    const group = actualBySku.get(sku) ?? { values: [], types: [], bindings: [] }
    if (
      !(await valuesMatch(group.values, item.command.input.organizationValues, sku, checkpoint)) ||
      !(await businessTypesMatch(group.types, item.command.input.businessTypes, sku, checkpoint)) ||
      !(await bindingsMatch(group.bindings, item.venueBindingRequests, sku, checkpoint))
    )
      return invalidReview('Las filas de revisión no coinciden con el comando hash-bound.')
    actualBySku.delete(sku)
    await checkpoint()
  }
  if (actualBySku.size) return invalidReview('Existen filas de revisión sin un Item staged.')
}
