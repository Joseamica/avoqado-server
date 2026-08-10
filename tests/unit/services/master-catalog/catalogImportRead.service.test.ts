import type { CatalogCommandContext } from '@/types/master-catalog'
import { createCatalogImportReadService } from '@/services/master-catalog/catalogImportRead.service'

const organizationId = 'org-pits'
const batchId = 'import-batch-1'
const targetHash = 'a'.repeat(64)
const previewTokenHash = 'b'.repeat(64)
const previewExpiresAt = new Date('2026-08-09T02:30:00.000Z')
const capacity = {
  schemaVersion: 1 as const,
  costModelVersion: 1 as const,
  measurement: 'EXACT' as const,
  workUnits: 52,
  limit: 12_000 as const,
  withinLimit: true,
  breakdown: {
    base: 32 as const,
    referenceProposals: 0,
    createItems: 0,
    updateItems: 20,
    retireItems: 0,
    organizationValues: 4,
    deactivations: 4,
  },
}
const context: CatalogCommandContext = {
  organizationId,
  actor: { type: 'HUMAN', staffId: 'staff-owner', impersonating: false },
  orgRole: 'OWNER',
}

// WHY: Read tests model only the narrow tenant/access/query seams; no database
// or raw staged payload is needed to prove authorization and response bounds.
function buildHarness() {
  const tx = {
    $queryRaw: jest.fn(),
  }
  const prisma = {
    $transaction: jest.fn().mockImplementation(async (work: (client: typeof tx) => unknown) => work(tx)),
  }
  const assertLiveAccessTx = jest.fn().mockResolvedValue(undefined)
  const queryBatchTx = jest.fn().mockResolvedValue({
    id: batchId,
    organizationId,
    schemaVersion: 1,
    targetHash,
    previewTokenHash,
    staffId: 'staff-owner',
    state: 'PREVIEWED',
    previewExpiresAt,
    capacity,
    lineCount: 4,
    itemCount: 1,
    capacityIntegrityValid: true,
    invalidLineCount: 0,
    invalidPayloadCount: 0,
    oversizedSheetCount: 0,
  })
  const querySectionPageTx = jest.fn().mockResolvedValue([
    {
      sourceSheet: 'Items',
      sourceRow: 2,
      ordinal: 0,
      durableShapeValid: true,
      status: 'READY',
      operation: 'CREATE',
      catalogItemId: null,
      proofCorporateSku: 'SKU-2',
      name: 'Producto',
      itemKind: 'RETAIL_PRODUCT',
      organizationValueCount: 2,
      businessTypeCount: 1,
      referenceProposalCount: 0,
      venueBindingRequestCount: 0,
      errorCount: 0,
    },
  ])
  const queryItemDetailTx = jest.fn().mockResolvedValue({
    sourceSheet: 'Items',
    sourceRow: 2,
    ordinal: 0,
    durableShapeValid: true,
    status: 'READY',
    operation: 'CREATE',
    catalogItemId: null,
    proofCorporateSku: 'SKU-2',
    name: 'Producto',
    description: 'Descripción',
    imageUrl: 'https://cdn.example.test/item.png',
    itemKind: 'RETAIL_PRODUCT',
    brandId: 'brand-1',
    manufacturerId: 'manufacturer-1',
    familyId: 'family-1',
    presentationLabel: 'Pieza',
    unit: 'UNIT',
    productType: 'REGULAR',
    taxRate: '0.1600',
    satProductKey: '50161509',
    satUnitKey: 'H87',
    objetoImp: '02',
    iepsMode: 'NONE',
    iepsRate: null,
    iepsQuota: null,
    iepsQuotaUnit: null,
    organizationValueCount: 2,
    businessTypeCount: 1,
    referenceProposalCount: 0,
    venueBindingRequestCount: 0,
    errorCount: 0,
  })
  const queryProfileVersionsTx = jest
    .fn()
    .mockResolvedValue([{ batchId, collectionShapeValid: true, ordinal: 0, rowShapeValid: true, profileVersion: null }])
  const service = createCatalogImportReadService({
    prisma: prisma as never,
    assertLiveAccessTx,
    queryBatchTx,
    querySectionPageTx,
    queryItemDetailTx,
    queryProfileVersionsTx,
    now: () => new Date('2026-08-09T02:00:00.000Z'),
  })
  return { tx, prisma, assertLiveAccessTx, queryBatchTx, querySectionPageTx, queryItemDetailTx, queryProfileVersionsTx, service }
}

