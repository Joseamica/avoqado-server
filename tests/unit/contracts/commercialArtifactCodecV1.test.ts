import catalogFixture from '@/contracts/commercial/fixtures/catalog-v1.json'
import campaignFixture from '@/contracts/commercial/fixtures/campaign-pos-50-v1.json'
import quoteFixture from '@/contracts/commercial/fixtures/quote-pos-50-v1.json'
import { canonicalJsonV1, hashCanonicalJsonV1 } from '@/services/master-catalog/catalogHash.service'
import {
  CommercialArtifactCodecError,
  assertCommercialQuoteAcceptable,
  decodeAndVerifyCommercialArtifact,
} from '@/services/commercial/commercialArtifactCodecRegistry.service'
import type { CommercialCatalogSnapshotV1 } from '@/types/commercial'
import type { CommercialCampaignVersionV1, CommercialQuoteV1 } from '@/types/commercialQuote'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function catalogInput(snapshot: CommercialCatalogSnapshotV1 = clone(catalogFixture) as CommercialCatalogSnapshotV1) {
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

function campaignInput(snapshot: CommercialCampaignVersionV1 = clone(campaignFixture) as CommercialCampaignVersionV1) {
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

function quoteAuthorities(snapshot: CommercialQuoteV1) {
  const catalog = clone(catalogFixture) as CommercialCatalogSnapshotV1
  catalog.publicationId = snapshot.catalogPublicationId
  return { catalog: catalogInput(catalog), campaign: snapshot.campaignVersionId === null ? null : campaignInput() }
}

function quoteRow(snapshot: CommercialQuoteV1, scope: 'VENUE' | 'UNSCOPED' = 'VENUE') {
  return {
    kind: 'QUOTE' as const,
    id: snapshot.quoteId,
    catalogPublicationId: snapshot.catalogPublicationId,
    campaignVersionId: snapshot.campaignVersionId,
    acquisitionContextId: 'legacy-acquisition-lineage',
    organizationId: scope === 'VENUE' ? 'organization-v1' : null,
    venueId: scope === 'VENUE' ? 'venue-v1' : null,
    createdById: scope === 'VENUE' ? 'staff-v1' : null,
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
    venueOrganizationId: scope === 'VENUE' ? 'organization-v1' : null,
  }
}

function quoteInput(snapshot: CommercialQuoteV1 = clone(quoteFixture) as CommercialQuoteV1, scope: 'VENUE' | 'UNSCOPED' = 'VENUE') {
  return {
    kind: 'QUOTE' as const,
    rowSchemaVersion: 1,
    snapshot,
    checksum: hashCanonicalJsonV1('commercial-quote-v1', snapshot),
    rowContext: quoteRow(snapshot, scope),
    authorities: quoteAuthorities(snapshot),
  }
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

function collectMinorValues(value: unknown, results: unknown[] = []): unknown[] {
  if (typeof value !== 'object' || value === null) return results
  for (const [key, nested] of Object.entries(value)) {
    if (key.endsWith('Minor')) results.push(nested)
    collectMinorValues(nested, results)
  }
  return results
}

function poisonedDate(iso: string): { value: Date; observations: () => number } {
  let reads = 0
  const value = new Date(iso)
  for (const key of ['getTime', 'toISOString']) {
    Object.defineProperty(value, key, {
      get() {
        reads += 1
        throw new Error('caller-secret')
      },
    })
  }
  return { value, observations: () => reads }
}

describe('commercial artifact codec v1 historical read-only support', () => {
  it('decodes the catalog fixture with its frozen digest and bigint price projection', () => {
    const source = clone(catalogFixture) as CommercialCatalogSnapshotV1
    const decoded = decodeAndVerifyCommercialArtifact(catalogInput(source))
    if (decoded.kind !== 'CATALOG') throw new Error('Expected decoded catalog')

    expect(decoded).toMatchObject({ kind: 'CATALOG', schemaVersion: 1, mode: 'READ_ONLY' })
    expect(decoded.checksum).toBe('679a2b2e15a7e1340afd6d7f561daec5e247180d855afa56f1efc2dbae7bb42e')
    expect(decoded.snapshot).not.toBe(source)
    expect(canonicalJsonV1(decoded.snapshot)).toBe(canonicalJsonV1(source))
    expect((decoded.snapshot as CommercialCatalogSnapshotV1).products[0].prices[0].amountMinor).toBe(0)
    expect(decoded.money.prices.every(price => typeof price.amountMinor === 'bigint')).toBe(true)
    expect(Object.isFrozen(decoded)).toBe(true)
    expect(Object.isFrozen(decoded.money.prices)).toBe(true)
    source.publicationId = 'mutated-after-decode'
    expect((decoded.snapshot as CommercialCatalogSnapshotV1).publicationId).toBe('commercial-publication-v1')
  })

  it('keeps a valid v1 catalog larger than one MiB readable', () => {
    const snapshot = clone(catalogFixture) as CommercialCatalogSnapshotV1
    snapshot.products = Array.from({ length: 4_000 }, () => clone(snapshot.products[0]))
    expect(Buffer.byteLength(JSON.stringify(snapshot), 'utf8')).toBeGreaterThan(1_048_576)

    const decoded = decodeAndVerifyCommercialArtifact(catalogInput(snapshot))
    expect(decoded.mode).toBe('READ_ONLY')
    expect((decoded.snapshot as CommercialCatalogSnapshotV1).products).toHaveLength(4_000)
  })

  it('covers every catalog v1 row and fixed-market identity field', () => {
    for (const mutate of [
      (input: ReturnType<typeof catalogInput>) => (input.rowContext.id = 'wrong-publication'),
      (input: ReturnType<typeof catalogInput>) => (input.rowContext.publishedAt = new Date('2030-01-01T00:00:00.000Z')),
    ]) {
      const input = catalogInput()
      mutate(input)
      expectCode(() => decodeAndVerifyCommercialArtifact(input), 'COMMERCIAL_CATALOG_IDENTITY_MISMATCH')
    }
    for (const mutate of [
      (snapshot: CommercialCatalogSnapshotV1) => (snapshot.market.country = 'US' as never),
      (snapshot: CommercialCatalogSnapshotV1) => (snapshot.market.currency = 'USD' as never),
      (snapshot: CommercialCatalogSnapshotV1) => (snapshot.market.timezone = 'UTC' as never),
      (snapshot: CommercialCatalogSnapshotV1) => (snapshot.market.taxLabel = 'VAT' as never),
      (snapshot: CommercialCatalogSnapshotV1) => (snapshot.market.taxRateBasisPoints = 1500 as never),
    ]) {
      const snapshot = clone(catalogFixture) as CommercialCatalogSnapshotV1
      mutate(snapshot)
      expectCode(() => decodeAndVerifyCommercialArtifact(catalogInput(snapshot)), 'COMMERCIAL_CATALOG_SHAPE_INVALID')
    }
  })

  it('uses intrinsic Date methods for catalog rows without invoking overrides', () => {
    const input = catalogInput()
    const poisoned = poisonedDate((input.snapshot as CommercialCatalogSnapshotV1).publishedAt)
    input.rowContext.publishedAt = poisoned.value
    expect(decodeAndVerifyCommercialArtifact(input).kind).toBe('CATALOG')
    expect(poisoned.observations()).toBe(0)
  })

  it('decodes campaign v1 without inventing or comparing historical publishedAt', () => {
    const first = campaignInput()
    const decoded = decodeAndVerifyCommercialArtifact(first)
    if (decoded.kind !== 'CAMPAIGN') throw new Error('Expected decoded campaign')
    expect(decoded).toMatchObject({ kind: 'CAMPAIGN', schemaVersion: 1, mode: 'READ_ONLY' })
    expect(decoded.checksum).toBe('4736788b4d87426d8fe8656e03a8dfee56fa5c2ff3d4cc7fafb95992d0305b84')
    expect(decoded.money.rules).toEqual([{ ruleCode: 'POS_FIXED_50', amountMinor: 5000n }])
    expect((decoded.snapshot as Record<string, unknown>).publishedAt).toBeUndefined()

    const differentRowTimestamp = campaignInput()
    differentRowTimestamp.rowContext.publishedAt = new Date('2030-01-01T00:00:00.000Z')
    expect(decodeAndVerifyCommercialArtifact(differentRowTimestamp).mode).toBe('READ_ONLY')
  })

  it('rejects an invalid v1 campaign row date without leaking RangeError', () => {
    const input = campaignInput()
    input.rowContext.publishedAt = new Date('invalid')
    expectCode(() => decodeAndVerifyCommercialArtifact(input), 'COMMERCIAL_CAMPAIGN_IDENTITY_MISMATCH')
  })

  it('covers campaign v1 row identity and intrinsic window semantics', () => {
    for (const mutate of [
      (input: ReturnType<typeof campaignInput>) => (input.rowContext.id = 'wrong-campaign'),
      (input: ReturnType<typeof campaignInput>) => (input.rowContext.campaignCode = 'WRONG'),
      (input: ReturnType<typeof campaignInput>) => (input.rowContext.sourceRevision += 1),
    ]) {
      const input = campaignInput()
      mutate(input)
      expectCode(() => decodeAndVerifyCommercialArtifact(input), 'COMMERCIAL_CAMPAIGN_IDENTITY_MISMATCH')
    }
    const snapshot = clone(campaignFixture) as CommercialCampaignVersionV1
    snapshot.endsAt = snapshot.startsAt
    expectCode(() => decodeAndVerifyCommercialArtifact(campaignInput(snapshot)), 'COMMERCIAL_CAMPAIGN_IDENTITY_MISMATCH')
  })

  it('uses intrinsic Date methods for the historical campaign row', () => {
    const input = campaignInput()
    const poisoned = poisonedDate('2026-07-31T06:00:00.000Z')
    input.rowContext.publishedAt = poisoned.value
    expect(decodeAndVerifyCommercialArtifact(input).kind).toBe('CAMPAIGN')
    expect(poisoned.observations()).toBe(0)
  })

  it.each([
    ['LEGACY_VENUE', 'VENUE' as const],
    ['LEGACY_UNSCOPED', 'UNSCOPED' as const],
  ])('decodes quote v1 scope %s for support only', (expectedScope, scope) => {
    const decoded = decodeAndVerifyCommercialArtifact(quoteInput(undefined, scope))
    expect(decoded).toMatchObject({ kind: 'QUOTE', schemaVersion: 1, mode: 'READ_ONLY', scope: { kind: expectedScope } })
    expect(decoded).toMatchObject({ lineage: { acquisitionContextId: 'legacy-acquisition-lineage' } })
    expect(decoded.checksum).toBe('5b7490935074aa4510d57c631ec32f9875144a7e940ada17c5ab6201f0f22d78')
    expect(collectMinorValues(decoded.money).every(value => typeof value === 'bigint')).toBe(true)
  })

  it('rejects a partial legacy quote scope', () => {
    const input = quoteInput()
    input.rowContext.createdById = null
    expectCode(() => decodeAndVerifyCommercialArtifact(input), 'COMMERCIAL_QUOTE_SCOPE_MISMATCH')
  })

  it('rejects non-string legacy tenant identifiers instead of blessing structural lookalikes', () => {
    const input = quoteInput()
    input.rowContext.organizationId = 7 as never
    input.rowContext.venueOrganizationId = 7 as never
    expectCode(() => decodeAndVerifyCommercialArtifact(input), 'COMMERCIAL_QUOTE_SCOPE_MISMATCH')
  })

  it('rejects row money, dates, catalog authority and campaign authority mismatches', () => {
    const wrongMoney = quoteInput()
    wrongMoney.rowContext.totalMinor += 1
    expectCode(() => decodeAndVerifyCommercialArtifact(wrongMoney), 'COMMERCIAL_QUOTE_IDENTITY_MISMATCH')

    const invalidDate = quoteInput()
    invalidDate.rowContext.quotedAt = new Date('invalid')
    expectCode(() => decodeAndVerifyCommercialArtifact(invalidDate), 'COMMERCIAL_QUOTE_IDENTITY_MISMATCH')

    const wrongCatalog = quoteInput()
    const otherCatalog = clone(catalogFixture) as CommercialCatalogSnapshotV1
    otherCatalog.publicationId = 'different-publication'
    wrongCatalog.authorities.catalog = catalogInput(otherCatalog)
    expectCode(() => decodeAndVerifyCommercialArtifact(wrongCatalog), 'COMMERCIAL_QUOTE_IDENTITY_MISMATCH')

    const wrongCampaign = quoteInput()
    const otherCampaign = clone(campaignFixture) as CommercialCampaignVersionV1
    otherCampaign.campaignVersionId = 'different-campaign-version'
    wrongCampaign.authorities.campaign = campaignInput(otherCampaign)
    expectCode(() => decodeAndVerifyCommercialArtifact(wrongCampaign), 'COMMERCIAL_QUOTE_IDENTITY_MISMATCH')

    const missingCampaign = quoteInput()
    missingCampaign.authorities.campaign = null
    expectCode(() => decodeAndVerifyCommercialArtifact(missingCampaign), 'COMMERCIAL_QUOTE_IDENTITY_MISMATCH')
  })

  it('covers every common quote v1 row identity field and all eight persisted money columns', () => {
    for (const [key, value] of [
      ['id', 'wrong-quote'],
      ['catalogPublicationId', 'wrong-publication'],
      ['campaignVersionId', 'wrong-campaign'],
      ['market', 'US'],
      ['currency', 'USD'],
      ['quotedAt', new Date('2030-01-01T00:00:00.000Z')],
      ['expiresAt', new Date('2030-01-02T00:00:00.000Z')],
    ] as const) {
      const input = quoteInput()
      ;(input.rowContext as unknown as Record<string, unknown>)[key] = value
      expectCode(() => decodeAndVerifyCommercialArtifact(input), 'COMMERCIAL_QUOTE_IDENTITY_MISMATCH')
    }
    for (const key of [
      'listSubtotalMinor',
      'discountMinor',
      'subtotalMinor',
      'taxMinor',
      'totalMinor',
      'renewalSubtotalMinor',
      'renewalTaxMinor',
      'renewalTotalMinor',
    ] as const) {
      const input = quoteInput()
      input.rowContext[key] += 1
      expectCode(() => decodeAndVerifyCommercialArtifact(input), 'COMMERCIAL_QUOTE_IDENTITY_MISMATCH')
    }
  })

  it.each(['quotedAt', 'expiresAt'] as const)('uses intrinsic Date methods for quote v1 %s', key => {
    const input = quoteInput()
    const poisoned = poisonedDate(input.snapshot[key])
    input.rowContext[key] = poisoned.value
    expect(decodeAndVerifyCommercialArtifact(input).kind).toBe('QUOTE')
    expect(poisoned.observations()).toBe(0)
  })

  it('always rejects acceptance of a verified v1 quote', () => {
    const decoded = decodeAndVerifyCommercialArtifact(quoteInput())
    if (decoded.kind !== 'QUOTE') throw new Error('Expected decoded quote')
    expectCode(() => assertCommercialQuoteAcceptable(decoded), 'COMMERCIAL_QUOTE_V1_ACCEPTANCE_DISABLED')
  })

  it('keeps the persisted authority graph acyclic by rejecting a quote in the catalog slot', () => {
    const input = quoteInput()
    input.authorities.catalog = input as never
    expectCode(() => decodeAndVerifyCommercialArtifact(input), 'COMMERCIAL_QUOTE_IDENTITY_MISMATCH')
  })

  it('rejects a proxy authority container without invoking its traps', () => {
    let observed = false
    const input = quoteInput()
    input.authorities = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          observed = true
          throw new Error('caller-secret')
        },
      },
    ) as never
    expectCode(() => decodeAndVerifyCommercialArtifact(input), 'COMMERCIAL_QUOTE_SHAPE_INVALID')
    expect(observed).toBe(false)
  })

  it.each([
    ['catalog', () => catalogInput(), 'COMMERCIAL_CATALOG_IDENTITY_MISMATCH'],
    ['campaign', () => campaignInput(), 'COMMERCIAL_CAMPAIGN_IDENTITY_MISMATCH'],
    ['quote', () => quoteInput(), 'COMMERCIAL_QUOTE_IDENTITY_MISMATCH'],
  ] as const)('checks both row kind and schema identity for v1 %s', (_label, inputFactory, code) => {
    for (const [key, value] of [
      ['kind', 'WRONG'],
      ['schemaVersion', 2],
    ] as const) {
      const input = inputFactory()
      ;(input.rowContext as unknown as Record<string, unknown>)[key] = value
      expectCode(() => decodeAndVerifyCommercialArtifact(input as never), code)
    }
  })
})
