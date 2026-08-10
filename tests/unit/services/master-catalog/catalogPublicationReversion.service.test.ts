import {
  applyCatalogPublicationReversionTx,
  createCatalogPublicationReversionPreviewService,
  projectCatalogPublicationReversion,
} from '@/services/master-catalog/catalogPublicationReversion.service'

function source(overrides: Record<string, unknown> = {}) {
  return {
    id: 'source-line-1',
    organizationId: 'org-1',
    bindingId: 'binding-1',
    catalogItemId: 'item-1',
    venueId: 'venue-1',
    productId: 'product-1',
    status: 'APPLIED',
    fieldMask: ['description', 'name'],
    decisions: [
      { field: 'description', before: 'Vieja', proposed: 'Corporativa', after: 'Corporativa' },
      { field: 'name', before: 'Nombre viejo', proposed: 'Nombre corp', after: 'Nombre corp' },
    ],
    ...overrides,
  }
}

describe('catalogPublicationReversion.service', () => {
  it('rejects source lines outside the route publication batch before staging', async () => {
    const tx = {
      catalogPublicationLine: { count: jest.fn().mockResolvedValue(0), createMany: jest.fn() },
      catalogPublicationBatch: { create: jest.fn() },
      catalogIdempotencyRecord: { create: jest.fn() },
    }
    const loadAuthoritiesTx = jest.fn()
    const prisma = { $transaction: jest.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)) }
    const service = createCatalogPublicationReversionPreviewService({
      prisma: prisma as never,
      assertAccessTx: jest.fn().mockResolvedValue(undefined),
      loadAuthoritiesTx,
    } as never)

    await expect(
      service.preview({ organizationId: 'org-1', actor: { type: 'HUMAN', staffId: 'staff-1', impersonating: false } }, {
        operation: 'CATALOG_FIELDS_REVERSION',
        sourcePublicationBatchId: 'batch-a',
        idempotencyKey: 'key',
        targets: [{ catalogItemId: 'item-1', venueId: 'venue-1', productId: 'product-1', sourceLineId: 'line-from-batch-b' }],
      } as never),
    ).rejects.toMatchObject({ statusCode: 409, code: 'CATALOG_REVERSION_SOURCE_BATCH_MISMATCH' })
    expect(loadAuthoritiesTx).not.toHaveBeenCalled()
    expect(tx.catalogPublicationBatch.create).not.toHaveBeenCalled()
    expect(tx.catalogPublicationLine.createMany).not.toHaveBeenCalled()
  })

  it('rejects 10,001 targets with stable 413 before opening a transaction', async () => {
    const prisma = { $transaction: jest.fn() }
    const service = createCatalogPublicationReversionPreviewService({ prisma } as never)
    const targets = Array.from({ length: 10_001 }, (_, index) => ({
      catalogItemId: `item-${index}`,
      venueId: `venue-${index}`,
      productId: `product-${index}`,
      sourceLineId: `source-${index}`,
    }))

    await expect(
      service.preview(
        {
          organizationId: 'org-1',
          actor: { type: 'HUMAN', staffId: 'staff-1', impersonating: false },
        },
        { operation: 'CATALOG_FIELDS_REVERSION', idempotencyKey: 'key', targets },
      ),
    ).rejects.toMatchObject({
      statusCode: 413,
      code: 'CATALOG_PUBLICATION_TARGET_CAP_EXCEEDED',
    })
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('stages immutable inverse values and exact current/historical lineage through shared dual authority', async () => {
    const tx = {
      catalogPublicationBatch: { create: jest.fn().mockResolvedValue({ id: 'batch-revert' }) },
      catalogIdempotencyRecord: { create: jest.fn().mockResolvedValue({ id: 'record-revert' }) },
      catalogPublicationLine: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
      catalogPublicationFieldDecision: { createMany: jest.fn() },
    }
    const prisma = { $transaction: jest.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)) }
    const projection = projectCatalogPublicationReversion({
      operation: 'CATALOG_FIELDS_REVERSION',
      source: source(),
      currentLineId: 'current-line-2',
      currentValues: { description: 'Corporativa', name: 'Nombre corp' },
    } as never)
    const service = createCatalogPublicationReversionPreviewService({
      prisma: prisma as never,
      assertAccessTx: jest.fn().mockResolvedValue(undefined),
      loadAuthoritiesTx: jest.fn().mockResolvedValue([
        {
          projection,
          sourceCatalogRevision: 7,
          sourceCatalogInvariantVersion: '12',
          bindingRevision: 5,
        },
      ]),
      now: () => new Date('2026-08-09T12:00:00.000Z'),
      randomToken: () => 'revert-token',
      randomId: jest.fn().mockReturnValueOnce('batch-revert').mockReturnValueOnce('record-revert').mockReturnValue('line-revert'),
    } as never)

    const preview = await service.preview(
      {
        organizationId: 'org-1',
        actor: { type: 'HUMAN' as const, staffId: 'staff-2', impersonating: false },
      },
      {
        operation: 'CATALOG_FIELDS_REVERSION',
        idempotencyKey: 'revert-key',
        targets: [{ catalogItemId: 'item-1', venueId: 'venue-1', productId: 'product-1', sourceLineId: 'source-line-1' }],
      },
    )

    expect(preview).toMatchObject({ operation: 'CATALOG_FIELDS_REVERSION', canConfirm: true })
    expect(tx.catalogPublicationLine.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          status: 'READY',
          changeKind: 'REVERSION',
          before: projection.before,
          after: projection.after,
          supersedesLineId: 'current-line-2',
          reversesLineId: 'source-line-1',
        }),
      ],
    })
    expect(tx.catalogPublicationFieldDecision.createMany).not.toHaveBeenCalled()
  })

  it('projects immutable source before values with exact successor and reversal lineage', () => {
    const projection = projectCatalogPublicationReversion({
      operation: 'CATALOG_FIELDS_REVERSION',
      source: source(),
      currentLineId: 'current-line-2',
      currentValues: { description: 'Corporativa', name: 'Nombre corp' },
    } as never)

    expect(projection).toMatchObject({
      fieldMask: ['description', 'name'],
      before: { description: 'Corporativa', name: 'Nombre corp' },
      after: { description: 'Vieja', name: 'Nombre viejo' },
      supersedesLineId: 'current-line-2',
      reversesLineId: 'source-line-1',
      changeKind: 'REVERSION',
    })
    expect(projection.canonicalTargetHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('rejects reversion when a current managed value changed after the source publication', () => {
    expect(() =>
      projectCatalogPublicationReversion({
        operation: 'CATALOG_FIELDS_REVERSION',
        source: source(),
        currentLineId: 'source-line-1',
        currentValues: { description: 'Editada después', name: 'Nombre corp' },
      } as never),
    ).toThrow(expect.objectContaining({ statusCode: 409, code: 'CATALOG_REVERSION_CONFLICT' }))
  })

  it('persists inverse decisions, audit and outbox in the caller transaction', async () => {
    const tx = {}
    const projection = projectCatalogPublicationReversion({
      operation: 'CATALOG_FIELDS_REVERSION',
      source: source(),
      currentLineId: 'current-line-2',
      currentValues: { description: 'Corporativa', name: 'Nombre corp' },
    } as never)
    const dependencies = {
      persist: jest
        .fn()
        .mockResolvedValue([
          { lineId: 'line-revert', catalogItemId: 'item-1', venueId: 'venue-1', productId: 'product-1', status: 'APPLIED' },
        ]),
      writeAudit: jest.fn().mockResolvedValue(undefined),
      enqueueOutbox: jest.fn().mockResolvedValue(undefined),
    }

    await expect(
      applyCatalogPublicationReversionTx(
        tx as never,
        {
          organizationId: 'org-1',
          publicationBatchId: 'batch-revert',
          lineId: 'line-revert',
          bindingRevision: 5,
          sourceCatalogRevision: 7,
          actor: { type: 'HUMAN', staffId: 'staff-2', impersonating: false },
          projection,
        },
        dependencies as never,
      ),
    ).resolves.toEqual(expect.objectContaining({ lineId: 'line-revert', status: 'APPLIED' }))

    expect(dependencies.persist).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        lines: [
          expect.objectContaining({
            supersedesLineId: 'current-line-2',
            reversesLineId: 'source-line-1',
            decisions: expect.arrayContaining([expect.objectContaining({ field: 'description', before: 'Corporativa', after: 'Vieja' })]),
          }),
        ],
      }),
    )
    expect(dependencies.writeAudit).toHaveBeenCalled()
    expect(dependencies.enqueueOutbox).toHaveBeenCalled()
  })

  it('maps only the exact already-reversed unique slot to a stable pre-commit conflict', async () => {
    const projection = projectCatalogPublicationReversion({
      operation: 'CATALOG_FIELDS_REVERSION',
      source: source(),
      currentLineId: 'current-line-2',
      currentValues: { description: 'Corporativa', name: 'Nombre corp' },
    } as never)
    const p2002 = Object.assign(new Error('unique'), {
      code: 'P2002',
      meta: { target: 'CatalogPublicationLine_one_applied_reversal_key' },
    })

    await expect(
      applyCatalogPublicationReversionTx(
        {} as never,
        {
          organizationId: 'org-1',
          publicationBatchId: 'batch',
          lineId: 'line',
          bindingRevision: 5,
          sourceCatalogRevision: 7,
          actor: { type: 'HUMAN', staffId: 'staff-2', impersonating: false },
          projection,
        },
        { persist: jest.fn().mockRejectedValue(p2002) } as never,
      ),
    ).rejects.toMatchObject({ code: 'CATALOG_REVERSION_CONFLICT' })

    const exactArray = Object.assign(new Error('unique'), {
      code: 'P2002',
      meta: { target: ['organizationId', 'reversesLineId'] },
    })
    await expect(
      applyCatalogPublicationReversionTx(
        {} as never,
        {
          organizationId: 'org-1',
          publicationBatchId: 'batch',
          lineId: 'line',
          bindingRevision: 5,
          sourceCatalogRevision: 7,
          actor: { type: 'HUMAN', staffId: 'staff-2', impersonating: false },
          projection,
        },
        { persist: jest.fn().mockRejectedValue(exactArray) } as never,
      ),
    ).rejects.toMatchObject({ code: 'CATALOG_REVERSION_CONFLICT' })

    for (const target of [['reversesLineId'], ['organizationId', 'reversesLineId', 'other'], ['reversesLineId', 'organizationId']]) {
      const foreignP2002 = Object.assign(new Error('foreign unique'), { code: 'P2002', meta: { target } })
      await expect(
        applyCatalogPublicationReversionTx(
          {} as never,
          {
            organizationId: 'org-1',
            publicationBatchId: 'batch',
            lineId: 'line',
            bindingRevision: 5,
            sourceCatalogRevision: 7,
            actor: { type: 'HUMAN', staffId: 'staff-2', impersonating: false },
            projection,
          },
          { persist: jest.fn().mockRejectedValue(foreignP2002) } as never,
        ),
      ).rejects.toBe(foreignP2002)
    }
  })
})
