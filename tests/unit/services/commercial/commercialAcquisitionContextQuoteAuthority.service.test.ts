import catalogFixtureJson from '@/contracts/commercial/fixtures/v2/catalog-base.json'
import { COMMERCIAL_V2_DOMAINS } from '@/contracts/commercial/commercialContractV2.constants'
import { hashCanonicalJsonV2 } from '@/services/commercial/commercialCanonicalJsonV2.service'
import { createCommercialAcquisitionContextService } from '@/services/commercial/commercialAcquisitionContext.service'
import {
  createCommercialQuoteV2AuthorityService,
  type CommercialQuoteV2AuthorityContext,
} from '@/services/commercial/commercialQuoteV2Authority.service'
import type { CommercialAcquisitionContextRecordV1 } from '@/types/commercialQuote'
import type { CommercialCatalogSnapshotV2 } from '@/types/commercialV2'

const TOKEN = 'a'.repeat(43)
const NOW = new Date('2026-08-28T12:00:00.000Z')

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

function record(overrides: Partial<CommercialAcquisitionContextRecordV1> = {}): CommercialAcquisitionContextRecordV1 {
  return {
    id: 'acquisition-context-v2',
    tokenHash: 'unused-by-test-repository',
    campaignVersionId: null,
    channel: 'DIRECT',
    attribution: {},
    createdAt: new Date('2026-08-27T12:00:00.000Z'),
    expiresAt: new Date('2026-09-04T12:00:00.000Z'),
    ...overrides,
  }
}

function acquisitionService(stored: CommercialAcquisitionContextRecordV1 | null) {
  const repository = {
    create: jest.fn(),
    findByTokenHash: jest.fn().mockResolvedValue(stored),
  }
  return {
    repository,
    service: createCommercialAcquisitionContextService({
      repository,
      resolveCampaignClaim: jest.fn(),
    }),
  }
}

describe('commercial acquisition context quote authority', () => {
  it('resolves a safe acquisition record only inside the live catalog authority scope', async () => {
    const { service, repository } = acquisitionService(record())

    const resolved = await authorityService().withVerifiedActiveCatalogV2(context => service.resolveForQuote(context, TOKEN, NOW))

    expect(resolved).toEqual({
      id: 'acquisition-context-v2',
      campaignVersionId: null,
      channel: 'DIRECT',
      attribution: {},
      createdAt: new Date('2026-08-27T12:00:00.000Z'),
      expiresAt: new Date('2026-09-04T12:00:00.000Z'),
    })
    expect(resolved).not.toHaveProperty('tokenHash')
    expect(repository.findByTokenHash).toHaveBeenCalledTimes(1)
  })

  it('rejects a forged authority context before reading the token repository', async () => {
    const { service, repository } = acquisitionService(record())

    await expect(service.resolveForQuote({} as CommercialQuoteV2AuthorityContext, TOKEN, NOW)).rejects.toMatchObject({
      statusCode: 500,
      code: 'COMMERCIAL_QUOTE_AUTHORITY_CONTEXT_REQUIRED',
    })
    expect(repository.findByTokenHash).not.toHaveBeenCalled()
  })

  it('uses intrinsic Date operations and preserves stable token errors', async () => {
    const expiredAtCutoff = record({ expiresAt: new Date(NOW) })
    Object.defineProperty(expiredAtCutoff.expiresAt, 'getTime', { value: () => Number.POSITIVE_INFINITY })
    const poisonedNow = new Date(NOW)
    Object.defineProperty(poisonedNow, 'getTime', { value: () => Number.NEGATIVE_INFINITY })
    const { service } = acquisitionService(expiredAtCutoff)

    await expect(
      authorityService().withVerifiedActiveCatalogV2(context => service.resolveForQuote(context, TOKEN, poisonedNow)),
    ).rejects.toMatchObject({ statusCode: 410, code: 'COMMERCIAL_ACQUISITION_EXPIRED' })
  })
})
