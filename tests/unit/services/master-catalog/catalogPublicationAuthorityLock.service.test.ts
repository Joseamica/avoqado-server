import {
  lockCatalogPublicationAuthoritiesTx,
  revalidateLockedCatalogPublicationTx,
} from '@/services/master-catalog/catalogPublicationAuthorityLock.service'
import { hashCanonicalJsonV1 } from '@/services/master-catalog/catalogHash.service'

describe('catalogPublicationAuthorityLock.service', () => {
  it('locks live authority in deterministic tenant-policy-catalog-product-recipe order', async () => {
    const statements: string[] = []
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      $queryRaw: jest.fn().mockImplementation(async query => {
        statements.push(query.strings.join('?'))
        return []
      }),
    }
    const batch = {
      id: 'batch-1',
      dependencies: {
        schemaVersion: 1,
        targets: [
          {
            catalogItemId: 'item-1',
            venueId: 'venue-1',
            productId: 'product-1',
            bindingId: 'binding-1',
            sourceCatalogRevision: 1,
            sourceCatalogInvariantVersion: '1',
            bindingRevision: 1,
            dependencies: {},
          },
          {
            catalogItemId: 'item-2',
            venueId: 'venue-2',
            productId: 'product-2',
            bindingId: 'binding-2',
            sourceCatalogRevision: 1,
            sourceCatalogInvariantVersion: '2',
            bindingRevision: 1,
            dependencies: {},
          },
        ],
      },
    }

    await lockCatalogPublicationAuthoritiesTx(
      tx as never,
      { organizationId: 'org-1', actor: { type: 'HUMAN', staffId: 'staff-1', impersonating: false } },
      batch as never,
    )

    const tableOrder = statements.map(statement => statement.match(/FROM "([^"]+)"/)?.[1])
    expect(tableOrder).toEqual([
      'Organization',
      'Staff',
      'StaffOrganization',
      'OrganizationEntitlement',
      'Module',
      'OrganizationModule',
      'Venue',
      'CatalogValidationProfile',
      'CatalogItem',
      'CatalogItemBusinessType',
      'CatalogItemPrice',
      'CatalogVenueBinding',
      'CatalogPublicationLine',
      'Product',
      'Recipe',
      'RecipeLine',
      'RawMaterial',
    ])
    expect(statements.every(statement => statement.includes('FOR NO KEY UPDATE'))).toBe(true)
    expect(tx.$executeRaw).toHaveBeenCalledTimes(3)
    expect(tx.$executeRaw.mock.calls.map(call => call[0].values)).toEqual([
      ['h1a:catalog-mutation:v1:org-1'],
      ['h1a:recipe-cost-graph:v1:venue-1'],
      ['h1a:recipe-cost-graph:v1:venue-2'],
    ])
    expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.$queryRaw.mock.invocationCallOrder[0])
    expect(tx.$executeRaw.mock.invocationCallOrder[2]).toBeLessThan(tx.$queryRaw.mock.invocationCallOrder[0])
  })

  it('locks exact binding ids and chunks every target-derived lock to at most 500 ids', async () => {
    const queries: Array<{ text: string; values: unknown[] }> = []
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      $queryRaw: jest.fn().mockImplementation(async query => {
        queries.push({ text: query.strings.join('?'), values: query.values })
        return []
      }),
    }
    const targets = Array.from({ length: 501 }, (_, index) => ({
      catalogItemId: `item-${String(index).padStart(3, '0')}`,
      venueId: `venue-${String(index).padStart(3, '0')}`,
      productId: `product-${String(index).padStart(3, '0')}`,
      bindingId: `binding-${String(index).padStart(3, '0')}`,
      sourceCatalogRevision: 1,
      sourceCatalogInvariantVersion: '1',
      bindingRevision: 1,
      dependencies: {},
    }))

    await lockCatalogPublicationAuthoritiesTx(
      tx as never,
      {
        organizationId: 'org-1',
        actor: { type: 'HUMAN', staffId: 'staff-1', impersonating: false },
      },
      { id: 'batch-1', dependencies: { schemaVersion: 1, targets } } as never,
    )

    const bindingQueries = queries.filter(query => query.text.includes('FROM "CatalogVenueBinding"'))
    expect(bindingQueries).toHaveLength(2)
    expect(bindingQueries.flatMap(query => query.values).filter(value => String(value).startsWith('binding-'))).toHaveLength(501)
    expect(bindingQueries.flatMap(query => query.values).some(value => String(value).startsWith('item-'))).toBe(false)
    expect(queries.filter(query => query.text.includes(' IN (')).every(query => query.values.length <= 501)).toBe(true)
  })

  const contradictoryMutations: Array<[string, { authority?: Record<string, unknown>; stored?: Record<string, unknown> }]> = [
    ['foreign staged binding', { authority: { bindingId: 'binding-foreign' } }],
    ['forged source revision', { authority: { sourceCatalogRevision: 999 } }],
    ['forged staged before', { stored: { before: { name: 'FORGED' } } }],
    ['future line versions', { stored: { hashVersion: 999, decisionSchemaVersion: 999 } }],
  ]

  it.each(contradictoryMutations)('rejects contradictory relational staging before apply: %s', async (_label, mutation) => {
    const projection = {
      fieldMask: ['name'],
      before: { name: 'local' },
      proposed: { name: 'corporate' },
      fields: [{ field: 'name', before: 'local', proposed: 'corporate', changed: true, diverged: false }],
      status: 'READY',
      diagnosticCode: null,
      diagnostic: null,
      canonicalTargetHash: 'a'.repeat(64),
    }
    const decision = {
      field: 'name',
      before: 'local',
      proposed: 'corporate',
      after: 'corporate',
      decision: 'PUBLISH_CORPORATE',
      overrideId: null,
    }
    const authority = {
      catalogItemId: 'item-1',
      venueId: 'venue-1',
      productId: 'product-1',
      bindingId: 'binding-1',
      sourceCatalogRevision: 7,
      sourceCatalogInvariantVersion: '12',
      bindingRevision: 4,
      dependencies: { projection: { profile: 'v1' }, decisions: [decision] },
      ...(mutation.authority ?? {}),
    }
    const stored = {
      id: 'line-1',
      organizationId: 'org-1',
      batchId: 'batch-1',
      bindingId: 'binding-1',
      catalogItemId: 'item-1',
      venueId: 'venue-1',
      productId: 'product-1',
      status: 'READY',
      fieldMask: ['name'],
      decisionSchemaVersion: 1,
      changeKind: 'PUBLICATION',
      hashVersion: 1,
      canonicalTargetHash: 'a'.repeat(64),
      before: { name: 'local' },
      after: { name: 'corporate' },
      sourceCatalogRevision: 7,
      bindingRevision: 4,
      supersedesLineId: null,
      reversesLineId: null,
      ...(mutation.stored ?? {}),
    }
    const tx = { catalogPublicationLine: { findMany: jest.fn().mockResolvedValue([stored]) } }
    const loadTargetsTx = jest.fn().mockResolvedValue([
      {
        organizationId: 'org-1',
        catalogItemId: 'item-1',
        venueId: 'venue-1',
        productId: 'product-1',
        bindingId: 'binding-1',
        sourceCatalogRevision: 7,
        sourceCatalogInvariantVersion: '12',
        bindingRevision: 4,
        dependencies: { profile: 'v1' },
        projection,
      },
    ])
    const resolve = jest.fn().mockResolvedValue([decision])

    await expect(
      (revalidateLockedCatalogPublicationTx as any)(
        tx,
        {
          organizationId: 'org-1',
          actor: { type: 'HUMAN', staffId: 'staff-1', impersonating: false },
        },
        {
          id: 'batch-1',
          operation: 'CATALOG_FIELDS_PUBLISH',
          targetHash: hashCanonicalJsonV1('catalog-publication-targets', {
            operation: 'CATALOG_FIELDS_PUBLISH',
            targets: ['a'.repeat(64)],
          }),
          dependencies: { schemaVersion: 1, targets: [authority] },
        },
        { loadTargetsTx, createOverrideService: () => ({ resolve }) },
      ),
    ).rejects.toMatchObject({ code: 'STALE_PREVIEW' })
    expect(resolve).not.toHaveBeenCalled()
  })
})
