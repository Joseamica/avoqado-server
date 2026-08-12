import { revalidateCatalogImportDependenciesTx } from '@/services/master-catalog/catalogImportDependencies.service'
import { calculateCatalogImportConfirmCapacityV1 } from '@/services/master-catalog/catalogImportCapacity.service'
import { CATALOG_IMPORT_LOOKUP_CHUNK_SIZE } from '@/services/master-catalog/catalogImportLookup.service'
import type { CatalogCommandContext } from '@/types/master-catalog'
import { expectCatalogImportEventLoopBudgetV1, startCatalogImportEventLoopProbeV1 } from './catalogImportEventLoopTestHarness'

const context: CatalogCommandContext = {
  organizationId: 'org-pits',
  actor: { type: 'HUMAN', staffId: 'staff-owner', impersonating: false },
  orgRole: 'OWNER',
}

function omitFixtureKey<T extends object>(value: T, key: keyof T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([candidate]) => candidate !== String(key)))
}

const snapshot = {
  schemaVersion: 1,
  capacity: calculateCatalogImportConfirmCapacityV1([]),
  items: [
    {
      id: 'catalog-item-1',
      revision: 8,
      invariantVersion: '4',
      status: 'ACTIVE',
      businessTypes: ['RETAIL_STORE'],
    },
  ],
  priceDependentItemIds: ['catalog-item-1'],
  organizationValues: [
    {
      id: 'price-1',
      catalogItemId: 'catalog-item-1',
      kind: 'SALE_PRICE',
      scope: 'ORGANIZATION',
      currency: 'MXN',
      revision: 2,
      active: true,
    },
  ],
  references: [],
  mappings: [
    {
      id: 'mapping-1',
      catalogProductType: 'ARTICULO_REGULAR',
      productType: 'REGULAR',
      mappingVersion: 3,
      active: true,
    },
  ],
  profiles: [],
}

function dependencyTx() {
  // WHY: One exact in-memory snapshot isolates child/profile drift semantics
  // without starting PostgreSQL or weakening the real TransactionClient seam.
  return {
    catalogItem: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'catalog-item-1',
          revision: 8,
          invariantVersion: 4n,
          status: 'ACTIVE',
          businessTypes: [{ businessType: 'RETAIL_STORE' }],
        },
      ]),
    },
    catalogItemPrice: { findMany: jest.fn().mockResolvedValue([snapshot.organizationValues[0]]) },
    catalogBrand: { findMany: jest.fn().mockResolvedValue([]) },
    catalogManufacturer: { findMany: jest.fn().mockResolvedValue([]) },
    catalogFamily: { findMany: jest.fn().mockResolvedValue([]) },
    catalogProductTypeMapping: { findMany: jest.fn().mockResolvedValue(snapshot.mappings) },
    catalogValidationProfile: { findMany: jest.fn().mockResolvedValue([]) },
  }
}

function mockPriceRows(tx: ReturnType<typeof dependencyTx>, rows: Array<Record<string, unknown>>): void {
  tx.catalogItemPrice.findMany.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
    if (where.active === true) {
      const ids = new Set((where.catalogItemId as { in: string[] }).in)
      return rows.filter(row => row.active === true && ids.has(row.catalogItemId as string))
    }
    if (where.id) {
      const ids = new Set((where.id as { in: string[] }).in)
      return rows.filter(row => ids.has(row.id as string))
    }
    const clauses = where.OR as Array<{
      id?: { in: string[] }
      catalogItemId?: string
      kind?: string
      currency?: string
    }>
    const ids = new Set(clauses.flatMap(clause => clause.id?.in ?? []))
    const keys = clauses.filter((clause): clause is { catalogItemId: string; kind: string; currency: string } =>
      Boolean(clause.catalogItemId),
    )
    const identities = new Set(keys.map(key => `${key.catalogItemId}:${key.kind}:${key.currency}`))
    return rows.filter(row => ids.has(row.id as string) || identities.has(`${row.catalogItemId}:${row.kind}:${row.currency}`))
  })
}

