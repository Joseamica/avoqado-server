import { createHash } from 'node:crypto'
import { createCatalogImportConfirmationService } from '@/services/master-catalog/catalogImportConfirmation.service'
import { calculateCatalogImportConfirmCapacityV1 } from '@/services/master-catalog/catalogImportCapacity.service'
import type { CatalogCommandContext } from '@/types/master-catalog'
import { CATALOG_IMPORT_CONFIRM_TRANSACTION_OPTIONS } from '@/services/master-catalog/catalogImport.types'
import { stageCatalogImportReferenceProposalsV1 } from '@/services/master-catalog/catalogImportStagedPayload.service'
import { validDurableReviewLines, validStagedPayload } from './catalogImportTestHarness'

const organizationId = 'org-pits'
const actorId = 'staff-owner'
const context: CatalogCommandContext = {
  organizationId,
  actor: { type: 'HUMAN', staffId: actorId, impersonating: false },
  orgRole: 'OWNER',
}
const token = 'opaque-preview-token'
const requestHash = 'a'.repeat(64)
const targetHash = 'b'.repeat(64)

function appliedResult(ids = ['catalog-item-original']) {
  return { importBatchId: 'import-batch-1', state: 'APPLIED', appliedItemIds: ids }
}

function batch(overrides: Record<string, unknown> = {}) {
  return {
    id: 'import-batch-1',
    organizationId,
    state: 'PREVIEWED',
    schemaVersion: 1,
    requestHash,
    requestHashVersion: 1,
    targetHash,
    previewTokenHash: createHash('sha256').update(token).digest('hex'),
    previewExpiresAt: new Date('2026-08-08T20:30:00.000Z'),
    dependencies: {
      schemaVersion: 1,
      capacity: calculateCatalogImportConfirmCapacityV1([validStagedPayload()]),
      items: [],
      priceDependentItemIds: [],
      organizationValues: [],
      references: [],
      mappings: [],
      profiles: [],
    },
    staffId: actorId,
    result: null,
    createdAt: new Date('2026-08-08T19:00:00.000Z'),
    updatedAt: new Date('2026-08-08T19:00:00.000Z'),
    ...overrides,
  }
}

function stagedLines(overrides: Record<string, unknown> = {}) {
  return [
    {
      id: 'line-1',
      status: 'READY',
      sourceSheet: 'Items',
      sourceRow: 2,
      payload: validStagedPayload(),
      errors: null,
      catalogItemId: null,
      ...overrides,
    },
  ]
}

function confirmableLines(overrides: Record<string, unknown> = {}) {
  return [...stagedLines(overrides), ...validDurableReviewLines()]
}

function appliedLines(ids = ['catalog-item-original']) {
  return ids.map((catalogItemId, index) => ({
    ...stagedLines()[0],
    id: `line-${index + 1}`,
    sourceRow: index + 2,
    status: 'APPLIED',
    catalogItemId,
  }))
}

