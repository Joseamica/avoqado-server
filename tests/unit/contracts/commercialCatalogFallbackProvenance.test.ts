import catalogV1Fixture from '@/contracts/commercial/fixtures/catalog-v1.json'
import catalogV2Fixture from '@/contracts/commercial/fixtures/v2/catalog-base.json'
import { COMMERCIAL_V2_DOMAINS } from '@/contracts/commercial/commercialContractV2.constants'
import { hashCanonicalJsonV2 } from '@/services/commercial/commercialCanonicalJsonV2.service'
import { hashCanonicalJsonV1 } from '@/services/master-catalog/catalogHash.service'
import { resolvePublicCommercialCatalog } from '@/services/commercial/commercialCatalogFallback.service'
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

function row(version: 1 | 2, id: string, day: number, contractVersion = '2.0.0'): CommercialCatalogPersistedRow {
  const publishedAt = `2026-08-${String(day).padStart(2, '0')}T06:00:00.000Z`
  if (version === 1) {
    const snapshot = clone(catalogV1Fixture) as CommercialCatalogSnapshotV1
    snapshot.publicationId = id
    snapshot.publishedAt = publishedAt
    return {
      id,
      schemaVersion: 1,
      snapshot,
      checksum: hashCanonicalJsonV1('commercial-catalog-snapshot-v1', snapshot),
      publishedAt: new Date(publishedAt),
    }
  }
  const snapshot = clone(catalogV2Fixture) as CommercialCatalogSnapshotV2
  snapshot.publicationId = id
  snapshot.publishedAt = publishedAt
  snapshot.contractVersion = contractVersion as '2.0.0'
  return {
    id,
    schemaVersion: 2,
    snapshot,
    checksum: hashCanonicalJsonV2(COMMERCIAL_V2_DOMAINS.CATALOG_SNAPSHOT, snapshot),
    publishedAt: new Date(publishedAt),
  }
}

function activation(
  revision: number,
  publication: CommercialCatalogPersistedRow,
  previousPublication: CommercialCatalogPersistedRow | null,
): CommercialCatalogActivationOutboxRecord {
  const eventType = revision % 2 === 0 ? ('PUBLICATION_ROLLED_BACK' as const) : ('PUBLICATION_ACTIVATED' as const)
  const dedupeKey = `commercial:activation:${revision}:${publication.id}`
  return {
    id: `activation-${revision}`,
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
      occurredAt: `2026-08-${String(10 + revision).padStart(2, '0')}T12:00:00.000Z`,
    },
    dedupeKey,
    createdAt: new Date(`2026-08-${String(10 + revision).padStart(2, '0')}T12:00:00.000Z`),
    publication,
    previousPublication,
  }
}

function chain() {
  const compatible = row(2, 'compatible', 20)
  const middle = row(2, 'future-middle', 21, '3.0.0')
  const active = row(2, 'future-active', 22, '4.0.0')
  return {
    compatible,
    middle,
    active,
    events: [activation(1, compatible, null), activation(2, middle, compatible), activation(3, active, middle)],
  }
}

function input(
  activePublication: CommercialCatalogPersistedRow,
  revision: number,
  activationEvents: readonly CommercialCatalogActivationOutboxRecord[],
): CommercialCatalogResolutionInput {
  return {
    activePointer: { environment: 'PRODUCTION', publicationId: activePublication.id, revision },
    activePublication,
    activationEvents,
  }
}

function codeOf(operation: () => unknown): string {
  try {
    operation()
    return 'NO_ERROR'
  } catch (error) {
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).not.toContain('caller-secret')
    return (error as { code?: string }).code ?? 'NO_CODE'
  }
}