describe('catalogImportRead.service authorization and pagination', () => {
  it('uses one RepeatableRead snapshot so confirmation cannot mix PREVIEWED batch metadata with APPLIED rows', async () => {
    const h = buildHarness()

    await h.service.listPage(context, { importBatchId: batchId, section: 'ITEMS' })

    expect(h.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ isolationLevel: 'RepeatableRead' }))
  })

  it('revalidates live MUTATE_CONTENT/CORE access, exact tenant, and preview actor before reading a default page', async () => {
    const h = buildHarness()

    const result = await h.service.listPage(context, { importBatchId: batchId, section: 'ITEMS' })

    expect(h.assertLiveAccessTx).toHaveBeenCalledWith(h.tx, context)
    expect(h.queryBatchTx).toHaveBeenCalledWith(h.tx, { organizationId, importBatchId: batchId })
    expect(h.assertLiveAccessTx.mock.invocationCallOrder[0]).toBeLessThan(h.queryBatchTx.mock.invocationCallOrder[0])
    expect(h.querySectionPageTx).toHaveBeenCalledWith(h.tx, {
      organizationId,
      importBatchId: batchId,
      section: 'ITEMS',
      after: null,
      take: 26,
    })
    expect(result).toEqual({
      schemaVersion: 1,
      importBatchId: batchId,
      section: 'ITEMS',
      pageSize: 25,
      batch: {
        state: 'PREVIEWED',
        targetHash,
        expiresAt: previewExpiresAt.toISOString(),
        canConfirm: true,
        capacity,
      },
      rows: [expect.objectContaining({ corporateSku: 'SKU-2', sourceRow: 2 })],
      nextCursor: null,
    })
  })

  it('rejects SERVICE, impersonation, and a blank human actor before opening a transaction', async () => {
    for (const actor of [
      { type: 'SERVICE' as const, servicePrincipalId: 'worker' },
      { type: 'HUMAN' as const, staffId: 'staff-owner', impersonating: true },
      { type: 'HUMAN' as const, staffId: ' ', impersonating: false },
    ]) {
      const h = buildHarness()
      await expect(h.service.listPage({ ...context, actor }, { importBatchId: batchId, section: 'ITEMS' })).rejects.toMatchObject({
        statusCode: 403,
        code: 'CATALOG_HUMAN_ACTOR_REQUIRED',
      })
      expect(h.prisma.$transaction).not.toHaveBeenCalled()
    }
  })

  it('does not reveal batch existence when live access fails or the tenant id is foreign', async () => {
    const denied = buildHarness()
    denied.assertLiveAccessTx.mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'GATE_DISABLED' }))
    await expect(denied.service.listPage(context, { importBatchId: batchId, section: 'ITEMS' })).rejects.toMatchObject({
      code: 'GATE_DISABLED',
    })
    expect(denied.queryBatchTx).not.toHaveBeenCalled()

    const foreign = buildHarness()
    foreign.queryBatchTx.mockResolvedValueOnce(null)
    await expect(foreign.service.listPage(context, { importBatchId: 'foreign-batch', section: 'ITEMS' })).rejects.toMatchObject({
      statusCode: 404,
    })
    expect(foreign.querySectionPageTx).not.toHaveBeenCalled()
  })

  it('requires the same human who created the preview even inside the same organization', async () => {
    const h = buildHarness()

    await expect(
      h.service.listPage(
        { ...context, actor: { type: 'HUMAN', staffId: 'staff-other', impersonating: false } },
        {
          importBatchId: batchId,
          section: 'ITEMS',
        },
      ),
    ).rejects.toMatchObject({ statusCode: 403, code: 'CATALOG_IMPORT_ACTOR_MISMATCH' })
    expect(h.querySectionPageTx).not.toHaveBeenCalled()
  })

  it('caps a 20k nested section response at 50 and emits a signed keyset cursor', async () => {
    const h = buildHarness()
    h.querySectionPageTx.mockResolvedValueOnce(
      Array.from({ length: 51 }, (_, index) => ({
        sourceSheet: 'BusinessTypes',
        sourceRow: 10 + index * 2,
        ordinal: 0,
        durableShapeValid: true,
        status: 'READY',
        proofCorporateSku: 'SKU-2',
        businessType: 'RETAIL_STORE',
      })),
    )

    const first = await h.service.listPage(context, { importBatchId: batchId, section: 'BUSINESS_TYPES', pageSize: 50 })

    expect(first.rows).toHaveLength(50)
    expect(first.nextCursor).toEqual(expect.any(String))
    expect(JSON.stringify(first).length).toBeLessThan(20_000)

    h.querySectionPageTx.mockResolvedValueOnce([])
    const second = await h.service.listPage(context, {
      importBatchId: batchId,
      section: 'BUSINESS_TYPES',
      pageSize: 50,
      cursor: first.nextCursor,
    })
    expect(h.querySectionPageTx).toHaveBeenLastCalledWith(h.tx, {
      organizationId,
      importBatchId: batchId,
      section: 'BUSINESS_TYPES',
      after: { sourceSheet: 'BusinessTypes', sourceRow: 108, ordinal: 0 },
      take: 51,
    })
    expect(second.nextCursor).toBeNull()
  })

  it('rejects a tampered cursor before querying any staged line', async () => {
    const h = buildHarness()
    h.querySectionPageTx.mockResolvedValueOnce(
      Array.from({ length: 26 }, (_, index) => ({
        sourceSheet: 'Items',
        sourceRow: index + 2,
        ordinal: 0,
        durableShapeValid: true,
        status: 'READY',
        operation: 'RETIRE',
        catalogItemId: `item-${index}`,
        proofCorporateSku: null,
        name: null,
        itemKind: null,
        organizationValueCount: 0,
        businessTypeCount: 0,
        referenceProposalCount: 0,
        venueBindingRequestCount: 0,
        errorCount: 0,
      })),
    )
    const page = await h.service.listPage(context, { importBatchId: batchId, section: 'ITEMS' })
    const [payload, signature] = (page.nextCursor as string).split('.')
    const tampered = `${payload?.startsWith('a') ? 'b' : 'a'}${payload?.slice(1)}.${signature}`
    h.querySectionPageTx.mockClear()

    await expect(h.service.listPage(context, { importBatchId: batchId, section: 'ITEMS', cursor: tampered })).rejects.toMatchObject({
      code: 'CATALOG_IMPORT_CURSOR_INVALID',
    })
    expect(h.querySectionPageTx).not.toHaveBeenCalled()
  })

  it('returns one bounded scalar detail and rejects an absent source row', async () => {
    const h = buildHarness()

    const detail = await h.service.getItemDetail(context, { importBatchId: batchId, sourceRow: 2 })

    expect(h.queryItemDetailTx).toHaveBeenCalledWith(h.tx, { organizationId, importBatchId: batchId, sourceRow: 2 })
    expect(detail).toEqual({
      schemaVersion: 1,
      importBatchId: batchId,
      batch: {
        state: 'PREVIEWED',
        targetHash,
        expiresAt: previewExpiresAt.toISOString(),
        canConfirm: true,
        capacity,
      },
      row: expect.objectContaining({ sourceRow: 2, corporateSku: 'SKU-2' }),
    })

    h.queryItemDetailTx.mockResolvedValueOnce(null)
    await expect(h.service.getItemDetail(context, { importBatchId: batchId, sourceRow: 99 })).rejects.toMatchObject({ statusCode: 404 })
  })

  it.each(['proofCorporateSku', 'name'])('fails closed when a READY CREATE Items page omits required %s', async field => {
    const h = buildHarness()
    h.querySectionPageTx.mockResolvedValueOnce([
      {
        sourceSheet: 'Items',
        sourceRow: 2,
        ordinal: 0,
        durableShapeValid: true,
        status: 'READY',
        operation: 'CREATE',
        catalogItemId: null,
        proofCorporateSku: 'SKU-2',
        name: 'Producto',
        itemKind: 'RETAIL_PRODUCT',
        organizationValueCount: 2,
        businessTypeCount: 1,
        referenceProposalCount: 0,
        venueBindingRequestCount: 0,
        errorCount: 0,
        [field]: null,
      },
    ])

    // WHY: SQL proves only the bounded container. The real service must still
    // fail before emitting a READY mutation whose visible identity is absent.
    await expect(h.service.listPage(context, { importBatchId: batchId, section: 'ITEMS' })).rejects.toMatchObject({
      code: 'CATALOG_IMPORT_PREVIEW_DATA_INVALID',
    })
  })

  it.each(['proofCorporateSku', 'name', 'unit', 'productType', 'taxRate', 'imageUrl'])(
    'fails closed when a READY CREATE detail omits required %s',
    async field => {
      const h = buildHarness()
      const valid = await h.queryItemDetailTx()
      h.queryItemDetailTx.mockClear()
      h.queryItemDetailTx.mockResolvedValueOnce({ ...valid, [field]: null })

      await expect(h.service.getItemDetail(context, { importBatchId: batchId, sourceRow: 2 })).rejects.toMatchObject({
        code: 'CATALOG_IMPORT_PREVIEW_DATA_INVALID',
      })
    },
  )

  it.each([
    ['unit enum', { unit: 'WAT' }],
    ['kind/productType matrix', { productType: 'SERVICE' }],
    ['canonical tax rate', { taxRate: '0.16' }],
    ['HTTP image URL', { imageUrl: 'ftp://cdn.example.test/item.png' }],
  ])('fails closed on an invalid READY CREATE detail %s', async (_label, patch) => {
    const h = buildHarness()
    const valid = await h.queryItemDetailTx()
    h.queryItemDetailTx.mockClear()
    h.queryItemDetailTx.mockResolvedValueOnce({ ...valid, ...patch })

    await expect(h.service.getItemDetail(context, { importBatchId: batchId, sourceRow: 2 })).rejects.toMatchObject({
      code: 'CATALOG_IMPORT_PREVIEW_DATA_INVALID',
    })
  })

  it('returns both workbook UPSERTs and synthesized UPDATE deactivations with stable coordinates', async () => {
    const h = buildHarness()
    const deactivation = {
      sourceSheet: 'Items',
      sourceRow: 9,
      ordinal: 1,
      durableShapeValid: true,
      status: 'READY',
      action: 'DEACTIVATE',
      proofCorporateSku: 'SKU-9',
      kind: 'SALE_PRICE',
      currency: 'MXN',
      amount: null,
      expectedRuleRevision: '7',
    }
    const upsert = {
      sourceSheet: 'OrganizationValues',
      sourceRow: 80,
      ordinal: 0,
      durableShapeValid: true,
      status: 'READY',
      action: 'UPSERT',
      proofCorporateSku: 'SKU-9',
      kind: 'SALE_PRICE',
      currency: 'MXN',
      amount: '25.00',
      expectedRuleRevision: '8',
    }
    h.querySectionPageTx.mockResolvedValueOnce([deactivation, upsert])

    const first = await h.service.listPage(context, {
      importBatchId: batchId,
      section: 'ORGANIZATION_VALUES',
      pageSize: 1,
    })

    expect(first.rows).toEqual([
      expect.objectContaining({ sourceSheet: 'Items', sourceRow: 9, ordinal: 1, action: 'DEACTIVATE', amount: null }),
    ])
    expect(first.nextCursor).toEqual(expect.any(String))

    h.querySectionPageTx.mockResolvedValueOnce([upsert])
    const second = await h.service.listPage(context, {
      importBatchId: batchId,
      section: 'ORGANIZATION_VALUES',
      pageSize: 1,
      cursor: first.nextCursor,
    })

    expect(h.querySectionPageTx).toHaveBeenLastCalledWith(h.tx, {
      organizationId,
      importBatchId: batchId,
      section: 'ORGANIZATION_VALUES',
      after: { sourceSheet: 'Items', sourceRow: 9, ordinal: 1 },
      take: 2,
    })
    expect(second.rows).toEqual([
      expect.objectContaining({ sourceSheet: 'OrganizationValues', sourceRow: 80, ordinal: 0, action: 'UPSERT' }),
    ])
  })

  it('reads every version from a valid durable profile snapshot larger than 100 rows', async () => {
    const h = buildHarness()
    const versions = Array.from({ length: 152 }, (_, index) => index + 1)
    h.queryProfileVersionsTx.mockResolvedValueOnce(
      versions.map((profileVersion, index) => ({
        batchId,
        collectionShapeValid: true,
        ordinal: index + 1,
        rowShapeValid: true,
        profileVersion: String(profileVersion),
      })),
    )

    await expect(h.service.getSnapshotProfileVersions(context, batchId)).resolves.toEqual(versions)
  })
})
