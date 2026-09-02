import { types as utilTypes } from 'node:util'
import catalogV1Fixture from '@/contracts/commercial/fixtures/catalog-v1.json'
import campaignV1Fixture from '@/contracts/commercial/fixtures/campaign-pos-50-v1.json'
import quoteV1Fixture from '@/contracts/commercial/fixtures/quote-pos-50-v1.json'
import catalogV2Fixture from '@/contracts/commercial/fixtures/v2/catalog-base.json'
import { COMMERCIAL_V2_DOMAINS } from '@/contracts/commercial/commercialContractV2.constants'
import { hashCanonicalJsonV1 } from '@/services/master-catalog/catalogHash.service'
import { hashCanonicalJsonV2 } from '@/services/commercial/commercialCanonicalJsonV2.service'
import { materializeCommercialContractV2Json } from '@/services/commercial/commercialContractV2Materialization.service'
import { toValidIso } from '@/services/commercial/commercialArtifactCodecBoundary.service'
import {
  CommercialArtifactCodecError,
  decodeAndVerifyCommercialArtifact,
  emitCommercialArtifact,
} from '@/services/commercial/commercialArtifactCodecRegistry.service'
import type { CommercialCatalogSnapshotV1 } from '@/types/commercial'
import type { CommercialCampaignVersionV1, CommercialQuoteV1 } from '@/types/commercialQuote'
import type { CommercialCatalogSnapshotV2 } from '@/types/commercialV2'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function expectCode(operation: () => unknown, code: string): void {
  try {
    operation()
    throw new Error('Expected codec error')
  } catch (error) {
    expect(error).toBeInstanceOf(CommercialArtifactCodecError)
    expect(error).toMatchObject({ code })
  }
}

function catalogV1Input(snapshot: CommercialCatalogSnapshotV1 = clone(catalogV1Fixture) as CommercialCatalogSnapshotV1) {
  return {
    kind: 'CATALOG' as const,
    rowSchemaVersion: 1,
    snapshot,
    checksum: hashCanonicalJsonV1('commercial-catalog-snapshot-v1', snapshot),
    rowContext: {
      kind: 'CATALOG' as const,
      id: snapshot.publicationId,
      schemaVersion: 1,
      publishedAt: new Date(snapshot.publishedAt),
    },
  }
}

function catalogV2Input(snapshot: CommercialCatalogSnapshotV2 = clone(catalogV2Fixture) as CommercialCatalogSnapshotV2) {
  return {
    kind: 'CATALOG' as const,
    rowSchemaVersion: 2,
    snapshot,
    checksum: hashCanonicalJsonV2(COMMERCIAL_V2_DOMAINS.CATALOG_SNAPSHOT, snapshot),
    rowContext: {
      kind: 'CATALOG' as const,
      id: snapshot.publicationId,
      schemaVersion: 2,
      publishedAt: new Date(snapshot.publishedAt),
    },
  }
}

function campaignV1Input(snapshot: CommercialCampaignVersionV1 = clone(campaignV1Fixture) as CommercialCampaignVersionV1) {
  return {
    kind: 'CAMPAIGN' as const,
    rowSchemaVersion: 1,
    snapshot,
    checksum: hashCanonicalJsonV1('commercial-campaign-snapshot-v1', snapshot),
    rowContext: {
      kind: 'CAMPAIGN' as const,
      id: snapshot.campaignVersionId,
      campaignCode: snapshot.campaignCode,
      sourceRevision: snapshot.version,
      schemaVersion: 1,
      publishedAt: new Date('2026-07-31T06:00:00.000Z'),
    },
  }
}

