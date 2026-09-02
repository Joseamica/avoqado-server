import catalogFixtureJson from '@/contracts/commercial/fixtures/v2/catalog-base.json'
import campaignFixtureJson from '@/contracts/commercial/fixtures/v2/campaign-pos-50.json'
import acquisitionQuoteFixtureJson from '@/contracts/commercial/fixtures/v2/quote-pos-50-acquisition.json'
import venueQuoteFixtureJson from '@/contracts/commercial/fixtures/v2/quote-pos-50-venue.json'
import { emitCommercialArtifactV2 } from '@/services/commercial/commercialArtifactCodecRegistry.service'
import { evaluateCommercialQuoteV2 } from '@/services/commercial/commercialQuoteEngineV2.service'
import { buildCommercialQuoteV2 } from '@/services/commercial/commercialQuoteV2Builder.service'
import type { CommercialCampaignSnapshotV2, CommercialCatalogSnapshotV2, CommercialQuoteSnapshotV2 } from '@/types/commercialV2'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

const catalogSnapshot = clone(catalogFixtureJson) as CommercialCatalogSnapshotV2
const campaignSnapshot = clone(campaignFixtureJson) as unknown as CommercialCampaignSnapshotV2
const catalog = emitCommercialArtifactV2({ kind: 'CATALOG', schemaVersion: 2, domainValue: catalogSnapshot })
const campaign = emitCommercialArtifactV2({ kind: 'CAMPAIGN', schemaVersion: 2, domainValue: campaignSnapshot })

function pos50Evaluation() {
  return evaluateCommercialQuoteV2({
    catalog: catalog.snapshot,
    campaign: campaign.snapshot,
    lines: [{ targetType: 'PRODUCT', targetCode: 'POS', priceCode: 'POS_MONTHLY', quantity: 1 }],
    now: new Date('2026-08-24T12:00:00.000Z'),
  })
}

