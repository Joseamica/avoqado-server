import { createHash } from 'node:crypto'
import { createCatalogPublicationConfirmationService } from '@/services/master-catalog/catalogPublicationConfirmation.service'
import { hashCanonicalJsonV1 } from '@/services/master-catalog/catalogHash.service'

const NOW = new Date('2026-08-09T12:00:00.000Z')
const context = {
  organizationId: 'org-1',
  actor: { type: 'HUMAN' as const, staffId: 'staff-1', impersonating: false },
}
const confirmInput = {
  publicationBatchId: 'batch-1',
  previewToken: 'raw-token',
  confirm: true as const,
  idempotencyKey: 'publish-key-1',
}

function batch(overrides: Record<string, unknown> = {}) {
  return {
    id: 'batch-1',
    organizationId: 'org-1',
    operation: 'CATALOG_FIELDS_PUBLISH',
    state: 'PREVIEWED',
    schemaVersion: 1,
    requestHash: 'a'.repeat(64),
    requestHashVersion: 1,
    targetHash: 'b'.repeat(64),
    previewTokenHash: createHash('sha256').update('raw-token').digest('hex'),
    previewExpiresAt: new Date('2026-08-09T12:30:00.000Z'),
    dependencies: { schemaVersion: 1, targets: [] },
    actorType: 'HUMAN',
    staffId: 'staff-1',
    attemptId: null,
    leaseExpiresAt: null,
    result: null,
    ...overrides,
  }
}

function record(overrides: Record<string, unknown> = {}) {
  return {
    id: 'idem-1',
    organizationId: 'org-1',
    operation: 'CATALOG_FIELDS_PUBLISH',
    idempotencyKey: 'publish-key-1',
    requestHash: 'a'.repeat(64),
    requestHashVersion: 1,
    state: 'PREVIEWED',
    resourceType: 'CatalogPublicationBatch',
    resourceId: 'batch-1',
    targetHash: 'b'.repeat(64),
    previewTokenHash: createHash('sha256').update('raw-token').digest('hex'),
    previewExpiresAt: new Date('2026-08-09T12:30:00.000Z'),
    dependencies: { schemaVersion: 1, targets: [] },
    actorType: 'HUMAN',
    staffId: 'staff-1',
    attemptId: null,
    leaseExpiresAt: null,
    result: null,
    ...overrides,
  }
}