function quoteV1Input() {
  const snapshot = clone(quoteV1Fixture) as CommercialQuoteV1
  const catalog = clone(catalogV1Fixture) as CommercialCatalogSnapshotV1
  catalog.publicationId = snapshot.catalogPublicationId
  return {
    kind: 'QUOTE' as const,
    rowSchemaVersion: 1,
    snapshot,
    checksum: hashCanonicalJsonV1('commercial-quote-v1', snapshot),
    rowContext: {
      kind: 'QUOTE' as const,
      id: snapshot.quoteId,
      catalogPublicationId: snapshot.catalogPublicationId,
      campaignVersionId: snapshot.campaignVersionId,
      acquisitionContextId: null,
      organizationId: 'organization-v1',
      venueId: 'venue-v1',
      createdById: 'staff-v1',
      schemaVersion: 1,
      market: snapshot.market,
      currency: snapshot.currency,
      quotedAt: new Date(snapshot.quotedAt),
      expiresAt: new Date(snapshot.expiresAt),
      listSubtotalMinor: snapshot.totals.listSubtotalMinor,
      discountMinor: snapshot.totals.discountMinor,
      subtotalMinor: snapshot.totals.subtotalMinor,
      taxMinor: snapshot.totals.taxMinor,
      totalMinor: snapshot.totals.totalMinor,
      renewalSubtotalMinor: snapshot.renewal.subtotalMinor,
      renewalTaxMinor: snapshot.renewal.taxMinor,
      renewalTotalMinor: snapshot.renewal.totalMinor,
      venueOrganizationId: 'organization-v1',
    },
    authorities: { catalog: catalogV1Input(catalog), campaign: campaignV1Input() },
  }
}

