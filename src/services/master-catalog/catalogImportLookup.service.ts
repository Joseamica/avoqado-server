import { CatalogItemPriceKind, ProductType, type Prisma } from '@prisma/client'
import type { ParsedMasterCatalogWorkbook, ParsedWorkbookCell } from '../../workers/masterCatalogXlsx.worker'
import type { CatalogImportCooperativeCheckpoint, CatalogImportReferenceRow } from './catalogImportMapping.service'
import type { CatalogImportDependencySnapshotV1, CatalogImportTransaction } from './catalogImport.types'
import { validateCatalogCurrencyV1 } from './catalogItemValidation.service'
import { normalizeCatalogCorporateSkuV1 } from './identifierNormalization.service'
import { normalizeCatalogReferenceNameV1 } from './catalogReference.service'
import { CATALOG_IMPORT_CONFIRM_WORK_UNIT_LIMIT } from './catalogImportCapacity.service'

// WHY: This cap stays far below PostgreSQL's bind ceiling and bounds each
// Prisma result materialization turn while maximum V1 workbooks are staged.
export const CATALOG_IMPORT_LOOKUP_CHUNK_SIZE = 1_000
export const CATALOG_IMPORT_PRICE_KEY_CHUNK_SIZE = 500
export const CATALOG_IMPORT_ACTIVE_PRICE_ITEM_CHUNK_SIZE = 25

export interface CatalogImportPriceKeyV1 {
  catalogItemId: string
  kind: CatalogItemPriceKind
  currency: string
}

export interface CatalogImportItemLookupRow {
  id: string
  sku: string
  normalizedSku: string
  status: string
  revision: number
  invariantVersion: bigint
  businessTypes: Array<{ businessType: string }>
}

export interface CatalogImportPriceLookupRow {
  id: string
  catalogItemId: string
  kind: 'SALE_PRICE' | 'PURCHASE_COST'
  scope: 'ORGANIZATION'
  currency: string
  revision: number
  active: boolean
}

export interface CatalogImportLookup {
  itemById: ReadonlyMap<string, CatalogImportItemLookupRow>
  itemByNormalizedSku: ReadonlyMap<string, CatalogImportItemLookupRow>
  pricesByItemId: ReadonlyMap<string, readonly CatalogImportPriceLookupRow[]>
  referencesByType: Readonly<Record<'BRAND' | 'MANUFACTURER' | 'FAMILY', ReadonlyMap<string, CatalogImportReferenceRow[]>>>
  mappingsByAlias: ReadonlyMap<string, Array<Record<string, unknown>>>
  profiles: Array<Record<string, unknown>>
  profileDependencies: CatalogImportDependencySnapshotV1['profiles']
  venueById: ReadonlyMap<string, Record<string, unknown>>
  productById: ReadonlyMap<string, Record<string, unknown>>
  categoryById: ReadonlyMap<string, Record<string, unknown>>
  activePriceHydrationOverflow: boolean
}

export async function findBoundedCatalogImportRowsByItemIdsV1<T>(
  itemIds: ReadonlySet<string>,
  maximumRows: number,
  findMany: (chunk: string[], take: number) => Promise<T[]>,
  checkpoint: CatalogImportCooperativeCheckpoint,
): Promise<{ rows: T[]; overflow: boolean }> {
  if (maximumRows < 1) return { rows: [], overflow: true }
  const ids = [...itemIds]
  const rows: T[] = []
  for (let offset = 0; offset < ids.length; offset += CATALOG_IMPORT_ACTIVE_PRICE_ITEM_CHUNK_SIZE) {
    const remaining = maximumRows - rows.length
    if (remaining < 1) return { rows, overflow: true }
    const chunk = ids.slice(offset, offset + CATALOG_IMPORT_ACTIVE_PRICE_ITEM_CHUNK_SIZE)
    rows.push(...(await findMany(chunk, remaining)))
    if (rows.length >= maximumRows) return { rows: rows.slice(0, maximumRows), overflow: true }
    const pause = checkpoint()
    if (pause) await pause
  }
  return { rows, overflow: false }
}

function text(cell: ParsedWorkbookCell | undefined): string | null {
  return cell?.kind === 'TEXT' && cell.value.trim() ? cell.value : null
}

function addReferenceKey(target: Set<string>, cell: ParsedWorkbookCell | undefined): void {
  const value = text(cell)
  if (!value) return
  try {
    target.add(normalizeCatalogReferenceNameV1(value).normalizedName)
  } catch {
    // WHY: The row validator owns the stable diagnostic; malformed names must
    // not broaden or abort tenant lookup before diagnostics are accumulated.
  }
}

