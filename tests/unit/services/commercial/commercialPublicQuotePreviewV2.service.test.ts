import catalogFixtureJson from '@/contracts/commercial/fixtures/v2/catalog-base.json'
import campaignFixtureJson from '@/contracts/commercial/fixtures/v2/campaign-pos-50.json'
import { COMMERCIAL_V2_DOMAINS } from '@/contracts/commercial/commercialContractV2.constants'
import AppError from '@/errors/AppError'
import { hashCanonicalJsonV2 } from '@/services/commercial/commercialCanonicalJsonV2.service'
import { decodeAndVerifyStoredCommercialCampaignV2 } from '@/services/commercial/commercialArtifactCodecRegistry.service'
import {
  createCommercialPublicQuotePreviewV2Service,
  type CommercialPublicQuotePreviewV2Dependencies,
} from '@/services/commercial/commercialPublicQuotePreviewV2.service'
import { verifyCommercialQuotePreviewTokenV2 } from '@/services/commercial/commercialQuotePreviewToken.service'
import {
  createCommercialQuoteV2AuthorityService,
  type CommercialQuoteV2AuthorityContext,
} from '@/services/commercial/commercialQuoteV2Authority.service'
import { reconstructCommercialQuotePreviewV2 } from '@/services/commercial/commercialQuotePreviewReconstruction.service'
import type { CommercialAcquisitionContextRecordV1 } from '@/types/commercialQuote'
import type { CommercialCampaignSnapshotV2, CommercialCatalogSnapshotV2 } from '@/types/commercialV2'

const NOW = new Date('2026-08-24T12:00:00.000Z')
const ACQUISITION_TOKEN = 'a'.repeat(43)
const SECRETS = {
  quotePreviewSigningSecret: 'q'.repeat(48),
  publicationPreviewSigningSecret: 'p'.repeat(48),
}
const REQUEST = {
  market: 'MX' as const,
  currency: 'MXN' as const,
  acquisitionToken: ACQUISITION_TOKEN,
  lines: [{ targetType: 'PRODUCT' as const, targetCode: 'POS', priceCode: 'POS_MONTHLY', quantity: 1 }],
}

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

function dependencies(overrides: Partial<CommercialPublicQuotePreviewV2Dependencies> = {}): CommercialPublicQuotePreviewV2Dependencies {
  const authority = authorityService()
  return {
    withVerifiedActiveCatalogV2: authority.withVerifiedActiveCatalogV2,
    resolveAcquisitionForQuote: jest.fn().mockResolvedValue(acquisition('campaign-version-pos-50-v2')),
    loadCampaignForQuote: jest.fn().mockResolvedValue(campaign()),
    reconstruct: jest.fn(reconstructCommercialQuotePreviewV2),
    issuePreviewToken: jest.fn(() => 'signed-preview-token'),
    now: jest.fn(() => new Date(NOW)),
    randomId: jest.fn(() => 'quote-pos-50-acquisition-v2'),
    recordEngineFailure: jest.fn(),
    secrets: SECRETS,
    ...overrides,
  }
}

