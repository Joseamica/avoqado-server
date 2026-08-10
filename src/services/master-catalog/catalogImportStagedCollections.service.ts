import { BusinessType, CatalogItemPriceKind } from '@prisma/client'
import type { CatalogImportCooperativeCheckpoint } from './catalogImportCanonical.service'
import AppError from '../../errors/AppError'
import type { CatalogVenueBindingRequestV1 } from './catalogImport.types'
import {
  CATALOG_ORGANIZATION_VALUE_MAX_V1,
  validateCatalogCurrencyV1,
  validateCatalogExpectedRevision,
} from './catalogItemValidation.service'
import { parseCatalogMoney } from './catalogMoney.service'
import { isCatalogWorkbookTextV1, normalizeCatalogCorporateSkuV1, normalizeCatalogVenueLocalSkuV1 } from './identifierNormalization.service'

export const CATALOG_IMPORT_BINDING_REQUEST_MAX_V1 = 20_000

function invalidCollection(message: string): never {
  throw new AppError(message, 409, true, 'CATALOG_IMPORT_STAGING_INVALID')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...allowed].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function boundedText(value: unknown, maximum = 256): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum
}

function boundedWorkbookText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && isCatalogWorkbookTextV1(value)
}

function denseArray(value: unknown, maximum: number): value is unknown[] {
  if (!Array.isArray(value) || value.length > maximum) return false
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) return false
  }
  return true
}

function canonicalCurrency(value: unknown): string {
  try {
    const currency = validateCatalogCurrencyV1(value)
    if (currency !== value) return invalidCollection('La moneda staged no es canónica.')
    return currency
  } catch {
    return invalidCollection('La moneda staged no es canónica.')
  }
}

function canonicalMoney(value: unknown): string {
  try {
    const amount = parseCatalogMoney(value)
    if (amount !== value) return invalidCollection('El dinero staged no es canónico.')
    return amount
  } catch {
    return invalidCollection('El dinero staged no es canónico.')
  }
}

function canonicalRevision(value: unknown): number {
  try {
    return validateCatalogExpectedRevision(value, 'expectedRuleRevision')
  } catch {
    return invalidCollection('La revisión staged no es válida.')
  }
}

export interface CatalogImportCurrencyPairInspectionV1 {
  currency: string
  saleCount: number
  purchaseCount: number
}

export function findIncompleteCatalogImportCurrencyPairsV1(
  values: readonly { kind: CatalogItemPriceKind; currency: string }[],
): CatalogImportCurrencyPairInspectionV1[] {
  const countsByCurrency = new Map<string, CatalogImportCurrencyPairInspectionV1>()
  // WHY: Preview, durable confirm, and read validation share one per-currency
  // invariant instead of inheriting Task 5's intentionally weaker “one pair” rule.
  for (const value of values) {
    const counts = countsByCurrency.get(value.currency) ?? {
      currency: value.currency,
      saleCount: 0,
      purchaseCount: 0,
    }
    if (value.kind === CatalogItemPriceKind.SALE_PRICE) counts.saleCount += 1
    else counts.purchaseCount += 1
    countsByCurrency.set(value.currency, counts)
  }
  return [...countsByCurrency.values()].filter(counts => counts.saleCount !== 1 || counts.purchaseCount !== 1)
}

function* walkCommandCollections(input: Record<string, unknown>, operation: 'CREATE' | 'UPDATE'): Generator<void> {
  if (!denseArray(input.businessTypes, Object.values(BusinessType).length)) {
    return invalidCollection('Los giros staged exceden el contrato V1.')
  }
  const seenBusinessTypes = new Set<BusinessType>()
  for (const raw of input.businessTypes) {
    if (!Object.values(BusinessType).includes(raw as BusinessType) || seenBusinessTypes.has(raw as BusinessType)) {
      return invalidCollection('Los giros staged no son un conjunto V1 válido.')
    }
    seenBusinessTypes.add(raw as BusinessType)
    yield
  }
  if (!denseArray(input.organizationValues, CATALOG_ORGANIZATION_VALUE_MAX_V1)) {
    return invalidCollection('Los valores organizacionales staged exceden V1.')
  }
  const seenValues = new Set<string>()
  for (const raw of input.organizationValues) {
    if (
      !isRecord(raw) ||
      (!hasExactKeys(raw, ['kind', 'amount', 'currency']) && !hasExactKeys(raw, ['kind', 'amount', 'currency', 'expectedRuleRevision'])) ||
      !Object.values(CatalogItemPriceKind).includes(raw.kind as CatalogItemPriceKind)
    )
      return invalidCollection('Un valor organizacional staged no es cerrado.')
    const currency = canonicalCurrency(raw.currency)
    canonicalMoney(raw.amount)
    if (raw.expectedRuleRevision !== undefined) canonicalRevision(raw.expectedRuleRevision)
    const key = `${raw.kind}:${currency}`
    if (seenValues.has(key)) return invalidCollection('Los valores organizacionales staged contienen duplicados.')
    seenValues.add(key)
    yield
  }
  if (
    findIncompleteCatalogImportCurrencyPairsV1(input.organizationValues as Array<{ kind: CatalogItemPriceKind; currency: string }>).length >
    0
  ) {
    return invalidCollection('Cada moneda staged requiere SALE_PRICE y PURCHASE_COST.')
  }
  if (operation !== 'UPDATE') return
  if (!denseArray(input.organizationValueDeactivations, CATALOG_ORGANIZATION_VALUE_MAX_V1)) {
    return invalidCollection('Las desactivaciones staged exceden V1.')
  }
  const seenDeactivations = new Set<string>()
  for (const raw of input.organizationValueDeactivations) {
    if (
      !isRecord(raw) ||
      !hasExactKeys(raw, ['kind', 'currency', 'expectedRuleRevision']) ||
      !Object.values(CatalogItemPriceKind).includes(raw.kind as CatalogItemPriceKind)
    )
      return invalidCollection('Una desactivación staged no es cerrada.')
    const key = `${raw.kind}:${canonicalCurrency(raw.currency)}`
    canonicalRevision(raw.expectedRuleRevision)
    if (seenDeactivations.has(key)) return invalidCollection('Las desactivaciones staged contienen duplicados.')
    seenDeactivations.add(key)
    yield
  }
}

