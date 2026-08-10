import type { ParsedWorkbookRow } from '../../workers/masterCatalogXlsx.worker'
import type { CatalogImportCooperativeCheckpoint } from './catalogImportCanonical.service'
import {
  addCatalogImportFinding,
  addCatalogImportFindingOnce,
  readCatalogImportDecimal,
  readCatalogImportText,
  validateCatalogImportCurrencyCell,
  validateCatalogImportMoneyCell,
} from './catalogImportFieldValidation.service'
import type { CatalogImportRowError, CatalogVenueBindingRequestV1 } from './catalogImport.types'
import { normalizeCatalogCorporateSkuV1, normalizeCatalogVenueLocalSkuV1 } from './identifierNormalization.service'

export async function parseCatalogImportBindingRequests(
  rows: readonly ParsedWorkbookRow[],
  venueById: ReadonlyMap<string, Record<string, unknown>>,
  productById: ReadonlyMap<string, Record<string, unknown>>,
  categoryById: ReadonlyMap<string, Record<string, unknown>>,
  errors: CatalogImportRowError[],
  checkpoint: CatalogImportCooperativeCheckpoint,
): Promise<CatalogVenueBindingRequestV1[]> {
  const requests: CatalogVenueBindingRequestV1[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    await checkpoint()
    // WHY: Grouping already classified the join cell once; binding leaf
    // validation reuses its safe text without duplicating the same finding.
    const corporateSkuCell = row.values.corporate_sku
    const corporateSkuRaw = corporateSkuCell?.kind === 'TEXT' && corporateSkuCell.value.trim() ? corporateSkuCell.value : null
    const venueId = readCatalogImportText(errors, 'VenueBindingRequests', row, 'venue_id')
    const action = readCatalogImportText(errors, 'VenueBindingRequests', row, 'requested_action')
    const productId = readCatalogImportText(errors, 'VenueBindingRequests', row, 'product_id', true)
    const localSku = readCatalogImportText(errors, 'VenueBindingRequests', row, 'local_sku', true)
    const categoryId = readCatalogImportText(errors, 'VenueBindingRequests', row, 'category_id', true)
    const initialPrice = readCatalogImportDecimal(errors, 'VenueBindingRequests', row, 'initial_price', true)
    const currency = readCatalogImportText(errors, 'VenueBindingRequests', row, 'currency', true)
    let corporateSku: string | null = null
    let canonicalLocalSku = localSku
    try {
      if (corporateSkuRaw) corporateSku = normalizeCatalogCorporateSkuV1({ code: corporateSkuRaw, format: 'SKU' }).normalizedCode
    } catch {
      corporateSku = null
    }
    // WHY: Task 8 will persist CREATE requests into Product.sku's indexed key.
    // Preview therefore canonicalizes and bounds that future key here, while
    // attributing any rejection to the original local_sku review coordinate.
    try {
      if (localSku) canonicalLocalSku = normalizeCatalogVenueLocalSkuV1({ code: localSku, format: 'SKU' }).normalizedCode
    } catch {
      canonicalLocalSku = null
      addCatalogImportFindingOnce(
        errors,
        'VenueBindingRequests',
        row.sourceRow,
        'local_sku',
        'CATALOG_IDENTIFIER_INVALID',
        row.values.local_sku,
      )
    }
    const actionValid = action === 'LINK' || action === 'CREATE' || action === 'SKIP'
    if (!actionValid) {
      addCatalogImportFindingOnce(
        errors,
        'VenueBindingRequests',
        row.sourceRow,
        'requested_action',
        'CATALOG_BINDING_ACTION_INVALID',
        row.values.requested_action,
      )
    }
    const venue = venueId ? venueById.get(venueId) : undefined
    if (venueId && !venue) {
      addCatalogImportFinding(errors, 'VenueBindingRequests', row.sourceRow, 'venue_id', 'CATALOG_TARGET_NOT_FOUND', row.values.venue_id)
    }
    const product = productId ? productById.get(productId) : undefined
    if (productId && (!product || !venueId || product.venueId !== venueId)) {
      addCatalogImportFinding(
        errors,
        'VenueBindingRequests',
        row.sourceRow,
        'product_id',
        'CATALOG_TARGET_NOT_FOUND',
        row.values.product_id,
      )
    }
    if (action === 'LINK' && !productId) {
      addCatalogImportFinding(
        errors,
        'VenueBindingRequests',
        row.sourceRow,
        'product_id',
        'CATALOG_TARGET_NOT_FOUND',
        row.values.product_id,
      )
    }
    if (action === 'CREATE' && (!localSku || !categoryId || !initialPrice || !currency)) {
      addCatalogImportFinding(
        errors,
        'VenueBindingRequests',
        row.sourceRow,
        'requested_action',
        'CATALOG_BINDING_REQUEST_INCOMPLETE',
        row.values.requested_action,
      )
    }
    const category = categoryId ? categoryById.get(categoryId) : undefined
    if (categoryId && (!category || !venueId || category.venueId !== venueId)) {
      addCatalogImportFinding(
        errors,
        'VenueBindingRequests',
        row.sourceRow,
        'category_id',
        'CATALOG_TARGET_NOT_FOUND',
        row.values.category_id,
      )
    }
    const canonicalInitialPrice =
      initialPrice !== null
        ? validateCatalogImportMoneyCell(errors, 'VenueBindingRequests', row, 'initial_price', initialPrice)
        : initialPrice
    if (currency !== null) {
      validateCatalogImportCurrencyCell(errors, 'VenueBindingRequests', row, 'currency', currency, venue?.currency)
    }
    // WHY: Binding requests are reviewed staging only; closed action shapes
    // prevent hidden fields from changing Task 8 publication semantics later.
    const hasUnexpectedShape =
      (action === 'LINK' && [localSku, categoryId, initialPrice, currency].some(value => value !== null)) ||
      (action === 'CREATE' && productId !== null) ||
      (action === 'SKIP' && [productId, localSku, categoryId, initialPrice, currency].some(value => value !== null))
    if (hasUnexpectedShape) {
      addCatalogImportFindingOnce(
        errors,
        'VenueBindingRequests',
        row.sourceRow,
        'requested_action',
        'CATALOG_BINDING_REQUEST_INVALID',
        row.values.requested_action,
      )
    }
    if (!corporateSku || !venueId || !actionValid) continue
    if (seen.has(venueId)) {
      addCatalogImportFinding(errors, 'VenueBindingRequests', row.sourceRow, 'venue_id', 'CATALOG_WORKBOOK_DUPLICATE', row.values.venue_id)
    }
    seen.add(venueId)
    requests.push({
      corporateSku,
      venueId,
      requestedAction: action,
      productId,
      localSku: canonicalLocalSku,
      categoryId,
      initialPrice: canonicalInitialPrice ?? initialPrice,
      currency,
    })
  }
  return requests
}
