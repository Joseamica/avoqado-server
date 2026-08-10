import { createCatalogPublicationPreviewService } from '@/services/master-catalog/catalogPublicationPreview.service'

const NOW = new Date('2026-08-09T12:00:00.000Z')
const context = {
  organizationId: 'org-1',
  actor: { type: 'HUMAN' as const, staffId: 'staff-1', impersonating: false },
}

function projectedTarget(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: 'org-1',
    venueId: 'venue-1',
    catalogItemId: 'item-1',
    productId: 'product-1',
    bindingId: 'binding-1',
    sourceCatalogRevision: 7,
    sourceCatalogInvariantVersion: '12',
    bindingRevision: 4,
    dependencies: { readiness: { state: 'READY' } },
    projection: {
      fieldMask: ['description', 'name'],
      before: { description: 'Local', name: 'Nombre local' },
      proposed: { description: 'Corporativa', name: 'Nombre corporativo' },
      fields: [
        { field: 'description', before: 'Local', proposed: 'Corporativa', changed: true, diverged: false },
        { field: 'name', before: 'Nombre local', proposed: 'Nombre corporativo', changed: true, diverged: true },
      ],
      status: 'LOCAL_DIVERGENCE',
      diagnosticCode: null,
      diagnostic: null,
      canonicalTargetHash: 'a'.repeat(64),
    },
    ...overrides,
  }
}

