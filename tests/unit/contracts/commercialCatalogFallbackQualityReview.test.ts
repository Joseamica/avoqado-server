import catalogV1Fixture from '@/contracts/commercial/fixtures/catalog-v1.json'
import catalogV2Fixture from '@/contracts/commercial/fixtures/v2/catalog-base.json'
import {
  COMMERCIAL_JSON_TEXT_V2_MAX_BYTES,
  COMMERCIAL_JSON_TEXT_V2_MAX_DEPTH,
  COMMERCIAL_V2_DOMAINS,
} from '@/contracts/commercial/commercialContractV2.constants'
import { hashCanonicalJsonV2 } from '@/services/commercial/commercialCanonicalJsonV2.service'
import { resolvePublicCommercialCatalog } from '@/services/commercial/commercialCatalogFallback.service'
import { proveCatalogActivationChain } from '@/services/commercial/commercialCatalogFallbackProvenance.service'
import { hashCanonicalJsonV1 } from '@/services/master-catalog/catalogHash.service'
import type { CommercialCatalogActivationOutboxRecord, CommercialCatalogPersistedRow } from '@/types/commercialCodec'
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
  const eventType = 'PUBLICATION_ACTIVATED' as const
  const dedupeKey = `commercial:activation:${revision}:${publication.id}`
  return {
    id: `quality-event-${revision}`,
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

function request(active: CommercialCatalogPersistedRow, events: CommercialCatalogActivationOutboxRecord[]) {
  return {
    activePointer: { environment: 'PRODUCTION' as const, publicationId: active.id, revision: events.length },
    activePublication: active,
    activationEvents: events,
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

function unknownRow(id: string, snapshot: unknown): CommercialCatalogPersistedRow {
  return {
    id,
    schemaVersion: 99,
    snapshot,
    checksum: 'a'.repeat(64),
    publishedAt: new Date('2026-08-20T06:00:00.000Z'),
  }
}

function wideUnknownRow(id: string, targetBytes: number): CommercialCatalogPersistedRow {
  const snapshot: Record<string, unknown> = {}
  for (let index = 0; index < 50_000; index += 1) snapshot[`field${String(index).padStart(5, '0')}`] = ''
  snapshot.padding = ''
  const baseBytes = Buffer.byteLength(JSON.stringify(snapshot), 'utf8')
  expect(baseBytes).toBeLessThan(targetBytes)
  snapshot.padding = 'x'.repeat(targetBytes - baseBytes)
  expect(Buffer.byteLength(JSON.stringify(snapshot), 'utf8')).toBe(targetBytes)
  return unknownRow(id, snapshot)
}

function nestedJson(depth: number): Record<string, unknown> {
  const root: Record<string, unknown> = {}
  let cursor = root
  for (let index = 0; index < depth - 1; index += 1) {
    const next: Record<string, unknown> = {}
    cursor.child = next
    cursor = next
  }
  cursor.value = true
  return root
}

describe('commercial catalog fallback quality review', () => {
  it('does not dispatch through mutable Array, Map, Set, WeakSet, Object, Reflect, RegExp, JSON or Buffer primordials', () => {
    const compatible = row(2, 'quality-compatible', 19)
    const active = row(2, 'quality-active', 20, '3.0.0')
    const events = [activation(1, compatible, null), activation(2, active, compatible)]
    const targets: Array<[object, PropertyKey]> = [
      [Array.prototype, 'map'],
      [Array.prototype, 'some'],
      [Array.prototype, 'every'],
      [Array.prototype, 'includes'],
      [Array.prototype, 'push'],
      [Map.prototype, 'has'],
      [Map.prototype, 'get'],
      [Map.prototype, 'set'],
      [Set.prototype, 'has'],
      [Set.prototype, 'add'],
      [WeakSet.prototype, 'has'],
      [WeakSet.prototype, 'add'],
      [Object, 'getOwnPropertyDescriptor'],
      [Object, 'getPrototypeOf'],
      [Object, 'is'],
      [Object, 'freeze'],
      [Reflect, 'ownKeys'],
      [Array, 'isArray'],
      [Number, 'isInteger'],
      [Number, 'isSafeInteger'],
      [RegExp.prototype, 'exec'],
      [JSON, 'stringify'],
      [Buffer, 'byteLength'],
    ]
    const descriptors = targets.map(([owner, key]) => Object.getOwnPropertyDescriptor(owner, key))
    const defineProperty = Object.defineProperty
    let callbacks = 0
    let result: readonly CommercialCatalogPersistedRow[] | undefined
    let thrown: unknown
    try {
      for (const [owner, key] of targets) {
        defineProperty(owner, key, {
          configurable: true,
          get() {
            callbacks += 1
            throw new Error('caller-secret')
          },
        })
      }
      try {
        result = proveCatalogActivationChain({ activePublication: active, pointerRevision: 2, activationEvents: events })
      } catch (error) {
        thrown = error
      }
    } finally {
      for (let index = 0; index < targets.length; index += 1) {
        defineProperty(targets[index][0], targets[index][1], descriptors[index] as PropertyDescriptor)
      }
    }
    expect(thrown).toBeUndefined()
    expect(result).toHaveLength(2)
    expect(callbacks).toBe(0)
  })

  it('does not dispatch through an inherited numeric Array setter while proving the chain', () => {
    const compatible = row(2, 'numeric-setter-compatible', 19)
    const active = row(2, 'numeric-setter-active', 20, '3.0.0')
    const events = [activation(1, compatible, null), activation(2, active, compatible)]
    const defineProperty = Object.defineProperty
    const priorDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, '0')
    let callbacks = 0
    let result: readonly CommercialCatalogPersistedRow[] | undefined
    let thrown: unknown
    try {
      defineProperty(Array.prototype, '0', {
        configurable: true,
        set() {
          callbacks += 1
          throw new Error('caller-secret')
        },
      })
      try {
        result = proveCatalogActivationChain({ activePublication: active, pointerRevision: 2, activationEvents: events })
      } catch (error) {
        thrown = error
      }
    } finally {
      if (priorDescriptor) defineProperty(Array.prototype, '0', priorDescriptor)
      else delete (Array.prototype as unknown as Record<string, unknown>)['0']
    }
    expect(thrown).toBeUndefined()
    expect(result).toHaveLength(2)
    expect(callbacks).toBe(0)
  })

  it('rejects a huge sparse event list before allocating a dense copy', () => {
    const active = row(2, 'huge-sparse-active', 20, '3.0.0')
    const sparseEvents = new Array(4_000_000_000)

    expect(
      codeOf(() =>
        proveCatalogActivationChain({
          activePublication: active,
          pointerRevision: sparseEvents.length,
          activationEvents: sparseEvents,
        }),
      ),
    ).toBe('COMMERCIAL_CATALOG_FALLBACK_PROVENANCE_INVALID')
  })

  it.each([
    ['BigInt', BigInt.prototype, 1n],
    ['Function', Function.prototype, function sharedSnapshotFunction() {}],
  ] as const)('rejects non-JSON %s evidence without consulting a post-import toJSON', (_label, prototype, primitive) => {
    const defineProperty = Object.defineProperty
    const priorDescriptor = Object.getOwnPropertyDescriptor(prototype, 'toJSON')
    const predecessor = unknownRow('non-json-predecessor', { value: primitive })
    const relation = { ...predecessor, snapshot: { value: primitive } }
    const active = row(2, 'non-json-active', 20, '3.0.0')
    const events = [activation(1, predecessor, null), activation(2, active, relation)]
    let callbacks = 0
    let resultCode = 'NO_ERROR'
    try {
      defineProperty(prototype, 'toJSON', {
        configurable: true,
        value() {
          callbacks += 1
          return 'caller-controlled'
        },
      })
      resultCode = codeOf(() => resolvePublicCommercialCatalog(request(active, events)))
    } finally {
      if (priorDescriptor) defineProperty(prototype, 'toJSON', priorDescriptor)
      else delete (prototype as { toJSON?: unknown }).toJSON
    }

    expect(resultCode).toBe('COMMERCIAL_CATALOG_FALLBACK_PROVENANCE_INVALID')
    expect(callbacks).toBe(0)
  })

  it('allows a rollback to the same immutable publication ID when all evidence and snapshot data are exact', () => {
    const original = row(2, 'immutable-rollback-publication', 18)
    const middle = row(2, 'immutable-rollback-middle', 19, '3.0.0')
    const rollback: CommercialCatalogPersistedRow = {
      ...original,
      snapshot: clone(original.snapshot),
      publishedAt: new Date(original.publishedAt),
    }
    const events = [activation(1, original, null), activation(2, middle, original), activation(3, rollback, middle)]

    const proven = proveCatalogActivationChain({ activePublication: rollback, pointerRevision: 3, activationEvents: events })

    expect([proven[0].id, proven[1].id, proven[2].id]).toEqual([original.id, middle.id, original.id])
  })

  it.each([
    [
      'snapshot',
      (value: CommercialCatalogPersistedRow) => {
        ;(value.snapshot as Record<string, unknown>).divergent = true
      },
    ],
    ['checksum', (value: CommercialCatalogPersistedRow): void => void (value.checksum = '0'.repeat(64))],
    ['schemaVersion', (value: CommercialCatalogPersistedRow): void => void (value.schemaVersion = 7)],
    ['publishedAt', (value: CommercialCatalogPersistedRow): void => void (value.publishedAt = new Date('2026-08-21T06:00:00.000Z'))],
  ] as const)('rejects a non-adjacent repeated publication ID with divergent %s evidence', (_field, mutate) => {
    const original = row(2, 'immutable-divergent-publication', 18)
    const middle = row(2, 'immutable-divergent-middle', 19, '3.0.0')
    const repeated: CommercialCatalogPersistedRow = {
      ...original,
      snapshot: clone(original.snapshot),
      publishedAt: new Date(original.publishedAt),
    }
    mutate(repeated)
    const events = [activation(1, original, null), activation(2, middle, original), activation(3, repeated, middle)]

    expect(codeOf(() => proveCatalogActivationChain({ activePublication: repeated, pointerRevision: 3, activationEvents: events }))).toBe(
      'COMMERCIAL_CATALOG_FALLBACK_PROVENANCE_INVALID',
    )
  })

  it('never returns public fallback metadata with one ID representing divergent active and fallback artifacts', () => {
    const compatible = row(2, 'immutable-public-result', 18)
    const middle = row(2, 'immutable-public-middle', 19, '3.0.0')
    const active = row(2, compatible.id, 20, '4.0.0')
    const events = [activation(1, compatible, null), activation(2, middle, compatible), activation(3, active, middle)]

    expect(codeOf(() => resolvePublicCommercialCatalog(request(active, events)))).toBe('COMMERCIAL_CATALOG_FALLBACK_PROVENANCE_INVALID')
  })

  it('bounds unknown 50k-key evidence at one MiB with linear near/over behavior', () => {
    const active = row(2, 'wide-active', 21, '3.0.0')
    const near = wideUnknownRow('wide-near', COMMERCIAL_JSON_TEXT_V2_MAX_BYTES)
    expect(codeOf(() => resolvePublicCommercialCatalog(request(active, [activation(1, near, null), activation(2, active, near)])))).toBe(
      'COMMERCIAL_CATALOG_SCHEMA_UNSUPPORTED',
    )

    const over = wideUnknownRow('wide-over', COMMERCIAL_JSON_TEXT_V2_MAX_BYTES + 1)
    expect(codeOf(() => resolvePublicCommercialCatalog(request(active, [activation(1, over, null), activation(2, active, over)])))).toBe(
      'COMMERCIAL_CATALOG_FALLBACK_PROVENANCE_INVALID',
    )
  })

  it('accepts bounded depth 128 and rejects depth 129 before unknown-schema classification', () => {
    const active = row(2, 'depth-active', 21, '3.0.0')
    const atLimit = unknownRow('depth-128', nestedJson(COMMERCIAL_JSON_TEXT_V2_MAX_DEPTH))
    expect(
      codeOf(() => resolvePublicCommercialCatalog(request(active, [activation(1, atLimit, null), activation(2, active, atLimit)]))),
    ).toBe('COMMERCIAL_CATALOG_SCHEMA_UNSUPPORTED')

    const overLimit = unknownRow('depth-129', nestedJson(COMMERCIAL_JSON_TEXT_V2_MAX_DEPTH + 1))
    expect(
      codeOf(() => resolvePublicCommercialCatalog(request(active, [activation(1, overLimit, null), activation(2, active, overLimit)]))),
    ).toBe('COMMERCIAL_CATALOG_FALLBACK_PROVENANCE_INVALID')
  })

  it('bounds schema-2 future predecessor evidence and still traverses a near-limit multi-revision chain', () => {
    const compatible = row(2, 'future-budget-compatible', 18)
    const near = row(2, 'future-budget-near', 19, '3.0.0')
    ;(near.snapshot as Record<string, unknown>).padding = 'x'.repeat(900_000)
    near.checksum = hashCanonicalJsonV2(COMMERCIAL_V2_DOMAINS.CATALOG_SNAPSHOT, near.snapshot)
    const active = row(2, 'future-budget-active', 20, '4.0.0')
    expect(
      resolvePublicCommercialCatalog(
        request(active, [activation(1, compatible, null), activation(2, near, compatible), activation(3, active, near)]),
      ).fallback,
    ).toMatchObject({ fallbackPublicationId: compatible.id })

    const over = row(2, 'future-budget-over', 19, '3.0.0')
    ;(over.snapshot as Record<string, unknown>).padding = 'x'.repeat(COMMERCIAL_JSON_TEXT_V2_MAX_BYTES)
    over.checksum = hashCanonicalJsonV2(COMMERCIAL_V2_DOMAINS.CATALOG_SNAPSHOT, over.snapshot)
    expect(codeOf(() => resolvePublicCommercialCatalog(request(active, [activation(1, over, null), activation(2, active, over)])))).toBe(
      'COMMERCIAL_CATALOG_FALLBACK_PROVENANCE_INVALID',
    )
  })

  it('keeps a valid v1 predecessor larger than one MiB traversable without a new evidence cap', () => {
    const historical = row(1, 'legacy-large', 19)
    const snapshot = historical.snapshot as CommercialCatalogSnapshotV1
    snapshot.products = Array.from({ length: 4_000 }, () => clone(snapshot.products[0]))
    historical.checksum = hashCanonicalJsonV1('commercial-catalog-snapshot-v1', snapshot)
    expect(Buffer.byteLength(JSON.stringify(snapshot), 'utf8')).toBeGreaterThan(COMMERCIAL_JSON_TEXT_V2_MAX_BYTES)
    const active = row(2, 'legacy-large-active', 20, '3.0.0')

    expect(
      codeOf(() => resolvePublicCommercialCatalog(request(active, [activation(1, historical, null), activation(2, active, historical)]))),
    ).toBe('COMMERCIAL_CATALOG_CONTRACT_UNSUPPORTED')
  })
})