function transaction(batchRows = [batch(), batch({ state: 'APPLYING', attemptId: 'attempt-1' })]) {
  let batchRead = 0
  const initial = batchRows[0]
  const initialRecord = record({
    operation: initial.operation,
    state: initial.state,
    attemptId: initial.attemptId,
    leaseExpiresAt: initial.leaseExpiresAt,
    result: initial.result,
    targetHash: initial.targetHash,
    dependencies: initial.dependencies,
  })
  return {
    $executeRaw: jest.fn().mockResolvedValue(1),
    catalogPublicationBatch: {
      findFirst: jest.fn().mockImplementation(() => batchRows[Math.min(batchRead++, batchRows.length - 1)]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    catalogIdempotencyRecord: {
      findUnique: jest.fn().mockResolvedValue(initialRecord),
      findFirst: jest.fn().mockResolvedValue(
        record({
          operation: initial.operation,
          state: 'APPLYING',
          attemptId: 'attempt-1',
          targetHash: initial.targetHash,
          dependencies: initial.dependencies,
        }),
      ),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    catalogPublicationLine: {
      findMany: jest.fn().mockResolvedValue(
        Array.isArray((initial.result as { lines?: unknown[] } | null)?.lines)
          ? (initial.result as unknown as { lines: Array<Record<string, unknown>> }).lines.map(line => ({
              id: line.lineId,
              organizationId: 'org-1',
              batchId: 'batch-1',
              bindingId: 'binding-1',
              catalogItemId: line.catalogItemId,
              venueId: line.venueId,
              productId: line.productId,
              status: line.status,
              fieldMask: ['name'],
              decisionSchemaVersion: 1,
              changeKind: 'PUBLICATION',
              hashVersion: 1,
              before: { name: 'Local' },
              after: { name: 'Corporate' },
              supersedesLineId: null,
              reversesLineId: null,
              decisions: [
                {
                  field: 'name',
                  decision: 'PUBLISH_CORPORATE',
                  before: 'Local',
                  proposed: 'Corporate',
                  after: 'Corporate',
                  overrideId: null,
                },
              ],
            }))
          : [],
      ),
    },
  }
}

function harness(options: { batchRows?: ReturnType<typeof batch>[]; persistError?: Error } = {}) {
  const reserveTx = transaction(options.batchRows)
  const initial = options.batchRows?.[0] ?? batch()
  const applyTx = transaction([
    batch({
      operation: initial.operation,
      dependencies: initial.dependencies,
      targetHash: initial.targetHash,
      state: 'APPLYING',
      attemptId: 'attempt-1',
    }),
  ])
  const prisma = {
    $transaction: jest
      .fn()
      .mockImplementationOnce(async (callback: (tx: typeof reserveTx) => unknown) => callback(reserveTx))
      .mockImplementationOnce(async (callback: (tx: typeof applyTx) => unknown) => callback(applyTx)),
  }
  const resultLines = [
    { lineId: 'line-1', catalogItemId: 'item-1', venueId: 'venue-1', productId: 'product-1', status: 'APPLIED' as const },
  ]
  const dependencies = {
    prisma: prisma as never,
    assertAccessTx: jest.fn().mockResolvedValue(undefined),
    acquireAttemptLockTx: jest.fn().mockResolvedValue(undefined),
    lockAuthoritiesTx: jest.fn().mockResolvedValue(undefined),
    revalidateTx: jest.fn().mockResolvedValue([{ lineId: 'line-1' }]),
    persistTx: options.persistError ? jest.fn().mockRejectedValue(options.persistError) : jest.fn().mockResolvedValue(resultLines),
    applyActivationTx: jest.fn().mockResolvedValue(resultLines[0]),
    revalidateReversionsTx: jest.fn().mockResolvedValue([
      {
        lineId: 'line-1',
        bindingRevision: 4,
        sourceCatalogRevision: 7,
        projection: {},
      },
    ]),
    applyReversionsTx: jest.fn().mockResolvedValue(resultLines),
    enqueueOutboxTx: jest.fn().mockResolvedValue(undefined),
    writeAudit: jest.fn().mockResolvedValue(undefined),
    now: jest.fn(() => NOW),
    randomAttemptId: jest.fn(() => 'attempt-1'),
  }
  return {
    reserveTx,
    applyTx,
    prisma,
    dependencies,
    service: createCatalogPublicationConfirmationService(dependencies as never),
  }
}

describe('catalogPublicationConfirmation.service', () => {
  it('confirms a staged reversion through shared locks and one bulk inverse persistence', async () => {
    const h = harness({
      batchRows: [
        batch({
          operation: 'CATALOG_FIELDS_REVERSION',
          dependencies: { schemaVersion: 1, targets: [] },
        }),
      ],
    })

    await expect(h.service.confirm(context, confirmInput)).resolves.toMatchObject({
      operation: 'CATALOG_FIELDS_REVERSION',
      state: 'APPLIED',
    })
    expect(h.dependencies.revalidateReversionsTx).toHaveBeenCalledWith(
      h.applyTx,
      context,
      expect.objectContaining({
        operation: 'CATALOG_FIELDS_REVERSION',
      }),
    )
    expect(h.dependencies.applyReversionsTx).toHaveBeenCalledTimes(1)
    expect(h.dependencies.persistTx).not.toHaveBeenCalled()
    expect(h.dependencies.enqueueOutboxTx).not.toHaveBeenCalled()
  })

  it('confirms a staged activation through the shared reservation and locked Product transaction', async () => {
    const activationTarget = {
      catalogItemId: 'item-1',
      venueId: 'venue-1',
      productId: 'product-1',
      bindingId: 'binding-1',
      sourceCatalogRevision: 7,
      sourceCatalogInvariantVersion: '12',
      bindingRevision: 4,
      dependencies: {
        activation: {
          itemRevision: 7,
          itemInvariantVersion: '12',
          bindingRevision: 4,
          publicationAuthorityValid: true,
          profileEvaluationValid: true,
          readiness: { state: 'READY', dependencies: {} },
        },
      },
    }
    const h = harness({
      batchRows: [
        batch({
          operation: 'CATALOG_PRODUCT_ACTIVATION',
          targetHash: hashCanonicalJsonV1('catalog-publication-targets', {
            operation: 'CATALOG_PRODUCT_ACTIVATION',
            targets: ['activation-line-hash'],
          }),
          dependencies: { schemaVersion: 1, targets: [activationTarget] },
        }),
      ],
    })
    h.applyTx.catalogPublicationLine.findMany.mockResolvedValue([
      {
        id: 'line-activation',
        organizationId: 'org-1',
        batchId: 'batch-1',
        bindingId: 'binding-1',
        catalogItemId: 'item-1',
        venueId: 'venue-1',
        productId: 'product-1',
        status: 'READY',
        fieldMask: ['active'],
        decisionSchemaVersion: 1,
        changeKind: 'PUBLICATION',
        hashVersion: 1,
        canonicalTargetHash: 'activation-line-hash',
        before: { active: false },
        after: { active: true },
        sourceCatalogRevision: 7,
        bindingRevision: 4,
        supersedesLineId: null,
        reversesLineId: null,
      },
    ])

    await expect(h.service.confirm(context, confirmInput)).resolves.toMatchObject({
      operation: 'CATALOG_PRODUCT_ACTIVATION',
      state: 'APPLIED',
    })
    expect(h.dependencies.applyActivationTx).toHaveBeenCalledWith(
      h.applyTx,
      expect.objectContaining({
        publicationBatchId: 'batch-1',
        lineId: 'line-activation',
        bindingId: 'binding-1',
      }),
    )
    expect(h.dependencies.persistTx).not.toHaveBeenCalled()
    expect(h.dependencies.enqueueOutboxTx).not.toHaveBeenCalled()
  })

  it.each([
    ['null root', null],
    ['array root', []],
    ['extra key', { ...confirmInput, operation: 'CATALOG_FIELDS_PUBLISH' }],
    ['numeric token', { ...confirmInput, previewToken: 1 }],
    ['oversized key', { ...confirmInput, idempotencyKey: 'k'.repeat(257) }],
  ])('rejects malformed confirmation input before opening a transaction: %s', async (_label, input) => {
    const h = harness()

    await expect(h.service.confirm(context, input as never)).rejects.toMatchObject({ statusCode: 422 })
    expect(h.prisma.$transaction).not.toHaveBeenCalled()
  })

  it('durably reserves PREVIEWED -> APPLYING before opening the Product transaction', async () => {
    const h = harness()

    await expect(h.service.confirm(context, confirmInput)).resolves.toMatchObject({
      publicationBatchId: 'batch-1',
      operation: 'CATALOG_FIELDS_PUBLISH',
      state: 'APPLIED',
    })

    expect(h.prisma.$transaction).toHaveBeenCalledTimes(2)
    expect(h.reserveTx.catalogPublicationBatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'batch-1', organizationId: 'org-1', state: 'PREVIEWED' }),
        data: expect.objectContaining({ state: 'APPLYING', attemptId: 'attempt-1' }),
      }),
    )
    expect(h.reserveTx.catalogIdempotencyRecord.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: 'org-1',
          operation: 'CATALOG_FIELDS_PUBLISH',
          idempotencyKey: 'publish-key-1',
          state: 'PREVIEWED',
        }),
        data: expect.objectContaining({ state: 'APPLYING', attemptId: 'attempt-1' }),
      }),
    )
    expect(h.dependencies.revalidateTx.mock.invocationCallOrder[0]).toBeLessThan(
      h.dependencies.persistTx.mock.invocationCallOrder[0] as number,
    )
    expect(h.dependencies.lockAuthoritiesTx.mock.invocationCallOrder[0]).toBeLessThan(
      h.dependencies.assertAccessTx.mock.invocationCallOrder[1] as number,
    )
    expect(h.applyTx.catalogPublicationBatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          result: expect.objectContaining({ schemaVersion: 1, publicationBatchId: 'batch-1', state: 'APPLIED' }),
        }),
      }),
    )
    expect(h.applyTx.catalogIdempotencyRecord.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ result: expect.objectContaining({ schemaVersion: 1 }) }) }),
    )
    const exactLease = new Date(NOW.getTime() + 120_000)
    expect(h.applyTx.catalogPublicationBatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ attemptId: 'attempt-1', leaseExpiresAt: exactLease }) }),
    )
    expect(h.applyTx.catalogIdempotencyRecord.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ attemptId: 'attempt-1', leaseExpiresAt: exactLease }) }),
    )
  })

  it('leaves the durable APPLYING reservation for watchdog recovery when Product persistence rolls back', async () => {
    const h = harness({ persistError: new Error('product transaction rolled back') })

    await expect(h.service.confirm(context, confirmInput)).rejects.toThrow('product transaction rolled back')

    expect(h.prisma.$transaction).toHaveBeenCalledTimes(2)
    expect(h.reserveTx.catalogPublicationBatch.updateMany).toHaveBeenCalledTimes(1)
    expect(h.applyTx.catalogPublicationBatch.updateMany).not.toHaveBeenCalled()
  })

  it('rejects contradictory dual authority inside the Product transaction before persistence', async () => {
    const h = harness()
    h.applyTx.catalogIdempotencyRecord.findFirst.mockResolvedValue(
      record({
        state: 'APPLYING',
        attemptId: 'attempt-1',
        targetHash: 'c'.repeat(64),
      }),
    )

    await expect(h.service.confirm(context, confirmInput)).rejects.toMatchObject({
      statusCode: 409,
      code: 'CATALOG_PUBLICATION_STAGING_INVALID',
    })
    expect(h.dependencies.persistTx).not.toHaveBeenCalled()
  })

  it('rejects stale revalidation before persistence and keeps zero Product writes', async () => {
    const h = harness()
    h.dependencies.revalidateTx.mockRejectedValueOnce(Object.assign(new Error('stale'), { statusCode: 409, code: 'STALE_PREVIEW' }))

    await expect(h.service.confirm(context, confirmInput)).rejects.toMatchObject({ code: 'STALE_PREVIEW' })
    expect(h.dependencies.persistTx).not.toHaveBeenCalled()
  })

  it('returns IN_PROGRESS for an existing live APPLYING reservation without executing publication', async () => {
    const liveLease = new Date('2026-08-09T12:00:30.000Z')
    const h = harness({
      batchRows: [batch({ state: 'APPLYING', attemptId: 'winner', leaseExpiresAt: liveLease })],
    })

    await expect(h.service.confirm(context, confirmInput)).resolves.toEqual({
      publicationBatchId: 'batch-1',
      operation: 'CATALOG_FIELDS_PUBLISH',
      state: 'IN_PROGRESS',
      retryAfterSeconds: 30,
    })
    expect(h.prisma.$transaction).toHaveBeenCalledTimes(1)
    expect(h.dependencies.persistTx).not.toHaveBeenCalled()
  })

  it('replays an identical durable APPLIED v1 envelope as the stable public DTO', async () => {
    const durableResult = {
      schemaVersion: 1,
      publicationBatchId: 'batch-1',
      operation: 'CATALOG_FIELDS_PUBLISH',
      state: 'APPLIED',
      lines: [{ lineId: 'line-1', catalogItemId: 'item-1', venueId: 'venue-1', productId: 'product-1', status: 'APPLIED' }],
    }
    const h = harness({
      batchRows: [batch({ state: 'APPLIED', result: durableResult, attemptId: null, leaseExpiresAt: null })],
    })

    await expect(h.service.confirm(context, confirmInput)).resolves.toEqual({
      publicationBatchId: 'batch-1',
      operation: 'CATALOG_FIELDS_PUBLISH',
      state: 'APPLIED',
      lines: durableResult.lines,
    })
    expect(h.prisma.$transaction).toHaveBeenCalledTimes(1)
    expect(h.dependencies.persistTx).not.toHaveBeenCalled()
  })

  it('rejects an APPLIED dual JSON replay whose relational line is absent', async () => {
    const durableResult = {
      schemaVersion: 1,
      publicationBatchId: 'batch-1',
      operation: 'CATALOG_FIELDS_PUBLISH',
      state: 'APPLIED',
      lines: [{ lineId: 'forged-line', catalogItemId: 'item-1', venueId: 'venue-1', productId: 'product-1', status: 'APPLIED' }],
    }
    const h = harness({ batchRows: [batch({ state: 'APPLIED', result: durableResult, attemptId: null })] })
    h.reserveTx.catalogPublicationLine.findMany.mockResolvedValue([])

    await expect(h.service.confirm(context, confirmInput)).rejects.toMatchObject({
      statusCode: 409,
      code: 'CATALOG_PUBLICATION_RESULT_INVALID',
    })
  })

  it('fails closed for a changed token or contradictory dual authority', async () => {
    const changedToken = harness()
    await expect(changedToken.service.confirm(context, { ...confirmInput, previewToken: 'forged' })).rejects.toMatchObject({
      statusCode: 409,
      code: 'STALE_PREVIEW',
    })

    const contradictory = harness()
    contradictory.reserveTx.catalogIdempotencyRecord.findUnique.mockResolvedValueOnce(record({ targetHash: 'c'.repeat(64) }))
    await expect(contradictory.service.confirm(context, confirmInput)).rejects.toMatchObject({
      statusCode: 409,
      code: 'CATALOG_PUBLICATION_STAGING_INVALID',
    })
    expect(contradictory.dependencies.persistTx).not.toHaveBeenCalled()
  })
})