async function indexMany<T>(
  rows: readonly T[],
  key: (row: T) => string,
  checkpoint: CatalogImportCooperativeCheckpoint,
): Promise<Map<string, T[]>> {
  const indexed = new Map<string, T[]>()
  for (const row of rows) {
    const value = key(row)
    const matches = indexed.get(value) ?? []
    matches.push(row)
    indexed.set(value, matches)
    await checkpoint()
  }
  return indexed
}

export async function findCatalogImportRowsInChunks<T>(
  keys: ReadonlySet<string>,
  findMany: (chunk: string[]) => Promise<T[]>,
  checkpoint: CatalogImportCooperativeCheckpoint,
): Promise<T[]> {
  const values = [...keys]
  const result: T[] = []
  for (let offset = 0; offset < values.length; offset += CATALOG_IMPORT_LOOKUP_CHUNK_SIZE) {
    // WHY: Every chunk remains inside the same preview transaction and merges
    // in workbook insertion order, preserving one tenant snapshot authority.
    result.push(...(await findMany(values.slice(offset, offset + CATALOG_IMPORT_LOOKUP_CHUNK_SIZE))))
    await checkpoint()
  }
  return result
}

export async function findCatalogImportRowsByPriceKeysInChunks<T>(
  keys: readonly CatalogImportPriceKeyV1[],
  findMany: (chunk: CatalogImportPriceKeyV1[]) => Promise<T[]>,
  checkpoint: CatalogImportCooperativeCheckpoint,
): Promise<T[]> {
  const result: T[] = []
  for (let offset = 0; offset < keys.length; offset += CATALOG_IMPORT_PRICE_KEY_CHUNK_SIZE) {
    // WHY: Exact tuple predicates avoid hydrating the item×currency cross
    // product while keeping every Prisma OR list far below bind limits.
    result.push(...(await findMany(keys.slice(offset, offset + CATALOG_IMPORT_PRICE_KEY_CHUNK_SIZE))))
    await checkpoint()
  }
  return result
}

export async function mergeCatalogImportRowsByIdV1<T extends { id: string }>(
  groups: readonly (readonly T[])[],
  checkpoint: CatalogImportCooperativeCheckpoint,
): Promise<T[]> {
  const byId = new Map<string, T>()
  // WHY: A captured row can match active, ID, and exact-key predicates; this
  // cooperative merge avoids both duplicates and one large synchronous map.
  for (const rows of groups) {
    for (const row of rows) {
      byId.set(row.id, row)
      await checkpoint()
    }
  }
  return [...byId.values()]
}

function profileDependency(row: Record<string, unknown>): CatalogImportDependencySnapshotV1['profiles'][number] {
  return {
    id: row.id as string,
    profileVersion: row.profileVersion as number,
    rulesSchemaVersion: row.rulesSchemaVersion as number,
    businessType: (row.businessType ?? null) as string | null,
    operationalRole: (row.operationalRole ?? null) as string | null,
    requiredFields: [...(row.requiredFields as string[])].sort(),
    additionalRules: (row.additionalRules ?? null) as Prisma.JsonValue,
  }
}

