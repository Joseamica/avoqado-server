import { createCatalogPublicationRecoveryService } from '@/services/master-catalog/catalogPublicationRecovery.service'

const context = {
  organizationId: 'org-1',
  actor: { type: 'HUMAN' as const, staffId: 'staff-1', impersonating: false },
}

const dependencies = {
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
      dependencies: { projection: {}, decisions: [] },
    },
  ],
}

function result() {
  return {
    schemaVersion: 1,
    publicationBatchId: 'batch-1',
    operation: 'CATALOG_FIELDS_PUBLISH',
    state: 'APPLIED',
    lines: [
      {
        lineId: 'line-1',
        catalogItemId: 'item-1',
        venueId: 'venue-1',
        productId: 'product-1',
        status: 'APPLIED',
      },
    ],
  }
}

function record(overrides: Record<string, unknown> = {}) {
  return {
    id: 'idem-1',
    organizationId: 'org-1',
    operation: 'CATALOG_FIELDS_PUBLISH',
    idempotencyKey: 'same-key',
    requestHash: 'a'.repeat(64),
    requestHashVersion: 1,
    previewTokenHash: 'c'.repeat(64),
    previewExpiresAt: new Date('2026-08-09T12:30:00.000Z'),
    dependencies,
    state: 'APPLIED',
    resourceType: 'CatalogPublicationBatch',
    resourceId: 'batch-1',
    targetHash: 'b'.repeat(64),
    result: result(),
    actorType: 'HUMAN',
    staffId: 'staff-1',
    servicePrincipalId: null,
    attemptId: null,
    leaseExpiresAt: null,
    heartbeatAt: null,
    failureCode: null,
    failureMessage: null,
    completedAt: new Date('2026-08-09T12:00:00.000Z'),
    ...overrides,
  }
}

function batch(overrides: Record<string, unknown> = {}) {
  return {
    id: 'batch-1',
    organizationId: 'org-1',
    operation: 'CATALOG_FIELDS_PUBLISH',
    schemaVersion: 1,
    requestHash: 'a'.repeat(64),
    requestHashVersion: 1,
    previewTokenHash: 'c'.repeat(64),
    previewExpiresAt: new Date('2026-08-09T12:30:00.000Z'),
    dependencies,
    targetHash: 'b'.repeat(64),
    state: 'APPLIED',
    result: result(),
    actorType: 'HUMAN',
    staffId: 'staff-1',
    servicePrincipalId: null,
    attemptId: null,
    leaseExpiresAt: null,
    heartbeatAt: null,
    failureCode: null,
    failureMessage: null,
    appliedAt: new Date('2026-08-09T12:00:00.000Z'),
    completedAt: new Date('2026-08-09T12:00:00.000Z'),
    ...overrides,
  }
}

function relationalLine(overrides: Record<string, unknown> = {}) {
  return {
    id: 'line-1',
    organizationId: 'org-1',
    batchId: 'batch-1',
    bindingId: 'binding-1',
    catalogItemId: 'item-1',
    venueId: 'venue-1',
    productId: 'product-1',
    status: 'APPLIED',
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
    ...overrides,
  }
}

function harness(idempotency = record(), publicationBatch = batch(), relationalLines = [relationalLine()]) {
  const prisma = {
    catalogIdempotencyRecord: { findUnique: jest.fn().mockResolvedValue(idempotency) },
    catalogPublicationBatch: { findFirst: jest.fn().mockResolvedValue(publicationBatch) },
    catalogPublicationLine: {
      findMany: jest.fn().mockResolvedValue(relationalLines),
    },
  }
  const dependencies = {
    prisma: prisma as never,
    assertAccess: jest.fn().mockResolvedValue(undefined),
    now: jest.fn(() => new Date('2026-08-09T12:00:00.000Z')),
  }
  return { prisma, dependencies, service: createCatalogPublicationRecoveryService(dependencies) }
}

