import { persistCatalogPublicationTx } from '@/services/master-catalog/catalogPublicationPersistence.service'
import type { CatalogPublicationApplyLine } from '@/services/master-catalog/catalogPublication.types'

function line(index = 1, overrides: Partial<CatalogPublicationApplyLine> = {}): CatalogPublicationApplyLine {
  const base: CatalogPublicationApplyLine = {
    lineId: `line-${index}`,
    organizationId: 'org-1',
    catalogItemId: `item-${index}`,
    venueId: 'venue-1',
    productId: `product-${index}`,
    bindingId: `binding-${index}`,
    sourceCatalogRevision: 7,
    bindingRevision: 4,
    fieldMask: ['description', 'name'],
    decisions: [
      {
        field: 'description',
        decision: 'PUBLISH_CORPORATE',
        before: 'Local',
        proposed: 'Corporativa',
        after: 'Corporativa',
        overrideId: null,
        reason: null,
      },
      {
        field: 'name',
        decision: 'APPROVE_LOCAL_OVERRIDE',
        before: 'Conservar',
        proposed: 'Corporativo',
        after: 'Conservar',
        overrideId: 'override-1',
        reason: 'Excepción aprobada',
      },
    ],
  }
  return { ...base, ...overrides }
}

function transaction() {
  return {
    $executeRaw: jest.fn().mockImplementation(async query => {
      const sql = query.strings.join('?')
      if (sql.includes('UPDATE "Product"')) return query.values.length / 3
      if (sql.includes('UPDATE "CatalogVenueBinding"')) return (query.values.length - 1) / 7
      if (sql.includes('UPDATE "CatalogPublicationLine"')) return (query.values.length - 1) / 5
      return 0
    }),
    product: { update: jest.fn(), updateMany: jest.fn() },
    catalogVenueBinding: { update: jest.fn(), updateMany: jest.fn() },
    catalogPublicationLine: { update: jest.fn(), updateMany: jest.fn() },
    catalogPublicationFieldDecision: {
      createMany: jest.fn().mockImplementation(async ({ data }) => ({ count: data.length })),
    },
  }
}

