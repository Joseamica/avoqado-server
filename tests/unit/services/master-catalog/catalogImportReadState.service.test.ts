import { createCatalogImportReadService } from '@/services/master-catalog/catalogImportRead.service'
import type { CatalogCommandContext } from '@/types/master-catalog'

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

function buildHarness() {
  // WHY: State/integrity tests inject only bounded scalar query rows so the
  // service contract is proven independently of PostgreSQL and authorization.
  const tx = { $queryRaw: jest.fn() }
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
  const service = createCatalogImportReadService({
    prisma: { $transaction: jest.fn().mockImplementation(async (work: (client: typeof tx) => unknown) => work(tx)) } as never,
    assertLiveAccessTx: jest.fn().mockResolvedValue(undefined),
    queryBatchTx,
    querySectionPageTx,
    queryItemDetailTx: jest.fn(),
    now: () => new Date('2026-08-09T02:00:00.000Z'),
  })
  return { queryBatchTx, querySectionPageTx, service }
}

describe('catalogImportRead.service batch state and integrity', () => {
  it('fails closed on malformed durable batch hashes before using them as cursor keys', async () => {
    const h = buildHarness()
    h.queryBatchTx.mockResolvedValueOnce({
      ...(await h.queryBatchTx()),
      targetHash: 'UPPER'.repeat(10),
    })
    h.queryBatchTx.mockClear()

    await expect(h.service.listPage(context, { importBatchId: batchId, section: 'ITEMS' })).rejects.toMatchObject({
      code: 'CATALOG_IMPORT_PREVIEW_DATA_INVALID',
    })
    expect(h.querySectionPageTx).not.toHaveBeenCalled()
  })

  it('marks an expired PREVIEWED batch non-confirmable while keeping its bounded review readable', async () => {
    const h = buildHarness()
    h.queryBatchTx.mockResolvedValueOnce({
      ...(await h.queryBatchTx()),
      previewExpiresAt: new Date('2026-08-09T01:59:59.999Z'),
    })
    h.queryBatchTx.mockClear()

    const result = await h.service.listPage(context, { importBatchId: batchId, section: 'ITEMS' })

    expect(result.batch.canConfirm).toBe(false)
    expect(result.batch.expiresAt).toBe('2026-08-09T01:59:59.999Z')
  })

  it.each(['NOT_STARTED', 'APPLYING', 'EXPIRED', 'SUPERSEDED'])(
    'rejects non-readable batch state %s before applying preview-line invariants',
    async state => {
      // WHY: In-flight/uninitialized/shared-terminal states have no stable line
      // matrix that this human review API can safely certify.
      const h = buildHarness()
      h.queryBatchTx.mockResolvedValueOnce({ ...(await h.queryBatchTx()), state })
      h.queryBatchTx.mockClear()

      await expect(h.service.listPage(context, { importBatchId: batchId, section: 'ITEMS' })).rejects.toMatchObject({
        code: 'CATALOG_IMPORT_PREVIEW_DATA_INVALID',
      })
      expect(h.querySectionPageTx).not.toHaveBeenCalled()
    },
  )

  it('keeps APPLIED Items and ancillary venue requests readable with canConfirm false', async () => {
    const h = buildHarness()
    h.queryBatchTx.mockResolvedValue({ ...(await h.queryBatchTx()), state: 'APPLIED' })
    h.queryBatchTx.mockClear()
    h.querySectionPageTx
      .mockResolvedValueOnce([
        {
          sourceSheet: 'Items',
          sourceRow: 2,
          ordinal: 0,
          durableShapeValid: true,
          status: 'APPLIED',
          operation: 'CREATE',
          catalogItemId: 'item-2',
          proofCorporateSku: 'SKU-2',
          name: 'Producto',
          itemKind: 'RETAIL_PRODUCT',
          organizationValueCount: 2,
          businessTypeCount: 1,
          referenceProposalCount: 0,
          venueBindingRequestCount: 1,
          errorCount: 0,
        },
      ])
      .mockResolvedValueOnce([
        {
          sourceSheet: 'VenueBindingRequests',
          sourceRow: 80,
          ordinal: 0,
          durableShapeValid: true,
          status: 'READY',
          proofCorporateSku: 'SKU-2',
          venueId: 'venue-1',
          requestedAction: 'CREATE',
          productId: null,
          proofLocalSku: 'LOCAL-2',
          categoryId: 'category-1',
          initialPrice: '20.00',
          currency: 'MXN',
        },
      ])

    const items = await h.service.listPage(context, { importBatchId: batchId, section: 'ITEMS' })
    const bindings = await h.service.listPage(context, { importBatchId: batchId, section: 'VENUE_BINDING_REQUESTS' })

    expect(items.batch).toEqual(expect.objectContaining({ state: 'APPLIED', canConfirm: false }))
    expect(items.rows[0]).toEqual(expect.objectContaining({ status: 'APPLIED', corporateSku: 'SKU-2' }))
    expect(bindings.rows[0]).toEqual(expect.objectContaining({ status: 'READY', venueId: 'venue-1' }))
  })

  it.each([
    ['mismatched work flag', { ...capacity, workUnits: 12_001, withinLimit: true }],
    ['wrong frozen limit', { ...capacity, limit: 11_999 }],
    ['double-counted breakdown', { ...capacity, workUnits: 53 }],
    ['missing capacity', null],
  ])('fails closed on %s before querying staged rows', async (_label, invalidCapacity) => {
    const h = buildHarness()
    h.queryBatchTx.mockResolvedValueOnce({ ...(await h.queryBatchTx()), capacity: invalidCapacity })
    h.queryBatchTx.mockClear()

    await expect(h.service.listPage(context, { importBatchId: batchId, section: 'ITEMS' })).rejects.toMatchObject({
      code: 'CATALOG_IMPORT_PREVIEW_DATA_INVALID',
    })
    expect(h.querySectionPageTx).not.toHaveBeenCalled()
  })

  it.each([
    ['invalid line metadata', 1, 0],
    ['invalid payload shape', 0, 1],
  ])('fails closed on %s during batch preflight before querying a page', async (_label, invalidLineCount, invalidPayloadCount) => {
    const h = buildHarness()
    h.queryBatchTx.mockResolvedValueOnce({ ...(await h.queryBatchTx()), invalidLineCount, invalidPayloadCount })
    h.queryBatchTx.mockClear()

    await expect(h.service.listPage(context, { importBatchId: batchId, section: 'ITEMS' })).rejects.toMatchObject({
      code: 'CATALOG_IMPORT_PREVIEW_DATA_INVALID',
    })
    expect(h.querySectionPageTx).not.toHaveBeenCalled()
  })

  it('rejects a source sheet above its frozen 20k line cap', async () => {
    const h = buildHarness()
    h.queryBatchTx.mockResolvedValueOnce({ ...(await h.queryBatchTx()), oversizedSheetCount: 1 })
    h.queryBatchTx.mockClear()

    await expect(h.service.listPage(context, { importBatchId: batchId, section: 'ITEMS' })).rejects.toMatchObject({
      code: 'CATALOG_IMPORT_PREVIEW_DATA_INVALID',
    })
    expect(h.querySectionPageTx).not.toHaveBeenCalled()
  })

  it('rejects capacity metadata that does not equal the staged workload', async () => {
    const h = buildHarness()
    h.queryBatchTx.mockResolvedValueOnce({ ...(await h.queryBatchTx()), capacityIntegrityValid: false })
    h.queryBatchTx.mockClear()

    // WHY: Self-consistent dependency JSON is insufficient; it must describe
    // the hash-bound commands/proposals that confirmation will actually apply.
    await expect(h.service.listPage(context, { importBatchId: batchId, section: 'ITEMS' })).rejects.toMatchObject({
      code: 'CATALOG_IMPORT_PREVIEW_DATA_INVALID',
    })
    expect(h.querySectionPageTx).not.toHaveBeenCalled()
  })

  it.each([
    ['empty batch', 0, 0],
    ['no Items line', 4, 0],
    ['too many durable lines', 50_001, 1],
    ['too many Items lines', 20_001, 20_001],
    ['item count exceeds total', 1, 2],
  ])('fails closed on %s before reporting canConfirm', async (_label, lineCount, itemCount) => {
    const h = buildHarness()
    h.queryBatchTx.mockResolvedValueOnce({ ...(await h.queryBatchTx()), lineCount, itemCount })
    h.queryBatchTx.mockClear()

    await expect(h.service.listPage(context, { importBatchId: batchId, section: 'ITEMS' })).rejects.toMatchObject({
      code: 'CATALOG_IMPORT_PREVIEW_DATA_INVALID',
    })
    expect(h.querySectionPageTx).not.toHaveBeenCalled()
  })

  it('accepts the exact 50k total-line envelope boundary', async () => {
    const h = buildHarness()
    h.queryBatchTx.mockResolvedValueOnce({ ...(await h.queryBatchTx()), lineCount: 50_000, itemCount: 20_000 })
    h.queryBatchTx.mockClear()

    await expect(h.service.listPage(context, { importBatchId: batchId, section: 'ITEMS' })).resolves.toEqual(
      expect.objectContaining({ importBatchId: batchId }),
    )
  })

  it('normalizes PostgreSQL text scalars only at the read-query boundary', async () => {
    const h = buildHarness()
    h.queryBatchTx.mockResolvedValueOnce({
      ...(await h.queryBatchTx()),
      capacity: {
        ...capacity,
        schemaVersion: '1',
        costModelVersion: '1',
        workUnits: '52',
        limit: '12000',
        withinLimit: 'true',
        breakdown: Object.fromEntries(Object.entries(capacity.breakdown).map(([key, value]) => [key, String(value)])),
      },
    })
    h.queryBatchTx.mockClear()

    const result = await h.service.listPage(context, { importBatchId: batchId, section: 'ITEMS' })

    expect(result.batch.capacity).toEqual(capacity)
  })

  it('accepts only FAILED lower-bound overflow and never advertises it as confirmable', async () => {
    const h = buildHarness()
    h.queryBatchTx.mockResolvedValueOnce({
      ...(await h.queryBatchTx()),
      state: 'FAILED',
      capacity: {
        ...capacity,
        measurement: 'LOWER_BOUND',
        workUnits: 12_001,
        withinLimit: false,
        breakdown: { ...capacity.breakdown, updateItems: 11_969 },
      },
    })
    h.queryBatchTx.mockClear()

    const result = await h.service.listPage(context, { importBatchId: batchId, section: 'ITEMS' })

    expect(result.batch).toEqual(expect.objectContaining({ state: 'FAILED', canConfirm: false }))
    expect(result.batch.capacity).toEqual(expect.objectContaining({ measurement: 'LOWER_BOUND', workUnits: 12_001 }))
  })
})
