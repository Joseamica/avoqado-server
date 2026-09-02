import catalogV1Fixture from '@/contracts/commercial/fixtures/catalog-v1.json'
import catalogV2Fixture from '@/contracts/commercial/fixtures/v2/catalog-base.json'
import { COMMERCIAL_V2_DOMAINS } from '@/contracts/commercial/commercialContractV2.constants'
import { hashCanonicalJsonV2 } from '@/services/commercial/commercialCanonicalJsonV2.service'
import { hashCanonicalJsonV1 } from '@/services/master-catalog/catalogHash.service'
import { CommercialCatalogFallbackError, resolvePublicCommercialCatalog } from '@/services/commercial/commercialCatalogFallback.service'
import { CommercialArtifactCodecError } from '@/services/commercial/commercialArtifactCodecRegistry.service'
import type {
  CommercialCatalogActivationOutboxRecord,
  CommercialCatalogPersistedRow,
  CommercialCatalogResolutionInput,
} from '@/types/commercialCodec'
import type { CommercialCatalogSnapshotV1 } from '@/types/commercial'
import type { CommercialCatalogSnapshotV2 } from '@/types/commercialV2'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function catalogRow(version: 1 | 2, publicationId: string, publishedAt: string, contractVersion = '2.0.0'): CommercialCatalogPersistedRow {
  if (version === 1) {
    const snapshot = clone(catalogV1Fixture) as CommercialCatalogSnapshotV1
    snapshot.publicationId = publicationId
    snapshot.publishedAt = publishedAt
    return {
      id: publicationId,
      schemaVersion: 1,
      snapshot,
      checksum: hashCanonicalJsonV1('commercial-catalog-snapshot-v1', snapshot),
      publishedAt: new Date(publishedAt),
    }
  }
  const snapshot = clone(catalogV2Fixture) as CommercialCatalogSnapshotV2
  snapshot.publicationId = publicationId
  snapshot.publishedAt = publishedAt
  snapshot.contractVersion = contractVersion as '2.0.0'
  return {
    id: publicationId,
    schemaVersion: 2,
    snapshot,
    checksum: hashCanonicalJsonV2(COMMERCIAL_V2_DOMAINS.CATALOG_SNAPSHOT, snapshot),
    publishedAt: new Date(publishedAt),
  }
}

function event(
  revision: number,
  publication: CommercialCatalogPersistedRow,
  previousPublication: CommercialCatalogPersistedRow | null,
): CommercialCatalogActivationOutboxRecord {
  const eventType = 'PUBLICATION_ACTIVATED' as const
  const dedupeKey = `commercial:activation:${revision}:${publication.id}`
  return {
    id: `event-${revision}`,
    eventType,
    publicationId: publication.id,
    previousPublicationId: previousPublication?.id ?? null,
    payloadVersion: 1,
    payload: {
      eventId: dedupeKey,
      type: eventType,
      publicationId: publication.id,
      previousPublicationId: previousPublication?.id ?? null,
      schemaVersion: publication.schemaVersion,
      checksum: publication.checksum,
      occurredAt: new Date(2026, 7, 20 + revision).toISOString(),
    },
    dedupeKey,
    createdAt: new Date(2026, 7, 20 + revision),
    publication,
    previousPublication,
  }
}

function input(
  activePublication: CommercialCatalogPersistedRow,
  revision: number,
  activationEvents: readonly CommercialCatalogActivationOutboxRecord[],
  environment: 'PRODUCTION' | 'PREVIEW' = 'PRODUCTION',
): CommercialCatalogResolutionInput {
  return {
    activePointer: { environment, publicationId: activePublication.id, revision },
    activePublication,
    activationEvents,
  }
}

function expectCode(operation: () => unknown, code: string): void {
  try {
    operation()
    throw new Error('Expected commercial fallback error')
  } catch (error) {
    expect(error).toBeInstanceOf(Error)
    expect(error).toMatchObject({ code })
    expect((error as Error).message).not.toContain('caller-secret')
  }
}

