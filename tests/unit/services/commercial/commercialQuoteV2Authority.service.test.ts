import catalogV1FixtureJson from '@/contracts/commercial/fixtures/catalog-v1.json'
import catalogV2FixtureJson from '@/contracts/commercial/fixtures/v2/catalog-base.json'
import campaignV2FixtureJson from '@/contracts/commercial/fixtures/v2/campaign-pos-50.json'
import acquisitionQuoteV2FixtureJson from '@/contracts/commercial/fixtures/v2/quote-pos-50-acquisition.json'
import { COMMERCIAL_V2_DOMAINS } from '@/contracts/commercial/commercialContractV2.constants'
import { hashCanonicalJsonV1 } from '@/services/master-catalog/catalogHash.service'
import { hashCanonicalJsonV2 } from '@/services/commercial/commercialCanonicalJsonV2.service'
import { emitCommercialArtifactV2 } from '@/services/commercial/commercialArtifactCodecRegistry.service'
import { evaluateCommercialQuoteV2 } from '@/services/commercial/commercialQuoteEngineV2.service'
import { buildCommercialQuoteV2 } from '@/services/commercial/commercialQuoteV2Builder.service'
import {
  assertCommercialQuoteV2AuthorityContext,
  createCommercialQuoteV2AuthorityService,
  type CommercialQuoteV2AuthorityContext,
} from '@/services/commercial/commercialQuoteV2Authority.service'
import type { CommercialCatalogAuthorityPointer } from '@/services/commercial/commercialCatalogAuthority.service'
import type { CommercialCatalogSnapshotV1 } from '@/types/commercial'
import type { CommercialCatalogSnapshotV2 } from '@/types/commercialV2'
import type { CommercialCampaignSnapshotV2, CommercialQuoteSnapshotV2 } from '@/types/commercialV2'

function activeV1Pointer(): CommercialCatalogAuthorityPointer {
  const snapshot = JSON.parse(JSON.stringify(catalogV1FixtureJson)) as CommercialCatalogSnapshotV1
  snapshot.publicationId = 'catalog-active-v1-for-quote'
  snapshot.publishedAt = '2026-08-27T12:00:00.000Z'
  const publication = {
    id: snapshot.publicationId,
    schemaVersion: 1,
    snapshot,
    checksum: hashCanonicalJsonV1('commercial-catalog-snapshot-v1', snapshot),
    publishedAt: new Date(snapshot.publishedAt),
  }
  return { environment: 'PRODUCTION', publicationId: publication.id, revision: 7, publication }
}

function activeV2Pointer(): CommercialCatalogAuthorityPointer {
  const snapshot = JSON.parse(JSON.stringify(catalogV2FixtureJson)) as CommercialCatalogSnapshotV2
  snapshot.publicationId = 'catalog-active-v2-for-quote'
  snapshot.publishedAt = '2026-08-27T12:00:00.000Z'
  const publication = {
    id: snapshot.publicationId,
    schemaVersion: 2,
    snapshot,
    checksum: hashCanonicalJsonV2(COMMERCIAL_V2_DOMAINS.CATALOG_SNAPSHOT, snapshot),
    publishedAt: new Date(snapshot.publishedAt),
  }
  return { environment: 'PRODUCTION', publicationId: publication.id, revision: 8, publication }
}

function fixtureV2Pointer(): CommercialCatalogAuthorityPointer {
  const snapshot = JSON.parse(JSON.stringify(catalogV2FixtureJson)) as CommercialCatalogSnapshotV2
  const publication = {
    id: snapshot.publicationId,
    schemaVersion: 2,
    snapshot,
    checksum: hashCanonicalJsonV2(COMMERCIAL_V2_DOMAINS.CATALOG_SNAPSHOT, snapshot),
    publishedAt: new Date(snapshot.publishedAt),
  }
  return { environment: 'PRODUCTION', publicationId: publication.id, revision: 8, publication }
}

function serviceFor(pointer: CommercialCatalogAuthorityPointer | null | Error) {
  const loadProductionCatalogPointer =
    pointer instanceof Error ? jest.fn().mockRejectedValue(pointer) : jest.fn().mockResolvedValue(pointer)
  return {
    service: createCommercialQuoteV2AuthorityService({ loadProductionCatalogPointer }),
    loadProductionCatalogPointer,
  }
}

