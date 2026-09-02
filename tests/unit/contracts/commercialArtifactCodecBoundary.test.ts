import catalogV1 from '@/contracts/commercial/fixtures/catalog-v1.json'
import campaignV1 from '@/contracts/commercial/fixtures/campaign-pos-50-v1.json'
import catalogV2 from '@/contracts/commercial/fixtures/v2/catalog-base.json'
import {
  CommercialArtifactCodecError,
  decodeAndVerifyCommercialArtifact,
  emitCommercialArtifact,
} from '@/services/commercial/commercialArtifactCodecRegistry.service'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function catalogRow(snapshot: { publicationId: string; publishedAt: string; schemaVersion: number }) {
  return {
    kind: 'CATALOG' as const,
    id: snapshot.publicationId,
    schemaVersion: snapshot.schemaVersion,
    publishedAt: new Date(snapshot.publishedAt),
  }
}

function expectCodecError(operation: () => unknown, code: string): void {
  try {
    operation()
    throw new Error('Expected codec error')
  } catch (error) {
    expect(error).toBeInstanceOf(CommercialArtifactCodecError)
    expect(error).toMatchObject({ code })
    expect((error as Error).message).not.toContain('caller-secret')
  }
}

describe('commercial artifact codec input boundary', () => {
  it('rejects an unknown trusted row schema before observing snapshot or row context', () => {
    let observations = 0
    const input: Record<string, unknown> = { kind: 'CATALOG', rowSchemaVersion: 99 }
    for (const key of ['snapshot', 'checksum', 'rowContext']) {
      Object.defineProperty(input, key, {
        enumerable: true,
        get() {
          observations += 1
          throw new Error('caller-secret')
        },
      })
    }

    expectCodecError(() => decodeAndVerifyCommercialArtifact(input as never), 'COMMERCIAL_CATALOG_SCHEMA_UNSUPPORTED')
    expect(observations).toBe(0)
  })

  it('rejects proxy and accessor envelopes without leaking caller exceptions', () => {
    const proxied = new Proxy(
      {},
      {
        get() {
          throw new Error('caller-secret')
        },
      },
    )
    expectCodecError(() => decodeAndVerifyCommercialArtifact(proxied as never), 'COMMERCIAL_ARTIFACT_ENVELOPE_INVALID')

    const accessor = Object.defineProperty({}, 'kind', {
      enumerable: true,
      get() {
        throw new Error('caller-secret')
      },
    })
    expectCodecError(() => decodeAndVerifyCommercialArtifact(accessor as never), 'COMMERCIAL_ARTIFACT_ENVELOPE_INVALID')
  })

  it('rejects an own-data unknown kind without observing the payload', () => {
    let observed = false
    const input = Object.defineProperties(
      { kind: 'ENTITLEMENTS', rowSchemaVersion: 2 },
      {
        snapshot: {
          enumerable: true,
          get() {
            observed = true
            throw new Error('caller-secret')
          },
        },
      },
    )
    expectCodecError(() => decodeAndVerifyCommercialArtifact(input as never), 'COMMERCIAL_ARTIFACT_KIND_UNSUPPORTED')
    expect(observed).toBe(false)
  })

  it('classifies a known-schema payload accessor as an invalid envelope without invoking it', () => {
    let observed = false
    const input = Object.defineProperties(
      { kind: 'CATALOG', rowSchemaVersion: 1 },
      {
        snapshot: {
          enumerable: true,
          get() {
            observed = true
            throw new Error('caller-secret')
          },
        },
        checksum: { enumerable: true, value: '0'.repeat(64) },
        rowContext: { enumerable: true, value: catalogRow(catalogV1) },
      },
    )
    expectCodecError(() => decodeAndVerifyCommercialArtifact(input as never), 'COMMERCIAL_ARTIFACT_ENVELOPE_INVALID')
    expect(observed).toBe(false)
  })

  it.each([
    ['null root', null],
    ['primitive root', 'not-an-artifact'],
    ['array root', []],
    [
      'proxy',
      new Proxy(
        {},
        {
          ownKeys() {
            throw new Error('caller-secret')
          },
        },
      ),
    ],
    ['exotic prototype', Object.create({ inherited: true })],
    ['toJSON', { schemaVersion: 1, toJSON: () => ({}) }],
    ['sparse array', { schemaVersion: 1, products: new Array(1), bundles: [] }],
    ['accessor', Object.defineProperty({ schemaVersion: 1 }, 'products', { enumerable: true, get: () => [] })],
  ])('maps a hostile %s snapshot to a stable shape error', (_label, snapshot) => {
    expectCodecError(
      () =>
        decodeAndVerifyCommercialArtifact({
          kind: 'CATALOG',
          rowSchemaVersion: 1,
          snapshot,
          checksum: '0'.repeat(64),
          rowContext: catalogRow(catalogV1),
        }),
      'COMMERCIAL_CATALOG_SHAPE_INVALID',
    )
  })

  it('rejects a cyclic snapshot with the same stable shape error', () => {
    const snapshot: Record<string, unknown> = { schemaVersion: 1 }
    snapshot.self = snapshot
    expectCodecError(
      () =>
        decodeAndVerifyCommercialArtifact({
          kind: 'CATALOG',
          rowSchemaVersion: 1,
          snapshot,
          checksum: '0'.repeat(64),
          rowContext: catalogRow(catalogV1),
        }),
      'COMMERCIAL_CATALOG_SHAPE_INVALID',
    )
  })

  it('distinguishes snapshot schema identity from an unsupported v2 contract', () => {
    const schemaMismatch = clone(catalogV2) as Record<string, unknown>
    schemaMismatch.schemaVersion = 1
    expectCodecError(
      () =>
        decodeAndVerifyCommercialArtifact({
          kind: 'CATALOG',
          rowSchemaVersion: 2,
          snapshot: schemaMismatch,
          checksum: '0'.repeat(64),
          rowContext: catalogRow(catalogV2),
        }),
      'COMMERCIAL_CATALOG_IDENTITY_MISMATCH',
    )

    const future = clone(catalogV2) as Record<string, unknown>
    future.contractVersion = '2.1.0'
    expectCodecError(
      () =>
        decodeAndVerifyCommercialArtifact({
          kind: 'CATALOG',
          rowSchemaVersion: 2,
          snapshot: future,
          checksum: '0'.repeat(64),
          rowContext: catalogRow(catalogV2),
        }),
      'COMMERCIAL_CATALOG_CONTRACT_UNSUPPORTED',
    )
  })

  it.each(['0'.repeat(63), 'A'.repeat(64), '1'.repeat(64)])('rejects malformed or incorrect checksum %s', checksum => {
    expectCodecError(
      () =>
        decodeAndVerifyCommercialArtifact({
          kind: 'CATALOG',
          rowSchemaVersion: 1,
          snapshot: catalogV1,
          checksum,
          rowContext: catalogRow(catalogV1),
        }),
      'COMMERCIAL_CATALOG_CHECKSUM_INVALID',
    )
  })

  it('disables runtime v1 emission before observing its domain value or authorities', () => {
    let observed = false
    const input = Object.defineProperties(
      { kind: 'QUOTE', schemaVersion: 1 },
      {
        domainValue: {
          enumerable: true,
          get() {
            observed = true
            throw new Error('caller-secret')
          },
        },
        authorities: {
          enumerable: true,
          get() {
            observed = true
            throw new Error('caller-secret')
          },
        },
      },
    )
    expectCodecError(() => emitCommercialArtifact(input as never), 'COMMERCIAL_V1_EMISSION_DISABLED')
    expect(observed).toBe(false)
  })

  it('keeps catalog and campaign decode inputs authority-free', () => {
    const catalog = {
      kind: 'CATALOG' as const,
      rowSchemaVersion: 1,
      snapshot: catalogV1,
      checksum: '679a2b2e15a7e1340afd6d7f561daec5e247180d855afa56f1efc2dbae7bb42e',
      rowContext: catalogRow(catalogV1),
      authorities: {},
    }
    expectCodecError(() => decodeAndVerifyCommercialArtifact(catalog as never), 'COMMERCIAL_CATALOG_SHAPE_INVALID')

    const campaign = {
      kind: 'CAMPAIGN' as const,
      rowSchemaVersion: 1,
      snapshot: campaignV1,
      checksum: '4736788b4d87426d8fe8656e03a8dfee56fa5c2ff3d4cc7fafb95992d0305b84',
      rowContext: {
        kind: 'CAMPAIGN' as const,
        id: campaignV1.campaignVersionId,
        campaignCode: campaignV1.campaignCode,
        sourceRevision: campaignV1.version,
        schemaVersion: 1,
        publishedAt: new Date('2026-07-31T06:00:00.000Z'),
      },
      authorities: {},
    }
    expectCodecError(() => decodeAndVerifyCommercialArtifact(campaign as never), 'COMMERCIAL_CAMPAIGN_SHAPE_INVALID')
  })

  it('rejects a proxy row context without invoking its traps', () => {
    let observed = false
    const rowContext = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          observed = true
          throw new Error('caller-secret')
        },
      },
    )
    expectCodecError(
      () =>
        decodeAndVerifyCommercialArtifact({
          kind: 'CATALOG',
          rowSchemaVersion: 1,
          snapshot: catalogV1,
          checksum: '679a2b2e15a7e1340afd6d7f561daec5e247180d855afa56f1efc2dbae7bb42e',
          rowContext: rowContext as never,
        }),
      'COMMERCIAL_CATALOG_IDENTITY_MISMATCH',
    )
    expect(observed).toBe(false)
  })
})
