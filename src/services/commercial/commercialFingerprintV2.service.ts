import { types as utilTypes } from 'node:util'
import {
  COMMERCIAL_CODE_V2_PATTERN,
  COMMERCIAL_CONTRACT_VERSION_V2,
  COMMERCIAL_CURRENCY_V2,
  COMMERCIAL_MARKET_V2,
  COMMERCIAL_SCHEMA_VERSION_V2,
  COMMERCIAL_SHA256_HEX_V2_PATTERN,
  COMMERCIAL_V2_DOMAINS,
  MAX_QUANTITY,
  MAX_QUOTE_LINES,
} from '@/contracts/commercial/commercialContractV2.constants'
import { hashCanonicalJsonV2 } from './commercialCanonicalJsonV2.service'

export interface CommercialSelectionFingerprintLineV2 {
  targetType: 'PRODUCT' | 'BUNDLE'
  targetCode: string
  priceCode: string
  quantity: number
}

export interface CommercialSelectionFingerprintInputV2 {
  lines: readonly CommercialSelectionFingerprintLineV2[]
}

export interface CommercialCheckoutRequestFingerprintInputV2 {
  operationType: 'CHECKOUT_SESSION'
  acceptanceId: string
  quoteId: string
  quoteChecksum: string
  organizationId: string
  venueId: string
}

interface NormalizedSelectionLineV2 extends CommercialSelectionFingerprintLineV2 {
  lineKey: string
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || utilTypes.isProxy(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function selectionInvalid(): never {
  throw new Error('COMMERCIAL_SELECTION_FINGERPRINT_V2_INVALID')
}

function checkoutInvalid(): never {
  throw new Error('COMMERCIAL_CHECKOUT_REQUEST_FINGERPRINT_V2_INVALID')
}

function withStableSelectionError<T>(operation: () => T): T {
  try {
    return operation()
  } catch {
    return selectionInvalid()
  }
}

function withStableCheckoutError<T>(operation: () => T): T {
  try {
    return operation()
  } catch {
    return checkoutInvalid()
  }
}

function ownEnumerableDataProperty(value: Record<string, unknown> | readonly unknown[], key: string, invalid: () => never): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) invalid()
  return descriptor.value
}

function normalizeSelectionLine(value: unknown): NormalizedSelectionLineV2 {
  if (!isPlainObject(value)) selectionInvalid()
  const targetType = ownEnumerableDataProperty(value, 'targetType', selectionInvalid)
  const targetCode = ownEnumerableDataProperty(value, 'targetCode', selectionInvalid)
  const priceCode = ownEnumerableDataProperty(value, 'priceCode', selectionInvalid)
  const quantity = ownEnumerableDataProperty(value, 'quantity', selectionInvalid)
  if (
    (targetType !== 'PRODUCT' && targetType !== 'BUNDLE') ||
    typeof targetCode !== 'string' ||
    !COMMERCIAL_CODE_V2_PATTERN.test(targetCode) ||
    typeof priceCode !== 'string' ||
    !COMMERCIAL_CODE_V2_PATTERN.test(priceCode) ||
    typeof quantity !== 'number' ||
    !Number.isInteger(quantity) ||
    quantity < 1 ||
    quantity > MAX_QUANTITY
  ) {
    selectionInvalid()
  }

  const lineKey = `${targetType}:${targetCode}:${priceCode}`
  if (lineKey.length > 192) selectionInvalid()
  return { lineKey, targetType, targetCode, priceCode, quantity }
}

function fingerprintSelection(input: CommercialSelectionFingerprintInputV2): string {
  if (!isPlainObject(input)) selectionInvalid()
  const linesValue = ownEnumerableDataProperty(input, 'lines', selectionInvalid)
  if (!Array.isArray(linesValue) || utilTypes.isProxy(linesValue)) selectionInvalid()
  const lines = linesValue as readonly unknown[]
  const lineCount = lines.length
  if (lineCount < 1 || lineCount > MAX_QUOTE_LINES) selectionInvalid()

  const normalized: NormalizedSelectionLineV2[] = []
  for (let index = 0; index < lineCount; index += 1) {
    const line = ownEnumerableDataProperty(lines, String(index), selectionInvalid)
    normalized.push(normalizeSelectionLine(line))
  }
  normalized.sort((left, right) => compareAscii(left.lineKey, right.lineKey))
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index - 1].lineKey === normalized[index].lineKey) selectionInvalid()
  }

  const preimage = {
    schemaVersion: COMMERCIAL_SCHEMA_VERSION_V2,
    contractVersion: COMMERCIAL_CONTRACT_VERSION_V2,
    market: COMMERCIAL_MARKET_V2,
    currency: COMMERCIAL_CURRENCY_V2,
    lines: normalized.map(({ targetType, targetCode, priceCode, quantity }) => ({
      targetType,
      targetCode,
      priceCode,
      quantity,
    })),
  }

  return hashCanonicalJsonV2(COMMERCIAL_V2_DOMAINS.QUOTE_SELECTION, preimage)
}

export function fingerprintCommercialSelectionV2(input: CommercialSelectionFingerprintInputV2): string {
  return withStableSelectionError(() => fingerprintSelection(input))
}

function validOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128
}

function fingerprintCheckoutRequest(input: CommercialCheckoutRequestFingerprintInputV2): string {
  if (!isPlainObject(input)) checkoutInvalid()
  const operationType = ownEnumerableDataProperty(input, 'operationType', checkoutInvalid)
  const acceptanceId = ownEnumerableDataProperty(input, 'acceptanceId', checkoutInvalid)
  const quoteId = ownEnumerableDataProperty(input, 'quoteId', checkoutInvalid)
  const quoteChecksum = ownEnumerableDataProperty(input, 'quoteChecksum', checkoutInvalid)
  const organizationId = ownEnumerableDataProperty(input, 'organizationId', checkoutInvalid)
  const venueId = ownEnumerableDataProperty(input, 'venueId', checkoutInvalid)

  if (
    operationType !== 'CHECKOUT_SESSION' ||
    !validOpaqueId(acceptanceId) ||
    !validOpaqueId(quoteId) ||
    typeof quoteChecksum !== 'string' ||
    !COMMERCIAL_SHA256_HEX_V2_PATTERN.test(quoteChecksum) ||
    !validOpaqueId(organizationId) ||
    !validOpaqueId(venueId)
  ) {
    checkoutInvalid()
  }

  const preimage = {
    schemaVersion: COMMERCIAL_SCHEMA_VERSION_V2,
    contractVersion: COMMERCIAL_CONTRACT_VERSION_V2,
    operationType: 'CHECKOUT_SESSION' as const,
    acceptanceId,
    quoteId,
    quoteChecksum,
    organizationId,
    venueId,
  }

  return hashCanonicalJsonV2(COMMERCIAL_V2_DOMAINS.STRIPE_CHECKOUT_REQUEST, preimage)
}

export function fingerprintCommercialCheckoutRequestV2(input: CommercialCheckoutRequestFingerprintInputV2): string {
  return withStableCheckoutError(() => fingerprintCheckoutRequest(input))
}