describe('catalogPublicationRecovery.service', () => {
  it.each([
    ['activation with managed mask', 'CATALOG_PRODUCT_ACTIVATION', relationalLine()],
    ['reversion without lineage', 'CATALOG_FIELDS_REVERSION', relationalLine({ changeKind: 'REVERSION' })],
  ])('rejects cross-operation relational replay: %s', async (_label, operation, line) => {
    const durable = { ...result(), operation }
    const h = harness(record({ operation, result: durable }), batch({ operation, result: durable }), [line])

    await expect(
      h.service.getByIdempotencyKey(context, {
        operation: operation as never,
        idempotencyKey: 'same-key',
      }),
    ).rejects.toMatchObject({ code: 'CATALOG_PUBLICATION_RESULT_INVALID' })
  })

  it.each([
    ['null root', null],
    ['array root', []],
    ['numeric key', { operation: 'CATALOG_FIELDS_PUBLISH', idempotencyKey: 1 }],
    ['extra key', { operation: 'CATALOG_FIELDS_PUBLISH', idempotencyKey: 'same-key', batchId: 'probe' }],
  ])('rejects malformed recovery input before access or lookup: %s', async (_label, input) => {
    const h = harness()

    await expect(h.service.getByIdempotencyKey(context, input as never)).rejects.toMatchObject({ statusCode: 422 })
    expect(h.dependencies.assertAccess).not.toHaveBeenCalled()
    expect(h.prisma.catalogIdempotencyRecord.findUnique).not.toHaveBeenCalled()
  })

  it('maps an access dependency outage to retryable 503 before recovery lookup', async () => {
    const client = {
      staff: { findUnique: jest.fn().mockRejectedValue(new Error('db unavailable')) },
      organizationEntitlement: { findUnique: jest.fn() },
      module: { findUnique: jest.fn() },
      catalogIdempotencyRecord: { findUnique: jest.fn() },
    }
    const service = createCatalogPublicationRecoveryService({ prisma: client as never })

    await expect(
      service.getByIdempotencyKey(context, {
        operation: 'CATALOG_FIELDS_PUBLISH',
        idempotencyKey: 'same-key',
      }),
    ).rejects.toMatchObject({ statusCode: 503, code: 'DEPENDENCY_UNAVAILABLE' })
    expect(client.catalogIdempotencyRecord.findUnique).not.toHaveBeenCalled()
  })

  it('scopes lookup by organization, exact operation and idempotency key', async () => {
    const h = harness()

    await expect(
      h.service.getByIdempotencyKey(context, { operation: 'CATALOG_FIELDS_PUBLISH', idempotencyKey: 'same-key' }),
    ).resolves.toEqual({
      publicationBatchId: 'batch-1',
      operation: 'CATALOG_FIELDS_PUBLISH',
      state: 'APPLIED',
      lines: result().lines,
    })
    expect(h.prisma.catalogIdempotencyRecord.findUnique).toHaveBeenCalledWith({
      where: {
        organizationId_operation_idempotencyKey: {
          organizationId: 'org-1',
          operation: 'CATALOG_FIELDS_PUBLISH',
          idempotencyKey: 'same-key',
        },
      },
    })
  })

  it('lets the same textual key belong to a different known operation without collision', async () => {
    const reversionResult = {
      ...result(),
      operation: 'CATALOG_FIELDS_REVERSION',
    }
    const h = harness(
      record({ operation: 'CATALOG_FIELDS_REVERSION', result: reversionResult }),
      batch({ operation: 'CATALOG_FIELDS_REVERSION', result: reversionResult }),
      [relationalLine({ changeKind: 'REVERSION', supersedesLineId: 'current-line', reversesLineId: 'source-line' })],
    )

    const recovered = await h.service.getByIdempotencyKey(context, {
      operation: 'CATALOG_FIELDS_REVERSION',
      idempotencyKey: 'same-key',
    })

    expect(recovered.operation).toBe('CATALOG_FIELDS_REVERSION')
  })

  it('rejects an unknown operation before access or generic resource lookup', async () => {
    const h = harness()

    await expect(
      h.service.getByIdempotencyKey(context, { operation: 'UNKNOWN' as never, idempotencyKey: 'same-key' }),
    ).rejects.toMatchObject({ statusCode: 422, code: 'CATALOG_PUBLICATION_OPERATION_UNSUPPORTED' })
    expect(h.dependencies.assertAccess).not.toHaveBeenCalled()
    expect(h.prisma.catalogIdempotencyRecord.findUnique).not.toHaveBeenCalled()
  })

  it('returns bounded IN_PROGRESS for APPLYING and never executes publication again', async () => {
    const lease = new Date('2026-08-09T12:00:30.000Z')
    const applying = {
      state: 'APPLYING',
      result: null,
      attemptId: 'attempt-1',
      leaseExpiresAt: lease,
      heartbeatAt: new Date('2026-08-09T12:00:00.000Z'),
      completedAt: null,
    }
    const h = harness(record(applying), batch({ ...applying, appliedAt: null }))

    await expect(
      h.service.getByIdempotencyKey(context, { operation: 'CATALOG_FIELDS_PUBLISH', idempotencyKey: 'same-key' }),
    ).resolves.toEqual({
      publicationBatchId: 'batch-1',
      operation: 'CATALOG_FIELDS_PUBLISH',
      state: 'IN_PROGRESS',
      retryAfterSeconds: 30,
    })
  })

  it('returns PREVIEWED without leaking the raw bearer or pretending an executor exists', async () => {
    const h = harness(
      record({ state: 'PREVIEWED', result: null, attemptId: null, leaseExpiresAt: null, completedAt: null }),
      batch({ state: 'PREVIEWED', result: null, attemptId: null, leaseExpiresAt: null, appliedAt: null, completedAt: null }),
    )

    await expect(
      h.service.getByIdempotencyKey(context, { operation: 'CATALOG_FIELDS_PUBLISH', idempotencyKey: 'same-key' }),
    ).resolves.toEqual({
      publicationBatchId: 'batch-1',
      operation: 'CATALOG_FIELDS_PUBLISH',
      state: 'PREVIEWED',
      expiresAt: '2026-08-09T12:30:00.000Z',
    })
  })

  it.each([
    ['forged resource linkage', record({ resourceId: 'batch-other' }), batch()],
    ['contradictory batch result', record(), batch({ result: { ...result(), publicationBatchId: 'batch-other' } })],
    ['blank line identity', record({ result: { ...result(), lines: [{ ...result().lines[0], lineId: '' }] } }), batch()],
    [
      'oversized result',
      record({
        result: { ...result(), lines: Array.from({ length: 10_001 }, (_, index) => ({ ...result().lines[0], lineId: `line-${index}` })) },
      }),
      batch(),
    ],
  ])('fails closed for a %s', async (_label, idempotency, publicationBatch) => {
    const h = harness(idempotency, publicationBatch)

    await expect(
      h.service.getByIdempotencyKey(context, { operation: 'CATALOG_FIELDS_PUBLISH', idempotencyKey: 'same-key' }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'CATALOG_PUBLICATION_RESULT_INVALID' })
  })

  it.each([
    ['unsupported batch schema', batch({ schemaVersion: 2 })],
    ['different preview token', batch({ previewTokenHash: 'd'.repeat(64) })],
    ['different preview expiry', batch({ previewExpiresAt: new Date('2026-08-09T12:31:00.000Z') })],
    ['different dependencies', batch({ dependencies: { ...dependencies, targets: [{ ...dependencies.targets[0], bindingRevision: 2 }] } })],
    ['different actor', batch({ actorType: 'SERVICE', staffId: null, servicePrincipalId: 'forged-service' })],
  ])('rejects contradictory dual authority: %s', async (_label, publicationBatch) => {
    const h = harness(record(), publicationBatch)

    await expect(
      h.service.getByIdempotencyKey(context, {
        operation: 'CATALOG_FIELDS_PUBLISH',
        idempotencyKey: 'same-key',
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'CATALOG_PUBLICATION_RESULT_INVALID' })
  })

  it.each([
    [
      'different APPLYING lease',
      record({
        state: 'APPLYING',
        result: null,
        attemptId: 'attempt-1',
        leaseExpiresAt: new Date('2026-08-09T12:00:30.000Z'),
        heartbeatAt: new Date('2026-08-09T12:00:00.000Z'),
        completedAt: null,
      }),
      batch({
        state: 'APPLYING',
        result: null,
        attemptId: 'attempt-1',
        leaseExpiresAt: new Date('2026-08-09T12:00:31.000Z'),
        heartbeatAt: new Date('2026-08-09T12:00:00.000Z'),
        appliedAt: null,
        completedAt: null,
      }),
    ],
    [
      'different APPLYING heartbeat',
      record({
        state: 'APPLYING',
        result: null,
        attemptId: 'attempt-1',
        leaseExpiresAt: new Date('2026-08-09T12:00:30.000Z'),
        heartbeatAt: new Date('2026-08-09T12:00:00.000Z'),
        completedAt: null,
      }),
      batch({
        state: 'APPLYING',
        result: null,
        attemptId: 'attempt-1',
        leaseExpiresAt: new Date('2026-08-09T12:00:30.000Z'),
        heartbeatAt: new Date('2026-08-09T12:00:01.000Z'),
        appliedAt: null,
        completedAt: null,
      }),
    ],
    ['APPLIED with a live attempt', record({ attemptId: 'attempt-1' }), batch({ attemptId: 'attempt-1' })],
    [
      'PREVIEWED with heartbeat',
      record({ state: 'PREVIEWED', result: null, heartbeatAt: new Date(), completedAt: null }),
      batch({ state: 'PREVIEWED', result: null, heartbeatAt: new Date(), appliedAt: null, completedAt: null }),
    ],
    [
      'FAILED without failure authority',
      record({ state: 'FAILED', result: null }),
      batch({ state: 'FAILED', result: null, appliedAt: null }),
    ],
  ])('fails closed for invalid durable state shape: %s', async (_label, idempotency, publicationBatch) => {
    const h = harness(idempotency, publicationBatch)
    await expect(
      h.service.getByIdempotencyKey(context, { operation: 'CATALOG_FIELDS_PUBLISH', idempotencyKey: 'same-key' }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'CATALOG_PUBLICATION_RESULT_INVALID' })
  })

  it('rejects an empty APPLIED authority and a batch with a hidden nonterminal line', async () => {
    const emptyResult = { ...result(), lines: [] }
    const emptyDependencies = { schemaVersion: 1, targets: [] }
    const empty = harness(
      record({ result: emptyResult, dependencies: emptyDependencies }),
      batch({ result: emptyResult, dependencies: emptyDependencies }),
      [],
    )
    await expect(
      empty.service.getByIdempotencyKey(context, { operation: 'CATALOG_FIELDS_PUBLISH', idempotencyKey: 'same-key' }),
    ).rejects.toMatchObject({ code: 'CATALOG_PUBLICATION_RESULT_INVALID' })

    const partial = harness(record(), batch(), [
      relationalLine(),
      relationalLine({
        id: 'line-hidden',
        catalogItemId: 'item-2',
        venueId: 'venue-1',
        productId: 'product-2',
        status: 'READY',
      }),
    ])
    await expect(
      partial.service.getByIdempotencyKey(context, { operation: 'CATALOG_FIELDS_PUBLISH', idempotencyKey: 'same-key' }),
    ).rejects.toMatchObject({ code: 'CATALOG_PUBLICATION_RESULT_INVALID' })
  })

  it.each(['FAILED', 'EXPIRED', 'SUPERSEDED'])('requires a new preview/key for terminal state %s', async state => {
    const failure =
      state === 'FAILED'
        ? { failureCode: 'ATTEMPT_FAILED', failureMessage: 'El intento falló.' }
        : { failureCode: null, failureMessage: null }
    const terminal = { state, result: null, attemptId: null, leaseExpiresAt: null, heartbeatAt: null, ...failure }
    const h = harness(record(terminal), batch({ ...terminal, appliedAt: null }))

    await expect(
      h.service.getByIdempotencyKey(context, { operation: 'CATALOG_FIELDS_PUBLISH', idempotencyKey: 'same-key' }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'CATALOG_PUBLICATION_NEW_PREVIEW_REQUIRED' })
  })
})
