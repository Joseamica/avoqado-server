import {
  loadCatalogPublicationReversionAuthoritiesTx,
  revalidateLockedCatalogPublicationReversionsTx,
  reversionBatchTargetHash,
} from '@/services/master-catalog/catalogPublicationReversionAuthority.service'

const context = {
  organizationId: 'org-1',
  actor: { type: 'HUMAN' as const, staffId: 'staff-1', impersonating: false },
}

function source(index: number, overrides: Record<string, unknown> = {}) {
  const suffix = String(index).padStart(3, '0')
  return {
    id: `source-${suffix}`,
    organizationId: 'org-1',
    bindingId: `binding-${suffix}`,
    catalogItemId: `item-${suffix}`,
    venueId: `venue-${suffix}`,
    productId: `product-${suffix}`,
    status: 'APPLIED',
    fieldMask: ['name'],
    decisionSchemaVersion: 1,
    hashVersion: 1,
    changeKind: 'PUBLICATION',
    before: { name: 'Old' },
    after: { name: 'Corporate' },
    sourceCatalogRevision: 6,
    bindingRevision: 3,
    decisions: [{ field: 'name', before: 'Old', proposed: 'Corporate', after: 'Corporate', decision: 'PUBLISH_CORPORATE' }],
    binding: {
      revision: 4,
      catalogItem: { revision: 7, invariantVersion: 12n },
      product: { name: 'Corporate', deletedAt: null },
    },
    ...overrides,
  }
}

describe('catalogPublicationReversionAuthority.service', () => {
  it('loads 10k-safe chunks and uses the current leaf as supersedes while reversing the historical source', async () => {
    const sources = Array.from({ length: 501 }, (_, index) => source(index))
    const tx = {
      catalogPublicationLine: {
        findMany: jest.fn().mockImplementation(async ({ where }: any) => {
          if (where.id?.in) return sources.filter(row => where.id.in.includes(row.id))
          if (where.bindingId?.in)
            return where.bindingId.in.map((bindingId: string) => ({
              id: `current-${bindingId}`,
              bindingId,
            }))
          return []
        }),
      },
    }
    const targets = sources.map(row => ({
      catalogItemId: row.catalogItemId,
      venueId: row.venueId,
      productId: row.productId,
      sourceLineId: row.id,
    }))
    const project = jest.fn((input: any) => ({
      organizationId: input.source.organizationId,
      bindingId: input.source.bindingId,
      catalogItemId: input.source.catalogItemId,
      venueId: input.source.venueId,
      productId: input.source.productId,
      fieldMask: ['name'],
      before: input.currentValues,
      after: { name: 'Old' },
      decisions: input.source.decisions,
      supersedesLineId: input.currentLineId,
      reversesLineId: input.source.id,
      changeKind: 'REVERSION',
      canonicalTargetHash: `hash-${input.source.id}`,
    }))

    const authorities = await loadCatalogPublicationReversionAuthoritiesTx(tx as never, context, targets, project as never)

    expect(authorities).toHaveLength(501)
    expect(authorities[0].projection).toMatchObject({
      supersedesLineId: 'current-binding-000',
      reversesLineId: 'source-000',
    })
    const sourceCalls = tx.catalogPublicationLine.findMany.mock.calls.filter(([input]) => input.where.id?.in)
    const currentCalls = tx.catalogPublicationLine.findMany.mock.calls.filter(([input]) => input.where.bindingId?.in)
    expect(sourceCalls.map(([input]) => input.where.id.in.length)).toEqual([500, 1])
    expect(currentCalls.map(([input]) => input.where.bindingId.in.length)).toEqual([500, 1])
    expect(sourceCalls[0][0].where.batch.operation.in).toEqual(['CATALOG_FIELDS_PUBLISH', 'CATALOG_FIELDS_REVERSION'])
    expect(sourceCalls[0][0].where.reversedByLines).toEqual({
      none: { status: 'APPLIED', batch: { operation: 'CATALOG_FIELDS_REVERSION' } },
    })
    expect(currentCalls[0][0].where).toMatchObject({
      batch: { operation: { in: ['CATALOG_FIELDS_PUBLISH', 'CATALOG_FIELDS_REVERSION'] } },
      supersededByLines: { none: { batch: { operation: { in: ['CATALOG_FIELDS_PUBLISH', 'CATALOG_FIELDS_REVERSION'] } } } },
    })
  })

  it('fails closed when immutable source JSON contradicts its decisions', async () => {
    const row = source(0, { before: { name: 'FORGED' } })
    const tx = {
      catalogPublicationLine: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([row])
          .mockResolvedValueOnce([{ id: 'current-binding-000', bindingId: 'binding-000' }]),
      },
    }

    await expect(
      loadCatalogPublicationReversionAuthoritiesTx(
        tx as never,
        context,
        [
          {
            catalogItemId: 'item-000',
            venueId: 'venue-000',
            productId: 'product-000',
            sourceLineId: 'source-000',
          },
        ],
        jest.fn() as never,
      ),
    ).rejects.toMatchObject({ code: 'CATALOG_REVERSION_CONFLICT' })
  })

  it('rejects a new current successor after preview before any inverse persistence', async () => {
    const projection = {
      organizationId: 'org-1',
      bindingId: 'binding-000',
      catalogItemId: 'item-000',
      venueId: 'venue-000',
      productId: 'product-000',
      fieldMask: ['name'],
      before: { name: 'Corporate' },
      after: { name: 'Old' },
      decisions: source(0).decisions,
      supersedesLineId: 'current-new',
      reversesLineId: 'source-000',
      changeKind: 'REVERSION',
      canonicalTargetHash: 'c'.repeat(64),
    }
    const authority = { projection, sourceCatalogRevision: 7, sourceCatalogInvariantVersion: '12', bindingRevision: 4 }
    const stagedTarget = {
      catalogItemId: 'item-000',
      venueId: 'venue-000',
      productId: 'product-000',
      bindingId: 'binding-000',
      sourceCatalogRevision: 7,
      sourceCatalogInvariantVersion: '12',
      bindingRevision: 4,
      dependencies: { reversion: { sourceLineId: 'source-000', currentLineId: 'current-old' } },
    }
    const tx = {
      catalogPublicationLine: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'line-revert',
            organizationId: 'org-1',
            batchId: 'batch-revert',
            bindingId: 'binding-000',
            catalogItemId: 'item-000',
            venueId: 'venue-000',
            productId: 'product-000',
            status: 'READY',
            hashVersion: 1,
            decisionSchemaVersion: 1,
            changeKind: 'REVERSION',
            sourceCatalogRevision: 7,
            bindingRevision: 4,
            canonicalTargetHash: 'c'.repeat(64),
            fieldMask: ['name'],
            before: projection.before,
            after: projection.after,
            supersedesLineId: 'current-old',
            reversesLineId: 'source-000',
          },
        ]),
      },
    }
    const load = jest.fn().mockResolvedValue([authority])

    await expect(
      revalidateLockedCatalogPublicationReversionsTx(
        tx as never,
        context,
        {
          id: 'batch-revert',
          operation: 'CATALOG_FIELDS_REVERSION',
          targetHash: reversionBatchTargetHash([projection as never]),
          dependencies: { schemaVersion: 1, targets: [stagedTarget] },
        } as never,
        jest.fn() as never,
        load as never,
      ),
    ).rejects.toMatchObject({ code: 'CATALOG_REVERSION_CONFLICT' })
  })
})