describe('public commercial catalog fallback resolution', () => {
  it('serves a supported active catalog without observing activation events', () => {
    const active = catalogRow(2, 'catalog-active', '2026-08-24T06:00:00.000Z')
    let observations = 0
    const activationEvents = new Proxy([], {
      get() {
        observations += 1
        throw new Error('caller-secret')
      },
      ownKeys() {
        observations += 1
        throw new Error('caller-secret')
      },
    })

    const result = resolvePublicCommercialCatalog(input(active, 9, activationEvents))

    expect(result.catalog).toMatchObject({ kind: 'CATALOG', schemaVersion: 2, mode: 'READ_WRITE' })
    expect(result.fallback).toBeNull()
    expect(observations).toBe(0)
  })

  it('walks a proven revision chain and serves the first v2/2.0 predecessor', () => {
    const oldest = catalogRow(2, 'catalog-compatible', '2026-08-20T06:00:00.000Z')
    const v1 = catalogRow(1, 'catalog-v1', '2026-08-21T06:00:00.000Z')
    const future = catalogRow(2, 'catalog-future-mid', '2026-08-22T06:00:00.000Z', '3.1.0')
    const active = catalogRow(2, 'catalog-future-active', '2026-08-23T06:00:00.000Z', '4.0.0')
    const events = [event(4, active, future), event(2, v1, oldest), event(1, oldest, null), event(3, future, v1)]

    const result = resolvePublicCommercialCatalog(input(active, 4, events))

    expect((result.catalog.snapshot as CommercialCatalogSnapshotV2).publicationId).toBe(oldest.id)
    expect(result.fallback).toEqual({
      fallbackUsed: true,
      activePublicationId: active.id,
      fallbackPublicationId: oldest.id,
      incidentCode: 'COMMERCIAL_CATALOG_CONTRACT_UNSUPPORTED',
    })
    expect(Object.keys(result.fallback!)).toEqual(['fallbackUsed', 'activePublicationId', 'fallbackPublicationId', 'incidentCode'])
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.fallback)).toBe(true)
    expect(Object.isFrozen(result.catalog.snapshot)).toBe(true)
    ;(oldest.snapshot as Record<string, unknown>).publicationId = 'mutated-after-resolution'
    expect((result.catalog.snapshot as CommercialCatalogSnapshotV2).publicationId).toBe('catalog-compatible')
  })

  it('never serves v1 and returns contract unsupported when no compatible predecessor exists', () => {
    const v1 = catalogRow(1, 'catalog-v1', '2026-08-21T06:00:00.000Z')
    const active = catalogRow(2, 'catalog-future', '2026-08-22T06:00:00.000Z', '3.0.0')
    expectCode(
      () => resolvePublicCommercialCatalog(input(active, 2, [event(1, v1, null), event(2, active, v1)])),
      'COMMERCIAL_CATALOG_CONTRACT_UNSUPPORTED',
    )
  })

  it('never falls back in preview and does not observe its events', () => {
    const active = catalogRow(2, 'catalog-future', '2026-08-22T06:00:00.000Z', '3.0.0')
    let observations = 0
    const activationEvents = new Proxy([], {
      get() {
        observations += 1
        throw new Error('caller-secret')
      },
    })
    expectCode(
      () => resolvePublicCommercialCatalog(input(active, 1, activationEvents, 'PREVIEW')),
      'COMMERCIAL_CATALOG_CONTRACT_UNSUPPORTED',
    )
    expect(observations).toBe(0)
  })

  it('accepts future-only extra fields while known 2.0 remains strict', () => {
    const compatible = catalogRow(2, 'catalog-compatible', '2026-08-20T06:00:00.000Z')
    const active = catalogRow(2, 'catalog-future', '2026-08-21T06:00:00.000Z', '3.0.0')
    ;(active.snapshot as Record<string, unknown>).futureOnly = { enabled: true }
    active.checksum = hashCanonicalJsonV2(COMMERCIAL_V2_DOMAINS.CATALOG_SNAPSHOT, active.snapshot)
    expect(resolvePublicCommercialCatalog(input(active, 2, [event(1, compatible, null), event(2, active, compatible)]))).toMatchObject({
      fallback: { fallbackUsed: true, fallbackPublicationId: compatible.id },
    })

    const strict = catalogRow(2, 'catalog-strict', '2026-08-22T06:00:00.000Z')
    ;(strict.snapshot as Record<string, unknown>).futureOnly = true
    strict.checksum = hashCanonicalJsonV2(COMMERCIAL_V2_DOMAINS.CATALOG_SNAPSHOT, strict.snapshot)
    expectCode(() => resolvePublicCommercialCatalog(input(strict, 1, [])), 'COMMERCIAL_CATALOG_SHAPE_INVALID')
  })

  it.each([
    ['checksum', (row: CommercialCatalogPersistedRow) => (row.checksum = '0'.repeat(64)), 'COMMERCIAL_CATALOG_CHECKSUM_INVALID'],
    ['identity', (row: CommercialCatalogPersistedRow) => (row.id = 'wrong-row-id'), 'COMMERCIAL_CATALOG_IDENTITY_MISMATCH'],
    [
      'envelope',
      (row: CommercialCatalogPersistedRow) => delete (row.snapshot as Record<string, unknown>).contractVersion,
      'COMMERCIAL_CATALOG_SHAPE_INVALID',
    ],
  ])('does not fall back when a future active %s is corrupt', (_case, mutate, code) => {
    const compatible = catalogRow(2, 'catalog-compatible', '2026-08-20T06:00:00.000Z')
    const active = catalogRow(2, 'catalog-future', '2026-08-21T06:00:00.000Z', '3.0.0')
    mutate(active)
    expectCode(() => resolvePublicCommercialCatalog(input(active, 2, [event(1, compatible, null), event(2, active, compatible)])), code)
  })

  it('does not observe events for an unknown active row schema', () => {
    const active = catalogRow(2, 'catalog-unknown', '2026-08-21T06:00:00.000Z')
    active.schemaVersion = 99
    let observations = 0
    const events = new Proxy([], {
      get() {
        observations += 1
        throw new Error('caller-secret')
      },
    })
    expectCode(() => resolvePublicCommercialCatalog(input(active, 1, events)), 'COMMERCIAL_CATALOG_SCHEMA_UNSUPPORTED')
    expect(observations).toBe(0)
  })

  it('exports no campaign or quote fallback and exposes a dedicated provenance error', () => {
    const module = require('@/services/commercial/commercialCatalogFallback.service') as Record<string, unknown>
    expect(module.resolvePublicCommercialCampaign).toBeUndefined()
    expect(module.resolvePublicCommercialQuote).toBeUndefined()
    expect(new CommercialCatalogFallbackError('COMMERCIAL_CATALOG_FALLBACK_PROVENANCE_INVALID')).toMatchObject({
      code: 'COMMERCIAL_CATALOG_FALLBACK_PROVENANCE_INVALID',
    })
    expect(CommercialArtifactCodecError).toBeDefined()
  })
})
