import { createHash } from 'node:crypto'
import { createCatalogImportConfirmationService } from '@/services/master-catalog/catalogImportConfirmation.service'
import { calculateCatalogImportConfirmCapacityV1 } from '@/services/master-catalog/catalogImportCapacity.service'
import { stageCatalogImportReferenceProposalsV1 } from '@/services/master-catalog/catalogImportStagedPayload.service'
import type { CatalogCommandContext } from '@/types/master-catalog'
import { validDurableReviewLines, validStagedPayload } from './catalogImportTestHarness'

const organizationId = 'org-pits'
const token = 'opaque-preview-token'
const requestHash = 'a'.repeat(64)
const targetHash = 'b'.repeat(64)
const context: CatalogCommandContext = {
  organizationId,
  actor: { type: 'HUMAN', staffId: 'staff-owner', impersonating: false },
  orgRole: 'OWNER',
}
const input = {
  importBatchId: 'import-batch-1',
  previewToken: token,
  confirm: true as const,
  idempotencyKey: 'catalog-import-key-1',
}

function result() {
  return { importBatchId: input.importBatchId, state: 'APPLIED', appliedItemIds: ['catalog-item-original'] }
}

function batch(state: 'PREVIEWED' | 'APPLIED', storedResult: ReturnType<typeof result> | null = null) {
  return {
    id: input.importBatchId,
    organizationId,
    state,
    schemaVersion: 1,
    requestHash,
    requestHashVersion: 1,
    targetHash,
    previewTokenHash: createHash('sha256').update(token).digest('hex'),
    previewExpiresAt: new Date('2026-08-08T20:30:00.000Z'),
    dependencies: {
      schemaVersion: 1,
      capacity: calculateCatalogImportConfirmCapacityV1([readyLines()[0]!.payload as never]),
      items: [
        {
          id: 'catalog-item-original',
          revision: 7,
          invariantVersion: '1',
          status: 'ACTIVE',
          businessTypes: ['RETAIL_STORE'],
        },
      ],
      priceDependentItemIds: ['catalog-item-original'],
      organizationValues: [],
      references: [],
      mappings: [],
      profiles: [],
    },
    staffId: 'staff-owner',
    result: storedResult,
    createdAt: new Date('2026-08-08T19:00:00.000Z'),
    updatedAt: new Date('2026-08-08T19:00:00.000Z'),
  }
}

function readyLines() {
  const payload = validStagedPayload()
  const command = {
    operation: 'UPDATE' as const,
    input: {
      ...payload.command.input,
      catalogItemId: 'catalog-item-original',
      expectedRevision: 7,
      organizationValues: [
        { ...payload.command.input.organizationValues[0]!, expectedRuleRevision: 2 },
        { ...payload.command.input.organizationValues[1]!, expectedRuleRevision: 3 },
      ],
      organizationValueDeactivations: [],
    },
  }
  const [saleReview, purchaseReview, ...otherReviews] = validDurableReviewLines()
  if (!saleReview || !purchaseReview) throw new Error('CATALOG_IMPORT_TEST_FIXTURE_INVALID')
  const reviews = [
    { ...saleReview, payload: { ...saleReview.payload, expectedRuleRevision: 2 } },
    { ...purchaseReview, payload: { ...purchaseReview.payload, expectedRuleRevision: 3 } },
    ...otherReviews,
  ]
  return [
    {
      id: 'line-1',
      status: 'READY',
      sourceSheet: 'Items',
      sourceRow: 2,
      payload: { ...payload, command },
      errors: null,
      catalogItemId: 'catalog-item-original',
    },
    ...reviews,
  ]
}