describe('commercial artifact codec review remediation boundary', () => {
  it.each([
    ['CATALOG', 'COMMERCIAL_CATALOG_SCHEMA_UNSUPPORTED'],
    ['CAMPAIGN', 'COMMERCIAL_CAMPAIGN_SCHEMA_UNSUPPORTED'],
    ['QUOTE', 'COMMERCIAL_QUOTE_SCHEMA_UNSUPPORTED'],
  ])('uses the trusted %s kind when row schema is missing or invalid', (kind, code) => {
    expectCode(() => decodeAndVerifyCommercialArtifact({ kind } as never), code)
    expectCode(() => decodeAndVerifyCommercialArtifact({ kind, rowSchemaVersion: '2' } as never), code)
  })

  it.each([
    ['CATALOG', 'COMMERCIAL_CATALOG_SCHEMA_UNSUPPORTED'],
    ['CAMPAIGN', 'COMMERCIAL_CAMPAIGN_SCHEMA_UNSUPPORTED'],
    ['QUOTE', 'COMMERCIAL_QUOTE_SCHEMA_UNSUPPORTED'],
  ])('distinguishes absent/invalid %s schemas from unsafe decode descriptors', (kind, code) => {
    expectCode(() => decodeAndVerifyCommercialArtifact({ kind } as never), code)
    expectCode(() => decodeAndVerifyCommercialArtifact({ kind, rowSchemaVersion: 2.5 } as never), code)

    let reads = 0
    const accessor = { kind }
    Object.defineProperty(accessor, 'rowSchemaVersion', {
      enumerable: true,
      get() {
        reads += 1
        throw new Error('caller-secret')
      },
    })
    expectCode(() => decodeAndVerifyCommercialArtifact(accessor as never), 'COMMERCIAL_ARTIFACT_ENVELOPE_INVALID')
    expect(reads).toBe(0)

    const hidden = { kind }
    Object.defineProperty(hidden, 'rowSchemaVersion', { enumerable: false, value: 2 })
    expectCode(() => decodeAndVerifyCommercialArtifact(hidden as never), 'COMMERCIAL_ARTIFACT_ENVELOPE_INVALID')
  })

  it.each([
    ['CATALOG', 'COMMERCIAL_CATALOG_SCHEMA_UNSUPPORTED'],
    ['CAMPAIGN', 'COMMERCIAL_CAMPAIGN_SCHEMA_UNSUPPORTED'],
    ['QUOTE', 'COMMERCIAL_QUOTE_SCHEMA_UNSUPPORTED'],
  ])('distinguishes absent/invalid %s schemas from unsafe emit descriptors', (kind, code) => {
    expectCode(() => emitCommercialArtifact({ kind } as never), code)
    expectCode(() => emitCommercialArtifact({ kind, schemaVersion: 2.5 } as never), code)

    let reads = 0
    const accessor = { kind }
    Object.defineProperty(accessor, 'schemaVersion', {
      enumerable: true,
      get() {
        reads += 1
        throw new Error('caller-secret')
      },
    })
    expectCode(() => emitCommercialArtifact(accessor as never), 'COMMERCIAL_ARTIFACT_ENVELOPE_INVALID')
    expect(reads).toBe(0)

    const hidden = { kind }
    Object.defineProperty(hidden, 'schemaVersion', { enumerable: false, value: 2 })
    expectCode(() => emitCommercialArtifact(hidden as never), 'COMMERCIAL_ARTIFACT_ENVELOPE_INVALID')
  })

  it('rejects an unknown kind before consulting a missing row schema', () => {
    expectCode(() => decodeAndVerifyCommercialArtifact({ kind: 'ENTITLEMENTS' } as never), 'COMMERCIAL_ARTIFACT_KIND_UNSUPPORTED')
  })

  it('maps missing, malformed, uppercase and different checksums for every persisted kind', () => {
    for (const [inputFactory, code] of [
      [() => catalogV1Input(), 'COMMERCIAL_CATALOG_CHECKSUM_INVALID'],
      [() => campaignV1Input(), 'COMMERCIAL_CAMPAIGN_CHECKSUM_INVALID'],
      [() => quoteV1Input(), 'COMMERCIAL_QUOTE_CHECKSUM_INVALID'],
    ] as const) {
      for (const checksum of [undefined, '0'.repeat(63), 'A'.repeat(64), '1'.repeat(64)]) {
        const input = inputFactory() as unknown as Record<string, unknown>
        if (checksum === undefined) delete input.checksum
        else input.checksum = checksum
        expectCode(() => decodeAndVerifyCommercialArtifact(input as never), code)
      }
    }
  })

  it('rejects accessor, symbol and non-enumerable extra envelope properties', () => {
    let reads = 0
    const accessor = catalogV1Input() as object
    Object.defineProperty(accessor, 'extra', {
      enumerable: true,
      get() {
        reads += 1
        throw new Error('caller-secret')
      },
    })
    expectCode(() => decodeAndVerifyCommercialArtifact(accessor as never), 'COMMERCIAL_ARTIFACT_ENVELOPE_INVALID')
    expect(reads).toBe(0)

    const symbolic = catalogV1Input() as Record<PropertyKey, unknown>
    symbolic[Symbol('extra')] = true
    expectCode(() => decodeAndVerifyCommercialArtifact(symbolic as never), 'COMMERCIAL_ARTIFACT_ENVELOPE_INVALID')

    const hidden = catalogV1Input() as object
    Object.defineProperty(hidden, 'extra', { enumerable: false, value: true })
    expectCode(() => decodeAndVerifyCommercialArtifact(hidden as never), 'COMMERCIAL_ARTIFACT_ENVELOPE_INVALID')
  })

  it('rejects custom array prototypes in both versioned materializers', () => {
    const v1 = clone(catalogV1Fixture) as CommercialCatalogSnapshotV1
    Object.setPrototypeOf(v1.products[0].prices, Object.create(Array.prototype))
    expectCode(() => decodeAndVerifyCommercialArtifact(catalogV1Input(v1)), 'COMMERCIAL_CATALOG_SHAPE_INVALID')

    const v2 = clone(catalogV2Fixture) as CommercialCatalogSnapshotV2
    Object.setPrototypeOf(v2.products[0].prices, Object.create(Array.prototype))
    expectCode(() => decodeAndVerifyCommercialArtifact(catalogV2Input(v2)), 'COMMERCIAL_CATALOG_SHAPE_INVALID')
  })

  it('rejects repeated object identities instead of expanding a DAG', () => {
    const shared = { nested: ['small'] }
    expect(() => materializeCommercialContractV2Json({ left: shared, right: shared })).toThrow('COMMERCIAL_CONTRACT_V2_NON_MATERIALIZED')

    const v1 = clone(catalogV1Fixture) as CommercialCatalogSnapshotV1
    v1.products[1].capabilityCodes = v1.products[0].capabilityCodes
    expectCode(() => decodeAndVerifyCommercialArtifact(catalogV1Input(v1)), 'COMMERCIAL_CATALOG_SHAPE_INVALID')
  })

  it('requires plain row and authority containers', () => {
    const catalog = catalogV1Input()
    catalog.rowContext = Object.assign(Object.create({ inherited: true }), catalog.rowContext)
    expectCode(() => decodeAndVerifyCommercialArtifact(catalog), 'COMMERCIAL_CATALOG_IDENTITY_MISMATCH')

    const quote = quoteV1Input()
    quote.authorities = Object.assign(Object.create({ inherited: true }), quote.authorities)
    expectCode(() => decodeAndVerifyCommercialArtifact(quote), 'COMMERCIAL_QUOTE_SHAPE_INVALID')
  })

  it('preserves the exact v2 depth and byte limits at the graph boundary', () => {
    let accepted: unknown = null
    for (let depth = 0; depth < 128; depth += 1) accepted = { nested: accepted }
    expect(() => materializeCommercialContractV2Json(accepted)).not.toThrow()

    const rejected = { nested: accepted }
    expect(() => materializeCommercialContractV2Json(rejected)).toThrow('COMMERCIAL_CONTRACT_V2_NON_MATERIALIZED')
    expect(() => materializeCommercialContractV2Json({ large: 'x'.repeat(1_048_576 - 12) })).not.toThrow()
    expect(() => materializeCommercialContractV2Json({ large: 'x'.repeat(1_048_576 - 11) })).toThrow(
      'COMMERCIAL_CONTRACT_V2_NON_MATERIALIZED',
    )
    for (const twoByteJsonCharacter of ['é', '"']) {
      expect(() => materializeCommercialContractV2Json({ large: twoByteJsonCharacter.repeat((1_048_576 - 12) / 2) })).not.toThrow()
      expect(() => materializeCommercialContractV2Json({ large: twoByteJsonCharacter.repeat((1_048_576 - 12) / 2 + 1) })).toThrow(
        'COMMERCIAL_CONTRACT_V2_NON_MATERIALIZED',
      )
    }
    expect(() => materializeCommercialContractV2Json({ value: '\ud800' })).toThrow('COMMERCIAL_CONTRACT_V2_NON_MATERIALIZED')
  })

  it('materializes an intact v2 snapshot without consulting inherited Array.prototype.toJSON', () => {
    const previous = Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON')
    const source = clone(catalogV2Fixture)
    let callbacks = 0
    let materialized: unknown
    try {
      Object.defineProperty(Array.prototype, 'toJSON', {
        configurable: true,
        value() {
          callbacks += 1
          return 'caller-controlled'
        },
      })
      materialized = materializeCommercialContractV2Json(source)
    } finally {
      if (previous) Object.defineProperty(Array.prototype, 'toJSON', previous)
      else delete (Array.prototype as Array<unknown> & { toJSON?: unknown }).toJSON
    }

    expect(callbacks).toBe(0)
    expect(materialized).toEqual(catalogV2Fixture)
  })

  it('uses captured Date primordials after callers replace the global prototype methods', () => {
    const getTime = Object.getOwnPropertyDescriptor(Date.prototype, 'getTime')
    const toISOString = Object.getOwnPropertyDescriptor(Date.prototype, 'toISOString')
    if (!getTime || !('value' in getTime) || !toISOString || !('value' in toISOString)) throw new Error('Date primordials missing')
    let callbacks = 0
    let observed: string | null = null
    try {
      Object.defineProperty(Date.prototype, 'getTime', {
        configurable: true,
        value(this: Date) {
          callbacks += 1
          return Reflect.apply(getTime.value as Date['getTime'], this, [])
        },
      })
      Object.defineProperty(Date.prototype, 'toISOString', {
        configurable: true,
        get() {
          callbacks += 1
          return toISOString.value
        },
      })
      observed = toValidIso(new Date('2026-08-24T12:34:56.000Z'))
    } finally {
      Object.defineProperty(Date.prototype, 'getTime', getTime)
      Object.defineProperty(Date.prototype, 'toISOString', toISOString)
    }

    expect(callbacks).toBe(0)
    expect(observed).toBe('2026-08-24T12:34:56.000Z')
  })

  it.each([
    ['Number.isFinite', Number, 'isFinite'],
    ['utilTypes.isProxy', utilTypes, 'isProxy'],
    ['utilTypes.isDate', utilTypes, 'isDate'],
  ] as const)('uses captured %s after callers install a hostile post-import getter', (_label, owner, key) => {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key)
    if (!descriptor || !('value' in descriptor)) throw new Error(`${key} primordial missing`)
    let callbacks = 0
    let observed: string | null = null
    let thrown: unknown
    try {
      Object.defineProperty(owner, key, {
        configurable: true,
        get() {
          callbacks += 1
          throw new Error(`caller-secret-${key}`)
        },
      })
      try {
        observed = toValidIso(new Date('2026-08-24T12:34:56.000Z'))
      } catch (error) {
        thrown = error
      }
    } finally {
      Object.defineProperty(owner, key, descriptor)
    }

    expect(thrown instanceof Error ? thrown.message : '').not.toContain('caller-secret')
    expect(thrown).toBeUndefined()
    expect(callbacks).toBe(0)
    expect(observed).toBe('2026-08-24T12:34:56.000Z')
  })
})
