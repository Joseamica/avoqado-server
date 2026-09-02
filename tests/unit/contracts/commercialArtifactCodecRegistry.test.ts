import { COMMERCIAL_CONTRACT_HASH } from '@/contracts/commercial/contractHash'
import { COMMERCIAL_CONTRACT_V2_ARTIFACT_HASHES, COMMERCIAL_CONTRACT_V2_BUNDLE_HASH } from '@/contracts/commercial/commercialContractHashV2'
import catalogFixture from '@/contracts/commercial/fixtures/v2/catalog-base.json'
import campaignFixture from '@/contracts/commercial/fixtures/v2/campaign-pos-50.json'
import quoteFixture from '@/contracts/commercial/fixtures/v2/quote-pos-50-venue.json'
import { COMMERCIAL_V2_DOMAINS } from '@/contracts/commercial/commercialContractV2.constants'
import { hashCanonicalJsonV2 } from '@/services/commercial/commercialCanonicalJsonV2.service'
import { parseCommercialMoneyV2 } from '@/services/commercial/commercialMoneyV2.service'
import {
  COMMERCIAL_ARTIFACT_CODEC_REGISTRY,
  assertEmittedCommercialCampaignV2,
  assertEmittedCommercialCatalogV2,
  assertEmittedCommercialQuoteV2,
  assertVerifiedStoredCommercialQuoteV2,
  decodeAndVerifyCommercialArtifact,
  decodeAndVerifyStoredCommercialQuoteV2,
  emitCommercialArtifactV2,
  isEmittedCommercialCampaignV2,
  isEmittedCommercialCatalogV2,
  isEmittedCommercialQuoteV2,
} from '@/services/commercial/commercialArtifactCodecRegistry.service'
import type { CommercialCampaignSnapshotV2, CommercialCatalogSnapshotV2, CommercialQuoteSnapshotV2 } from '@/types/commercialV2'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function catalogInput(snapshot: CommercialCatalogSnapshotV2) {
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

function campaignInput(snapshot: CommercialCampaignSnapshotV2) {
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

function quoteInput(snapshot: CommercialQuoteSnapshotV2) {
  const catalog = clone(catalogFixture) as CommercialCatalogSnapshotV2
  const campaign = clone(campaignFixture) as unknown as CommercialCampaignSnapshotV2
  return {
    kind: 'QUOTE' as const,
    rowSchemaVersion: 2,
    snapshot,
    checksum: hashCanonicalJsonV2(COMMERCIAL_V2_DOMAINS.QUOTE, snapshot),
    rowContext: {
      kind: 'QUOTE' as const,
      id: snapshot.quoteId,
      catalogPublicationId: snapshot.catalogPublicationId,
      campaignVersionId: snapshot.campaignVersionId,
      acquisitionContextId: snapshot.acquisitionContextId,
      organizationId: snapshot.subject.kind === 'VENUE' ? snapshot.subject.organizationId : null,
      venueId: snapshot.subject.kind === 'VENUE' ? snapshot.subject.venueId : null,
      createdById: snapshot.subject.kind === 'VENUE' ? snapshot.subject.actorId : null,
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
      venueOrganizationId: snapshot.subject.kind === 'VENUE' ? snapshot.subject.organizationId : null,
    },
    authorities: { catalog: catalogInput(catalog), campaign: campaignInput(campaign) },
  }
}

describe('commercial artifact codec registry', () => {
  it('exposes exactly the frozen 3 by 2 persisted codec matrix', () => {
    expect(COMMERCIAL_ARTIFACT_CODEC_REGISTRY).toEqual([
      { kind: 'CATALOG', schemaVersion: 1, mode: 'READ_ONLY' },
      { kind: 'CATALOG', schemaVersion: 2, mode: 'READ_WRITE' },
      { kind: 'CAMPAIGN', schemaVersion: 1, mode: 'READ_ONLY' },
      { kind: 'CAMPAIGN', schemaVersion: 2, mode: 'READ_WRITE' },
      { kind: 'QUOTE', schemaVersion: 1, mode: 'READ_ONLY' },
      { kind: 'QUOTE', schemaVersion: 2, mode: 'READ_WRITE' },
    ])
    expect(Object.isFrozen(COMMERCIAL_ARTIFACT_CODEC_REGISTRY)).toBe(true)
    COMMERCIAL_ARTIFACT_CODEC_REGISTRY.forEach(entry => expect(Object.isFrozen(entry)).toBe(true))
  })

  it('preserves the historical v1 bundle and all six frozen v2 contract digests', () => {
    expect(COMMERCIAL_CONTRACT_HASH).toBe('aaee77e19f7cf51bcd9087c6e4f043bef759fa53857b80f3ee2d84a20317eb12')
    expect(COMMERCIAL_CONTRACT_V2_ARTIFACT_HASHES).toEqual({
      CATALOG: 'd7380618527c005635b1f4098f929e4ee942aa2cc6fb81cc02baf7334276db91',
      CAMPAIGN: 'c086841a458e2b6cfd3ec26b094e55f6ba4486b038481624699a51c22c6081fd',
      QUOTE: 'c7283f2ac358fc8d169c5c130647d5796a9f8ecb4db85adc5ed9ddd9d01b670e',
      ENTITLEMENTS: '68c272adbb9d7cb4b2a982fb04a12165f3b753f0617100cfe816c8b58cc3109b',
      LIFECYCLE: '73220924b3239bbe7aab393511a260c4ebe907cb77737fb06386c38f4d655c7f',
    })
    expect(COMMERCIAL_CONTRACT_V2_BUNDLE_HASH).toBe('a1755221256332250bb43a8e2130a62b25309c5a3917e555b0261dd652cb334d')
  })

  it('brands only registry-emitted v2 artifacts and rejects caller-created or cast values', () => {
    const catalog = emitCommercialArtifactV2({
      kind: 'CATALOG',
      schemaVersion: 2,
      domainValue: clone(catalogFixture),
    })
    const campaign = emitCommercialArtifactV2({
      kind: 'CAMPAIGN',
      schemaVersion: 2,
      domainValue: clone(campaignFixture),
    })
    const quote = emitCommercialArtifactV2({
      kind: 'QUOTE',
      schemaVersion: 2,
      domainValue: clone(quoteFixture),
      authorities: { catalog, campaign },
    })

    expect(isEmittedCommercialCatalogV2(catalog)).toBe(true)
    expect(isEmittedCommercialCampaignV2(campaign)).toBe(true)
    expect(isEmittedCommercialQuoteV2(quote)).toBe(true)
    expect(() => assertEmittedCommercialCatalogV2(catalog)).not.toThrow()
    expect(() => assertEmittedCommercialCampaignV2(campaign)).not.toThrow()
    expect(() => assertEmittedCommercialQuoteV2(quote)).not.toThrow()

    expect(() => assertEmittedCommercialCatalogV2({ ...catalog, snapshot: clone(catalog.snapshot) } as never)).toThrow(
      expect.objectContaining({ code: 'COMMERCIAL_ARTIFACT_VERIFICATION_REQUIRED' }),
    )
    expect(() => assertEmittedCommercialCampaignV2({ ...campaign, snapshot: clone(campaign.snapshot) } as never)).toThrow(
      expect.objectContaining({ code: 'COMMERCIAL_ARTIFACT_VERIFICATION_REQUIRED' }),
    )
    expect(() => assertEmittedCommercialQuoteV2({ ...quote, snapshot: clone(quote.snapshot) } as never)).toThrow(
      expect.objectContaining({ code: 'COMMERCIAL_ARTIFACT_VERIFICATION_REQUIRED' }),
    )
  })

  it('keeps stored-v2 verification distinct from emission and returns a typed replay quote', () => {
    const catalogSnapshot = clone(catalogFixture) as CommercialCatalogSnapshotV2
    const campaignSnapshot = clone(campaignFixture) as unknown as CommercialCampaignSnapshotV2
    const snapshot = clone(quoteFixture) as CommercialQuoteSnapshotV2
    const decodedCatalog = decodeAndVerifyCommercialArtifact(catalogInput(catalogSnapshot))
    const decodedCampaign = decodeAndVerifyCommercialArtifact(campaignInput(campaignSnapshot))
    const decoded = decodeAndVerifyCommercialArtifact(quoteInput(snapshot))
    const stored = decodeAndVerifyStoredCommercialQuoteV2(quoteInput(snapshot))

    expect(() => assertEmittedCommercialCatalogV2(decodedCatalog as never)).toThrow(
      expect.objectContaining({ code: 'COMMERCIAL_ARTIFACT_VERIFICATION_REQUIRED' }),
    )
    expect(() => assertEmittedCommercialCampaignV2(decodedCampaign as never)).toThrow(
      expect.objectContaining({ code: 'COMMERCIAL_ARTIFACT_VERIFICATION_REQUIRED' }),
    )
    expect(() => assertEmittedCommercialQuoteV2(decoded as never)).toThrow(
      expect.objectContaining({ code: 'COMMERCIAL_ARTIFACT_VERIFICATION_REQUIRED' }),
    )
    expect(() => assertVerifiedStoredCommercialQuoteV2(stored)).not.toThrow()
    expect(stored.snapshot.subject.kind).toBe('VENUE')
    expect(stored.snapshot.quoteId).toBe(snapshot.quoteId)

    const emittedCatalog = emitCommercialArtifactV2({ kind: 'CATALOG', schemaVersion: 2, domainValue: clone(catalogFixture) })
    expect(() => assertVerifiedStoredCommercialQuoteV2(emittedCatalog as never)).toThrow(
      expect.objectContaining({ code: 'COMMERCIAL_ARTIFACT_VERIFICATION_REQUIRED' }),
    )
  })
})
