import catalogFixtureV1 from '@/contracts/commercial/fixtures/catalog-v1.json'
import campaignFixtureV1 from '@/contracts/commercial/fixtures/campaign-pos-50-v1.json'
import { createCommercialReleasePreflightService } from '@/services/commercial/commercialReleasePreflight.service'
import { hashCanonicalJsonV1 } from '@/services/master-catalog/catalogHash.service'
import type { CommercialCatalogSnapshotV1 } from '@/types/commercial'
import type { CommercialCampaignVersionV1 } from '@/types/commercialQuote'
import type { CommercialCatalogActivationOutboxRecord, CommercialCatalogPersistedRow } from '@/types/commercialCodec'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

const allowedQ3B = {
  offerControlEvents: 1,
  dedicatedClaims: 1,
  pinnedAcquisitionContexts: 1,
  acquisitionBindings: 1,
  directQuotes: 2,
  bridgedQuotes: 1,
  previewBridges: 1,
  quoteAcceptances: 2,
  acquisitionRedemptions: 1,
}
const prohibitedQ3B = {
  campaignActivations: 0,
  legacyCampaignClaims: 0,
  legacyAcquisitionContexts: 0,
  legacyCampaignLinkedQuotes: 0,
  invalidOfferQuoteShapes: 0,
  stripeOperations: 0,
  subscriptionEvents: 0,
  entitlementEffects: 0,
  hardwareOrderEffects: 0,
}

function catalogV1Row(): CommercialCatalogPersistedRow {
  const snapshot = clone(catalogFixtureV1) as CommercialCatalogSnapshotV1
  snapshot.publicationId = 'preflight-catalog-v1'
  snapshot.publishedAt = '2026-08-27T12:00:00.000Z'
  return {
    id: snapshot.publicationId,
    schemaVersion: 1,
    snapshot,
    checksum: hashCanonicalJsonV1('commercial-catalog-snapshot-v1', snapshot),
    publishedAt: new Date(snapshot.publishedAt),
  }
}

function activationEvent(publication: CommercialCatalogPersistedRow): CommercialCatalogActivationOutboxRecord {
  const dedupeKey = `commercial:activation:1:${publication.id}`
  return {
    id: 'preflight-event-1',
    eventType: 'PUBLICATION_ACTIVATED',
    publicationId: publication.id,
    previousPublicationId: null,
    payloadVersion: 1,
    payload: {
      eventId: dedupeKey,
      type: 'PUBLICATION_ACTIVATED',
      publicationId: publication.id,
      previousPublicationId: null,
      schemaVersion: publication.schemaVersion,
      checksum: publication.checksum,
      occurredAt: '2026-08-27T12:00:00.000Z',
    },
    dedupeKey,
    createdAt: new Date('2026-08-27T12:00:00.000Z'),
    publication,
    previousPublication: null,
  }
}

function campaignV1Row() {
  const snapshot = clone(campaignFixtureV1) as CommercialCampaignVersionV1
  return {
    id: snapshot.campaignVersionId,
    campaignCode: snapshot.campaignCode,
    sourceDraftId: 'preflight-campaign-draft',
    sourceRevision: snapshot.version,
    schemaVersion: 1,
    snapshot,
    checksum: hashCanonicalJsonV1('commercial-campaign-snapshot-v1', snapshot),
    publishedAt: new Date('2026-07-31T06:00:00.000Z'),
  }
}

function harness(overrides: Record<string, unknown> = {}) {
  const publication = catalogV1Row()
  const campaign = campaignV1Row()
  const tx = {
    getProductionPointer: jest.fn().mockResolvedValue({
      environment: 'PRODUCTION',
      publicationId: publication.id,
      revision: 1,
      publication,
    }),
    getActivationEvents: jest.fn().mockResolvedValue([activationEvent(publication)]),
    countPreviewCatalogPointers: jest.fn().mockResolvedValue(0),
    getActiveCampaignV1Versions: jest.fn().mockResolvedValue([campaign]),
    getNonexpiredCampaignV1Claims: jest.fn().mockResolvedValue([
      { id: 'claim-1', campaignVersionId: campaign.id, campaignVersion: campaign },
      { id: 'claim-2', campaignVersionId: campaign.id, campaignVersion: campaign },
    ]),
    countPublishedV3Versions: jest.fn().mockResolvedValue(2),
    countAllowedOfferV3Q3AReferences: jest.fn().mockResolvedValue({
      offerControlEvents: 1,
      directQuotes: 2,
      directQuoteAcceptances: 1,
    }),
    countProhibitedOfferV3Q3AReferences: jest.fn().mockResolvedValue({
      campaignActivations: 0,
      campaignClaims: 0,
      acquisitionContexts: 0,
      legacyCampaignLinkedQuotes: 0,
      invalidOfferQuoteShapes: 0,
      previewBridges: 0,
      stripeOperations: 0,
      subscriptionEvents: 0,
    }),
    countAllowedOfferV3Q3BReferences: jest.fn().mockResolvedValue(allowedQ3B),
    countProhibitedOfferV3Q3BReferences: jest.fn().mockResolvedValue(prohibitedQ3B),
    ...overrides,
  }
  const runInRepeatableRead = jest.fn(async operation => operation(tx))
  const now = jest.fn(() => new Date('2026-08-27T18:00:00.000Z'))
  return { service: createCommercialReleasePreflightService({ runInRepeatableRead, now }), tx, runInRepeatableRead, now }
}