export async function loadCatalogImportLookup(
  tx: CatalogImportTransaction,
  organizationId: string,
  workbook: ParsedMasterCatalogWorkbook,
  checkpoint: CatalogImportCooperativeCheckpoint,
): Promise<CatalogImportLookup> {
  const itemIds = new Set<string>()
  const updateItemIds = new Set<string>()
  const updateItemIdBySku = new Map<string, string>()
  const normalizedSkus = new Set<string>()
  const brandKeys = new Set<string>()
  const manufacturerKeys = new Set<string>()
  const familyKeys = new Set<string>()
  const aliases = new Set<string>()
  const venueIds = new Set<string>()
  const productIds = new Set<string>()
  const categoryIds = new Set<string>()
  let minimumItemWorkUnits = 32

  // WHY: Extracting bounded lookup keys before the transaction queries avoids
  // loading the tenant's full catalog and prevents O(workbook×catalog) scans.
  for (const row of workbook.sheets.Items?.rows ?? []) {
    const itemId = text(row.values.catalog_item_id)
    if (itemId) itemIds.add(itemId)
    const operation = text(row.values.operation)?.trim()
    if (operation === 'CREATE') minimumItemWorkUnits += 10
    else if (operation === 'UPDATE') minimumItemWorkUnits += 12
    else if (operation === 'RETIRE') minimumItemWorkUnits += 6
    const sku = text(row.values.corporate_sku)
    if (sku) {
      try {
        const normalizedSku = normalizeCatalogCorporateSkuV1({ code: sku, format: 'SKU' }).normalizedCode
        normalizedSkus.add(normalizedSku)
        if (operation === 'UPDATE' && itemId) updateItemIdBySku.set(normalizedSku, itemId)
      } catch {
        // WHY: The row validator owns the stable diagnostic; lookup extraction
        // simply omits malformed keys so they cannot broaden a database query.
      }
    }
    if (operation === 'UPDATE' && itemId) updateItemIds.add(itemId)
    addReferenceKey(brandKeys, row.values.brand)
    addReferenceKey(manufacturerKeys, row.values.manufacturer)
    addReferenceKey(familyKeys, row.values.family)
    addReferenceKey(familyKeys, row.values.subfamily)
    const productType = text(row.values.product_type)
    if (productType && !Object.values(ProductType).includes(productType as ProductType)) aliases.add(productType)
    await checkpoint()
  }
  const requestedPriceKeyByIdentity = new Map<string, CatalogImportPriceKeyV1>()
  for (const row of workbook.sheets.OrganizationValues?.rows ?? []) {
    const sku = text(row.values.corporate_sku)
    const rawKind = text(row.values.value_type)?.trim()
    const rawCurrency = text(row.values.currency)?.trim()
    if (sku && rawKind && rawCurrency && Object.values(CatalogItemPriceKind).includes(rawKind as CatalogItemPriceKind)) {
      try {
        const normalizedSku = normalizeCatalogCorporateSkuV1({ code: sku, format: 'SKU' }).normalizedCode
        const catalogItemId = updateItemIdBySku.get(normalizedSku)
        const currency = validateCatalogCurrencyV1(rawCurrency)
        if (catalogItemId) {
          const key = { catalogItemId, kind: rawKind as CatalogItemPriceKind, currency }
          requestedPriceKeyByIdentity.set(`${catalogItemId}:${rawKind}:${currency}`, key)
        }
      } catch {
        // WHY: Invalid leaf cells stay in row diagnostics and never broaden a
        // retained-price predicate during tenant lookup.
      }
    }
    await checkpoint()
  }
  for (const row of workbook.sheets.VenueBindingRequests?.rows ?? []) {
    const venueId = text(row.values.venue_id)
    const productId = text(row.values.product_id)
    const categoryId = text(row.values.category_id)
    if (venueId) venueIds.add(venueId)
    if (productId) productIds.add(productId)
    if (categoryId) categoryIds.add(categoryId)
    await checkpoint()
  }

  const itemSelect = {
    id: true,
    sku: true,
    normalizedSku: true,
    status: true,
    revision: true,
    invariantVersion: true,
    businessTypes: { select: { businessType: true } },
  } as const
  const itemsById = await findCatalogImportRowsInChunks(
    itemIds,
    chunk => tx.catalogItem.findMany({ where: { organizationId, id: { in: chunk } }, select: itemSelect }) as never,
    checkpoint,
  )
  const itemsBySku = await findCatalogImportRowsInChunks(
    normalizedSkus,
    chunk => tx.catalogItem.findMany({ where: { organizationId, normalizedSku: { in: chunk } }, select: itemSelect }) as never,
    checkpoint,
  )
  const itemRows = [...itemsById, ...itemsBySku] as unknown as CatalogImportItemLookupRow[]
  const typedItems = [...new Map(itemRows.map(item => [item.id, item])).values()]
  const brands = await findCatalogImportRowsInChunks(
    brandKeys,
    chunk =>
      tx.catalogBrand.findMany({
        where: { organizationId, normalizedName: { in: chunk } },
        select: { id: true, name: true, normalizedName: true, status: true, revision: true },
      }) as never,
    checkpoint,
  )
  const manufacturers = await findCatalogImportRowsInChunks(
    manufacturerKeys,
    chunk =>
      tx.catalogManufacturer.findMany({
        where: { organizationId, normalizedName: { in: chunk } },
        select: { id: true, name: true, normalizedName: true, status: true, revision: true },
      }) as never,
    checkpoint,
  )
  const families = await findCatalogImportRowsInChunks(
    familyKeys,
    chunk =>
      tx.catalogFamily.findMany({
        where: { organizationId, normalizedName: { in: chunk } },
        select: { id: true, name: true, normalizedName: true, status: true, revision: true, parentId: true },
      }) as never,
    checkpoint,
  )
  const mappings = await findCatalogImportRowsInChunks(
    aliases,
    chunk =>
      tx.catalogProductTypeMapping.findMany({
        where: { organizationId, active: true, catalogProductType: { in: chunk } },
        select: { id: true, catalogProductType: true, productType: true, mappingVersion: true, active: true },
      }) as never,
    checkpoint,
  )
  const profiles = await tx.catalogValidationProfile.findMany({
    where: { organizationId, active: true },
    select: {
      id: true,
      active: true,
      profileVersion: true,
      rulesSchemaVersion: true,
      businessType: true,
      operationalRole: true,
      requiredFields: true,
      additionalRules: true,
    },
  })
  const venues = await findCatalogImportRowsInChunks(
    venueIds,
    chunk => tx.venue.findMany({ where: { organizationId, id: { in: chunk } }, select: { id: true, currency: true } }) as never,
    checkpoint,
  )
  const products = await findCatalogImportRowsInChunks(
    productIds,
    chunk =>
      tx.product.findMany({
        where: { id: { in: chunk }, venue: { organizationId } },
        select: { id: true, venueId: true },
      }) as never,
    checkpoint,
  )
  const categories = await findCatalogImportRowsInChunks(
    categoryIds,
    chunk =>
      tx.menuCategory.findMany({
        where: { id: { in: chunk }, venue: { organizationId } },
        select: { id: true, venueId: true },
      }) as never,
    checkpoint,
  )
  const priceSelect = {
    id: true,
    catalogItemId: true,
    kind: true,
    scope: true,
    currency: true,
    revision: true,
    active: true,
  } as const
  const requestedUpdateValueCount = requestedPriceKeyByIdentity.size
  const activePriceLimit = CATALOG_IMPORT_CONFIRM_WORK_UNIT_LIMIT - minimumItemWorkUnits + 1
  const activePriceResult =
    minimumItemWorkUnits + requestedUpdateValueCount > CATALOG_IMPORT_CONFIRM_WORK_UNIT_LIMIT
      ? { rows: [], overflow: true }
      : await findBoundedCatalogImportRowsByItemIdsV1(
          updateItemIds,
          activePriceLimit,
          (chunk, take) =>
            tx.catalogItemPrice.findMany({
              where: { organizationId, catalogItemId: { in: chunk }, scope: 'ORGANIZATION', active: true },
              select: priceSelect,
              orderBy: { id: 'asc' },
              take,
            }) as never,
          checkpoint,
        )
  // WHY: A lower-bound overflow stops before a tenant's active-price history
  // can be materialized; final capacity reports it as ≥12,001, never exact.
  const activePrices = activePriceResult.rows
  const activePriceKeys = new Set<string>()
  for (const raw of activePrices as unknown as CatalogImportPriceLookupRow[]) {
    activePriceKeys.add(`${raw.catalogItemId}:${raw.kind}:${raw.currency}`)
    await checkpoint()
  }
  const unresolvedRequestedPriceKeys: CatalogImportPriceKeyV1[] = []
  for (const [identity, key] of requestedPriceKeyByIdentity) {
    if (!activePriceKeys.has(identity)) unresolvedRequestedPriceKeys.push(key)
    await checkpoint()
  }
  const requestedPrices = activePriceResult.overflow
    ? []
    : await findCatalogImportRowsByPriceKeysInChunks(
        unresolvedRequestedPriceKeys,
        chunk =>
          tx.catalogItemPrice.findMany({
            where: {
              organizationId,
              scope: 'ORGANIZATION',
              OR: chunk.map(key => ({ catalogItemId: key.catalogItemId, kind: key.kind, currency: key.currency })),
            },
            select: priceSelect,
          }) as never,
        checkpoint,
      )
  const prices = await mergeCatalogImportRowsByIdV1(
    [activePrices, requestedPrices] as unknown as CatalogImportPriceLookupRow[][],
    checkpoint,
  )
  const typedProfiles = profiles as unknown as Array<Record<string, unknown>>

  // WHY: Index construction is cooperative and one-time; per-row validation
  // thereafter performs O(1) tenant joins instead of rescanning query results.
  const pricesByItemId = await indexMany(prices, price => price.catalogItemId, checkpoint)
  const brandsByName = await indexMany(brands as unknown as CatalogImportReferenceRow[], row => row.normalizedName, checkpoint)
  const manufacturersByName = await indexMany(
    manufacturers as unknown as CatalogImportReferenceRow[],
    row => row.normalizedName,
    checkpoint,
  )
  const familiesByName = await indexMany(families as unknown as CatalogImportReferenceRow[], row => row.normalizedName, checkpoint)
  const mappingsByAlias = await indexMany(
    mappings as unknown as Array<Record<string, unknown>>,
    row => String(row.catalogProductType),
    checkpoint,
  )

  return {
    itemById: new Map(typedItems.map(item => [item.id, item])),
    itemByNormalizedSku: new Map(typedItems.map(item => [item.normalizedSku, item])),
    pricesByItemId,
    referencesByType: {
      BRAND: brandsByName,
      MANUFACTURER: manufacturersByName,
      FAMILY: familiesByName,
    },
    mappingsByAlias,
    profiles: typedProfiles,
    profileDependencies: typedProfiles.map(profileDependency),
    venueById: new Map((venues as unknown as Array<Record<string, unknown>>).map(row => [String(row.id), row])),
    productById: new Map((products as unknown as Array<Record<string, unknown>>).map(row => [String(row.id), row])),
    categoryById: new Map((categories as unknown as Array<Record<string, unknown>>).map(row => [String(row.id), row])),
    activePriceHydrationOverflow: activePriceResult.overflow,
  }
}