describe('catalog import durable dependency revalidation', () => {
  it('does not make RETIRE stale when the item has ordinary active prices', async () => {
    const retireSnapshot = { ...snapshot, priceDependentItemIds: [], organizationValues: [], mappings: [] }
    const tx = dependencyTx()
    tx.catalogItemPrice.findMany.mockResolvedValue([
      snapshot.organizationValues[0],
      { ...snapshot.organizationValues[0], id: 'price-2', kind: 'PURCHASE_COST' },
    ])
    tx.catalogProductTypeMapping.findMany.mockResolvedValue([])

    await expect(revalidateCatalogImportDependenciesTx(tx as never, context, retireSnapshot)).resolves.toBeUndefined()

    expect(tx.catalogItemPrice.findMany).not.toHaveBeenCalled()
  })

  it('detects a new active price for an UPDATE whose captured price set was empty', async () => {
    const emptyAtPreview = { ...snapshot, organizationValues: [] }
    const tx = dependencyTx()
    mockPriceRows(tx, [snapshot.organizationValues[0]!])

    await expect(revalidateCatalogImportDependenciesTx(tx as never, context, emptyAtPreview)).rejects.toMatchObject({
      statusCode: 409,
      code: 'STALE_PREVIEW',
    })
  })

  it('queries only active rows or captured price identities/keys under the organization lock', async () => {
    const tx = dependencyTx()

    await revalidateCatalogImportDependenciesTx(tx as never, context, snapshot)

    expect(tx.catalogItemPrice.findMany).toHaveBeenCalledTimes(1)
    for (const [call] of tx.catalogItemPrice.findMany.mock.calls) {
      expect(call.where.organizationId).toBe(context.organizationId)
      expect(call.where.scope).toBe('ORGANIZATION')
      expect(call.where.active === true || call.where.id?.in || call.where.OR).toBeTruthy()
    }
  })

  it('stops active-price hydration at captured-set plus one before querying another item chunk', async () => {
    const items = Array.from({ length: 26 }, (_, index) => ({
      id: `catalog-item-${index}`,
      revision: 1,
      invariantVersion: '1',
      status: 'ACTIVE',
      businessTypes: ['RETAIL_STORE'],
    }))
    const guarded = {
      ...snapshot,
      items,
      priceDependentItemIds: items.map(item => item.id),
      organizationValues: [],
      mappings: [],
    }
    const tx = dependencyTx()
    tx.catalogItem.findMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) =>
      where.id.in.map(id => ({
        id,
        revision: 1,
        invariantVersion: 1n,
        status: 'ACTIVE',
        businessTypes: [{ businessType: 'RETAIL_STORE' }],
      })),
    )
    tx.catalogProductTypeMapping.findMany.mockResolvedValue([])
    tx.catalogItemPrice.findMany.mockResolvedValue([
      {
        ...snapshot.organizationValues[0],
        id: 'new-active-price',
        catalogItemId: items[0]!.id,
      },
    ])

    await expect(revalidateCatalogImportDependenciesTx(tx as never, context, guarded)).rejects.toMatchObject({
      statusCode: 409,
      code: 'STALE_PREVIEW',
    })
    expect(tx.catalogItemPrice.findMany).toHaveBeenCalledTimes(1)
    expect(tx.catalogItemPrice.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 1, orderBy: { id: 'asc' } }))
  })

  it('accepts the exact aggregate child/profile set and rejects invariant, price, or new-profile drift', async () => {
    const stable = dependencyTx()
    await expect(revalidateCatalogImportDependenciesTx(stable as never, context, snapshot)).resolves.toBeUndefined()

    const drifts = [
      (tx: ReturnType<typeof dependencyTx>) =>
        tx.catalogItem.findMany.mockResolvedValue([
          {
            id: 'catalog-item-1',
            revision: 8,
            invariantVersion: 5n,
            status: 'ACTIVE',
            businessTypes: [{ businessType: 'RETAIL_STORE' }],
          },
        ]),
      (tx: ReturnType<typeof dependencyTx>) =>
        tx.catalogItemPrice.findMany.mockResolvedValue([{ ...snapshot.organizationValues[0], active: false }]),
      (tx: ReturnType<typeof dependencyTx>) =>
        tx.catalogValidationProfile.findMany.mockResolvedValue([
          {
            id: 'profile-new',
            profileVersion: 1,
            rulesSchemaVersion: 1,
            businessType: 'RETAIL_STORE',
            operationalRole: null,
            requiredFields: ['supplierCode'],
            additionalRules: null,
          },
        ]),
      (tx: ReturnType<typeof dependencyTx>) =>
        tx.catalogProductTypeMapping.findMany.mockResolvedValue([{ ...snapshot.mappings[0], productType: 'FOOD_AND_BEV' }]),
    ]
    for (const arrange of drifts) {
      const tx = dependencyTx()
      arrange(tx)
      await expect(revalidateCatalogImportDependenciesTx(tx as never, context, snapshot)).rejects.toMatchObject({
        statusCode: 409,
        code: 'STALE_PREVIEW',
      })
    }
    expect(stable.catalogProductTypeMapping.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          catalogProductType: true,
          productType: true,
          mappingVersion: true,
          active: true,
        }),
      }),
    )
  })

  it('ignores new inactive historical prices but detects every active or captured-key drift', async () => {
    const stable = dependencyTx()
    mockPriceRows(stable, [
      snapshot.organizationValues[0],
      {
        id: 'price-inactive-unrelated',
        catalogItemId: 'catalog-item-1',
        kind: 'PURCHASE_COST',
        scope: 'ORGANIZATION',
        currency: 'USD',
        revision: 1,
        active: false,
      },
    ])
    await expect(revalidateCatalogImportDependenciesTx(stable as never, context, snapshot)).resolves.toBeUndefined()

    const newlyActive = dependencyTx()
    mockPriceRows(newlyActive, [
      snapshot.organizationValues[0],
      {
        id: 'price-active-new',
        catalogItemId: 'catalog-item-1',
        kind: 'PURCHASE_COST',
        scope: 'ORGANIZATION',
        currency: 'USD',
        revision: 1,
        active: true,
      },
    ])
    await expect(revalidateCatalogImportDependenciesTx(newlyActive as never, context, snapshot)).rejects.toMatchObject({
      code: 'STALE_PREVIEW',
    })

    const capturedInactive = {
      ...snapshot,
      organizationValues: [{ ...snapshot.organizationValues[0], active: false }],
    }
    const retained = dependencyTx()
    mockPriceRows(retained, capturedInactive.organizationValues)
    await expect(revalidateCatalogImportDependenciesTx(retained as never, context, capturedInactive)).resolves.toBeUndefined()
    expect(retained.catalogItemPrice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          scope: 'ORGANIZATION',
          OR: expect.arrayContaining([
            { id: { in: ['price-1'] } },
            { catalogItemId: 'catalog-item-1', kind: 'SALE_PRICE', currency: 'MXN' },
          ]),
        }),
      }),
    )
  })

  it('revalidates maximum reference sets through tenant-scoped bind chunks', async () => {
    const references = Array.from({ length: CATALOG_IMPORT_LOOKUP_CHUNK_SIZE + 1 }, (_, index) => ({
      type: 'FAMILY' as const,
      id: `family-${index}`,
      revision: 1,
    }))
    const largeSnapshot = {
      ...snapshot,
      items: [],
      priceDependentItemIds: [],
      organizationValues: [],
      mappings: [],
      references,
    }
    const tx = dependencyTx()
    tx.catalogItem.findMany.mockResolvedValue([])
    tx.catalogItemPrice.findMany.mockResolvedValue([])
    tx.catalogProductTypeMapping.findMany.mockResolvedValue([])
    tx.catalogFamily.findMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) =>
      where.id.in.map(id => ({ id, revision: 1, status: 'ACTIVE' })),
    )

    await expect(revalidateCatalogImportDependenciesTx(tx as never, context, largeSnapshot)).resolves.toBeUndefined()

    expect(tx.catalogFamily.findMany).toHaveBeenCalledTimes(2)
    for (const [call] of tx.catalogFamily.findMany.mock.calls) {
      expect(call.where.organizationId).toBe(context.organizationId)
      expect(call.where.id.in.length).toBeLessThanOrEqual(CATALOG_IMPORT_LOOKUP_CHUNK_SIZE)
    }
  })

  it('rejects unknown, blank, duplicate, and oversized durable dependency shapes before database queries', async () => {
    const price = snapshot.organizationValues[0]!
    const reference = { type: 'BRAND' as const, id: 'brand-1', revision: 1 }
    const mapping = snapshot.mappings[0]!
    const profile = {
      id: 'profile-1',
      profileVersion: 1,
      rulesSchemaVersion: 1,
      businessType: 'RETAIL_STORE',
      operationalRole: null,
      requiredFields: ['supplierCode'],
      additionalRules: null,
    }
    const itemMissingKey = omitFixtureKey(snapshot.items[0]!, 'businessTypes')
    const snapshotMissingPriceAuthority = omitFixtureKey(snapshot, 'priceDependentItemIds')
    const priceMissingKey = omitFixtureKey(price, 'active')
    const referenceMissingKey = omitFixtureKey(reference, 'revision')
    const mappingMissingKey = omitFixtureKey(mapping, 'productType')
    const profileMissingKey = omitFixtureKey(profile, 'additionalRules')
    const malformed = [
      { ...snapshot, unexpected: true },
      { ...snapshot, items: [{ ...snapshot.items[0], id: '' }] },
      { ...snapshot, items: [itemMissingKey] },
      { ...snapshot, items: [null] },
      { ...snapshot, items: [snapshot.items[0], snapshot.items[0]] },
      { ...snapshot, items: Array.from({ length: 20_001 }, () => snapshot.items[0]) },
      snapshotMissingPriceAuthority,
      { ...snapshot, priceDependentItemIds: [''] },
      { ...snapshot, priceDependentItemIds: ['catalog-item-foreign'] },
      { ...snapshot, priceDependentItemIds: ['catalog-item-1', 'catalog-item-1'] },
      { ...snapshot, priceDependentItemIds: [null] },
      { ...snapshot, organizationValues: [{ ...price, unexpected: true }] },
      { ...snapshot, organizationValues: [{ ...price, id: '' }] },
      { ...snapshot, organizationValues: [priceMissingKey] },
      { ...snapshot, organizationValues: [7] },
      { ...snapshot, organizationValues: [price, price] },
      { ...snapshot, references: [{ ...reference, unexpected: true }] },
      { ...snapshot, references: [{ ...reference, id: '' }] },
      { ...snapshot, references: [referenceMissingKey] },
      { ...snapshot, references: [null] },
      { ...snapshot, references: [reference, reference] },
      { ...snapshot, mappings: [{ ...mapping, unexpected: true }] },
      { ...snapshot, mappings: [{ ...mapping, id: '' }] },
      { ...snapshot, mappings: [mappingMissingKey] },
      { ...snapshot, mappings: ['mapping'] },
      { ...snapshot, mappings: [mapping, mapping] },
      { ...snapshot, profiles: [{ ...profile, unexpected: true }] },
      { ...snapshot, profiles: [{ ...profile, id: '' }] },
      { ...snapshot, profiles: [profileMissingKey] },
      { ...snapshot, profiles: [false] },
      { ...snapshot, profiles: [profile, profile] },
      { ...snapshot, profiles: [{ ...profile, requiredFields: ['supplierCode', 'supplierCode'] }] },
      { ...snapshot, profiles: [{ ...profile, requiredFields: [''] }] },
      { ...snapshot, profiles: [{ ...profile, requiredFields: Array.from({ length: 65 }, (_, index) => `field-${index}`) }] },
    ]

    for (const value of malformed) {
      const tx = dependencyTx()
      await expect(revalidateCatalogImportDependenciesTx(tx as never, context, value)).rejects.toMatchObject({
        statusCode: 409,
        code: 'STALE_PREVIEW',
      })
      // WHY: Durable JSON is inspected and capped before it can become an
      // oversized tenant `IN` query or consume any Task 5 transaction work.
      expect(tx.catalogItem.findMany).not.toHaveBeenCalled()
    }
  })

  it('compares bounded non-applicable additional rules exactly instead of rejecting the whole profile set', async () => {
    const profile = {
      id: 'profile-unrelated',
      profileVersion: 3,
      rulesSchemaVersion: 1,
      businessType: 'RESTAURANT',
      operationalRole: null,
      requiredFields: [],
      additionalRules: { enforcePositiveShelfLife: true, nested: ['x', 1] },
    }
    const captured = { ...snapshot, profiles: [profile] }
    const stable = dependencyTx()
    stable.catalogValidationProfile.findMany.mockResolvedValue([profile])

    await expect(revalidateCatalogImportDependenciesTx(stable as never, context, captured)).resolves.toBeUndefined()

    const drifted = dependencyTx()
    drifted.catalogValidationProfile.findMany.mockResolvedValue([
      { ...profile, additionalRules: { enforcePositiveShelfLife: false, nested: ['x', 1] } },
    ])
    await expect(revalidateCatalogImportDependenciesTx(drifted as never, context, captured)).rejects.toMatchObject({
      code: 'STALE_PREVIEW',
    })
  })

  it('keeps full dependency parsing and exact-set revalidation within the main-thread budget', async () => {
    const count = 5_000
    const id = (prefix: string, index: number) => `${prefix}-${String(index).padStart(5, '0')}-${'x'.repeat(96)}`
    const items = Array.from({ length: count }, (_, index) => ({
      id: id('item', index),
      revision: 1,
      invariantVersion: '1',
      status: 'ACTIVE',
      businessTypes: ['RETAIL_STORE'],
    }))
    const organizationValues = items.map((item, index) => ({
      id: id('price', index),
      catalogItemId: item.id,
      kind: 'SALE_PRICE',
      scope: 'ORGANIZATION' as const,
      currency: 'MXN',
      revision: 1,
      active: true,
    }))
    const references = Array.from({ length: count }, (_, index) => ({
      type: 'FAMILY' as const,
      id: id('family', index),
      revision: 1,
    }))
    const mappings = Array.from({ length: count }, (_, index) => ({
      id: id('mapping', index),
      catalogProductType: `ALIAS_${index}`,
      productType: 'REGULAR',
      mappingVersion: 1,
      active: true as const,
    }))
    const largeSnapshot = {
      schemaVersion: 1 as const,
      capacity: calculateCatalogImportConfirmCapacityV1([]),
      items,
      priceDependentItemIds: items.map(item => item.id),
      organizationValues,
      references,
      mappings,
      profiles: [],
    }
    const itemById = new Map(items.map(value => [value.id, value]))
    const mappingById = new Map(mappings.map(value => [value.id, value]))
    const tx = dependencyTx()
    tx.catalogItem.findMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) =>
      where.id.in.map(itemId => {
        const value = itemById.get(itemId)!
        return { ...value, invariantVersion: 1n, businessTypes: [{ businessType: 'RETAIL_STORE' }] }
      }),
    )
    mockPriceRows(tx, organizationValues)
    tx.catalogFamily.findMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) =>
      where.id.in.map(familyId => ({ id: familyId, revision: 1, status: 'ACTIVE' })),
    )
    tx.catalogProductTypeMapping.findMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) =>
      where.id.in.map(mappingId => mappingById.get(mappingId)!),
    )

    const probe = startCatalogImportEventLoopProbeV1()
    let samples: readonly number[] = []
    try {
      await revalidateCatalogImportDependenciesTx(tx as never, context, largeSnapshot)
    } finally {
      samples = probe.stop()
    }

    // WHY: The test exercises the actual confirm revalidation boundary, not a
    // standalone hasher, with multi-megabyte captured and current sets.
    expectCatalogImportEventLoopBudgetV1(samples)
  }, 20_000)
})
