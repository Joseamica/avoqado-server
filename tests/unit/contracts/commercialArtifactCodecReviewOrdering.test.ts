import catalogV1Fixture from '@/contracts/commercial/fixtures/catalog-v1.json'
import campaignV1Fixture from '@/contracts/commercial/fixtures/campaign-pos-50-v1.json'
import quoteV1Fixture from '@/contracts/commercial/fixtures/quote-pos-50-v1.json'
import catalogV2Fixture from '@/contracts/commercial/fixtures/v2/catalog-base.json'
import campaignV2Fixture from '@/contracts/commercial/fixtures/v2/campaign-pos-50.json'
import quoteV2Fixture from '@/contracts/commercial/fixtures/v2/quote-pos-50-venue.json'
import { COMMERCIAL_V2_DOMAINS } from '@/contracts/commercial/commercialContractV2.constants'
import { hashCanonicalJsonV1 } from '@/services/master-catalog/catalogHash.service'
import { hashCanonicalJsonV2 } from '@/services/commercial/commercialCanonicalJsonV2.service'
import {
  CommercialArtifactCodecError,
  decodeAndVerifyCommercialArtifact,
} from '@/services/commercial/commercialArtifactCodecRegistry.service'
import { parseCommercialMoneyV2 } from '@/services/commercial/commercialMoneyV2.service'
import type { CommercialCatalogSnapshotV1 } from '@/types/commercial'
import type { CommercialCampaignVersionV1, CommercialQuoteV1 } from '@/types/commercialQuote'
import type { CommercialCampaignSnapshotV2, CommercialCatalogSnapshotV2, CommercialQuoteSnapshotV2 } from '@/types/commercialV2'

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

function catalogV1Input(snapshot: CommercialCatalogSnapshotV1) {
  return {
    kind: 'CATALOG' as const,
    rowSchemaVersion: 1,
    snapshot,
    checksum: hashCanonicalJsonV1('commercial-catalog-snapshot-v1', snapshot),
    rowContext: { kind: 'CATALOG' as const, id: snapshot.publicationId, schemaVersion: 1, publishedAt: new Date(snapshot.publishedAt) },
  }
}

function campaignV1Input(snapshot: CommercialCampaignVersionV1) {
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
  const campaign = clone(campaignV1Fixture) as CommercialCampaignVersionV1
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
      createdById: 'actor-v1',
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
    authorities: { catalog: catalogV1Input(catalog), campaign: campaignV1Input(campaign) },
  }
}

function catalogV2Input(snapshot: CommercialCatalogSnapshotV2 = clone(catalogV2Fixture) as CommercialCatalogSnapshotV2) {
  return {
    kind: 'CATALOG' as const,
    rowSchemaVersion: 2,
    snapshot,
    checksum: hashCanonicalJsonV2(COMMERCIAL_V2_DOMAINS.CATALOG_SNAPSHOT, snapshot),
    rowContext: { kind: 'CATALOG' as const, id: snapshot.publicationId, schemaVersion: 2, publishedAt: new Date(snapshot.publishedAt) },
  }
}

function campaignV2Input(snapshot: CommercialCampaignSnapshotV2 = clone(campaignV2Fixture) as unknown as CommercialCampaignSnapshotV2) {
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

function quoteV2Input() {
  const snapshot = clone(quoteV2Fixture) as CommercialQuoteSnapshotV2
  if (snapshot.subject.kind !== 'VENUE') throw new Error('Venue quote fixture missing VENUE subject')
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
      organizationId: snapshot.subject.organizationId,
      venueId: snapshot.subject.venueId,
      createdById: snapshot.subject.actorId,
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
      venueOrganizationId: snapshot.subject.organizationId,
    },
    authorities: { catalog: catalogV2Input(), campaign: campaignV2Input() },
  }
}

describe('commercial quote decoder deterministic review ordering', () => {
  it('reports an intrinsic v2 quote shape before a bad nested authority', () => {
    const input = quoteV2Input()
    input.snapshot.lines[0].quantity = 0
    input.authorities.catalog.checksum = '0'.repeat(64)
    expectCode(() => decodeAndVerifyCommercialArtifact(input), 'COMMERCIAL_QUOTE_SHAPE_INVALID')
  })

  it.each([
    ['v1', quoteV1Input()],
    ['v2', quoteV2Input()],
  ])('reports the %s quote checksum before a bad nested authority', (_label, input) => {
    input.checksum = '0'.repeat(64)
    input.authorities.catalog.checksum = '0'.repeat(64)
    expectCode(() => decodeAndVerifyCommercialArtifact(input as never), 'COMMERCIAL_QUOTE_CHECKSUM_INVALID')
  })

  it('checks the historical campaign pair only after the quote checksum', () => {
    const input = quoteV1Input()
    input.snapshot.campaignCode = null
    expectCode(() => decodeAndVerifyCommercialArtifact(input), 'COMMERCIAL_QUOTE_CHECKSUM_INVALID')
  })

  it('decodes nested v1 authorities before reconciling the historical campaign pair', () => {
    const input = quoteV1Input()
    input.snapshot.campaignCode = null
    input.checksum = hashCanonicalJsonV1('commercial-quote-v1', input.snapshot)
    input.authorities.catalog.checksum = '0'.repeat(64)
    expectCode(() => decodeAndVerifyCommercialArtifact(input), 'COMMERCIAL_CATALOG_CHECKSUM_INVALID')
  })

  it.each([
    [
      'line price',
      (input: ReturnType<typeof quoteV2Input>) => {
        const catalog = input.authorities.catalog.snapshot
        const pos = catalog.products.find(product => product.code === 'POS')
        if (!pos) throw new Error('POS fixture missing')
        pos.prices[0].amount = '248.00'
        input.authorities.catalog = catalogV2Input(catalog)
      },
    ],
    [
      'entitlement grant origins',
      (input: ReturnType<typeof quoteV2Input>) => {
        input.snapshot.entitlementGrants[0].origins = input.snapshot.entitlementGrants[0].origins.filter(
          origin => origin.kind !== 'CAMPAIGN',
        )
        input.checksum = hashCanonicalJsonV2(COMMERCIAL_V2_DOMAINS.QUOTE, input.snapshot)
      },
    ],
    [
      'campaign calculation',
      (input: ReturnType<typeof quoteV2Input>) => {
        const campaign = input.authorities.campaign?.snapshot
        if (!campaign) throw new Error('Campaign fixture missing')
        const rule = campaign.rules[0]
        if (!('amount' in rule)) throw new Error('Fixed-price campaign rule fixture missing')
        rule.amount = '49.00'
        input.authorities.campaign = campaignV2Input(campaign)
      },
    ],
  ] as const)('maps a post-checksum %s authority mismatch to quote identity', (_label, mutate) => {
    const input = quoteV2Input()
    mutate(input)
    expectCode(() => decodeAndVerifyCommercialArtifact(input), 'COMMERCIAL_QUOTE_IDENTITY_MISMATCH')
  })
})
