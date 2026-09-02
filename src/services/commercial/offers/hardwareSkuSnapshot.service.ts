import { createHash } from 'node:crypto'

import { TPV_CATALOG, type TpvCatalogEntry } from '@/config/tpvCatalog'
import { canonicalJsonBytesV2 } from '@/services/commercial/commercialCanonicalJsonV2.service'
import type { HardwareSkuSnapshotV3 } from '@/types/commercialOfferV3'

const HARDWARE_SKU_SOURCE_HASH_DOMAIN = 'avoqado.commercial.hardware-sku-source@1\0'
const MAX_HARDWARE_UNIT_AMOUNT_MINOR = 999_999_999_999

function sourceInvalid(): never {
  throw new Error('COMMERCIAL_HARDWARE_SKU_SOURCE_INVALID')
}

function assertSourceText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string' || value.trim() !== value || value.length < 1 || value.length > maxLength) sourceInvalid()
  return value
}

function sourceHash(source: {
  catalogKey: string
  brand: string
  model: string
  name: string
  listUnitAmountMinor: string
}): string {
  return createHash('sha256')
    .update(Buffer.concat([Buffer.from(HARDWARE_SKU_SOURCE_HASH_DOMAIN, 'ascii'), canonicalJsonBytesV2(source)]))
    .digest('hex')
}

export function createHardwareSkuSnapshotV3(
  catalogKey: string,
  catalog: Readonly<Record<string, TpvCatalogEntry>> = TPV_CATALOG,
): HardwareSkuSnapshotV3 {
  if (typeof catalogKey !== 'string' || !/^[A-Z][A-Z0-9_]{1,63}$/.test(catalogKey)) {
    throw new Error('COMMERCIAL_HARDWARE_SKU_UNKNOWN')
  }
  const entry = catalog[catalogKey]
  if (!entry) throw new Error('COMMERCIAL_HARDWARE_SKU_UNKNOWN')

  const unitPriceCents = entry.unitPriceCents
  if (
    !Number.isSafeInteger(unitPriceCents) ||
    unitPriceCents < 1 ||
    unitPriceCents > MAX_HARDWARE_UNIT_AMOUNT_MINOR
  ) {
    throw new Error('COMMERCIAL_HARDWARE_SKU_PRICE_INVALID')
  }

  const source = Object.freeze({
    catalogKey,
    brand: assertSourceText(entry.brand, 80),
    model: assertSourceText(entry.model, 80),
    name: assertSourceText(entry.name, 120),
    listUnitAmountMinor: unitPriceCents.toString(),
  })
  return Object.freeze({
    ...source,
    catalogContentHash: sourceHash(source),
    currency: 'MXN' as const,
    taxRateBasisPoints: 1600 as const,
  })
}