describe('commercial release preflight', () => {
  it('verifies dense catalog history, active/claimed campaign v1 and returns a read-only receipt', async () => {
    const { service, tx, runInRepeatableRead, now } = harness()

    await expect(service.run()).resolves.toEqual({
      status: 'PASS',
      catalog: { pointerRevision: 1, chainPublications: 1, historicalV1Verified: 1 },
      campaigns: { activeV1VersionsVerified: 1, claimedV1VersionsVerified: 1, nonexpiredV1Claims: 2 },
      offerV3: {
        publishedVersions: 2,
        q3a: {
          allowed: { offerControlEvents: 1, directQuotes: 2, directQuoteAcceptances: 1 },
          prohibited: {
            campaignActivations: 0,
            campaignClaims: 0,
            acquisitionContexts: 0,
            legacyCampaignLinkedQuotes: 0,
            invalidOfferQuoteShapes: 0,
            previewBridges: 0,
            stripeOperations: 0,
            subscriptionEvents: 0,
          },
        },
        q3b: { allowed: allowedQ3B, prohibited: prohibitedQ3B },
      },
      previewCatalogPointers: 0,
      checkedAt: '2026-08-27T18:00:00.000Z',
    })
    expect(runInRepeatableRead).toHaveBeenCalledTimes(1)
    expect(tx.getActivationEvents).toHaveBeenCalledTimes(1)
    expect(tx.getNonexpiredCampaignV1Claims).toHaveBeenCalledWith(new Date('2026-08-27T18:00:00.000Z'))
    expect(now).toHaveBeenCalledTimes(1)
  })

  it('blocks release when any catalog PREVIEW pointer exists', async () => {
    const { service } = harness({ countPreviewCatalogPointers: jest.fn().mockResolvedValue(1) })

    await expect(service.run()).rejects.toMatchObject({
      code: 'COMMERCIAL_RELEASE_PREFLIGHT_FAILED',
      reason: 'PREVIEW_CATALOG_POINTER_PRESENT',
    })
  })

  it('blocks the real release gate when any Offer v3 has a prohibited Q3-B reference', async () => {
    const { service } = harness({
      countProhibitedOfferV3Q3BReferences: jest.fn().mockResolvedValue({ ...prohibitedQ3B, campaignActivations: 1 }),
    })

    await expect(service.run()).rejects.toMatchObject({
      code: 'COMMERCIAL_OFFER_V3_PROHIBITED_Q3B_REFERENCE',
      references: expect.objectContaining({ campaignActivations: 1 }),
    })
  })

  it('blocks release when a nonexpired v1 claim references an unverifiable campaign', async () => {
    const campaign = campaignV1Row()
    campaign.checksum = 'f'.repeat(64)
    const { service } = harness({
      getActiveCampaignV1Versions: jest.fn().mockResolvedValue([]),
      getNonexpiredCampaignV1Claims: jest
        .fn()
        .mockResolvedValue([{ id: 'claim-invalid', campaignVersionId: campaign.id, campaignVersion: campaign }]),
    })

    await expect(service.run()).rejects.toMatchObject({
      code: 'COMMERCIAL_RELEASE_PREFLIGHT_FAILED',
      reason: 'CAMPAIGN_V1_AUTHORITY_INVALID',
    })
  })

  it('rethrows an unknown catalog-history infrastructure failure instead of diagnosing corruption', async () => {
    const infrastructureFailure = new Error('database connection closed')
    const { service } = harness({ getActivationEvents: jest.fn().mockRejectedValue(infrastructureFailure) })

    await expect(service.run()).rejects.toBe(infrastructureFailure)
  })

  it('captures the preflight clock inside the repeatable-read snapshot', async () => {
    const publication = catalogV1Row()
    const campaign = campaignV1Row()
    const order: string[] = []
    const tx = {
      getProductionPointer: jest.fn().mockResolvedValue({
        environment: 'PRODUCTION',
        publicationId: publication.id,
        revision: 1,
        publication,
      }),
      getActivationEvents: jest.fn().mockResolvedValue([activationEvent(publication)]),
      countPreviewCatalogPointers: jest.fn().mockResolvedValue(0),
      getActiveCampaignV1Versions: jest.fn().mockResolvedValue([campaign]),
      getNonexpiredCampaignV1Claims: jest.fn().mockResolvedValue([]),
      countPublishedV3Versions: jest.fn().mockResolvedValue(0),
      countAllowedOfferV3Q3AReferences: jest.fn().mockResolvedValue({
        offerControlEvents: 0,
        directQuotes: 0,
        directQuoteAcceptances: 0,
      }),
      countProhibitedOfferV3Q3AReferences: jest.fn().mockResolvedValue({
        campaignActivations: 0,
        campaignClaims: 0,
        acquisitionContexts: 0,
        legacyCampaignLinkedQuotes: 0,
        invalidOfferQuoteShapes: 0,
        previewBridges: 0,
        stripeOperations: 0,
        subscriptionEvents: 0,
      }),
      countAllowedOfferV3Q3BReferences: jest.fn().mockResolvedValue(allowedQ3B),
      countProhibitedOfferV3Q3BReferences: jest.fn().mockResolvedValue(prohibitedQ3B),
    }
    const runInRepeatableRead = jest.fn(async operation => {
      order.push('transaction')
      return operation(tx)
    })
    const now = jest.fn(() => {
      order.push('clock')
      return new Date('2026-08-27T18:00:00.000Z')
    })
    const service = createCommercialReleasePreflightService({ runInRepeatableRead, now })

    await expect(service.run()).resolves.toMatchObject({ checkedAt: '2026-08-27T18:00:00.000Z' })
    expect(order.slice(0, 2)).toEqual(['transaction', 'clock'])
  })
})
