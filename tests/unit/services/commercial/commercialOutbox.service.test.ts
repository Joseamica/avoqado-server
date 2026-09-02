import { createCommercialOutboxService, type ClaimedCommercialOutboxRow } from '@/services/commercial/commercialOutbox.service'
import { CommercialArtifactCodecError } from '@/services/commercial/commercialArtifactCodecRegistry.service'
import catalogV2Fixture from '@/contracts/commercial/fixtures/v2/catalog-base.json'
import { COMMERCIAL_V2_DOMAINS } from '@/contracts/commercial/commercialContractV2.constants'
import { hashCanonicalJsonV2 } from '@/services/commercial/commercialCanonicalJsonV2.service'
import type { CommercialCatalogActivationOutboxRecord, CommercialCatalogPersistedRow } from '@/types/commercialCodec'
import type { CommercialCatalogSnapshotV2 } from '@/types/commercialV2'

const publication = {
  id: 'pub_1',
  schemaVersion: 1,
  snapshot: { schemaVersion: 1 },
  checksum: 'a'.repeat(64),
  publishedAt: new Date('2026-08-21T12:00:00.000Z'),
}

function verifiedActivationAuthorityDependencies(referencedPublication = publication) {
  const head = {
    publicationId: referencedPublication.id,
    schemaVersion: referencedPublication.schemaVersion,
    checksum: referencedPublication.checksum,
  }
  const pointer = {
    environment: 'PRODUCTION' as const,
    publicationId: referencedPublication.id,
    revision: 1,
    publication: referencedPublication,
  }
  return {
    loadActivationGraph: jest.fn().mockResolvedValue({ pointer, activationEvents: [] }),
    proveActivationChain: jest.fn().mockReturnValue({ pointer, publications: [referencedPublication] }),
    verifyClaimedRevision: jest.fn().mockReturnValue({ publication: referencedPublication, head }),
  }
}

function verifiedPublicationDependencies(referencedPublication = publication) {
  return {
    ...verifiedActivationAuthorityDependencies(referencedPublication),
    loadPublication: jest.fn().mockResolvedValue(referencedPublication),
    verifyPublication: jest.fn(),
  }
}

function row(overrides: Partial<ClaimedCommercialOutboxRow> = {}): ClaimedCommercialOutboxRow {
  return {
    id: 'outbox_1',
    eventType: 'PUBLICATION_ACTIVATED',
    publicationId: 'pub_1',
    previousPublicationId: null,
    payloadVersion: 1,
    payload: {
      eventId: 'activation:1:pub_1',
      type: 'PUBLICATION_ACTIVATED',
      publicationId: 'pub_1',
      previousPublicationId: null,
      schemaVersion: 1,
      checksum: 'a'.repeat(64),
      occurredAt: '2026-08-21T12:00:00.000Z',
    },
    dedupeKey: 'activation:1:pub_1',
    attempts: 1,
    claimExpiresAt: new Date('2026-08-21T12:01:00.000Z'),
    ...overrides,
  }
}

function catalogV2Row(id: string, publishedAt: string): CommercialCatalogPersistedRow {
  const snapshot = JSON.parse(JSON.stringify(catalogV2Fixture)) as CommercialCatalogSnapshotV2
  snapshot.publicationId = id
  snapshot.publishedAt = publishedAt
  return {
    id,
    schemaVersion: 2,
    snapshot,
    checksum: hashCanonicalJsonV2(COMMERCIAL_V2_DOMAINS.CATALOG_SNAPSHOT, snapshot),
    publishedAt: new Date(publishedAt),
  }
}

function activationOutboxRecord(
  revision: number,
  current: CommercialCatalogPersistedRow,
  previous: CommercialCatalogPersistedRow | null,
): CommercialCatalogActivationOutboxRecord {
  const eventType = 'PUBLICATION_ACTIVATED' as const
  const dedupeKey = `commercial:activation:${revision}:${current.id}`
  const occurredAt = `2026-08-${20 + revision}T12:00:00.000Z`
  return {
    id: `stored-event-${revision}`,
    eventType,
    publicationId: current.id,
    previousPublicationId: previous?.id ?? null,
    payloadVersion: 1,
    payload: {
      eventId: dedupeKey,
      type: eventType,
      publicationId: current.id,
      previousPublicationId: previous?.id ?? null,
      schemaVersion: current.schemaVersion,
      checksum: current.checksum,
      occurredAt,
    },
    dedupeKey,
    createdAt: new Date(occurredAt),
    publication: current,
    previousPublication: previous,
  }
}