describe('commercial quote v2 authority', () => {
  it('rejects an active verified v1 catalog with exact 409 before invoking the callback', async () => {
    const loadProductionCatalogPointer = jest.fn().mockResolvedValue(activeV1Pointer())
    const callback = jest.fn()
    const service = createCommercialQuoteV2AuthorityService({ loadProductionCatalogPointer })

    await expect(service.withVerifiedActiveCatalogV2(callback)).rejects.toMatchObject({
      statusCode: 409,
      code: 'COMMERCIAL_QUOTE_CATALOG_V2_REQUIRED',
    })
    expect(loadProductionCatalogPointer).toHaveBeenCalledTimes(1)
    expect(callback).not.toHaveBeenCalled()
  })

  it('invokes the callback exactly once with the exact verified active v2 artifact', async () => {
    const pointer = activeV2Pointer()
    const { service, loadProductionCatalogPointer } = serviceFor(pointer)
    const callback = jest.fn((context: CommercialQuoteV2AuthorityContext) => {
      expect(() => assertCommercialQuoteV2AuthorityContext(context)).not.toThrow()
      expect(context.catalog).toMatchObject({
        kind: 'CATALOG',
        schemaVersion: 2,
        mode: 'READ_WRITE',
        checksum: pointer.publication.checksum,
      })
      expect(context.catalog.snapshot.publicationId).toBe(pointer.publicationId)
      return context.catalog
    })

    await expect(service.withVerifiedActiveCatalogV2(callback)).resolves.toMatchObject({ checksum: pointer.publication.checksum })
    expect(loadProductionCatalogPointer).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledTimes(1)
  })

  it.each([
    { label: 'missing pointer', pointer: null },
    {
      label: 'non-production environment',
      pointer: { ...activeV2Pointer(), environment: 'PREVIEW' as 'PRODUCTION' },
    },
    { label: 'empty publication id', pointer: { ...activeV2Pointer(), publicationId: '' } },
    { label: 'non-positive revision', pointer: { ...activeV2Pointer(), revision: 0 } },
    { label: 'unsafe revision', pointer: { ...activeV2Pointer(), revision: Number.MAX_SAFE_INTEGER + 1 } },
    { label: 'pointer and row mismatch', pointer: { ...activeV2Pointer(), publicationId: 'different-publication' } },
    {
      label: 'missing joined publication row',
      pointer: { ...activeV2Pointer(), publication: undefined } as unknown as CommercialCatalogAuthorityPointer,
    },
    {
      label: 'malformed catalog',
      pointer: (() => {
        const pointer = activeV2Pointer()
        pointer.publication.snapshot = { schemaVersion: 2 }
        return pointer
      })(),
    },
    {
      label: 'checksum mismatch',
      pointer: (() => {
        const pointer = activeV2Pointer()
        pointer.publication.checksum = 'f'.repeat(64)
        return pointer
      })(),
    },
    {
      label: 'future contract',
      pointer: (() => {
        const pointer = activeV2Pointer()
        const snapshot = pointer.publication.snapshot as CommercialCatalogSnapshotV2
        snapshot.contractVersion = '3.0.0' as '2.0.0'
        pointer.publication.checksum = hashCanonicalJsonV2(COMMERCIAL_V2_DOMAINS.CATALOG_SNAPSHOT, snapshot)
        return pointer
      })(),
    },
    {
      label: 'unsupported schema',
      pointer: (() => {
        const pointer = activeV2Pointer()
        pointer.publication.schemaVersion = 99
        return pointer
      })(),
    },
  ])('maps $label to exact 503 before callback', async scenario => {
    const { service, loadProductionCatalogPointer } = serviceFor(scenario.pointer)
    const callback = jest.fn()

    await expect(service.withVerifiedActiveCatalogV2(callback)).rejects.toMatchObject({
      statusCode: 503,
      code: 'COMMERCIAL_CATALOG_UNAVAILABLE',
    })
    expect(loadProductionCatalogPointer).toHaveBeenCalledTimes(1)
    expect(callback).not.toHaveBeenCalled()
  })

  it('revokes a retained context after a successful callback', async () => {
    const { service } = serviceFor(activeV2Pointer())
    let retained: CommercialQuoteV2AuthorityContext | null = null

    await service.withVerifiedActiveCatalogV2(context => {
      retained = context
      expect(() => assertCommercialQuoteV2AuthorityContext(context)).not.toThrow()
    })

    expect(() => assertCommercialQuoteV2AuthorityContext(retained)).toThrow(
      expect.objectContaining({ statusCode: 500, code: 'COMMERCIAL_QUOTE_AUTHORITY_CONTEXT_REQUIRED', isOperational: false }),
    )
  })

  it('revokes a retained context when the callback throws and rethrows the same error', async () => {
    const { service } = serviceFor(activeV2Pointer())
    const sentinel = new Error('downstream failed')
    let retained: CommercialQuoteV2AuthorityContext | null = null

    await expect(
      service.withVerifiedActiveCatalogV2(context => {
        retained = context
        throw sentinel
      }),
    ).rejects.toBe(sentinel)
    expect(() => assertCommercialQuoteV2AuthorityContext(retained)).toThrow(
      expect.objectContaining({ statusCode: 500, code: 'COMMERCIAL_QUOTE_AUTHORITY_CONTEXT_REQUIRED', isOperational: false }),
    )
  })

  it('rejects a caller-created lookalike context', () => {
    expect(() => assertCommercialQuoteV2AuthorityContext({ catalog: {} })).toThrow(
      expect.objectContaining({ statusCode: 500, code: 'COMMERCIAL_QUOTE_AUTHORITY_CONTEXT_REQUIRED', isOperational: false }),
    )
  })

  it('rejects a context borrowed from another concurrently active authority scope', async () => {
    const first = serviceFor(activeV2Pointer()).service
    const second = serviceFor(activeV2Pointer()).service
    let releaseFirst!: () => void
    let firstStarted!: () => void
    const firstRelease = new Promise<void>(resolve => {
      releaseFirst = resolve
    })
    const firstReady = new Promise<void>(resolve => {
      firstStarted = resolve
    })
    let firstContext: CommercialQuoteV2AuthorityContext | null = null

    const firstOperation = first.withVerifiedActiveCatalogV2(async context => {
      firstContext = context
      expect(() => assertCommercialQuoteV2AuthorityContext(context)).not.toThrow()
      firstStarted()
      await firstRelease
      expect(() => assertCommercialQuoteV2AuthorityContext(context)).not.toThrow()
    })

    await firstReady
    expect(() => assertCommercialQuoteV2AuthorityContext(firstContext)).toThrow(
      expect.objectContaining({ statusCode: 500, code: 'COMMERCIAL_QUOTE_AUTHORITY_CONTEXT_REQUIRED', isOperational: false }),
    )
    await second.withVerifiedActiveCatalogV2(secondContext => {
      expect(() => assertCommercialQuoteV2AuthorityContext(secondContext)).not.toThrow()
      expect(() => assertCommercialQuoteV2AuthorityContext(firstContext)).toThrow(
        expect.objectContaining({ statusCode: 500, code: 'COMMERCIAL_QUOTE_AUTHORITY_CONTEXT_REQUIRED', isOperational: false }),
      )
    })
    releaseFirst()
    await firstOperation
  })

  it('composes the decoded production catalog through evaluation and the sole quote builder', async () => {
    const { service } = serviceFor(fixtureV2Pointer())
    const campaign = emitCommercialArtifactV2({
      kind: 'CAMPAIGN',
      schemaVersion: 2,
      domainValue: JSON.parse(JSON.stringify(campaignV2FixtureJson)) as CommercialCampaignSnapshotV2,
    })

    const result = await service.withVerifiedActiveCatalogV2(context => {
      assertCommercialQuoteV2AuthorityContext(context)
      const evaluation = evaluateCommercialQuoteV2({
        catalog: context.catalog.snapshot,
        campaign: campaign.snapshot,
        lines: [{ targetType: 'PRODUCT', targetCode: 'POS', priceCode: 'POS_MONTHLY', quantity: 1 }],
        now: new Date('2026-08-24T12:00:00.000Z'),
      })
      return buildCommercialQuoteV2({
        quoteId: 'quote-pos-50-acquisition-v2',
        subject: { kind: 'ACQUISITION_CONTEXT', acquisitionContextId: 'acquisition-pos-50-v2' },
        acquisitionContextId: 'acquisition-pos-50-v2',
        derivedFromPreview: null,
        quotedAt: new Date('2026-08-24T12:00:00.000Z'),
        expiresAt: new Date('2026-08-24T12:15:00.000Z'),
        evaluation,
        authorities: { catalog: context.catalog, campaign },
      })
    })

    expect(result.snapshot).toEqual(acquisitionQuoteV2FixtureJson as CommercialQuoteSnapshotV2)
    expect(result.checksum).toBe('3554436db0016fb80907b7a0e3d06731699020cb6b04d4ca0994e5b7e8ff59a9')
  })

  it('rethrows an unknown infrastructure failure unchanged', async () => {
    const sentinel = new Error('database unavailable')
    const { service } = serviceFor(sentinel)
    await expect(service.withVerifiedActiveCatalogV2(jest.fn())).rejects.toBe(sentinel)
  })
})
