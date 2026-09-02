import catalogFixtureJson from '@/contracts/commercial/fixtures/v2/catalog-base.json'
import campaignFixtureJson from '@/contracts/commercial/fixtures/v2/campaign-pos-50.json'
import { COMMERCIAL_V2_DOMAINS } from '@/contracts/commercial/commercialContractV2.constants'
import { hashCanonicalJsonV2 } from '@/services/commercial/commercialCanonicalJsonV2.service'
import {
  createCommercialCampaignQuoteAuthorityLoader,
  type CommercialCampaignQuoteAuthorityRecord,
} from '@/services/commercial/commercialCampaignClaim.service'
import {
  createCommercialQuoteV2AuthorityService,
  type CommercialQuoteV2AuthorityContext,
} from '@/services/commercial/commercialQuoteV2Authority.service'
import type { CommercialCampaignSnapshotV2, CommercialCatalogSnapshotV2 } from '@/types/commercialV2'

const ISSUED_AT = new Date('2026-08-24T12:00:00.000Z')

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

function campaignRecord(overrides: Partial<CommercialCampaignQuoteAuthorityRecord> = {}): CommercialCampaignQuoteAuthorityRecord {
  const snapshot = JSON.parse(JSON.stringify(campaignFixtureJson)) as CommercialCampaignSnapshotV2
  return {
    activeCampaignVersionId: snapshot.campaignVersionId,
    campaignVersion: {
      id: snapshot.campaignVersionId,
      campaignCode: snapshot.campaignCode,
      sourceRevision: snapshot.version,
      schemaVersion: 2,
      snapshot,
      checksum: hashCanonicalJsonV2(COMMERCIAL_V2_DOMAINS.CAMPAIGN_SNAPSHOT, snapshot),
      publishedAt: new Date(snapshot.publishedAt),
    },
    ...overrides,
  }
}

describe('commercial campaign quote authority loader', () => {
  it('returns the exact verified active v2 campaign inside the live quote authority scope', async () => {
    const repository = { findVersionAndProductionActivation: jest.fn().mockResolvedValue(campaignRecord()) }
    const loader = createCommercialCampaignQuoteAuthorityLoader({ repository })

    const campaign = await authorityService().withVerifiedActiveCatalogV2(context =>
      loader.load(context, 'campaign-version-pos-50-v2', ISSUED_AT),
    )

    expect(campaign).toMatchObject({
      kind: 'CAMPAIGN',
      schemaVersion: 2,
      mode: 'READ_WRITE',
      snapshot: { campaignVersionId: 'campaign-version-pos-50-v2', campaignCode: 'POS_50' },
    })
    expect(repository.findVersionAndProductionActivation).toHaveBeenCalledWith('campaign-version-pos-50-v2')
  })

  it('rejects a forged authority context before querying storage', async () => {
    const repository = { findVersionAndProductionActivation: jest.fn() }
    const loader = createCommercialCampaignQuoteAuthorityLoader({ repository })

    await expect(loader.load({} as CommercialQuoteV2AuthorityContext, 'campaign-version-pos-50-v2', ISSUED_AT)).rejects.toMatchObject({
      statusCode: 500,
      code: 'COMMERCIAL_QUOTE_AUTHORITY_CONTEXT_REQUIRED',
    })
    expect(repository.findVersionAndProductionActivation).not.toHaveBeenCalled()
  })

  it.each([
    ['missing row', null],
    ['superseded activation', campaignRecord({ activeCampaignVersionId: 'campaign-version-newer' })],
    [
      'tampered snapshot',
      (() => {
        const value = campaignRecord()
        value.campaignVersion.checksum = 'f'.repeat(64)
        return value
      })(),
    ],
    [
      'inactive at issuance',
      (() => {
        const value = campaignRecord()
        ;(value.campaignVersion.snapshot as CommercialCampaignSnapshotV2).endsAt = ISSUED_AT.toISOString()
        value.campaignVersion.checksum = hashCanonicalJsonV2(
          COMMERCIAL_V2_DOMAINS.CAMPAIGN_SNAPSHOT,
          value.campaignVersion.snapshot as CommercialCampaignSnapshotV2,
        )
        return value
      })(),
    ],
  ])('maps %s to one stable campaign error', async (_label, stored) => {
    const loader = createCommercialCampaignQuoteAuthorityLoader({
      repository: { findVersionAndProductionActivation: jest.fn().mockResolvedValue(stored) },
    })

    await expect(
      authorityService().withVerifiedActiveCatalogV2(context => loader.load(context, 'campaign-version-pos-50-v2', ISSUED_AT)),
    ).rejects.toMatchObject({ statusCode: 409, code: 'COMMERCIAL_CAMPAIGN_NOT_ACTIVE' })
  })

  it('does not hide unexpected repository failures', async () => {
    const databaseFailure = new Error('database unavailable')
    const loader = createCommercialCampaignQuoteAuthorityLoader({
      repository: { findVersionAndProductionActivation: jest.fn().mockRejectedValue(databaseFailure) },
    })

    await expect(
      authorityService().withVerifiedActiveCatalogV2(context => loader.load(context, 'campaign-version-pos-50-v2', ISSUED_AT)),
    ).rejects.toBe(databaseFailure)
  })
})