describe('commercialOutboxService', () => {
  it('loads and proves one activation authority snapshot and delivers the verified current head', async () => {
    const claimed = row()
    const head = { publicationId: 'pub_head', schemaVersion: 2, checksum: 'b'.repeat(64) }
    const graph = { pointer: { publicationId: 'pub_head', revision: 9 }, activationEvents: [] }
    const decision = { pointer: graph.pointer, publications: [] }
    const loadActivationGraph = jest.fn().mockResolvedValue(graph)
    const proveActivationChain = jest.fn().mockReturnValue(decision)
    const verifyClaimedRevision = jest.fn().mockReturnValue({ head, publication })
    const deliver = jest.fn()
    const acknowledge = jest.fn().mockResolvedValue(true)
    const service = createCommercialOutboxService({
      claim: jest.fn().mockResolvedValue([claimed]),
      loadActivationGraph,
      proveActivationChain,
      verifyClaimedRevision,
      loadPublication: jest.fn(),
      verifyPublication: jest.fn(),
      deliver,
      acknowledge,
      fail: jest.fn(),
      now: () => new Date('2026-08-21T12:00:00.000Z'),
    } as never)

    await expect(service.sweepOnce({ workerId: 'worker-authority' })).resolves.toEqual({
      claimed: 1,
      delivered: 1,
      failed: 0,
    })
    expect(loadActivationGraph).toHaveBeenCalledTimes(1)
    expect(proveActivationChain).toHaveBeenCalledTimes(1)
    expect(verifyClaimedRevision).toHaveBeenCalledTimes(1)
    expect(deliver).toHaveBeenCalledWith({ event: expect.objectContaining({ publicationId: 'pub_1' }), head })
    expect(deliver.mock.invocationCallOrder[0]).toBeLessThan(acknowledge.mock.invocationCallOrder[0])
  })

  it('uses one graph load and one proof for a 1,000-revision graph with a 100-row claimed batch', async () => {
    const receipt = {
      graphLoads: 0,
      chainProofs: 0,
      membershipChecks: 0,
      hydratedPublicationRows: 0,
      comparedSnapshotBytes: 0,
    }
    const claimed = Array.from({ length: 100 }, (_, index) => {
      const revision = index + 901
      const dedupeKey = `commercial:activation:${revision}:pub_1`
      return row({
        id: `outbox-${revision}`,
        dedupeKey,
        payload: {
          eventId: dedupeKey,
          type: 'PUBLICATION_ACTIVATED',
          publicationId: 'pub_1',
          previousPublicationId: null,
          schemaVersion: 1,
          checksum: 'a'.repeat(64),
          occurredAt: '2026-08-21T12:00:00.000Z',
        },
      })
    })
    const activationEvents = Array.from({ length: 1_000 }, (_, index) => ({
      dedupeKey: `commercial:activation:${index + 1}:pub_1`,
      publicationId: 'pub_1',
      publication,
      previousPublicationId: index === 0 ? null : publication.id,
      previousPublication: index === 0 ? null : publication,
    }))
    const pointer = { publicationId: 'pub_1', revision: 1_000, publication }
    const loadActivationGraph = jest.fn(async () => {
      receipt.graphLoads += 1
      receipt.hydratedPublicationRows += activationEvents.reduce(
        (count, event) => count + 1 + (event.previousPublication === null ? 0 : 1),
        0,
      )
      return { pointer, activationEvents }
    })
    const proveActivationChain = jest.fn(() => {
      receipt.chainProofs += 1
      receipt.comparedSnapshotBytes += activationEvents.reduce(
        (bytes, event) =>
          bytes +
          Buffer.byteLength(JSON.stringify(event.publication.snapshot)) +
          (event.previousPublication === null ? 0 : Buffer.byteLength(JSON.stringify(event.previousPublication.snapshot))),
        0,
      )
      return { pointer, publications: [] }
    })
    const verifyClaimedRevision = jest.fn(() => {
      receipt.membershipChecks += 1
      return {
        publication,
        head: { publicationId: publication.id, schemaVersion: publication.schemaVersion, checksum: publication.checksum },
      }
    })
    const deliver = jest.fn()
    const acknowledge = jest.fn().mockResolvedValue(true)
    const service = createCommercialOutboxService({
      claim: jest.fn().mockResolvedValue(claimed),
      loadActivationGraph,
      proveActivationChain,
      verifyClaimedRevision,
      verifyPublication: jest.fn(),
      deliver,
      acknowledge,
      fail: jest.fn(),
      now: () => new Date('2026-08-21T12:00:00.000Z'),
    } as never)

    await expect(service.sweepOnce({ workerId: 'worker-batch', limit: 100 })).resolves.toEqual({
      claimed: 100,
      delivered: 100,
      failed: 0,
    })
    expect(loadActivationGraph).toHaveBeenCalledTimes(1)
    expect(proveActivationChain).toHaveBeenCalledTimes(1)
    expect(verifyClaimedRevision).toHaveBeenCalledTimes(100)
    expect(deliver).toHaveBeenCalledTimes(100)
    expect(acknowledge).toHaveBeenCalledTimes(100)
    expect(receipt).toEqual({
      graphLoads: 1,
      chainProofs: 1,
      membershipChecks: 100,
      hydratedPublicationRows: 1_999,
      comparedSnapshotBytes: 37_981,
    })
  })

  it('proves a historical claimed revision and invalidates with the current verified head', async () => {
    const historical = catalogV2Row('catalog-historical', '2026-08-20T12:00:00.000Z')
    const active = catalogV2Row('catalog-active', '2026-08-21T12:00:00.000Z')
    const first = activationOutboxRecord(1, historical, null)
    const second = activationOutboxRecord(2, active, historical)
    const claimed: ClaimedCommercialOutboxRow = {
      id: first.id,
      eventType: first.eventType,
      publicationId: first.publicationId,
      previousPublicationId: first.previousPublicationId,
      payloadVersion: first.payloadVersion,
      payload: first.payload,
      dedupeKey: first.dedupeKey,
      attempts: 1,
      claimExpiresAt: new Date('2026-08-27T12:01:00.000Z'),
    }
    const deliver = jest.fn()
    const acknowledge = jest.fn().mockResolvedValue(true)
    const service = createCommercialOutboxService({
      claim: jest.fn().mockResolvedValue([claimed]),
      loadActivationGraph: jest.fn().mockResolvedValue({
        pointer: {
          environment: 'PRODUCTION',
          publicationId: active.id,
          revision: 2,
          publication: active,
        },
        activationEvents: [second, first],
      }),
      verifyPublication: jest.fn(),
      deliver,
      acknowledge,
      fail: jest.fn(),
      now: () => new Date('2026-08-27T12:00:00.000Z'),
    })

    await expect(service.sweepOnce({ workerId: 'worker-history' })).resolves.toEqual({
      claimed: 1,
      delivered: 1,
      failed: 0,
    })
    expect(deliver).toHaveBeenCalledWith({
      event: expect.objectContaining({ publicationId: historical.id }),
      head: { publicationId: active.id, schemaVersion: 2, checksum: active.checksum },
    })
  })

  it('verifies and acknowledges PUBLICATION_CREATED with telemetry only, without active-state invalidation', async () => {
    const claimed = row({
      eventType: 'PUBLICATION_CREATED',
      payload: {
        eventId: 'activation:1:pub_1',
        type: 'PUBLICATION_CREATED',
        publicationId: 'pub_1',
        previousPublicationId: null,
        schemaVersion: 1,
        checksum: 'a'.repeat(64),
        occurredAt: '2026-08-21T12:00:00.000Z',
      },
    })
    const loadPublication = jest.fn().mockResolvedValue(publication)
    const verifyPublication = jest.fn()
    const deliver = jest.fn()
    const telemetry = jest.fn()
    const acknowledge = jest.fn().mockResolvedValue(true)
    const service = createCommercialOutboxService({
      claim: jest.fn().mockResolvedValue([claimed]),
      loadPublication,
      verifyPublication,
      deliver,
      telemetry,
      acknowledge,
      fail: jest.fn(),
      now: () => new Date('2026-08-21T12:00:00.000Z'),
    })

    await expect(service.sweepOnce({ workerId: 'worker-a' })).resolves.toEqual({ claimed: 1, delivered: 1, failed: 0 })

    expect(loadPublication).toHaveBeenCalledWith('pub_1')
    expect(verifyPublication).toHaveBeenCalledWith(publication)
    expect(telemetry).toHaveBeenCalledWith(expect.objectContaining({ type: 'PUBLICATION_CREATED', schemaVersion: 1 }))
    expect(deliver).not.toHaveBeenCalled()
    expect(acknowledge).toHaveBeenCalledTimes(1)
  })

  it('accepts document schema 2 independently of transport version 1 and verifies before invalidation and ACK', async () => {
    const claimed = row({
      payload: {
        eventId: 'activation:1:pub_1',
        type: 'PUBLICATION_ACTIVATED',
        publicationId: 'pub_1',
        previousPublicationId: null,
        schemaVersion: 2,
        checksum: 'b'.repeat(64),
        occurredAt: '2026-08-21T12:00:00.000Z',
      },
    })
    const publicationV2 = { ...publication, schemaVersion: 2, checksum: 'b'.repeat(64), snapshot: { schemaVersion: 2 } }
    const verifyPublication = jest.fn()
    const deliver = jest.fn()
    const acknowledge = jest.fn().mockResolvedValue(true)
    const service = createCommercialOutboxService({
      ...verifiedActivationAuthorityDependencies(publicationV2),
      claim: jest.fn().mockResolvedValue([claimed]),
      loadPublication: jest.fn().mockResolvedValue(publicationV2),
      verifyPublication,
      deliver,
      acknowledge,
      fail: jest.fn(),
      now: () => new Date('2026-08-21T12:00:00.000Z'),
    })

    await expect(service.sweepOnce({ workerId: 'worker-a' })).resolves.toEqual({ claimed: 1, delivered: 1, failed: 0 })

    expect(verifyPublication).toHaveBeenCalledWith(publicationV2)
    expect(verifyPublication.mock.invocationCallOrder[0]).toBeLessThan(deliver.mock.invocationCallOrder[0])
    expect(deliver.mock.invocationCallOrder[0]).toBeLessThan(acknowledge.mock.invocationCallOrder[0])
  })

  it('ACKs exact PUBLICATION_CREATED row-2/payload-2 and dead-letters row-2/payload-1', async () => {
    const publicationV2 = { ...publication, schemaVersion: 2, checksum: 'b'.repeat(64), snapshot: { schemaVersion: 2 } }
    const exact = row({
      eventType: 'PUBLICATION_CREATED',
      dedupeKey: 'commercial:publication:pub_1:created',
      payload: {
        eventId: 'commercial:publication:pub_1:created',
        type: 'PUBLICATION_CREATED',
        publicationId: 'pub_1',
        previousPublicationId: null,
        schemaVersion: 2,
        checksum: 'b'.repeat(64),
        occurredAt: '2026-08-21T12:00:00.000Z',
      },
    })
    const acknowledgeExact = jest.fn().mockResolvedValue(true)
    const exactService = createCommercialOutboxService({
      claim: jest.fn().mockResolvedValue([exact]),
      loadPublication: jest.fn().mockResolvedValue(publicationV2),
      verifyPublication: jest.fn(),
      deliver: jest.fn(),
      acknowledge: acknowledgeExact,
      fail: jest.fn(),
      now: () => new Date('2026-08-21T12:00:00.000Z'),
    })

    await expect(exactService.sweepOnce({ workerId: 'worker-a' })).resolves.toEqual({ claimed: 1, delivered: 1, failed: 0 })
    expect(acknowledgeExact).toHaveBeenCalledTimes(1)

    const mismatch = row({ eventType: 'PUBLICATION_CREATED' })
    const failMismatch = jest.fn()
    const acknowledgeMismatch = jest.fn()
    const mismatchService = createCommercialOutboxService({
      claim: jest.fn().mockResolvedValue([mismatch]),
      loadPublication: jest.fn().mockResolvedValue(publicationV2),
      verifyPublication: jest.fn(),
      deliver: jest.fn(),
      acknowledge: acknowledgeMismatch,
      fail: failMismatch,
      now: () => new Date('2026-08-21T12:00:00.000Z'),
    })

    await mismatchService.sweepOnce({ workerId: 'worker-b' })
    expect(acknowledgeMismatch).not.toHaveBeenCalled()
    expect(failMismatch).toHaveBeenCalledWith(
      mismatch,
      'worker-b',
      expect.objectContaining({ terminal: true, lastError: 'COMMERCIAL_OUTBOX_PAYLOAD_UNSUPPORTED' }),
    )
  })

  it.each([
    ['publication identity', { id: 'pub_other' }],
    ['document schema', { schemaVersion: 2 }],
    ['checksum', { checksum: 'b'.repeat(64) }],
  ] as const)('dead-letters a supported envelope/publication %s mismatch before invalidation or ACK', async (_case, mismatch) => {
    const claimed = row()
    const fail = jest.fn()
    const deliver = jest.fn()
    const acknowledge = jest.fn()
    const service = createCommercialOutboxService({
      ...verifiedActivationAuthorityDependencies({ ...publication, ...mismatch }),
      claim: jest.fn().mockResolvedValue([claimed]),
      loadPublication: jest.fn().mockResolvedValue({ ...publication, ...mismatch }),
      verifyPublication: jest.fn(),
      deliver,
      acknowledge,
      fail,
      now: () => new Date('2026-08-21T12:00:00.000Z'),
    })

    await service.sweepOnce({ workerId: 'worker-a' })

    expect(deliver).not.toHaveBeenCalled()
    expect(acknowledge).not.toHaveBeenCalled()
    expect(fail).toHaveBeenCalledWith(
      claimed,
      'worker-a',
      expect.objectContaining({ terminal: true, lastError: 'COMMERCIAL_OUTBOX_PAYLOAD_UNSUPPORTED' }),
    )
  })

  it('dead-letters a supported document rejected by registry verification before invalidation or ACK', async () => {
    const claimed = row()
    const fail = jest.fn()
    const deliver = jest.fn()
    const acknowledge = jest.fn()
    const service = createCommercialOutboxService({
      ...verifiedActivationAuthorityDependencies(publication),
      claim: jest.fn().mockResolvedValue([claimed]),
      loadPublication: jest.fn().mockResolvedValue(publication),
      verifyPublication: jest.fn(() => {
        throw new Error('COMMERCIAL_CATALOG_CHECKSUM_INVALID')
      }),
      deliver,
      acknowledge,
      fail,
      now: () => new Date('2026-08-21T12:00:00.000Z'),
    })

    await service.sweepOnce({ workerId: 'worker-a' })

    expect(deliver).not.toHaveBeenCalled()
    expect(acknowledge).not.toHaveBeenCalled()
    expect(fail).toHaveBeenCalledWith(
      claimed,
      'worker-a',
      expect.objectContaining({ terminal: true, lastError: 'COMMERCIAL_OUTBOX_PAYLOAD_UNSUPPORTED' }),
    )
  })

  it('alerts and retries a structurally valid future document schema instead of poisoning it immediately', async () => {
    const claimed = row({
      payload: {
        eventId: 'activation:1:pub_1',
        type: 'PUBLICATION_ACTIVATED',
        publicationId: 'pub_1',
        previousPublicationId: null,
        schemaVersion: 3,
        checksum: 'c'.repeat(64),
        occurredAt: '2026-08-21T12:00:00.000Z',
      },
    })
    const alertFutureSchema = jest.fn()
    const fail = jest.fn()
    const service = createCommercialOutboxService({
      ...verifiedActivationAuthorityDependencies(publication),
      claim: jest.fn().mockResolvedValue([claimed]),
      loadPublication: jest.fn(),
      verifyPublication: jest.fn(),
      deliver: jest.fn(),
      alertFutureSchema,
      acknowledge: jest.fn(),
      fail,
      now: () => new Date('2026-08-21T12:00:00.000Z'),
    })

    await service.sweepOnce({ workerId: 'worker-a' })

    expect(alertFutureSchema).toHaveBeenCalledWith(expect.objectContaining({ schemaVersion: 3 }))
    expect(fail).toHaveBeenCalledWith(
      claimed,
      'worker-a',
      expect.objectContaining({ terminal: false, lastError: 'COMMERCIAL_OUTBOX_SCHEMA_FUTURE' }),
    )
  })

  it.each(['PUBLICATION_ACTIVATED', 'PUBLICATION_ROLLED_BACK'] as const)(
    'delivers verified %s invalidation once and acknowledges the exact lease',
    async eventType => {
      const claimed = [
        row({
          eventType,
          payload: {
            eventId: 'activation:1:pub_1',
            type: eventType,
            publicationId: 'pub_1',
            previousPublicationId: null,
            schemaVersion: 1,
            checksum: 'a'.repeat(64),
            occurredAt: '2026-08-21T12:00:00.000Z',
          },
        }),
      ]
      const deliver = jest.fn().mockResolvedValue(undefined)
      const acknowledge = jest.fn().mockResolvedValue(true)
      const service = createCommercialOutboxService({
        ...verifiedPublicationDependencies(),
        claim: jest.fn().mockResolvedValueOnce(claimed).mockResolvedValue([]),
        deliver,
        acknowledge,
        fail: jest.fn(),
        now: () => new Date('2026-08-21T12:00:00.000Z'),
      })

      await expect(service.sweepOnce({ workerId: 'worker-a', limit: 10 })).resolves.toEqual({
        claimed: 1,
        delivered: 1,
        failed: 0,
      })
      await expect(service.sweepOnce({ workerId: 'worker-b', limit: 10 })).resolves.toEqual({
        claimed: 0,
        delivered: 0,
        failed: 0,
      })
      expect(deliver).toHaveBeenCalledTimes(1)
      expect(acknowledge).toHaveBeenCalledWith(claimed[0], 'worker-a', expect.any(Date))
    },
  )

  it('backs off a transient failure and does not acknowledge it', async () => {
    const claimed = row({ attempts: 2 })
    const fail = jest.fn().mockResolvedValue(undefined)
    const service = createCommercialOutboxService({
      ...verifiedPublicationDependencies(),
      claim: jest.fn().mockResolvedValue([claimed]),
      deliver: jest.fn().mockRejectedValue(new Error('socket temporarily unavailable')),
      acknowledge: jest.fn(),
      fail,
      now: () => new Date('2026-08-21T12:00:00.000Z'),
    })

    await expect(service.sweepOnce({ workerId: 'worker-a', limit: 10 })).resolves.toEqual({
      claimed: 1,
      delivered: 0,
      failed: 1,
    })
    expect(fail).toHaveBeenCalledWith(
      claimed,
      'worker-a',
      expect.objectContaining({
        terminal: false,
        nextAttemptAt: new Date('2026-08-21T12:00:04.000Z'),
        lastError: 'COMMERCIAL_OUTBOX_DELIVERY_FAILED',
      }),
    )
  })

  it('counts a lost ACK lease as failed without attempting to persist failure through the lost lease', async () => {
    const claimed = row()
    const deliver = jest.fn().mockResolvedValue(undefined)
    const acknowledge = jest.fn().mockResolvedValue(false)
    const fail = jest.fn()
    const service = createCommercialOutboxService({
      ...verifiedPublicationDependencies(),
      claim: jest.fn().mockResolvedValue([claimed]),
      deliver,
      acknowledge,
      fail,
      now: () => new Date('2026-08-21T12:00:00.000Z'),
    })

    await expect(service.sweepOnce({ workerId: 'worker-lost' })).resolves.toEqual({
      claimed: 1,
      delivered: 0,
      failed: 1,
    })
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(fail).not.toHaveBeenCalled()
  })

  it('retries a verified schema-2 future contract with a stable contract code', async () => {
    const claimed = row({
      payload: {
        eventId: 'activation:1:pub_1',
        type: 'PUBLICATION_ACTIVATED',
        publicationId: 'pub_1',
        previousPublicationId: null,
        schemaVersion: 2,
        checksum: 'b'.repeat(64),
        occurredAt: '2026-08-21T12:00:00.000Z',
      },
    })
    const futurePublication = { ...publication, schemaVersion: 2, checksum: 'b'.repeat(64) }
    const fail = jest.fn()
    const service = createCommercialOutboxService({
      ...verifiedActivationAuthorityDependencies(futurePublication),
      claim: jest.fn().mockResolvedValue([claimed]),
      verifyPublication: jest.fn(() => {
        throw new CommercialArtifactCodecError('COMMERCIAL_CATALOG_CONTRACT_UNSUPPORTED')
      }),
      verifyFuturePublication: jest.fn(),
      deliver: jest.fn(),
      acknowledge: jest.fn(),
      fail,
      now: () => new Date('2026-08-21T12:00:00.000Z'),
    })

    await expect(service.sweepOnce({ workerId: 'worker-future-contract' })).resolves.toEqual({
      claimed: 1,
      delivered: 0,
      failed: 1,
    })
    expect(fail).toHaveBeenCalledWith(
      claimed,
      'worker-future-contract',
      expect.objectContaining({ terminal: false, lastError: 'COMMERCIAL_OUTBOX_CONTRACT_FUTURE' }),
    )
  })

  it('dead-letters a noncurrent contract row that fails the future-row identity proof', async () => {
    const claimed = row({
      payload: {
        eventId: 'activation:1:pub_1',
        type: 'PUBLICATION_ACTIVATED',
        publicationId: 'pub_1',
        previousPublicationId: null,
        schemaVersion: 2,
        checksum: 'b'.repeat(64),
        occurredAt: '2026-08-21T12:00:00.000Z',
      },
    })
    const futurePublication = { ...publication, schemaVersion: 2, checksum: 'b'.repeat(64) }
    const fail = jest.fn()
    const deliver = jest.fn()
    const acknowledge = jest.fn()
    const service = createCommercialOutboxService({
      ...verifiedActivationAuthorityDependencies(futurePublication),
      claim: jest.fn().mockResolvedValue([claimed]),
      verifyPublication: jest.fn(() => {
        throw new CommercialArtifactCodecError('COMMERCIAL_CATALOG_CONTRACT_UNSUPPORTED')
      }),
      verifyFuturePublication: jest.fn(() => {
        throw new CommercialArtifactCodecError('COMMERCIAL_CATALOG_CHECKSUM_INVALID')
      }),
      deliver,
      acknowledge,
      fail,
      now: () => new Date('2026-08-21T12:00:00.000Z'),
    } as never)

    await expect(service.sweepOnce({ workerId: 'worker-future-poison' })).resolves.toEqual({
      claimed: 1,
      delivered: 0,
      failed: 1,
    })
    expect(deliver).not.toHaveBeenCalled()
    expect(acknowledge).not.toHaveBeenCalled()
    expect(fail).toHaveBeenCalledWith(
      claimed,
      'worker-future-poison',
      expect.objectContaining({ terminal: true, lastError: 'COMMERCIAL_OUTBOX_PAYLOAD_UNSUPPORTED' }),
    )
  })

  it('dead-letters unsupported poison payloads without invoking delivery', async () => {
    const claimed = row({ payload: { arbitrary: 'internal-data' } })
    const deliver = jest.fn()
    const fail = jest.fn().mockResolvedValue(undefined)
    const service = createCommercialOutboxService({
      ...verifiedActivationAuthorityDependencies(publication),
      claim: jest.fn().mockResolvedValue([claimed]),
      deliver,
      acknowledge: jest.fn(),
      fail,
      now: () => new Date('2026-08-21T12:00:00.000Z'),
    })

    await service.sweepOnce({ workerId: 'worker-a', limit: 10 })

    expect(deliver).not.toHaveBeenCalled()
    expect(fail).toHaveBeenCalledWith(claimed, 'worker-a', expect.objectContaining({ terminal: true }))
  })

  it('bounds the claim limit before handing it to the SKIP LOCKED adapter', async () => {
    const claim = jest.fn().mockResolvedValue([])
    const service = createCommercialOutboxService({
      claim,
      deliver: jest.fn(),
      acknowledge: jest.fn(),
      fail: jest.fn(),
      now: () => new Date('2026-08-21T12:00:00.000Z'),
    })

    await service.sweepOnce({ workerId: 'worker-a', limit: 50_000 })
    expect(claim).toHaveBeenCalledWith('worker-a', 100, new Date('2026-08-21T12:00:00.000Z'), expect.any(Date))
  })
})