describe('commercial catalog fallback provenance', () => {
  it.each([
    ['environment', (value: CommercialCatalogResolutionInput) => ((value.activePointer as { environment: string }).environment = 'TEST')],
    ['zero revision', (value: CommercialCatalogResolutionInput) => (value.activePointer.revision = 0)],
    ['fractional revision', (value: CommercialCatalogResolutionInput) => (value.activePointer.revision = 1.5)],
    ['publication mismatch', (value: CommercialCatalogResolutionInput) => (value.activePointer.publicationId = 'different')],
  ])('rejects invalid pointer %s before fallback', (_case, mutate) => {
    const value = chain()
    const request = input(value.active, 3, value.events)
    mutate(request)
    expect(codeOf(() => resolvePublicCommercialCatalog(request))).toBe('COMMERCIAL_CATALOG_FALLBACK_PROVENANCE_INVALID')
  })

  it('rejects an unsafe pointer revision even when the active catalog is supported', () => {
    const supported = row(2, 'supported', 20)
    const request = input(supported, Number.MAX_SAFE_INTEGER + 1, new Proxy([], {}))
    expect(codeOf(() => resolvePublicCommercialCatalog(request))).toBe('COMMERCIAL_CATALOG_FALLBACK_PROVENANCE_INVALID')
  })

  it.each([
    ['missing revision', (events: CommercialCatalogActivationOutboxRecord[]) => events.splice(1, 1)],
    ['duplicate revision', (events: CommercialCatalogActivationOutboxRecord[]) => (events[1] = { ...events[0], id: 'duplicate' })],
    ['false dedupe', (events: CommercialCatalogActivationOutboxRecord[]) => (events[1].dedupeKey = 'commercial:activation:2:other')],
    ['payload version', (events: CommercialCatalogActivationOutboxRecord[]) => (events[1].payloadVersion = 2)],
    [
      'payload event id',
      (events: CommercialCatalogActivationOutboxRecord[]) => ((events[1].payload as Record<string, unknown>).eventId = 'false'),
    ],
    [
      'payload publication',
      (events: CommercialCatalogActivationOutboxRecord[]) => ((events[1].payload as Record<string, unknown>).publicationId = 'false'),
    ],
    [
      'payload checksum',
      (events: CommercialCatalogActivationOutboxRecord[]) => ((events[1].payload as Record<string, unknown>).checksum = '0'.repeat(64)),
    ],
    [
      'payload extra field',
      (events: CommercialCatalogActivationOutboxRecord[]) => ((events[1].payload as Record<string, unknown>).extra = true),
    ],
    ['join id', (events: CommercialCatalogActivationOutboxRecord[]) => (events[1].previousPublicationId = 'false')],
    ['broken chain', (events: CommercialCatalogActivationOutboxRecord[]) => (events[2].previousPublication = events[0].publication)],
    [
      'head mismatch',
      (events: CommercialCatalogActivationOutboxRecord[]) =>
        (events[2].publication = { ...events[2].publication, checksum: '0'.repeat(64) }),
    ],
    ['duplicate outbox id', (events: CommercialCatalogActivationOutboxRecord[]) => (events[1].id = events[0].id)],
    [
      'impossible occurredAt date',
      (events: CommercialCatalogActivationOutboxRecord[]) =>
        ((events[1].payload as Record<string, unknown>).occurredAt = '2026-02-31T12:00:00.000Z'),
    ],
  ])('rejects %s instead of guessing history', (_case, mutate) => {
    const value = chain()
    mutate(value.events)
    expect(codeOf(() => resolvePublicCommercialCatalog(input(value.active, 3, value.events)))).toBe(
      'COMMERCIAL_CATALOG_FALLBACK_PROVENANCE_INVALID',
    )
  })

  it('rejects a full-relation join whose snapshot differs despite matching row metadata', () => {
    const value = chain()
    const forgedRelation = clone(value.compatible.snapshot) as CommercialCatalogSnapshotV2
    forgedRelation.publicationId = 'forged-inside-relation'
    value.events[1].previousPublication = { ...value.compatible, snapshot: forgedRelation }

    expect(codeOf(() => resolvePublicCommercialCatalog(input(value.active, 3, value.events)))).toBe(
      'COMMERCIAL_CATALOG_FALLBACK_PROVENANCE_INVALID',
    )
  })

  it('rejects a divergent unknown-schema join before reporting the predecessor schema', () => {
    const value = chain()
    value.middle.schemaVersion = 7
    value.events[1] = activation(2, value.middle, value.compatible)
    value.events[2] = activation(3, value.active, value.middle)
    const forged = clone(value.middle.snapshot) as Record<string, unknown>
    forged.publicationId = 'different-unknown-relation'
    value.events[2].previousPublication = { ...value.middle, snapshot: forged }

    expect(codeOf(() => resolvePublicCommercialCatalog(input(value.active, 3, value.events)))).toBe(
      'COMMERCIAL_CATALOG_FALLBACK_PROVENANCE_INVALID',
    )
  })

  it.each([
    [
      'checksum',
      (candidate: CommercialCatalogPersistedRow) => (candidate.checksum = '0'.repeat(64)),
      'COMMERCIAL_CATALOG_CHECKSUM_INVALID',
    ],
    [
      'shape',
      (candidate: CommercialCatalogPersistedRow) => {
        ;(candidate.snapshot as Record<string, unknown>).contractVersion = '2.0.0'
        delete (candidate.snapshot as Record<string, unknown>).products
        candidate.checksum = hashCanonicalJsonV2(COMMERCIAL_V2_DOMAINS.CATALOG_SNAPSHOT, candidate.snapshot)
      },
      'COMMERCIAL_CATALOG_SHAPE_INVALID',
    ],
    [
      'unknown schema',
      (candidate: CommercialCatalogPersistedRow) => (candidate.schemaVersion = 7),
      'COMMERCIAL_CATALOG_SCHEMA_UNSUPPORTED',
    ],
  ])('stops at a corrupt predecessor %s and propagates its visible code', (_case, mutate, expected) => {
    const value = chain()
    mutate(value.middle)
    value.events[1] = activation(2, value.middle, value.compatible)
    value.events[2] = activation(3, value.active, value.middle)
    expect(codeOf(() => resolvePublicCommercialCatalog(input(value.active, 3, value.events)))).toBe(expected)
  })

  it('stops at the first compatible predecessor without classifying older artifacts', () => {
    const corruptOldest = row(2, 'old-corrupt', 19)
    corruptOldest.schemaVersion = 99
    const compatible = row(2, 'closest-compatible', 20)
    const active = row(2, 'future-active', 21, '3.0.0')
    const events = [activation(1, corruptOldest, null), activation(2, compatible, corruptOldest), activation(3, active, compatible)]
    expect(resolvePublicCommercialCatalog(input(active, 3, events)).fallback).toMatchObject({
      fallbackPublicationId: compatible.id,
    })
  })

  it('allows extra fields on a future predecessor but rejects them on a known predecessor', () => {
    const oldest = row(2, 'old-compatible', 19)
    const future = row(2, 'future-middle', 20, '3.0.0')
    ;(future.snapshot as Record<string, unknown>).futureField = { value: 1 }
    future.checksum = hashCanonicalJsonV2(COMMERCIAL_V2_DOMAINS.CATALOG_SNAPSHOT, future.snapshot)
    const active = row(2, 'future-active', 21, '4.0.0')
    expect(
      resolvePublicCommercialCatalog(
        input(active, 3, [activation(1, oldest, null), activation(2, future, oldest), activation(3, active, future)]),
      ).fallback,
    ).toMatchObject({ fallbackPublicationId: oldest.id })

    const knownExtra = row(2, 'known-extra', 20)
    ;(knownExtra.snapshot as Record<string, unknown>).futureField = true
    knownExtra.checksum = hashCanonicalJsonV2(COMMERCIAL_V2_DOMAINS.CATALOG_SNAPSHOT, knownExtra.snapshot)
    expect(
      codeOf(() => resolvePublicCommercialCatalog(input(active, 2, [activation(1, knownExtra, null), activation(2, active, knownExtra)]))),
    ).toBe('COMMERCIAL_CATALOG_SHAPE_INVALID')
  })

  it('does not execute supported-path activationEvents or cache-like accessors', () => {
    const active = row(2, 'supported', 20)
    let callbacks = 0
    const request = {
      activePointer: { environment: 'PRODUCTION', publicationId: active.id, revision: 1 },
      activePublication: active,
      get activationEvents() {
        callbacks += 1
        throw new Error('caller-secret')
      },
      get cache() {
        callbacks += 1
        throw new Error('caller-secret')
      },
    }
    expect(resolvePublicCommercialCatalog(request as never).fallback).toBeNull()
    expect(callbacks).toBe(0)
  })

  it('ignores a hostile cache accessor while a future active exhausts the chain without a candidate', () => {
    const historical = row(1, 'historical-v1', 19)
    const active = row(2, 'future-without-candidate', 20, '3.0.0')
    let callbacks = 0
    const request = {
      activePointer: { environment: 'PRODUCTION', publicationId: active.id, revision: 2 },
      activePublication: active,
      activationEvents: [activation(1, historical, null), activation(2, active, historical)],
      get cache() {
        callbacks += 1
        throw new Error('caller-secret')
      },
    }

    expect(codeOf(() => resolvePublicCommercialCatalog(request as never))).toBe('COMMERCIAL_CATALOG_CONTRACT_UNSUPPORTED')
    expect(callbacks).toBe(0)
  })

  it('rejects PUBLICATION_CREATED even when the event and payload types agree at runtime', () => {
    const value = chain()
    ;(value.events[1] as unknown as { eventType: string }).eventType = 'PUBLICATION_CREATED'
    ;(value.events[1].payload as Record<string, unknown>).type = 'PUBLICATION_CREATED'

    expect(codeOf(() => resolvePublicCommercialCatalog(input(value.active, 3, value.events)))).toBe(
      'COMMERCIAL_CATALOG_FALLBACK_PROVENANCE_INVALID',
    )
  })

  it.each(['2025-02-29T12:00:00.000Z', '2026-04-31T12:00:00.000Z'])('rejects non-canonical calendar timestamp %s', occurredAt => {
    const value = chain()
    ;(value.events[1].payload as Record<string, unknown>).occurredAt = occurredAt
    expect(codeOf(() => resolvePublicCommercialCatalog(input(value.active, 3, value.events)))).toBe(
      'COMMERCIAL_CATALOG_FALLBACK_PROVENANCE_INVALID',
    )
  })

  it('accepts leap-day occurredAt when its ISO round-trip is exact', () => {
    const value = chain()
    ;(value.events[1].payload as Record<string, unknown>).occurredAt = '2024-02-29T12:00:00.000Z'
    expect(resolvePublicCommercialCatalog(input(value.active, 3, value.events)).fallback).toMatchObject({ fallbackUsed: true })
  })

  it('verifies a future PREVIEW active before returning contract unsupported and never reads history', () => {
    const active = row(2, 'preview-future', 20, '3.0.0')
    active.checksum = '0'.repeat(64)
    let callbacks = 0
    const request = {
      activePointer: { environment: 'PREVIEW', publicationId: active.id, revision: 1 },
      activePublication: active,
      get activationEvents() {
        callbacks += 1
        throw new Error('caller-secret')
      },
    }
    expect(codeOf(() => resolvePublicCommercialCatalog(request as never))).toBe('COMMERCIAL_CATALOG_CHECKSUM_INVALID')
    expect(callbacks).toBe(0)
  })

  it.each(['id', 'createdAt', 'payload'])('rejects event %s accessors without executing them', key => {
    const value = chain()
    let callbacks = 0
    Object.defineProperty(value.events[1], key, {
      enumerable: true,
      get() {
        callbacks += 1
        throw new Error('caller-secret')
      },
    })
    expect(codeOf(() => resolvePublicCommercialCatalog(input(value.active, 3, value.events)))).toBe(
      'COMMERCIAL_CATALOG_FALLBACK_PROVENANCE_INVALID',
    )
    expect(callbacks).toBe(0)
  })

  it('rejects a future snapshot getter without executing it', () => {
    const value = chain()
    let callbacks = 0
    Object.defineProperty(value.active.snapshot as object, 'contractVersion', {
      enumerable: true,
      get() {
        callbacks += 1
        throw new Error('caller-secret')
      },
    })
    expect(codeOf(() => resolvePublicCommercialCatalog(input(value.active, 3, value.events)))).toBe('COMMERCIAL_CATALOG_SHAPE_INVALID')
    expect(callbacks).toBe(0)
  })

  it('captures Date construction and ISO serialization before callers can replace the primordials', () => {
    const value = chain()
    const originalDate = Date
    const originalToISOString = Date.prototype.toISOString
    let callbacks = 0
    const hostileDate = new Proxy(originalDate, {
      construct() {
        callbacks += 1
        throw new Error('caller-secret')
      },
    })
    ;(globalThis as { Date: DateConstructor }).Date = hostileDate
    Date.prototype.toISOString = () => {
      callbacks += 1
      throw new Error('caller-secret')
    }
    try {
      expect(resolvePublicCommercialCatalog(input(value.active, 3, value.events)).fallback).toMatchObject({ fallbackUsed: true })
      expect(callbacks).toBe(0)
    } finally {
      ;(globalThis as { Date: DateConstructor }).Date = originalDate
      originalDate.prototype.toISOString = originalToISOString
    }
  })
})