describe('commercial public quote preview v2', () => {
  it('gates on active catalog v2, resolves exact authorities and signs only lineage data', async () => {
    const deps = dependencies()
    const service = createCommercialPublicQuotePreviewV2Service(deps)

    const result = await service.preview(REQUEST)

    expect(result.quote).toMatchObject({
      quoteId: 'quote-pos-50-acquisition-v2',
      campaignVersionId: 'campaign-version-pos-50-v2',
      totals: { subtotal: '50.00', tax: '8.00', total: '58.00' },
    })
    expect(result.previewToken).toBe('signed-preview-token')
    expect(deps.now).toHaveBeenCalledTimes(1)
    expect(deps.randomId).toHaveBeenCalledTimes(1)
    expect(deps.resolveAcquisitionForQuote).toHaveBeenCalledWith(expect.any(Object), ACQUISITION_TOKEN, NOW)
    expect(deps.loadCampaignForQuote).toHaveBeenCalledWith(expect.any(Object), 'campaign-version-pos-50-v2', NOW)
    expect(deps.issuePreviewToken).toHaveBeenCalledWith(
      {
        version: 2,
        previewQuoteId: 'quote-pos-50-acquisition-v2',
        previewChecksum: '3554436db0016fb80907b7a0e3d06731699020cb6b04d4ca0994e5b7e8ff59a9',
        acquisitionContextId: 'acquisition-pos-50-v2',
        publicationId: 'commercial-catalog-initial-v2',
        campaignVersionId: 'campaign-version-pos-50-v2',
        selectionFingerprint: '934a31d9b6495822a10bb8d4d07b17920982dcf13583eea0b1f8e9e6184d9eea',
        issuedAt: '2026-08-24T12:00:00.000Z',
        expiresAt: '2026-08-24T12:15:00.000Z',
      },
      SECRETS,
    )
    const signedPayload = (deps.issuePreviewToken as jest.Mock).mock.calls[0][0]
    expect(signedPayload).not.toHaveProperty('lines')
    expect(signedPayload).not.toHaveProperty('totals')
  })

  it('produces a verifiable HMAC token bound to the emitted quote', async () => {
    const deps = dependencies({
      issuePreviewToken: jest.requireActual('@/services/commercial/commercialQuotePreviewToken.service').issueCommercialQuotePreviewTokenV2,
    })
    const result = await createCommercialPublicQuotePreviewV2Service(deps).preview(REQUEST)

    expect(verifyCommercialQuotePreviewTokenV2(result.previewToken, SECRETS, new Date('2026-08-24T12:01:00.000Z'))).toMatchObject({
      previewQuoteId: result.quote.quoteId,
      previewChecksum: '3554436db0016fb80907b7a0e3d06731699020cb6b04d4ca0994e5b7e8ff59a9',
      acquisitionContextId: result.quote.acquisitionContextId,
      publicationId: result.quote.catalogPublicationId,
      campaignVersionId: result.quote.campaignVersionId,
    })
  })

  it('supports organic acquisition without loading a campaign', async () => {
    const deps = dependencies({ resolveAcquisitionForQuote: jest.fn().mockResolvedValue(acquisition(null)) })

    const result = await createCommercialPublicQuotePreviewV2Service(deps).preview(REQUEST)

    expect(result.quote).toMatchObject({ campaignVersionId: null, totals: { subtotal: '249.00', tax: '39.84', total: '288.84' } })
    expect(deps.loadCampaignForQuote).not.toHaveBeenCalled()
  })

  it('requires an exact acquisition bearer even for organic traffic', async () => {
    const deps = dependencies()
    const { acquisitionToken: _token, ...missingToken } = REQUEST

    await expect(createCommercialPublicQuotePreviewV2Service(deps).preview(missingToken)).rejects.toMatchObject({
      statusCode: 422,
      code: 'COMMERCIAL_ACQUISITION_REQUIRED',
    })
    expect(deps.resolveAcquisitionForQuote).not.toHaveBeenCalled()
  })

  it('checks active catalog v2 before touching input, clocks or downstream authorities', async () => {
    const catalogGateError = new AppError('catalog v2 required', 409, true, 'COMMERCIAL_QUOTE_CATALOG_V2_REQUIRED')
    const gate = jest.fn().mockRejectedValue(catalogGateError)
    const deps = dependencies({ withVerifiedActiveCatalogV2: gate })
    const poisonedInput = {}
    Object.defineProperty(poisonedInput, 'market', { enumerable: true, get: () => Promise.reject(new Error('input touched')) })

    await expect(createCommercialPublicQuotePreviewV2Service(deps).preview(poisonedInput)).rejects.toBe(catalogGateError)
    expect(gate).toHaveBeenCalledTimes(1)
    expect(deps.now).not.toHaveBeenCalled()
    expect(deps.resolveAcquisitionForQuote).not.toHaveBeenCalled()
    expect(deps.loadCampaignForQuote).not.toHaveBeenCalled()
    expect(deps.reconstruct).not.toHaveBeenCalled()
    expect(deps.issuePreviewToken).not.toHaveBeenCalled()
  })

  it('never falls back to organic when the claimed campaign authority fails', async () => {
    const campaignFailure = new AppError('campaign inactive', 409, true, 'COMMERCIAL_CAMPAIGN_NOT_ACTIVE')
    const deps = dependencies({ loadCampaignForQuote: jest.fn().mockRejectedValue(campaignFailure) })

    await expect(createCommercialPublicQuotePreviewV2Service(deps).preview(REQUEST)).rejects.toBe(campaignFailure)
    expect(deps.reconstruct).not.toHaveBeenCalled()
    expect(deps.issuePreviewToken).not.toHaveBeenCalled()
  })

  it('records only a stable engine-failure event and correlation id without masking the original error', async () => {
    const engineFailure = new Error('raw engine details must not enter telemetry')
    const recordEngineFailure = jest.fn(() => {
      throw new Error('telemetry unavailable')
    })
    const deps = dependencies({
      reconstruct: jest.fn(() => {
        throw engineFailure
      }),
      recordEngineFailure,
    })

    await expect(createCommercialPublicQuotePreviewV2Service(deps).preview(REQUEST, 'correlation-preview-v2')).rejects.toBe(engineFailure)
    expect(recordEngineFailure).toHaveBeenCalledWith({
      eventName: 'COMMERCIAL_QUOTE_PREVIEW_V2_ENGINE_FAILED',
      code: 'COMMERCIAL_QUOTE_PREVIEW_V2_ENGINE_FAILED',
      correlationId: 'correlation-preview-v2',
    })
    expect(JSON.stringify(recordEngineFailure.mock.calls)).not.toContain(ACQUISITION_TOKEN)
    expect(JSON.stringify(recordEngineFailure.mock.calls)).not.toContain('raw engine details')
  })

  it('does not permit a forged context through the real acquisition resolver', async () => {
    const resolver = jest.fn(async (context: CommercialQuoteV2AuthorityContext) => {
      expect(context).toEqual(expect.any(Object))
      return acquisition(null)
    })
    const deps = dependencies({ resolveAcquisitionForQuote: resolver })

    await expect(createCommercialPublicQuotePreviewV2Service(deps).preview(REQUEST)).resolves.toHaveProperty('quote')
    expect(resolver).toHaveBeenCalledTimes(1)
  })
})