describe('buildCommercialQuoteV2', () => {
  it('emits the exact frozen acquisition quote snapshot and checksum', () => {
    const result = buildCommercialQuoteV2({
      quoteId: 'quote-pos-50-acquisition-v2',
      subject: { kind: 'ACQUISITION_CONTEXT', acquisitionContextId: 'acquisition-pos-50-v2' },
      acquisitionContextId: 'acquisition-pos-50-v2',
      derivedFromPreview: null,
      quotedAt: new Date('2026-08-24T12:00:00.000Z'),
      expiresAt: new Date('2026-08-24T12:15:00.000Z'),
      evaluation: pos50Evaluation(),
      authorities: { catalog, campaign },
    })

    expect(result.snapshot).toEqual(acquisitionQuoteFixtureJson as CommercialQuoteSnapshotV2)
    expect(result.checksum).toBe('3554436db0016fb80907b7a0e3d06731699020cb6b04d4ca0994e5b7e8ff59a9')
    expect(Object.isFrozen(result.snapshot)).toBe(true)
  })

  it('emits the exact frozen VENUE quote derived from the acquisition preview', () => {
    const result = buildCommercialQuoteV2({
      quoteId: 'quote-pos-50-venue-v2',
      subject: {
        kind: 'VENUE',
        organizationId: 'organization-pos-50-v2',
        venueId: 'venue-pos-50-v2',
        actorId: 'staff-pos-50-v2',
      },
      acquisitionContextId: 'acquisition-pos-50-v2',
      derivedFromPreview: {
        previewQuoteId: 'quote-pos-50-acquisition-v2',
        previewChecksum: '3554436db0016fb80907b7a0e3d06731699020cb6b04d4ca0994e5b7e8ff59a9',
        selectionFingerprint: '934a31d9b6495822a10bb8d4d07b17920982dcf13583eea0b1f8e9e6184d9eea',
      },
      quotedAt: new Date('2026-08-24T12:10:00.000Z'),
      expiresAt: new Date('2026-08-24T12:25:00.000Z'),
      evaluation: pos50Evaluation(),
      authorities: { catalog, campaign },
    })

    expect(result.snapshot).toEqual(venueQuoteFixtureJson as CommercialQuoteSnapshotV2)
    expect(result.checksum).toBe('b9cc0eb11b43c9a96f1b3623e1bb2147f263e0b692ea459357c232caaa3be0c5')
  })

  it('supports a direct VENUE quote with no acquisition or campaign lineage', () => {
    const evaluation = evaluateCommercialQuoteV2({
      catalog: catalog.snapshot,
      campaign: null,
      lines: [{ targetType: 'PRODUCT', targetCode: 'POS', priceCode: 'POS_MONTHLY', quantity: 1 }],
      now: new Date('2026-08-24T12:00:00.000Z'),
    })
    const result = buildCommercialQuoteV2({
      quoteId: 'quote-direct-venue-v2',
      subject: { kind: 'VENUE', organizationId: 'organization-direct', venueId: 'venue-direct', actorId: 'staff-direct' },
      acquisitionContextId: null,
      derivedFromPreview: null,
      quotedAt: new Date('2026-08-24T12:00:00.000Z'),
      expiresAt: new Date('2026-08-24T12:15:00.000Z'),
      evaluation,
      authorities: { catalog, campaign: null },
    })

    expect(result.snapshot).toMatchObject({
      schemaVersion: 2,
      contractVersion: '2.0.0',
      market: 'MX',
      currency: 'MXN',
      subject: { kind: 'VENUE', organizationId: 'organization-direct', venueId: 'venue-direct', actorId: 'staff-direct' },
      acquisitionContextId: null,
      derivedFromPreview: null,
      campaignVersionId: null,
      campaignCode: null,
    })
  })

  it('is byte-deterministic for identical identity, time, evaluation and authorities', () => {
    const input = {
      quoteId: 'quote-pos-50-acquisition-v2',
      subject: { kind: 'ACQUISITION_CONTEXT' as const, acquisitionContextId: 'acquisition-pos-50-v2' },
      acquisitionContextId: 'acquisition-pos-50-v2',
      derivedFromPreview: null,
      quotedAt: new Date('2026-08-24T12:00:00.000Z'),
      expiresAt: new Date('2026-08-24T12:15:00.000Z'),
      evaluation: pos50Evaluation(),
      authorities: { catalog, campaign },
    }

    const left = buildCommercialQuoteV2(input)
    const right = buildCommercialQuoteV2(input)
    expect(left.snapshot).toEqual(right.snapshot)
    expect(JSON.stringify(left.snapshot)).toBe(JSON.stringify(right.snapshot))
    expect(left.checksum).toBe(right.checksum)
  })

  it.each([
    { label: 'invalid quotedAt', quotedAt: new Date('invalid'), expiresAt: new Date('2026-08-24T12:15:00.000Z') },
    { label: 'invalid expiresAt', quotedAt: new Date('2026-08-24T12:00:00.000Z'), expiresAt: new Date('invalid') },
    { label: 'zero window', quotedAt: new Date('2026-08-24T12:00:00.000Z'), expiresAt: new Date('2026-08-24T12:00:00.000Z') },
    { label: 'negative window', quotedAt: new Date('2026-08-24T12:00:00.000Z'), expiresAt: new Date('2026-08-24T11:59:59.999Z') },
  ])('rejects $label before constructing an emitted artifact', scenario => {
    expect(() =>
      buildCommercialQuoteV2({
        quoteId: 'quote-invalid-window',
        subject: { kind: 'ACQUISITION_CONTEXT', acquisitionContextId: 'acquisition-pos-50-v2' },
        acquisitionContextId: 'acquisition-pos-50-v2',
        derivedFromPreview: null,
        quotedAt: scenario.quotedAt,
        expiresAt: scenario.expiresAt,
        evaluation: pos50Evaluation(),
        authorities: { catalog, campaign },
      }),
    ).toThrow(expect.objectContaining({ statusCode: 422, code: 'COMMERCIAL_QUOTE_INVALID_WINDOW' }))
  })

  it('rejects evaluation identity that does not match the verified authority', () => {
    const evaluation = { ...pos50Evaluation(), catalogPublicationId: 'wrong-publication' }
    expect(() =>
      buildCommercialQuoteV2({
        quoteId: 'quote-wrong-catalog',
        subject: { kind: 'ACQUISITION_CONTEXT', acquisitionContextId: 'acquisition-pos-50-v2' },
        acquisitionContextId: 'acquisition-pos-50-v2',
        derivedFromPreview: null,
        quotedAt: new Date('2026-08-24T12:00:00.000Z'),
        expiresAt: new Date('2026-08-24T12:15:00.000Z'),
        evaluation,
        authorities: { catalog, campaign },
      }),
    ).toThrow(expect.objectContaining({ code: 'COMMERCIAL_QUOTE_IDENTITY_MISMATCH' }))
  })

  it('rejects a campaign evaluation when the matching verified campaign authority is absent', () => {
    expect(() =>
      buildCommercialQuoteV2({
        quoteId: 'quote-missing-campaign-authority',
        subject: { kind: 'ACQUISITION_CONTEXT', acquisitionContextId: 'acquisition-pos-50-v2' },
        acquisitionContextId: 'acquisition-pos-50-v2',
        derivedFromPreview: null,
        quotedAt: new Date('2026-08-24T12:00:00.000Z'),
        expiresAt: new Date('2026-08-24T12:15:00.000Z'),
        evaluation: pos50Evaluation(),
        authorities: { catalog, campaign: null },
      }),
    ).toThrow(expect.objectContaining({ code: 'COMMERCIAL_QUOTE_IDENTITY_MISMATCH' }))
  })

  it('rejects invalid subject/acquisition lineage through the frozen contract', () => {
    expect(() =>
      buildCommercialQuoteV2({
        quoteId: 'quote-invalid-lineage',
        subject: { kind: 'ACQUISITION_CONTEXT', acquisitionContextId: 'subject-context' },
        acquisitionContextId: 'different-root-context',
        derivedFromPreview: null,
        quotedAt: new Date('2026-08-24T12:00:00.000Z'),
        expiresAt: new Date('2026-08-24T12:15:00.000Z'),
        evaluation: pos50Evaluation(),
        authorities: { catalog, campaign },
      }),
    ).toThrow(expect.objectContaining({ code: 'COMMERCIAL_QUOTE_SHAPE_INVALID' }))
  })

  it('rejects a caller-created lookalike authority without weakening the registry brand', () => {
    const lookalike = { ...catalog, snapshot: clone(catalog.snapshot) }
    expect(() =>
      buildCommercialQuoteV2({
        quoteId: 'quote-unbranded-authority',
        subject: { kind: 'ACQUISITION_CONTEXT', acquisitionContextId: 'acquisition-pos-50-v2' },
        acquisitionContextId: 'acquisition-pos-50-v2',
        derivedFromPreview: null,
        quotedAt: new Date('2026-08-24T12:00:00.000Z'),
        expiresAt: new Date('2026-08-24T12:15:00.000Z'),
        evaluation: pos50Evaluation(),
        authorities: { catalog: lookalike as never, campaign },
      }),
    ).toThrow(expect.objectContaining({ code: 'COMMERCIAL_ARTIFACT_VERIFICATION_REQUIRED' }))
  })
})
