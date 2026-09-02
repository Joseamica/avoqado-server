import catalogFixtureJson from '@/contracts/commercial/fixtures/v2/catalog-base.json'
import campaignFixtureJson from '@/contracts/commercial/fixtures/v2/campaign-pos-50.json'
import { COMMERCIAL_V2_DOMAINS } from '@/contracts/commercial/commercialContractV2.constants'
import { hashCanonicalJsonV2 } from '@/services/commercial/commercialCanonicalJsonV2.service'
import { decodeAndVerifyStoredCommercialCampaignV2 } from '@/services/commercial/commercialArtifactCodecRegistry.service'
import {
  createCommercialQuoteV2AuthorityService,
  type CommercialQuoteV2AuthorityContext,
} from '@/services/commercial/commercialQuoteV2Authority.service'
import { reconstructCommercialQuotePreviewV2 } from '@/services/commercial/commercialQuotePreviewReconstruction.service'
import type { CommercialAcquisitionContextRecordV1 } from '@/types/commercialQuote'
import type { CommercialCampaignSnapshotV2, CommercialCatalogSnapshotV2 } from '@/types/commercialV2'

const ISSUED_AT = new Date('2026-08-24T12:00:00.000Z')
const EXPIRES_AT = new Date('2026-08-24T12:15:00.000Z')
const LINES = [{ targetType: 'PRODUCT' as const, targetCode: 'POS', priceCode: 'POS_MONTHLY', quantity: 1 }]

function authorityService() {
  const snapshot = JSON.parse(JSON.stringify(catalogFixtureJson)) as CommercialCatalogSnapshotV2
  return createCommercialQuoteV2AuthorityService({
    loadProductionCatalogPointer: async () => ({
      environment: 'PRODUCTION',
      publicationId: snapshot.publicationId,
      revision: 1,
      publication: {
        id: snapshot.publicationId,
        schemaVersion: 2,
        snapshot,
        checksum: hashCanonicalJsonV2(COMMERCIAL_V2_DOMAINS.CATALOG_SNAPSHOT, snapshot),
        publishedAt: new Date(snapshot.publishedAt),
      },
    }),
  })
}

function acquisition(campaignVersionId: string | null): Omit<CommercialAcquisitionContextRecordV1, 'tokenHash'> {
  return {
    id: 'acquisition-pos-50-v2',
    campaignVersionId,
    channel: campaignVersionId ? 'PAID_META' : 'DIRECT',
    attribution: {},
    createdAt: new Date('2026-08-23T12:00:00.000Z'),
    expiresAt: new Date('2026-08-30T12:00:00.000Z'),
  }
}

function campaign() {
  const snapshot = JSON.parse(JSON.stringify(campaignFixtureJson)) as CommercialCampaignSnapshotV2
  return decodeAndVerifyStoredCommercialCampaignV2({
    kind: 'CAMPAIGN',
    rowSchemaVersion: 2,
    snapshot,
    checksum: hashCanonicalJsonV2(COMMERCIAL_V2_DOMAINS.CAMPAIGN_SNAPSHOT, snapshot),
    rowContext: {
      kind: 'CAMPAIGN',
      id: snapshot.campaignVersionId,
      campaignCode: snapshot.campaignCode,
      sourceRevision: snapshot.version,
      schemaVersion: 2,
      publishedAt: new Date(snapshot.publishedAt),
    },
  })
}