function makeHarness() {
  let state: 'PREVIEWED' | 'APPLIED' = 'PREVIEWED'
  const storedResult = result()
  const tx = {
    catalogImportBatch: {
      findFirst: jest.fn().mockImplementation(async () => batch(state, state === 'APPLIED' ? storedResult : null)),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    catalogImportLine: {
      findMany: jest.fn().mockImplementation(async ({ where }: { where: { sourceSheet?: string } }) => {
        if (where.sourceSheet === 'Items' && state === 'APPLIED') {
          return [{ id: 'line-1', status: 'APPLIED', catalogItemId: 'catalog-item-original', sourceSheet: 'Items', sourceRow: 2 }]
        }
        return readyLines()
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    catalogIdempotencyRecord: {
      create: jest.fn().mockResolvedValue({ id: 'record-1' }),
      findUnique: jest.fn().mockResolvedValue({
        organizationId,
        operation: 'CATALOG_IMPORT',
        idempotencyKey: input.idempotencyKey,
        requestHash,
        targetHash,
        state: 'APPLIED',
        resourceType: 'CatalogImportBatch',
        resourceId: input.importBatchId,
        dependencies: batch('APPLIED', storedResult).dependencies,
        result: storedResult,
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  }
  const acquireMutationLockTx = jest.fn().mockResolvedValue(undefined)
  const revalidateDependenciesTx = jest.fn().mockResolvedValue(undefined)
  const canonicalizeRows = jest.fn().mockResolvedValue({ hash: targetHash })
  const applyCatalogItemAggregateTx = jest.fn().mockResolvedValue({
    detail: { id: 'catalog-item-original' },
    auditEnvelope: {
      action: 'CATALOG_ITEM_UPDATED',
      entity: 'CatalogItem',
      entityId: 'catalog-item-original',
      batchId: input.importBatchId,
    },
  })
  const applyCatalogReferenceProposalsTx = jest.fn().mockResolvedValue({ references: [], auditEnvelopes: [] })
  const writeCatalogAudit = jest.fn().mockResolvedValue(undefined)
  const prisma = {
    $transaction: jest.fn().mockImplementation(async (work: (client: typeof tx) => unknown) => work(tx)),
  }
  const service = createCatalogImportConfirmationService({
    prisma: prisma as never,
    assertLiveAccessTx: jest.fn().mockResolvedValue(undefined),
    acquireMutationLockTx,
    revalidateDependenciesTx,
    canonicalizeRows,
    applyCatalogReferenceProposalsTx,
    applyCatalogItemAggregateTx,
    writeCatalogAudit,
    now: () => new Date('2026-08-08T20:00:00.000Z'),
    randomAttemptId: () => 'attempt-1',
  })
  return {
    service,
    tx,
    acquireMutationLockTx,
    revalidateDependenciesTx,
    canonicalizeRows,
    applyCatalogReferenceProposalsTx,
    applyCatalogItemAggregateTx,
    writeCatalogAudit,
    setState: (next: 'PREVIEWED' | 'APPLIED') => {
      state = next
    },
  }
}

describe('catalog import confirmation concurrency recovery', () => {
  it('bounds the durable line read and rejects an over-envelope batch before hash, lock, or writers', async () => {
    const harness = makeHarness()
    harness.tx.catalogImportLine.findMany.mockResolvedValue(Array(50_001).fill(readyLines()[0]))

    await expect(harness.service.confirm(context, input)).rejects.toMatchObject({
      statusCode: 409,
      code: 'CATALOG_IMPORT_STAGING_INVALID',
    })

    expect(harness.tx.catalogImportLine.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 50_001 }))
    expect(harness.canonicalizeRows).not.toHaveBeenCalled()
    expect(harness.acquireMutationLockTx).not.toHaveBeenCalled()
    expect(harness.applyCatalogItemAggregateTx).not.toHaveBeenCalled()
  })

  it('rejects more than 20,000 durable rows in one allowed sheet before hashing', async () => {
    const harness = makeHarness()
    const review = validDurableReviewLines()[0]!
    harness.tx.catalogImportLine.findMany.mockResolvedValue([readyLines()[0], ...Array(20_001).fill(review)])

    await expect(harness.service.confirm(context, input)).rejects.toMatchObject({
      statusCode: 409,
      code: 'CATALOG_IMPORT_STAGING_INVALID',
    })

    expect(harness.canonicalizeRows).not.toHaveBeenCalled()
    expect(harness.acquireMutationLockTx).not.toHaveBeenCalled()
    expect(harness.applyCatalogItemAggregateTx).not.toHaveBeenCalled()
  })

  it('recovers the exact same-key UPDATE result when the org-lock winner committed while this confirm waited', async () => {
    const harness = makeHarness()
    harness.acquireMutationLockTx.mockImplementationOnce(async () => harness.setState('APPLIED'))

    await expect(harness.service.confirm(context, input)).resolves.toEqual(result())

    expect(harness.revalidateDependenciesTx).not.toHaveBeenCalled()
    expect(harness.applyCatalogItemAggregateTx).not.toHaveBeenCalled()
    expect(harness.tx.catalogIdempotencyRecord.create).not.toHaveBeenCalled()
  })

  it('rejects a different key after the post-lock batch reread instead of replaying another actor result', async () => {
    const harness = makeHarness()
    harness.acquireMutationLockTx.mockImplementationOnce(async () => harness.setState('APPLIED'))
    harness.tx.catalogIdempotencyRecord.findUnique.mockResolvedValue(null)

    await expect(harness.service.confirm(context, { ...input, idempotencyKey: 'different-key' })).rejects.toMatchObject({
      statusCode: 409,
      code: 'IDEMPOTENCY_KEY_REUSED',
    })
  })

  it('orders org lock, post-lock authority reread, and dependency validation', async () => {
    const harness = makeHarness()

    await expect(harness.service.confirm(context, input)).resolves.toEqual(result())

    expect(harness.acquireMutationLockTx.mock.invocationCallOrder[0]).toBeLessThan(
      harness.tx.catalogImportBatch.findFirst.mock.invocationCallOrder[1]!,
    )
    expect(harness.tx.catalogImportBatch.findFirst.mock.invocationCallOrder[1]).toBeLessThan(
      harness.revalidateDependenciesTx.mock.invocationCallOrder[0]!,
    )
  })

  it('uses P2002 recovery only after a post-lock PREVIEWED attempt loses the exact idempotency unique race', async () => {
    const harness = makeHarness()
    const collision = Object.assign(new Error('unique'), {
      code: 'P2002',
      meta: { target: 'CatalogIdempotencyRecord_organizationId_operation_idemp_key' },
    })
    harness.tx.catalogIdempotencyRecord.create.mockImplementationOnce(async () => {
      harness.setState('APPLIED')
      throw collision
    })

    await expect(harness.service.confirm(context, input)).resolves.toEqual(result())
    expect(harness.applyCatalogItemAggregateTx).not.toHaveBeenCalled()
  })

  it('maps the exact preview snapshot DDL boundary to stable expiry before any mutation writer', async () => {
    const harness = makeHarness()
    harness.tx.catalogIdempotencyRecord.create.mockImplementationOnce(async ({ data }: { data: { createdAt?: Date } }) => {
      expect(data.createdAt).toEqual(new Date('2026-08-08T20:00:00.000Z'))
      throw Object.assign(new Error('preview snapshot check'), {
        code: 'P2004',
        meta: { constraint: 'CatalogIdempotencyRecord_preview_snapshot_check' },
      })
    })

    await expect(harness.service.confirm(context, input)).rejects.toMatchObject({
      statusCode: 409,
      code: 'CATALOG_IMPORT_PREVIEW_EXPIRED',
    })

    expect(harness.tx.catalogImportBatch.updateMany).not.toHaveBeenCalled()
    expect(harness.applyCatalogReferenceProposalsTx).not.toHaveBeenCalled()
    expect(harness.applyCatalogItemAggregateTx).not.toHaveBeenCalled()
    expect(harness.writeCatalogAudit).not.toHaveBeenCalled()
    expect(harness.tx.catalogIdempotencyRecord.updateMany).not.toHaveBeenCalled()
  })

  it('rejects a reviewed CREATE_REFERENCE that another writer created before proposal application', async () => {
    const harness = makeHarness()
    const lines = readyLines()
    const item = lines[0]!
    if (item.sourceSheet !== 'Items' || !('command' in item.payload) || !('referenceProposals' in item.payload)) {
      throw new Error('CATALOG_IMPORT_TEST_FIXTURE_INVALID')
    }
    const proposal = { operation: 'CREATE' as const, referenceType: 'BRAND' as const, name: 'Marca Nueva' }
    item.payload.command.input.brandId = '@proposal:BRAND:MARCA NUEVA'
    item.payload.referenceProposals = stageCatalogImportReferenceProposalsV1([proposal])
    const capacity = calculateCatalogImportConfirmCapacityV1([item.payload as never])
    harness.tx.catalogImportBatch.findFirst.mockResolvedValue({
      ...batch('PREVIEWED'),
      dependencies: { ...batch('PREVIEWED').dependencies, capacity },
    })
    harness.tx.catalogImportLine.findMany.mockResolvedValue(lines)
    harness.applyCatalogReferenceProposalsTx.mockResolvedValue({
      references: [{ id: 'brand-raced', reused: true }],
      auditEnvelopes: [
        {
          action: 'CATALOG_BRAND_REUSED',
          entity: 'CatalogBrand',
          entityId: 'brand-raced',
          batchId: input.importBatchId,
        },
      ],
    })

    await expect(harness.service.confirm(context, input)).rejects.toMatchObject({ statusCode: 409, code: 'STALE_PREVIEW' })
    expect(harness.applyCatalogItemAggregateTx).not.toHaveBeenCalled()
    expect(harness.writeCatalogAudit).not.toHaveBeenCalled()
    expect(harness.tx.catalogIdempotencyRecord.updateMany).not.toHaveBeenCalled()
    expect(harness.tx.catalogImportLine.updateMany).not.toHaveBeenCalled()
  })
})