export function preflightCatalogImportCommandCollectionsV1(input: Record<string, unknown>, operation: 'CREATE' | 'UPDATE'): void {
  // WHY: Single-line parser tests retain a synchronous seam, but the frozen
  // currency cardinality bounds this traversal before Task 5 is invoked.
  for (const _ of walkCommandCollections(input, operation)) {
    // Iterator consumption performs closed-shape and canonical-leaf checks.
  }
}

export async function preflightCatalogImportCommandCollectionsCooperativelyV1(
  input: Record<string, unknown>,
  operation: 'CREATE' | 'UPDATE',
  checkpoint: CatalogImportCooperativeCheckpoint,
): Promise<void> {
  // WHY: Confirm yields within every legal nested collection even when one
  // Item carries all currency pairs allowed by V1.
  for (const _ of walkCommandCollections(input, operation)) await checkpoint()
}

function parseBindingRequest(raw: unknown): CatalogVenueBindingRequestV1 {
  const keys = ['categoryId', 'corporateSku', 'currency', 'initialPrice', 'localSku', 'productId', 'requestedAction', 'venueId']
  if (!isRecord(raw) || !hasExactKeys(raw, keys) || !boundedWorkbookText(raw.corporateSku) || !boundedText(raw.venueId))
    return invalidCollection('La solicitud de venue staged no conserva el shape V1.')
  if (raw.requestedAction !== 'LINK' && raw.requestedAction !== 'CREATE' && raw.requestedAction !== 'SKIP') {
    return invalidCollection('La acción de venue staged no es válida.')
  }
  for (const key of ['productId', 'categoryId'] as const) {
    if (raw[key] !== null && !boundedText(raw[key])) return invalidCollection('La solicitud de venue contiene un ID inválido.')
  }
  if (raw.localSku !== null && !boundedWorkbookText(raw.localSku)) {
    return invalidCollection('La solicitud de venue contiene un SKU inválido.')
  }
  for (const key of ['initialPrice', 'currency'] as const) {
    if (raw[key] !== null && !boundedWorkbookText(raw[key])) {
      return invalidCollection('La solicitud de venue contiene un valor inválido.')
    }
  }
  try {
    const corporateSku = normalizeCatalogCorporateSkuV1({ code: raw.corporateSku, format: 'SKU' }).normalizedCode
    if (corporateSku !== raw.corporateSku) return invalidCollection('La solicitud de venue no conserva SKU canónico.')
    if (raw.localSku !== null) {
      const localSku = normalizeCatalogVenueLocalSkuV1({ code: raw.localSku, format: 'SKU' }).normalizedCode
      if (localSku !== raw.localSku) return invalidCollection('La solicitud de venue no conserva SKU local canónico.')
    }
    if (raw.requestedAction === 'CREATE') {
      canonicalMoney(raw.initialPrice)
      canonicalCurrency(raw.currency)
    }
  } catch {
    return invalidCollection('La solicitud de venue staged no conserva dinero/moneda válidos.')
  }
  const closedShape =
    (raw.requestedAction === 'LINK' &&
      raw.productId !== null &&
      [raw.localSku, raw.categoryId, raw.initialPrice, raw.currency].every(field => field === null)) ||
    (raw.requestedAction === 'CREATE' &&
      raw.productId === null &&
      [raw.localSku, raw.categoryId, raw.initialPrice, raw.currency].every(field => field !== null)) ||
    (raw.requestedAction === 'SKIP' &&
      [raw.productId, raw.localSku, raw.categoryId, raw.initialPrice, raw.currency].every(field => field === null))
  if (!closedShape) return invalidCollection('La solicitud de venue staged no coincide con su acción.')
  return raw as unknown as CatalogVenueBindingRequestV1
}

export function parseCatalogImportBindingRequestsV1(value: unknown): CatalogVenueBindingRequestV1[] {
  if (!denseArray(value, CATALOG_IMPORT_BINDING_REQUEST_MAX_V1)) {
    return invalidCollection('Las solicitudes de venue staged exceden V1.')
  }
  const requests: CatalogVenueBindingRequestV1[] = []
  for (const raw of value) requests.push(parseBindingRequest(raw))
  return requests
}

export async function parseCatalogImportBindingRequestsCooperativelyV1(
  value: unknown,
  checkpoint: CatalogImportCooperativeCheckpoint,
): Promise<CatalogVenueBindingRequestV1[]> {
  if (!denseArray(value, CATALOG_IMPORT_BINDING_REQUEST_MAX_V1)) {
    return invalidCollection('Las solicitudes de venue staged exceden V1.')
  }
  const requests: CatalogVenueBindingRequestV1[] = []
  for (const raw of value) {
    requests.push(parseBindingRequest(raw))
    await checkpoint()
  }
  return requests
}