describe('catalogPublicationPersistence.service', () => {
  it('writes only corporate Product fields and preserves approved local values in normalized decisions', async () => {
    const tx = transaction()

    await expect(
      persistCatalogPublicationTx(tx as never, {
        organizationId: 'org-1',
        staffId: 'staff-1',
        lines: [line()],
      }),
    ).resolves.toEqual([
      {
        lineId: 'line-1',
        catalogItemId: 'item-1',
        venueId: 'venue-1',
        productId: 'product-1',
        status: 'APPLIED',
      },
    ])

    const sql = tx.$executeRaw.mock.calls.map(call => call[0].strings.join('?')).join('\n')
    expect(sql).toContain('UPDATE "Product"')
    expect(sql).toContain('UPDATE "CatalogVenueBinding"')
    expect(sql).toContain('UPDATE "CatalogPublicationLine"')
    expect(tx.catalogPublicationFieldDecision.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({ lineId: 'line-1', field: 'description', decision: 'PUBLISH_CORPORATE' }),
        expect.objectContaining({ lineId: 'line-1', field: 'name', decision: 'APPROVE_LOCAL_OVERRIDE' }),
      ]),
    })
    const lineWrite = tx.$executeRaw.mock.calls.find(call => call[0].strings.join('?').includes('UPDATE "CatalogPublicationLine"'))
    expect(tx.catalogPublicationFieldDecision.createMany.mock.invocationCallOrder[0]).toBeLessThan(
      lineWrite?.[0] ? tx.$executeRaw.mock.invocationCallOrder[tx.$executeRaw.mock.calls.indexOf(lineWrite)] : Number.NaN,
    )
    expect(tx.product.update).not.toHaveBeenCalled()
    expect(tx.product.updateMany).not.toHaveBeenCalled()
  })

  it('keeps exact corporate cost and taxRate decimals in the bulk Product patch', async () => {
    const tx = transaction()
    const monetaryLine = line(1, {
      fieldMask: ['cost', 'taxRate'],
      decisions: [
        {
          field: 'cost',
          decision: 'PUBLISH_CORPORATE',
          before: '11.00',
          proposed: '12.00',
          after: '12.00',
          overrideId: null,
          reason: null,
        },
        {
          field: 'taxRate',
          decision: 'PUBLISH_CORPORATE',
          before: '0.0800',
          proposed: '0.1600',
          after: '0.1600',
          overrideId: null,
          reason: null,
        },
      ],
    })

    await persistCatalogPublicationTx(tx as never, {
      organizationId: 'org-1',
      staffId: 'staff-1',
      lines: [monetaryLine],
    })

    const productQuery = tx.$executeRaw.mock.calls.find(call => call[0].strings.join('?').includes('UPDATE "Product"'))?.[0]
    expect(productQuery?.values).toEqual(['product-1', 'venue-1', JSON.stringify({ cost: '12.00', taxRate: '0.1600' })])
    expect(productQuery?.strings.join('?')).toContain("(changes.patch->>'cost')::numeric")
    expect(productQuery?.strings.join('?')).toContain("(changes.patch->>'taxRate')::numeric")
  })

  it('chunks a 501-target atomic apply into bounded bulk statements of at most 500 targets', async () => {
    const tx = transaction()
    const lines = Array.from({ length: 501 }, (_, index) =>
      line(index + 1, {
        decisions: [
          {
            field: 'name',
            decision: 'PUBLISH_CORPORATE',
            before: `Local ${index}`,
            proposed: `Corporativo ${index}`,
            after: `Corporativo ${index}`,
            overrideId: null,
            reason: null,
          },
        ],
        fieldMask: ['name'],
      }),
    )

    await persistCatalogPublicationTx(tx as never, { organizationId: 'org-1', staffId: 'staff-1', lines })

    const productStatements = tx.$executeRaw.mock.calls.filter(call => call[0].strings.join('?').includes('UPDATE "Product"'))
    expect(productStatements).toHaveLength(2)
    expect(tx.product.update).not.toHaveBeenCalled()
  })

  it('marks an all-preserved line NO_CHANGE without issuing a Product update', async () => {
    const tx = transaction()
    const preserved = line(1, {
      decisions: [
        {
          field: 'name',
          decision: 'APPROVE_LOCAL_OVERRIDE',
          before: 'Conservar',
          proposed: 'Corporativo',
          after: 'Conservar',
          overrideId: 'override-1',
          reason: null,
        },
      ],
      fieldMask: ['name'],
    })

    const result = await persistCatalogPublicationTx(tx as never, {
      organizationId: 'org-1',
      staffId: 'staff-1',
      lines: [preserved],
    })

    expect(result[0]?.status).toBe('NO_CHANGE')
    expect(tx.$executeRaw.mock.calls.some(call => call[0].strings.join('?').includes('UPDATE "Product"'))).toBe(false)
  })

  it.each([
    ['Product', 'UPDATE "Product"'],
    ['binding', 'UPDATE "CatalogVenueBinding"'],
    ['line', 'UPDATE "CatalogPublicationLine"'],
  ])('rolls back when the bulk %s affected count is not exact', async (_label, statement) => {
    const tx = transaction()
    const original = tx.$executeRaw.getMockImplementation() as (query: { strings: string[]; values: unknown[] }) => Promise<number>
    tx.$executeRaw.mockImplementation(async query => (query.strings.join('?').includes(statement) ? 0 : original(query)))

    await expect(
      persistCatalogPublicationTx(tx as never, { organizationId: 'org-1', staffId: 'staff-1', lines: [line()] }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'CATALOG_PUBLICATION_STATE_CONFLICT' })
  })

  it('rolls back when normalized decision creation is partial', async () => {
    const tx = transaction()
    tx.catalogPublicationFieldDecision.createMany.mockResolvedValueOnce({ count: 0 })

    await expect(
      persistCatalogPublicationTx(tx as never, { organizationId: 'org-1', staffId: 'staff-1', lines: [line()] }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'CATALOG_PUBLICATION_STATE_CONFLICT' })
  })

  it('writes tenant-safe successor and historical reversal lineage in the terminal line CAS', async () => {
    const tx = transaction()

    await persistCatalogPublicationTx(tx as never, {
      organizationId: 'org-1',
      staffId: 'staff-1',
      lines: [line(1, { supersedesLineId: 'current-line-2', reversesLineId: 'historical-line-1' })],
    })

    const lineQuery = tx.$executeRaw.mock.calls.find(call => call[0].strings.join('?').includes('UPDATE "CatalogPublicationLine"'))?.[0]
    expect(lineQuery?.strings.join('?')).toContain('"supersedesLineId"')
    expect(lineQuery?.strings.join('?')).toContain('"reversesLineId"')
    expect(lineQuery?.values).toEqual(expect.arrayContaining(['current-line-2', 'historical-line-1']))
  })
})