function makeHarness() {
  const tx = {
    catalogImportBatch: {
      findFirst: jest.fn().mockResolvedValue(batch()),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    catalogImportLine: {
      findMany: jest.fn().mockResolvedValue(confirmableLines()),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    catalogIdempotencyRecord: {
      create: jest.fn().mockResolvedValue({ id: 'idempotency-record-1' }),
      findUnique: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    product: { create: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    catalogVenueBinding: { create: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  }
  const prisma = {
    $transaction: jest.fn().mockImplementation(async (work: (client: typeof tx) => unknown) => work(tx)),
    catalogIdempotencyRecord: { findUnique: jest.fn() },
    catalogImportBatch: { findFirst: jest.fn().mockResolvedValue(batch({ state: 'APPLIED', result: appliedResult() })) },
  }
  const applyCatalogReferenceProposalsTx = jest.fn().mockResolvedValue({ references: [], auditEnvelopes: [] })
  const applyCatalogItemAggregateTx = jest.fn().mockResolvedValue({
    detail: { id: 'catalog-item-1' },
    auditEnvelope: {
      action: 'CATALOG_ITEM_CREATED',
      entity: 'CatalogItem',
      entityId: 'catalog-item-1',
      batchId: 'import-batch-1',
    },
  })
  const writeCatalogAudit = jest.fn().mockResolvedValue(undefined)
  const assertLiveAccessTx = jest.fn().mockResolvedValue(undefined)
  const revalidateDependenciesTx = jest.fn().mockResolvedValue(undefined)
  const acquireMutationLockTx = jest.fn().mockResolvedValue(undefined)
  const canonicalizeRows = jest.fn().mockResolvedValue({ hash: targetHash })
  const service = createCatalogImportConfirmationService({
    prisma: prisma as never,
    applyCatalogReferenceProposalsTx,
    applyCatalogItemAggregateTx,
    writeCatalogAudit,
    assertLiveAccessTx,
    revalidateDependenciesTx,
    acquireMutationLockTx,
    canonicalizeRows,
    now: () => new Date('2026-08-08T20:00:00.000Z'),
    randomAttemptId: () => 'import-attempt-1',
  })
  return {
    service,
    tx,
    prisma,
    applyCatalogReferenceProposalsTx,
    applyCatalogItemAggregateTx,
    writeCatalogAudit,
    assertLiveAccessTx,
    revalidateDependenciesTx,
    acquireMutationLockTx,
    canonicalizeRows,
  }
}

const confirmInput = {
  importBatchId: 'import-batch-1',
  previewToken: token,
  confirm: true as const,
  idempotencyKey: 'catalog-import-key-1',
}

describe('catalogImportConfirmation.service atomic confirmation', () => {
  it('uses only Task 5 tx seams with BATCH ownership and writes one summary audit/result in the same transaction', async () => {
    const h = makeHarness()
    const line = stagedLines()[0] as ReturnType<typeof stagedLines>[number] & {
      payload: { command: { input: { brandId: string } }; referenceProposals: unknown[] }
    }
    line.payload.command.input.brandId = '@proposal:BRAND:MARCA NUEVA'
    line.payload.referenceProposals = stageCatalogImportReferenceProposalsV1([
      { operation: 'CREATE', referenceType: 'BRAND', name: 'Marca Nueva' },
    ])
    h.tx.catalogImportLine.findMany.mockResolvedValue([line, ...validDurableReviewLines()])
    const capacity = calculateCatalogImportConfirmCapacityV1([line.payload as never])
    h.tx.catalogImportBatch.findFirst.mockResolvedValue(batch({ dependencies: { ...batch().dependencies, capacity } }))
    h.applyCatalogReferenceProposalsTx.mockResolvedValue({
      references: [{ id: 'brand-created' }],
      auditEnvelopes: [
        {
          action: 'CATALOG_BRAND_CREATED',
          entity: 'CatalogBrand',
          entityId: 'brand-created',
          batchId: 'import-batch-1',
        },
      ],
    })

    const result = await h.service.confirm(context, confirmInput)

    expect(result).toMatchObject({ importBatchId: 'import-batch-1', state: 'APPLIED', appliedItemIds: ['catalog-item-1'] })
    expect(h.assertLiveAccessTx).toHaveBeenCalledWith(h.tx, context)
    expect(h.revalidateDependenciesTx).toHaveBeenCalledWith(h.tx, context, expect.anything())
    expect(h.acquireMutationLockTx).toHaveBeenCalledWith(h.tx, context.organizationId)
    expect(h.acquireMutationLockTx.mock.invocationCallOrder[0]).toBeLessThan(h.revalidateDependenciesTx.mock.invocationCallOrder[0]!)
    expect(h.applyCatalogItemAggregateTx).toHaveBeenCalledWith(h.tx, context, expect.objectContaining({ operation: 'CREATE' }), {
      auditOwnership: { kind: 'BATCH', batchId: 'import-batch-1' },
    })
    expect(h.writeCatalogAudit).toHaveBeenCalledTimes(1)
    expect(h.writeCatalogAudit).toHaveBeenCalledWith(
      h.tx,
      expect.objectContaining({
        action: 'CATALOG_IMPORT_APPLIED',
        entity: 'CatalogImportBatch',
        entityId: 'import-batch-1',
        metadata: expect.objectContaining({
          appliedItemCount: 1,
          auditEnvelopeCount: 2,
          auditEnvelopeDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
          mutationGroups: [
            { action: 'CATALOG_BRAND_CREATED', entity: 'CatalogBrand', count: 1 },
            { action: 'CATALOG_ITEM_CREATED', entity: 'CatalogItem', count: 1 },
          ],
        }),
      }),
    )
    expect(JSON.stringify(h.writeCatalogAudit.mock.calls[0]?.[1].metadata)).not.toContain('Marca Nueva')
    expect(h.tx.catalogIdempotencyRecord.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          operation: 'CATALOG_IMPORT',
          idempotencyKey: 'catalog-import-key-1',
          requestHash,
          resourceType: 'CatalogImportBatch',
          resourceId: 'import-batch-1',
          previewTokenHash: batch().previewTokenHash,
          previewExpiresAt: batch().previewExpiresAt,
          dependencies: { ...batch().dependencies, capacity },
          attemptId: 'import-attempt-1',
          createdAt: new Date('2026-08-08T20:00:00.000Z'),
          heartbeatAt: new Date('2026-08-08T20:00:00.000Z'),
          leaseExpiresAt: expect.any(Date),
        }),
      }),
    )
    expect(h.tx.catalogImportBatch.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({
          state: 'APPLYING',
          attemptId: 'import-attempt-1',
          heartbeatAt: new Date('2026-08-08T20:00:00.000Z'),
          leaseExpiresAt: expect.any(Date),
        }),
      }),
    )
    expect(h.tx.product.create).not.toHaveBeenCalled()
    expect(h.tx.catalogVenueBinding.create).not.toHaveBeenCalled()
    expect(h.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), CATALOG_IMPORT_CONFIRM_TRANSACTION_OPTIONS)
  })

  it.each([
    ['wrong bearer', { previewToken: 'wrong-token' }, 'CATALOG_IMPORT_PREVIEW_TOKEN_INVALID'],
    ['confirm false', { confirm: false as true }, 'CATALOG_CONFIRM_REQUIRED'],
    ['blank key', { idempotencyKey: '   ' }, 'CATALOG_IDEMPOTENCY_KEY_INVALID'],
  ])('rejects %s before references/items/audit', async (_label, overrides, code) => {
    const h = makeHarness()

    await expect(h.service.confirm(context, { ...confirmInput, ...overrides })).rejects.toMatchObject({ code })
    expect(h.applyCatalogReferenceProposalsTx).not.toHaveBeenCalled()
    expect(h.applyCatalogItemAggregateTx).not.toHaveBeenCalled()
    expect(h.writeCatalogAudit).not.toHaveBeenCalled()
  })

  it('rejects expired, wrong-actor, invalid-line, and stale-dependency previews before operational writes', async () => {
    const cases = [
      {
        arrange: (h: ReturnType<typeof makeHarness>) =>
          h.tx.catalogImportBatch.findFirst.mockResolvedValue(batch({ previewExpiresAt: new Date('2026-08-08T19:59:59.999Z') })),
        code: 'CATALOG_IMPORT_PREVIEW_EXPIRED',
      },
      {
        arrange: (h: ReturnType<typeof makeHarness>) =>
          h.tx.catalogImportBatch.findFirst.mockResolvedValue(batch({ staffId: 'staff-other' })),
        code: 'CATALOG_IMPORT_ACTOR_MISMATCH',
      },
      {
        arrange: (h: ReturnType<typeof makeHarness>) =>
          h.tx.catalogImportLine.findMany.mockResolvedValue(stagedLines({ status: 'INVALID', errors: [{ error_code: 'BROKEN' }] })),
        code: 'CATALOG_IMPORT_NOT_CONFIRMABLE',
      },
      {
        arrange: (h: ReturnType<typeof makeHarness>) =>
          h.revalidateDependenciesTx.mockRejectedValue(Object.assign(new Error('stale'), { statusCode: 409, code: 'STALE_PREVIEW' })),
        code: 'STALE_PREVIEW',
      },
    ]

    // WHY: Every precondition is re-read inside the applying transaction; a
    // valid old token alone can never authorize stale or foreign staged data.
    for (const testCase of cases) {
      const h = makeHarness()
      testCase.arrange(h)
      await expect(h.service.confirm(context, confirmInput)).rejects.toMatchObject({ code: testCase.code })
      expect(h.applyCatalogItemAggregateTx).not.toHaveBeenCalled()
    }
  })

  it('returns the exact same-key/same-hash result when the batch is already APPLIED', async () => {
    const h = makeHarness()
    const result = appliedResult()
    h.tx.catalogImportBatch.findFirst.mockResolvedValue(batch({ state: 'APPLIED', result }))
    h.tx.catalogIdempotencyRecord.findUnique.mockResolvedValue({
      organizationId,
      operation: 'CATALOG_IMPORT',
      idempotencyKey: confirmInput.idempotencyKey,
      requestHash,
      targetHash,
      state: 'APPLIED',
      resourceType: 'CatalogImportBatch',
      resourceId: 'import-batch-1',
      dependencies: batch().dependencies,
      result,
    })
    h.tx.catalogImportLine.findMany.mockResolvedValue(appliedLines())

    await expect(h.service.confirm(context, confirmInput)).resolves.toEqual(result)
    expect(h.applyCatalogItemAggregateTx).not.toHaveBeenCalled()
  })

  it('maps same key with a different hash to 409 and rejects malformed APPLIED recovery authority', async () => {
    const cases = [
      { record: { requestHash: 'c'.repeat(64), state: 'APPLIED' }, code: 'IDEMPOTENCY_KEY_REUSED' },
      {
        record: {
          requestHash,
          state: 'APPLIED',
          resourceType: 'CatalogImportBatch',
          resourceId: 'different-batch',
          result: { importBatchId: 'import-batch-1', state: 'APPLIED', appliedItemIds: [] },
        },
        code: 'CATALOG_IMPORT_RESULT_INVALID',
      },
      {
        record: { requestHash, state: 'APPLIED', result: appliedResult(['', 'catalog-item-1']) },
        code: 'CATALOG_IMPORT_RESULT_INVALID',
      },
      {
        record: { requestHash, state: 'APPLIED', result: appliedResult(['catalog-item-1', 'catalog-item-1']) },
        code: 'CATALOG_IMPORT_RESULT_INVALID',
      },
    ]
    for (const testCase of cases) {
      const h = makeHarness()
      h.tx.catalogIdempotencyRecord.create.mockRejectedValueOnce(
        Object.assign(new Error('unique'), {
          code: 'P2002',
          meta: { target: 'CatalogIdempotencyRecord_organizationId_operation_idemp_key' },
        }),
      )
      const recoveredRecord = {
        organizationId,
        operation: 'CATALOG_IMPORT',
        idempotencyKey: 'catalog-import-key-1',
        targetHash,
        resourceType: 'CatalogImportBatch',
        resourceId: 'import-batch-1',
        dependencies: batch().dependencies,
        result: { importBatchId: 'import-batch-1', state: 'APPLIED', appliedItemIds: [] },
        ...testCase.record,
      }
      h.tx.catalogImportBatch.findFirst
        .mockResolvedValueOnce(batch())
        .mockResolvedValueOnce(batch({ state: 'APPLIED', result: appliedResult() }))
      h.tx.catalogImportLine.findMany.mockResolvedValueOnce(confirmableLines()).mockResolvedValueOnce(appliedLines())
      h.tx.catalogIdempotencyRecord.findUnique.mockResolvedValue(recoveredRecord)
      await expect(h.service.confirm(context, confirmInput)).rejects.toMatchObject({ statusCode: 409, code: testCase.code })
    }
  })

  it('rejects a staged payload whose recomputed canonical hash no longer matches the preview', async () => {
    const h = makeHarness()
    h.canonicalizeRows.mockResolvedValue({ hash: 'c'.repeat(64) })

    await expect(h.service.confirm(context, confirmInput)).rejects.toMatchObject({
      statusCode: 409,
      code: 'CATALOG_IMPORT_STAGING_HASH_MISMATCH',
    })
    expect(h.applyCatalogItemAggregateTx).not.toHaveBeenCalled()
  })

  it('hashes and cross-checks ancillary review rows but applies and CASes only Items', async () => {
    const h = makeHarness()
    const item = stagedLines()[0]!
    h.tx.catalogImportLine.findMany.mockResolvedValue([item, ...validDurableReviewLines()])

    await expect(h.service.confirm(context, confirmInput)).resolves.toMatchObject({ appliedItemIds: ['catalog-item-1'] })

    expect(h.canonicalizeRows).toHaveBeenCalledWith([item, ...validDurableReviewLines()], expect.anything())
    expect(h.applyCatalogItemAggregateTx).toHaveBeenCalledTimes(1)
    expect(h.tx.catalogImportLine.updateMany).toHaveBeenCalledTimes(1)
    expect(h.tx.catalogImportLine.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'line-1' }) }),
    )
  })

  it('rejects review rows that drift from the hash-bound item command', async () => {
    const h = makeHarness()
    const reviews = validDurableReviewLines()
    reviews[0]!.payload.amount = '99.99'
    h.tx.catalogImportLine.findMany.mockResolvedValue([...stagedLines(), ...reviews])

    await expect(h.service.confirm(context, confirmInput)).rejects.toMatchObject({ code: 'CATALOG_IMPORT_STAGING_INVALID' })
    expect(h.applyCatalogItemAggregateTx).not.toHaveBeenCalled()
  })

  it('rejects recovery when the batch-authoritative and idempotency results disagree', async () => {
    const h = makeHarness()
    h.tx.catalogImportBatch.findFirst.mockResolvedValue(batch({ state: 'APPLIED', result: appliedResult(['catalog-item-real']) }))
    h.tx.catalogIdempotencyRecord.findUnique.mockResolvedValue({
      organizationId,
      operation: 'CATALOG_IMPORT',
      idempotencyKey: confirmInput.idempotencyKey,
      requestHash,
      targetHash,
      state: 'APPLIED',
      resourceType: 'CatalogImportBatch',
      resourceId: 'import-batch-1',
      dependencies: batch().dependencies,
      result: appliedResult(['catalog-item-forged']),
    })

    await expect(h.service.confirm(context, confirmInput)).rejects.toMatchObject({
      statusCode: 409,
      code: 'CATALOG_IMPORT_RESULT_INVALID',
    })
  })

  it('propagates audit failure so the outer transaction cannot mark batch/idempotency APPLIED', async () => {
    const h = makeHarness()
    h.writeCatalogAudit.mockRejectedValue(new Error('audit FK rejected'))

    await expect(h.service.confirm(context, confirmInput)).rejects.toThrow('audit FK rejected')
    expect(h.tx.catalogImportBatch.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ state: 'APPLIED' }) }),
    )
    expect(h.tx.catalogIdempotencyRecord.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ state: 'APPLIED' }) }),
    )
  })

  it('never misclassifies an audit P2002 as an idempotency replay', async () => {
    const h = makeHarness()
    const auditConflict = Object.assign(new Error('audit unique'), {
      code: 'P2002',
      meta: { target: 'ActivityLog_some_key' },
    })
    h.writeCatalogAudit.mockRejectedValue(auditConflict)

    await expect(h.service.confirm(context, confirmInput)).rejects.toBe(auditConflict)
    expect(h.tx.catalogIdempotencyRecord.findUnique).not.toHaveBeenCalled()
  })

  it.each([
    ['line', (h: ReturnType<typeof makeHarness>) => h.tx.catalogImportLine.updateMany.mockResolvedValue({ count: 0 })],
    [
      'batch',
      (h: ReturnType<typeof makeHarness>) =>
        h.tx.catalogImportBatch.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 }),
    ],
    ['idempotency record', (h: ReturnType<typeof makeHarness>) => h.tx.catalogIdempotencyRecord.updateMany.mockResolvedValue({ count: 0 })],
  ])('rejects a lost final %s CAS so the outer transaction rolls back', async (_label, arrange) => {
    const h = makeHarness()
    arrange(h)

    await expect(h.service.confirm(context, confirmInput)).rejects.toMatchObject({
      statusCode: 409,
      code: 'CATALOG_IMPORT_STATE_CONFLICT',
    })
  })
})