function tx() {
  return {
    catalogPublicationBatch: { create: jest.fn().mockResolvedValue({ id: 'batch-1' }) },
    catalogIdempotencyRecord: { create: jest.fn().mockResolvedValue({ id: 'idem-1' }) },
    catalogPublicationLine: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
    catalogPublicationFieldDecision: { createMany: jest.fn().mockResolvedValue({ count: 2 }) },
    product: { update: jest.fn(), updateMany: jest.fn() },
    catalogVenueBinding: { update: jest.fn(), updateMany: jest.fn() },
    catalogVenueOverride: { create: jest.fn(), createMany: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  }
}

function harness(targets = [projectedTarget()]) {
  const client = tx()
  const prisma = { $transaction: jest.fn(async (callback: (value: typeof client) => unknown) => callback(client)) }
  const dependencies = {
    prisma: prisma as never,
    assertAccessTx: jest.fn().mockResolvedValue(undefined),
    loadTargetsTx: jest.fn().mockResolvedValue(targets),
    now: jest.fn(() => NOW),
    randomToken: jest.fn(() => 'raw-preview-token'),
    randomId: jest.fn().mockReturnValueOnce('batch-1').mockReturnValueOnce('idem-1').mockReturnValue('line-1'),
  }
  return { tx: client, prisma, dependencies, service: createCatalogPublicationPreviewService(dependencies) }
}

describe('catalogPublicationPreview.service', () => {
  it('maps an access dependency outage to retryable 503 before target loading', async () => {
    const client = tx() as ReturnType<typeof tx> & {
      staff: { findUnique: jest.Mock }
      organizationEntitlement: { findUnique: jest.Mock }
      module: { findUnique: jest.Mock }
    }
    client.staff = { findUnique: jest.fn().mockRejectedValue(new Error('db unavailable')) }
    client.organizationEntitlement = { findUnique: jest.fn() }
    client.module = { findUnique: jest.fn() }
    const prisma = { $transaction: jest.fn(async (callback: (value: typeof client) => unknown) => callback(client)) }
    const loadTargetsTx = jest.fn()
    const service = createCatalogPublicationPreviewService({ prisma: prisma as never, loadTargetsTx })

    await expect(
      service.preview(context, {
        operation: 'CATALOG_FIELDS_PUBLISH',
        idempotencyKey: 'dependency-outage',
        targets: [{ catalogItemId: 'item-1', venueId: 'venue-1', productId: 'product-1' }],
      }),
    ).rejects.toMatchObject({ statusCode: 503, code: 'DEPENDENCY_UNAVAILABLE' })
    expect(loadTargetsTx).not.toHaveBeenCalled()
  })

  it('stages immutable targets and one explicit decision per field without mutating Product, binding or overrides', async () => {
    const h = harness()

    const preview = await h.service.preview(context, {
      operation: 'CATALOG_FIELDS_PUBLISH',
      idempotencyKey: 'publish-key-1',
      targets: [
        {
          catalogItemId: 'item-1',
          venueId: 'venue-1',
          productId: 'product-1',
          decisions: [
            { field: 'description', decision: 'PUBLISH_CORPORATE' },
            { field: 'name', decision: 'UNDECIDED' },
          ],
        },
      ],
    })

    expect(h.dependencies.assertAccessTx).toHaveBeenCalledWith(h.tx, context)
    expect(preview).toMatchObject({
      publicationBatchId: 'batch-1',
      previewToken: 'raw-preview-token',
      canConfirm: false,
      lines: [
        {
          catalogItemId: 'item-1',
          venueId: 'venue-1',
          productId: 'product-1',
          status: 'LOCAL_DIVERGENCE',
          fieldMask: ['description', 'name'],
          fields: [
            { field: 'description', decision: 'PUBLISH_CORPORATE' },
            { field: 'name', decision: 'UNDECIDED' },
          ],
        },
      ],
    })
    expect(h.tx.catalogPublicationLine.createMany).toHaveBeenCalledTimes(1)
    expect(h.tx.catalogPublicationFieldDecision.createMany).not.toHaveBeenCalled()
    expect(h.tx.product.update).not.toHaveBeenCalled()
    expect(h.tx.product.updateMany).not.toHaveBeenCalled()
    expect(h.tx.catalogVenueBinding.update).not.toHaveBeenCalled()
    expect(h.tx.catalogVenueOverride.create).not.toHaveBeenCalled()
    expect(h.tx.catalogVenueOverride.createMany).not.toHaveBeenCalled()
    expect(h.tx.catalogPublicationBatch.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        dependencies: expect.objectContaining({
          targets: [
            expect.objectContaining({
              sourceCatalogInvariantVersion: '12',
              dependencies: expect.objectContaining({
                decisions: expect.arrayContaining([
                  expect.objectContaining({ field: 'description', decision: 'PUBLISH_CORPORATE' }),
                  expect.objectContaining({ field: 'name', decision: 'UNDECIDED' }),
                ]),
              }),
            }),
          ],
        }),
      }),
    })
  })

  it('becomes confirmable only when every line is valid and every field has a terminal decision', async () => {
    const h = harness()

    const preview = await h.service.preview(context, {
      operation: 'CATALOG_FIELDS_PUBLISH',
      idempotencyKey: 'publish-key-2',
      targets: [
        {
          catalogItemId: 'item-1',
          venueId: 'venue-1',
          productId: 'product-1',
          decisions: [
            { field: 'description', decision: 'PUBLISH_CORPORATE' },
            { field: 'name', decision: 'APPROVE_LOCAL_OVERRIDE', overrideId: 'override-1' },
          ],
        },
      ],
    })

    expect(preview.canConfirm).toBe(true)
  })

  it('rejects an unknown operation before opening a transaction or looking up resources', async () => {
    const h = harness()

    await expect(
      h.service.preview(context, {
        operation: 'UNKNOWN_OPERATION' as never,
        idempotencyKey: 'bad-operation',
        targets: [{ catalogItemId: 'item-1', venueId: 'venue-1', productId: 'product-1' }],
      }),
    ).rejects.toMatchObject({ statusCode: 422, code: 'CATALOG_PUBLICATION_OPERATION_UNSUPPORTED' })
    expect(h.prisma.$transaction).not.toHaveBeenCalled()
    expect(h.dependencies.loadTargetsTx).not.toHaveBeenCalled()
  })

  it.each([
    ['non-array decisions', {}],
    ['unknown decision', [{ field: 'name', decision: 'UNKNOWN' }]],
    ['blank override identity', [{ field: 'name', decision: 'APPROVE_LOCAL_OVERRIDE', overrideId: '' }]],
    ['extra union key', [{ field: 'name', decision: 'PUBLISH_CORPORATE', overrideId: 'smuggled' }]],
    [
      'duplicate field',
      [
        { field: 'name', decision: 'UNDECIDED' },
        { field: 'name', decision: 'PUBLISH_CORPORATE' },
      ],
    ],
  ])('rejects malformed runtime target input before the transaction: %s', async (_label, decisions) => {
    const h = harness()

    await expect(
      h.service.preview(context, {
        operation: 'CATALOG_FIELDS_PUBLISH',
        idempotencyKey: 'malformed-input',
        targets: [{ catalogItemId: 'item-1', venueId: 'venue-1', productId: 'product-1', decisions } as never],
      }),
    ).rejects.toMatchObject({ statusCode: 422, code: 'CATALOG_PUBLICATION_INPUT_INVALID' })
    expect(h.prisma.$transaction).not.toHaveBeenCalled()
    expect(h.dependencies.loadTargetsTx).not.toHaveBeenCalled()
  })

  it.each([
    ['null root', null],
    ['array root', []],
    [
      'numeric idempotency key',
      {
        operation: 'CATALOG_FIELDS_PUBLISH',
        idempotencyKey: 1,
        targets: [{ catalogItemId: 'item-1', venueId: 'venue-1', productId: 'product-1' }],
      },
    ],
  ])('rejects malformed root input before dereference or transaction: %s', async (_label, input) => {
    const h = harness()

    await expect(h.service.preview(context, input as never)).rejects.toMatchObject({
      statusCode: 422,
      code: 'CATALOG_PUBLICATION_INPUT_INVALID',
    })
    expect(h.prisma.$transaction).not.toHaveBeenCalled()
  })

  it('enforces the configurable default cap of 10,000 immutable Product targets before staging', async () => {
    const h = harness()
    const targets = Array.from({ length: 10_001 }, (_, index) => ({
      catalogItemId: `item-${index}`,
      venueId: 'venue-1',
      productId: `product-${index}`,
    }))

    await expect(
      h.service.preview(context, { operation: 'CATALOG_FIELDS_PUBLISH', idempotencyKey: 'over-cap', targets }),
    ).rejects.toMatchObject({ statusCode: 413, code: 'CATALOG_PUBLICATION_TARGET_CAP_EXCEEDED' })
    expect(h.prisma.$transaction).not.toHaveBeenCalled()
  })

  it('rejects duplicate immutable targets instead of staging ambiguous line authority', async () => {
    const h = harness()
    const target = { catalogItemId: 'item-1', venueId: 'venue-1', productId: 'product-1' }

    await expect(
      h.service.preview(context, {
        operation: 'CATALOG_FIELDS_PUBLISH',
        idempotencyKey: 'duplicates',
        targets: [target, target],
      }),
    ).rejects.toMatchObject({ statusCode: 422, code: 'CATALOG_PUBLICATION_TARGET_DUPLICATE' })
  })

  it.each([
    ['same durable request', false, 'CATALOG_PUBLICATION_PREVIEW_TOKEN_NOT_RECOVERABLE'],
    ['different durable request', true, 'IDEMPOTENCY_KEY_REUSED'],
  ])('maps exact operation/key P2002 for %s without exposing a Prisma 500', async (_label, changed, code) => {
    const h = harness()
    h.tx.catalogIdempotencyRecord.create.mockRejectedValueOnce(
      Object.assign(new Error('unique'), {
        code: 'P2002',
        meta: { target: ['organizationId', 'operation', 'idempotencyKey'] },
      }),
    )
    const findUnique = jest.fn().mockImplementation(() => {
      const attempted = h.tx.catalogIdempotencyRecord.create.mock.calls[0][0].data
      return {
        ...attempted,
        requestHash: changed ? 'd'.repeat(64) : attempted.requestHash,
        resourceType: 'CatalogPublicationBatch',
        resourceId: 'existing-batch',
      }
    })
    const findFirst = jest.fn().mockImplementation(() => {
      const attempted = h.tx.catalogPublicationBatch.create.mock.calls[0][0].data
      return { ...attempted, id: 'existing-batch' }
    })
    Object.assign(h.prisma, {
      catalogIdempotencyRecord: { findUnique },
      catalogPublicationBatch: { findFirst },
    })

    await expect(
      h.service.preview(context, {
        operation: 'CATALOG_FIELDS_PUBLISH',
        idempotencyKey: 'publish-key-1',
        targets: [{ catalogItemId: 'item-1', venueId: 'venue-1', productId: 'product-1' }],
      }),
    ).rejects.toMatchObject({ statusCode: 409, code })
    expect(findUnique).toHaveBeenCalled()
    expect(findFirst).toHaveBeenCalled()
  })

  it('rethrows an unrelated P2002 instead of misclassifying it as idempotency', async () => {
    const h = harness()
    const unrelated = Object.assign(new Error('line unique'), {
      code: 'P2002',
      meta: { target: ['batchId', 'catalogItemId', 'venueId', 'productId'] },
    })
    h.tx.catalogIdempotencyRecord.create.mockRejectedValueOnce(unrelated)

    await expect(
      h.service.preview(context, {
        operation: 'CATALOG_FIELDS_PUBLISH',
        idempotencyKey: 'publish-key-1',
        targets: [{ catalogItemId: 'item-1', venueId: 'venue-1', productId: 'product-1' }],
      }),
    ).rejects.toBe(unrelated)
  })
})
