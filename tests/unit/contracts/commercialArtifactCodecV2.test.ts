import catalogFixture from '@/contracts/commercial/fixtures/v2/catalog-base.json'
import campaignFixture from '@/contracts/commercial/fixtures/v2/campaign-pos-50.json'
import acquisitionQuoteFixture from '@/contracts/commercial/fixtures/v2/quote-pos-50-acquisition.json'
import venueQuoteFixture from '@/contracts/commercial/fixtures/v2/quote-pos-50-venue.json'
import { COMMERCIAL_V2_DOMAINS } from '@/contracts/commercial/commercialContractV2.constants'
import { hashCanonicalJsonV2 } from '@/services/commercial/commercialCanonicalJsonV2.service'
import { parseCommercialMoneyV2 } from '@/services/commercial/commercialMoneyV2.service'
import {
  CommercialArtifactCodecError,
  assertCommercialQuoteAcceptable,
  decodeAndVerifyCommercialArtifact,
  emitCommercialArtifact,
  emitCommercialArtifactV2,
} from '@/services/commercial/commercialArtifactCodecRegistry.service'
import type { CommercialCampaignSnapshotV2, CommercialCatalogSnapshotV2, CommercialQuoteSnapshotV2 } from '@/types/commercialV2'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function catalogInput(snapshot: CommercialCatalogSnapshotV2 = clone(catalogFixture) as CommercialCatalogSnapshotV2) {
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

function campaignInput(snapshot: CommercialCampaignSnapshotV2 = clone(campaignFixture) as unknown as CommercialCampaignSnapshotV2) {
  return {
    kind: 'CAMPAIGN' as const,
    rowSchemaVersion: 2,
    snapshot,
    checksum: hashCanonicalJsonV2(COMMERCIAL_V2_DOMAINS.CAMPAIGN_SNAPSHOT, snapshot),
    rowContext: {
      kind: 'CAMPAIGN' as const,
      id: snapshot.campaignVersionId,
      campaignCode: snapshot.campaignCode,
      sourceRevision: snapshot.version,
      schemaVersion: 2,
      publishedAt: new Date(snapshot.publishedAt),
    },
  }
}

function quoteRow(snapshot: CommercialQuoteSnapshotV2) {
  const venueSubject = snapshot.subject.kind === 'VENUE' ? snapshot.subject : null
  return {
    kind: 'QUOTE' as const,
    id: snapshot.quoteId,
    catalogPublicationId: snapshot.catalogPublicationId,
    campaignVersionId: snapshot.campaignVersionId,
    acquisitionContextId: snapshot.acquisitionContextId,
    organizationId: venueSubject?.organizationId ?? null,
    venueId: venueSubject?.venueId ?? null,
    createdById: venueSubject?.actorId ?? null,
    schemaVersion: 2,
    market: snapshot.market,
    currency: snapshot.currency,
    quotedAt: new Date(snapshot.quotedAt),
    expiresAt: new Date(snapshot.expiresAt),
    listSubtotalMinor: parseCommercialMoneyV2(snapshot.totals.listSubtotal),
    discountMinor: parseCommercialMoneyV2(snapshot.totals.discount),
    subtotalMinor: parseCommercialMoneyV2(snapshot.totals.subtotal),
    taxMinor: parseCommercialMoneyV2(snapshot.totals.tax),
    totalMinor: parseCommercialMoneyV2(snapshot.totals.total),
    renewalSubtotalMinor: parseCommercialMoneyV2(snapshot.renewal.subtotal),
    renewalTaxMinor: parseCommercialMoneyV2(snapshot.renewal.tax),
    renewalTotalMinor: parseCommercialMoneyV2(snapshot.renewal.total),
    venueOrganizationId: venueSubject?.organizationId ?? null,
  }
}

function quoteInput(snapshot: CommercialQuoteSnapshotV2) {
  return {
    kind: 'QUOTE' as const,
    rowSchemaVersion: 2,
    snapshot,
    checksum: hashCanonicalJsonV2(COMMERCIAL_V2_DOMAINS.QUOTE, snapshot),
    rowContext: quoteRow(snapshot),
    authorities: { catalog: catalogInput(), campaign: snapshot.campaignVersionId === null ? null : campaignInput() },
  }
}

function expectCode(operation: () => unknown, code: string): void {
  try {
    operation()
    throw new Error('Expected codec error')
  } catch (error) {
    expect(error).toBeInstanceOf(CommercialArtifactCodecError)
    expect(error).toMatchObject({ code })
    expect((error as Error).message).not.toContain('caller-secret')
  }
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

function recursivelyFrozen(value: unknown): boolean {
  return (
    typeof value !== 'object' ||
    value === null ||
    (Object.isFrozen(value) && Object.values(value).every(nested => recursivelyFrozen(nested)))
  )
}

describe('commercial artifact codec v2 read-write support', () => {
  it('decodes catalog and campaign fixtures with exact domains and bigint projections', () => {
    const catalog = decodeAndVerifyCommercialArtifact(catalogInput())
    if (catalog.kind !== 'CATALOG') throw new Error('Expected decoded catalog')
    expect(catalog).toMatchObject({ kind: 'CATALOG', schemaVersion: 2, mode: 'READ_WRITE' })
    expect(catalog.checksum).toBe('d946ff3d054ba33550a5a76415facd56d0119dde5489511f8baacd6843fc95d1')
    expect(catalog.money.prices.every(price => typeof price.amountMinor === 'bigint')).toBe(true)

    const campaign = decodeAndVerifyCommercialArtifact(campaignInput())
    if (campaign.kind !== 'CAMPAIGN') throw new Error('Expected decoded campaign')
    expect(campaign).toMatchObject({ kind: 'CAMPAIGN', schemaVersion: 2, mode: 'READ_WRITE' })
    expect(campaign.checksum).toBe('02d73b6fd4dff336722ce32fa78dcf8c8e9ab0ca32345538dcecfa2e561ab513')
    expect(campaign.money.rules).toEqual([{ ruleCode: 'POS_FIXED_50', amountMinor: 5000n }])
  })

  it('covers every catalog v2 row and fixed-market identity field', () => {
    for (const mutate of [
      (input: ReturnType<typeof catalogInput>) => (input.rowContext.id = 'wrong-publication'),
      (input: ReturnType<typeof catalogInput>) => (input.rowContext.publishedAt = new Date('2030-01-01T00:00:00.000Z')),
    ]) {
      const input = catalogInput()
      mutate(input)
      expectCode(() => decodeAndVerifyCommercialArtifact(input), 'COMMERCIAL_CATALOG_IDENTITY_MISMATCH')
    }
    for (const mutate of [
      (snapshot: CommercialCatalogSnapshotV2) => (snapshot.market.country = 'US' as never),
      (snapshot: CommercialCatalogSnapshotV2) => (snapshot.market.currency = 'USD' as never),
      (snapshot: CommercialCatalogSnapshotV2) => (snapshot.market.timezone = 'UTC' as never),
      (snapshot: CommercialCatalogSnapshotV2) => (snapshot.market.taxLabel = 'VAT' as never),
      (snapshot: CommercialCatalogSnapshotV2) => (snapshot.market.taxRateBasisPoints = 1500 as never),
    ]) {
      const snapshot = clone(catalogFixture) as CommercialCatalogSnapshotV2
      mutate(snapshot)
      expectCode(() => decodeAndVerifyCommercialArtifact(catalogInput(snapshot)), 'COMMERCIAL_CATALOG_SHAPE_INVALID')
    }
  })

  it('uses intrinsic Date methods for catalog v2 without invoking overrides', () => {
    const input = catalogInput()
    const poisoned = poisonedDate(input.snapshot.publishedAt)
    input.rowContext.publishedAt = poisoned.value
    expect(decodeAndVerifyCommercialArtifact(input).kind).toBe('CATALOG')
    expect(poisoned.observations()).toBe(0)
  })

  it('requires exact campaign v2 publishedAt row identity', () => {
    const input = campaignInput()
    input.rowContext.publishedAt = new Date('2026-08-01T06:00:00.000Z')
    expectCode(() => decodeAndVerifyCommercialArtifact(input), 'COMMERCIAL_CAMPAIGN_IDENTITY_MISMATCH')
  })

  it('covers campaign v2 row identity and intrinsic window semantics', () => {
    for (const mutate of [
      (input: ReturnType<typeof campaignInput>) => (input.rowContext.id = 'wrong-campaign'),
      (input: ReturnType<typeof campaignInput>) => (input.rowContext.campaignCode = 'WRONG'),
      (input: ReturnType<typeof campaignInput>) => (input.rowContext.sourceRevision += 1),
    ]) {
      const input = campaignInput()
      mutate(input)
      expectCode(() => decodeAndVerifyCommercialArtifact(input), 'COMMERCIAL_CAMPAIGN_IDENTITY_MISMATCH')
    }
    const snapshot = clone(campaignFixture) as unknown as CommercialCampaignSnapshotV2
    snapshot.endsAt = snapshot.startsAt
    expectCode(() => decodeAndVerifyCommercialArtifact(campaignInput(snapshot)), 'COMMERCIAL_CAMPAIGN_SHAPE_INVALID')
  })

  it('uses intrinsic Date methods for campaign v2 without invoking overrides', () => {
    const input = campaignInput()
    const poisoned = poisonedDate(input.snapshot.publishedAt)
    input.rowContext.publishedAt = poisoned.value
    expect(decodeAndVerifyCommercialArtifact(input).kind).toBe('CAMPAIGN')
    expect(poisoned.observations()).toBe(0)
  })

  it.each([
    ['ACQUISITION_CONTEXT', acquisitionQuoteFixture, '3554436db0016fb80907b7a0e3d06731699020cb6b04d4ca0994e5b7e8ff59a9'],
    ['VENUE', venueQuoteFixture, 'b9cc0eb11b43c9a96f1b3623e1bb2147f263e0b692ea459357c232caaa3be0c5'],
  ])('decodes a valid %s quote and projects every wire amount to bigint', (scope, fixture, digest) => {
    const decoded = decodeAndVerifyCommercialArtifact(quoteInput(clone(fixture) as CommercialQuoteSnapshotV2))
    if (decoded.kind !== 'QUOTE') throw new Error('Expected decoded quote')
    expect(decoded).toMatchObject({ kind: 'QUOTE', schemaVersion: 2, mode: 'READ_WRITE', scope: { kind: scope } })
    expect(decoded).toMatchObject({ lineage: { acquisitionContextId: (fixture as CommercialQuoteSnapshotV2).acquisitionContextId } })
    expect(decoded.checksum).toBe(digest)
    expect(decoded.money.totals.totalMinor).toBe(5800n)
    expect(decoded.money.lines[0].adjustments[0]).toMatchObject({
      inputAmountMinor: 24900n,
      discountAmountMinor: 19900n,
      outputAmountMinor: 5000n,
    })
  })

  it('requires bigint DB columns for v2 quote identity', () => {
    const input = quoteInput(clone(venueQuoteFixture) as CommercialQuoteSnapshotV2)
    input.rowContext.totalMinor = 5800 as never
    expectCode(() => decodeAndVerifyCommercialArtifact(input), 'COMMERCIAL_QUOTE_IDENTITY_MISMATCH')
  })

  it('covers every common quote v2 row identity field and all eight persisted money columns', () => {
    for (const [key, value] of [
      ['id', 'wrong-quote'],
      ['catalogPublicationId', 'wrong-publication'],
      ['campaignVersionId', 'wrong-campaign'],
      ['market', 'US'],
      ['currency', 'USD'],
      ['quotedAt', new Date('2030-01-01T00:00:00.000Z')],
      ['expiresAt', new Date('2030-01-02T00:00:00.000Z')],
    ] as const) {
      const input = quoteInput(clone(venueQuoteFixture) as CommercialQuoteSnapshotV2)
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
      const input = quoteInput(clone(venueQuoteFixture) as CommercialQuoteSnapshotV2)
      input.rowContext[key] += 1n
      expectCode(() => decodeAndVerifyCommercialArtifact(input), 'COMMERCIAL_QUOTE_IDENTITY_MISMATCH')
    }
  })

  it.each(['quotedAt', 'expiresAt'] as const)('uses intrinsic Date methods for quote v2 %s', key => {
    const input = quoteInput(clone(venueQuoteFixture) as CommercialQuoteSnapshotV2)
    const poisoned = poisonedDate(input.snapshot[key])
    input.rowContext[key] = poisoned.value
    expect(decodeAndVerifyCommercialArtifact(input).kind).toBe('QUOTE')
    expect(poisoned.observations()).toBe(0)
  })

  it('rejects a proxy v2 quote row without invoking its traps', () => {
    let observed = false
    const input = quoteInput(clone(venueQuoteFixture) as CommercialQuoteSnapshotV2)
    input.rowContext = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          observed = true
          throw new Error('caller-secret')
        },
      },
    ) as never
    expectCode(() => decodeAndVerifyCommercialArtifact(input), 'COMMERCIAL_QUOTE_IDENTITY_MISMATCH')
    expect(observed).toBe(false)
  })

  it('rejects cross-tenant and acquisition subject mixtures as scope mismatches', () => {
    const crossTenant = quoteInput(clone(venueQuoteFixture) as CommercialQuoteSnapshotV2)
    crossTenant.rowContext.venueOrganizationId = 'another-organization'
    expectCode(() => decodeAndVerifyCommercialArtifact(crossTenant), 'COMMERCIAL_QUOTE_SCOPE_MISMATCH')

    const mixedPreview = quoteInput(clone(acquisitionQuoteFixture) as CommercialQuoteSnapshotV2)
    mixedPreview.rowContext.organizationId = 'organization-leak'
    expectCode(() => decodeAndVerifyCommercialArtifact(mixedPreview), 'COMMERCIAL_QUOTE_SCOPE_MISMATCH')

    const wrongLineage = quoteInput(clone(venueQuoteFixture) as CommercialQuoteSnapshotV2)
    wrongLineage.rowContext.acquisitionContextId = 'another-acquisition'
    expectCode(() => decodeAndVerifyCommercialArtifact(wrongLineage), 'COMMERCIAL_QUOTE_SCOPE_MISMATCH')
  })

  it('rejects independently valid but wrong persisted catalog/campaign authorities', () => {
    const wrongCatalog = quoteInput(clone(venueQuoteFixture) as CommercialQuoteSnapshotV2)
    const otherCatalog = clone(catalogFixture) as CommercialCatalogSnapshotV2
    otherCatalog.publicationId = 'other-publication-v2'
    wrongCatalog.authorities.catalog = catalogInput(otherCatalog)
    expectCode(() => decodeAndVerifyCommercialArtifact(wrongCatalog), 'COMMERCIAL_QUOTE_IDENTITY_MISMATCH')

    const wrongCampaign = quoteInput(clone(venueQuoteFixture) as CommercialQuoteSnapshotV2)
    const otherCampaign = clone(campaignFixture) as unknown as CommercialCampaignSnapshotV2
    otherCampaign.campaignVersionId = 'other-campaign-version-v2'
    wrongCampaign.authorities.campaign = campaignInput(otherCampaign)
    expectCode(() => decodeAndVerifyCommercialArtifact(wrongCampaign), 'COMMERCIAL_QUOTE_IDENTITY_MISMATCH')
  })

  it('rejects an intrinsically singular v2 campaign pair before authority reconciliation', () => {
    const input = quoteInput(clone(venueQuoteFixture) as CommercialQuoteSnapshotV2)
    input.snapshot.campaignCode = null
    expectCode(() => decodeAndVerifyCommercialArtifact(input), 'COMMERCIAL_QUOTE_SHAPE_INVALID')
  })

  it('emits all three v2 artifacts through one runtime boundary without aliases', () => {
    const sourceCatalog = clone(catalogFixture) as CommercialCatalogSnapshotV2
    const catalog = emitCommercialArtifactV2({ kind: 'CATALOG', schemaVersion: 2, domainValue: sourceCatalog })
    expect(catalog.checksum).toBe('d946ff3d054ba33550a5a76415facd56d0119dde5489511f8baacd6843fc95d1')
    expect(catalog.snapshot).not.toBe(sourceCatalog)

    const campaign = emitCommercialArtifact({
      kind: 'CAMPAIGN',
      schemaVersion: 2,
      domainValue: clone(campaignFixture) as unknown as CommercialCampaignSnapshotV2,
    })
    expect(campaign.checksum).toBe('02d73b6fd4dff336722ce32fa78dcf8c8e9ab0ca32345538dcecfa2e561ab513')

    const quote = emitCommercialArtifactV2({
      kind: 'QUOTE',
      schemaVersion: 2,
      domainValue: clone(venueQuoteFixture) as CommercialQuoteSnapshotV2,
      authorities: { catalog, campaign },
    })
    expect(quote.checksum).toBe('b9cc0eb11b43c9a96f1b3623e1bb2147f263e0b692ea459357c232caaa3be0c5')
    expect(Object.isFrozen(quote)).toBe(true)
    expect(Object.isFrozen(quote.snapshot)).toBe(true)
  })

  it('recursively freezes and detaches all three emitted artifact kinds', () => {
    const catalogSource = clone(catalogFixture) as CommercialCatalogSnapshotV2
    const campaignSource = clone(campaignFixture) as unknown as CommercialCampaignSnapshotV2
    const quoteSource = clone(venueQuoteFixture) as CommercialQuoteSnapshotV2
    const catalog = emitCommercialArtifactV2({ kind: 'CATALOG', schemaVersion: 2, domainValue: catalogSource })
    const campaign = emitCommercialArtifactV2({ kind: 'CAMPAIGN', schemaVersion: 2, domainValue: campaignSource })
    const quote = emitCommercialArtifactV2({
      kind: 'QUOTE',
      schemaVersion: 2,
      domainValue: quoteSource,
      authorities: { catalog, campaign },
    })
    for (const [result, source] of [
      [catalog, catalogSource],
      [campaign, campaignSource],
      [quote, quoteSource],
    ] as const) {
      expect(result.snapshot).not.toBe(source)
      expect(recursivelyFrozen(result)).toBe(true)
    }
    catalogSource.publicationId = 'mutated-catalog'
    campaignSource.campaignCode = 'MUTATED_CAMPAIGN'
    quoteSource.quoteId = 'mutated-quote'
    expect((catalog.snapshot as CommercialCatalogSnapshotV2).publicationId).not.toBe('mutated-catalog')
    expect((campaign.snapshot as CommercialCampaignSnapshotV2).campaignCode).not.toBe('MUTATED_CAMPAIGN')
    expect((quote.snapshot as CommercialQuoteSnapshotV2).quoteId).not.toBe('mutated-quote')
  })

  it('rejects forged emit authorities before observing their fields', () => {
    let observed = false
    const forged = Object.defineProperty({}, 'snapshot', {
      enumerable: true,
      get() {
        observed = true
        throw new Error('caller-secret')
      },
    })
    expectCode(
      () =>
        emitCommercialArtifactV2({
          kind: 'QUOTE',
          schemaVersion: 2,
          domainValue: clone(venueQuoteFixture) as CommercialQuoteSnapshotV2,
          authorities: { catalog: forged as never, campaign: forged as never },
        }),
      'COMMERCIAL_ARTIFACT_VERIFICATION_REQUIRED',
    )
    expect(observed).toBe(false)
  })

  it('keeps catalog and campaign emit inputs authority-free', () => {
    expectCode(
      () =>
        emitCommercialArtifact({
          kind: 'CATALOG',
          schemaVersion: 2,
          domainValue: clone(catalogFixture),
          authorities: {},
        }),
      'COMMERCIAL_CATALOG_SHAPE_INVALID',
    )
    expectCode(
      () =>
        emitCommercialArtifact({
          kind: 'CAMPAIGN',
          schemaVersion: 2,
          domainValue: clone(campaignFixture),
          authorities: {},
        }),
      'COMMERCIAL_CAMPAIGN_SHAPE_INVALID',
    )
  })

  it('brands decoded acceptance inputs: venue passes, preview and forged values fail safely', () => {
    const venue = decodeAndVerifyCommercialArtifact(quoteInput(clone(venueQuoteFixture) as CommercialQuoteSnapshotV2))
    if (venue.kind !== 'QUOTE') throw new Error('Expected decoded venue quote')
    expect(() => assertCommercialQuoteAcceptable(venue)).not.toThrow()

    const preview = decodeAndVerifyCommercialArtifact(quoteInput(clone(acquisitionQuoteFixture) as CommercialQuoteSnapshotV2))
    if (preview.kind !== 'QUOTE') throw new Error('Expected decoded preview quote')
    expectCode(() => assertCommercialQuoteAcceptable(preview), 'COMMERCIAL_QUOTE_SUBJECT_NOT_ACCEPTABLE')

    let observed = false
    const forged = Object.defineProperty({}, 'subject', {
      enumerable: true,
      get() {
        observed = true
        throw new Error('caller-secret')
      },
    })
    expectCode(() => assertCommercialQuoteAcceptable(forged as never), 'COMMERCIAL_ARTIFACT_VERIFICATION_REQUIRED')
    expect(observed).toBe(false)

    const verifiedCatalog = decodeAndVerifyCommercialArtifact(catalogInput())
    expectCode(() => assertCommercialQuoteAcceptable(verifiedCatalog as never), 'COMMERCIAL_ARTIFACT_VERIFICATION_REQUIRED')
  })

  it.each([
    ['catalog', () => catalogInput(), 'COMMERCIAL_CATALOG_IDENTITY_MISMATCH'],
    ['campaign', () => campaignInput(), 'COMMERCIAL_CAMPAIGN_IDENTITY_MISMATCH'],
    ['quote', () => quoteInput(clone(venueQuoteFixture) as CommercialQuoteSnapshotV2), 'COMMERCIAL_QUOTE_IDENTITY_MISMATCH'],
  ] as const)('checks both row kind and schema identity for v2 %s', (_label, inputFactory, code) => {
    for (const [key, value] of [
      ['kind', 'WRONG'],
      ['schemaVersion', 1],
    ] as const) {
      const input = inputFactory()
      ;(input.rowContext as unknown as Record<string, unknown>)[key] = value
      expectCode(() => decodeAndVerifyCommercialArtifact(input as never), code)
    }
  })
})