describe('commercial quote preview reconstruction', () => {
  it('emits the deterministic acquisition quote from verified catalog and campaign authorities', async () => {
    const result = await authorityService().withVerifiedActiveCatalogV2(context =>
      reconstructCommercialQuotePreviewV2({
        authorityContext: context,
        acquisition: acquisition('campaign-version-pos-50-v2'),
        campaign: campaign(),
        lines: LINES,
        previewQuoteId: 'quote-pos-50-acquisition-v2',
        issuedAt: ISSUED_AT,
        expiresAt: EXPIRES_AT,
      }),
    )

    expect(result.quote.snapshot).toMatchObject({
      quoteId: 'quote-pos-50-acquisition-v2',
      subject: { kind: 'ACQUISITION_CONTEXT', acquisitionContextId: 'acquisition-pos-50-v2' },
      acquisitionContextId: 'acquisition-pos-50-v2',
      catalogPublicationId: 'commercial-catalog-initial-v2',
      campaignVersionId: 'campaign-version-pos-50-v2',
      quotedAt: ISSUED_AT.toISOString(),
      expiresAt: EXPIRES_AT.toISOString(),
      totals: { listSubtotal: '249.00', discount: '199.00', subtotal: '50.00', tax: '8.00', total: '58.00' },
    })
    expect(result.quote.checksum).toBe('3554436db0016fb80907b7a0e3d06731699020cb6b04d4ca0994e5b7e8ff59a9')
    expect(result.selectionFingerprint).toBe('934a31d9b6495822a10bb8d4d07b17920982dcf13583eea0b1f8e9e6184d9eea')
  })

  it('reconstructs an organic quote with no campaign authority', async () => {
    const result = await authorityService().withVerifiedActiveCatalogV2(context =>
      reconstructCommercialQuotePreviewV2({
        authorityContext: context,
        acquisition: acquisition(null),
        campaign: null,
        lines: LINES,
        previewQuoteId: 'quote-organic-v2',
        issuedAt: ISSUED_AT,
        expiresAt: EXPIRES_AT,
      }),
    )

    expect(result.quote.snapshot).toMatchObject({
      campaignVersionId: null,
      campaignCode: null,
      totals: { subtotal: '249.00', tax: '39.84', total: '288.84' },
    })
  })

  it('accepts only an exact signed-preview expectation, including checksum and selection', async () => {
    await authorityService().withVerifiedActiveCatalogV2(async context => {
      const input = {
        authorityContext: context,
        acquisition: acquisition('campaign-version-pos-50-v2'),
        campaign: campaign(),
        lines: LINES,
        previewQuoteId: 'quote-pos-50-acquisition-v2',
        issuedAt: ISSUED_AT,
        expiresAt: EXPIRES_AT,
      }
      const initial = reconstructCommercialQuotePreviewV2(input)
      const expected = {
        version: 2 as const,
        previewQuoteId: initial.quote.snapshot.quoteId,
        previewChecksum: initial.quote.checksum,
        acquisitionContextId: initial.quote.snapshot.acquisitionContextId!,
        publicationId: initial.quote.snapshot.catalogPublicationId,
        campaignVersionId: initial.quote.snapshot.campaignVersionId,
        selectionFingerprint: initial.selectionFingerprint,
        issuedAt: initial.quote.snapshot.quotedAt,
        expiresAt: initial.quote.snapshot.expiresAt,
      }

      expect(reconstructCommercialQuotePreviewV2({ ...input, expected })).toEqual(initial)

      for (const changed of [
        { ...expected, version: 3 as 2 },
        { ...expected, previewQuoteId: 'quote-other-preview-v2' },
        { ...expected, previewChecksum: 'f'.repeat(64) },
        { ...expected, acquisitionContextId: 'acquisition-other-preview-v2' },
        { ...expected, selectionFingerprint: 'e'.repeat(64) },
        { ...expected, publicationId: 'catalog-superseded' },
        { ...expected, campaignVersionId: null },
        { ...expected, issuedAt: '2026-08-24T11:59:59.999Z' },
        { ...expected, expiresAt: '2026-08-24T12:15:00.001Z' },
      ]) {
        expect(() => reconstructCommercialQuotePreviewV2({ ...input, expected: changed })).toThrow(
          expect.objectContaining({ statusCode: 409, code: 'COMMERCIAL_PREVIEW_SUPERSEDED' }),
        )
      }
    })
  })

  it('rejects acquisition/campaign lineage mismatch before emitting a quote', async () => {
    await expect(
      authorityService().withVerifiedActiveCatalogV2(context =>
        reconstructCommercialQuotePreviewV2({
          authorityContext: context,
          acquisition: acquisition(null),
          campaign: campaign(),
          lines: LINES,
          previewQuoteId: 'quote-mismatch-v2',
          issuedAt: ISSUED_AT,
          expiresAt: EXPIRES_AT,
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: 'COMMERCIAL_PREVIEW_SUPERSEDED' })
  })

  it('requires the exact fifteen-minute window using intrinsic Date operations', async () => {
    const poisonedIssuedAt = new Date(ISSUED_AT)
    Object.defineProperty(poisonedIssuedAt, 'getTime', { value: () => 0 })
    const wrongExpiry = new Date('2026-08-24T12:14:59.999Z')

    await expect(
      authorityService().withVerifiedActiveCatalogV2(context =>
        reconstructCommercialQuotePreviewV2({
          authorityContext: context,
          acquisition: acquisition(null),
          campaign: null,
          lines: LINES,
          previewQuoteId: 'quote-window-v2',
          issuedAt: poisonedIssuedAt,
          expiresAt: wrongExpiry,
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: 'COMMERCIAL_PREVIEW_SUPERSEDED' })
  })

  it('rejects a forged authority context before evaluating any commercial line', () => {
    expect(() =>
      reconstructCommercialQuotePreviewV2({
        authorityContext: {} as CommercialQuoteV2AuthorityContext,
        acquisition: acquisition(null),
        campaign: null,
        lines: LINES,
        previewQuoteId: 'quote-forged-v2',
        issuedAt: ISSUED_AT,
        expiresAt: EXPIRES_AT,
      }),
    ).toThrow(expect.objectContaining({ statusCode: 500, code: 'COMMERCIAL_QUOTE_AUTHORITY_CONTEXT_REQUIRED' }))
  })
})
