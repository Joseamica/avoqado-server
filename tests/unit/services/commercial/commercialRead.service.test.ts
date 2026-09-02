import commercialFixture from '@/contracts/commercial/fixtures/catalog-v1.json'
import commercialV2Fixture from '@/contracts/commercial/fixtures/v2/catalog-base.json'
import { createCommercialReadService, prismaCommercialReadDependencies } from '@/services/commercial/commercialRead.service'

describe('commercial public catalog compatibility fallback', () => {
  it('wires the verified catalog authority into the production read dependencies', () => {
    expect(prismaCommercialReadDependencies.resolveVerifiedActiveCatalog).toEqual(expect.any(Function))
  })

  it('uses the verified authority decision for an active v2 catalog instead of the legacy history lookup', async () => {
    const resolveVerifiedActiveCatalog = jest.fn().mockResolvedValue({
      catalog: {
        kind: 'CATALOG',
        schemaVersion: 2,
        mode: 'READ_WRITE',
        snapshot: commercialV2Fixture,
        checksum: 'c'.repeat(64),
        money: { prices: [] },
      },
      fallback: null,
    })
    const service = createCommercialReadService({
      resolveVerifiedActiveCatalog,
    })

    const result = await service.getActiveCommercialCatalog(new Date('2026-08-22T12:00:00.000Z'))

    expect(result).toEqual({
      snapshot: commercialV2Fixture,
      etag: `"${'c'.repeat(64)}"`,
      fallback: null,
    })
    expect(resolveVerifiedActiveCatalog).toHaveBeenCalledTimes(1)
  })

  it('returns a verified cache hit without reopening the authority transaction', async () => {
    const resolveVerifiedActiveCatalog = jest.fn().mockResolvedValue({
      catalog: { snapshot: commercialFixture, checksum: 'a'.repeat(64) },
      fallback: null,
    })
    const service = createCommercialReadService({ resolveVerifiedActiveCatalog })

    const first = await service.getActiveCommercialCatalog(new Date('2026-08-22T12:00:00.000Z'))
    const cached = await service.getActiveCommercialCatalog(new Date('2026-08-22T12:00:59.999Z'))

    expect(cached).toEqual(first)
    expect(resolveVerifiedActiveCatalog).toHaveBeenCalledTimes(1)
  })

  it('uses the checksum of the exact proved fallback artifact as its ETag', async () => {
    const service = createCommercialReadService({
      resolveVerifiedActiveCatalog: jest.fn().mockResolvedValue({
        catalog: { snapshot: commercialV2Fixture, checksum: 'd'.repeat(64) },
        fallback: {
          fallbackUsed: true,
          activePublicationId: 'catalog-future',
          fallbackPublicationId: commercialV2Fixture.publicationId,
          incidentCode: 'COMMERCIAL_CATALOG_CONTRACT_UNSUPPORTED',
        },
      }),
    })

    const result = await service.getActiveCommercialCatalog()

    expect(result).toMatchObject({
      snapshot: commercialV2Fixture,
      etag: `"${'d'.repeat(64)}"`,
      fallback: {
        activePublicationId: 'catalog-future',
        servedPublicationId: commercialV2Fixture.publicationId,
        reason: 'ACTIVE_SCHEMA_INCOMPATIBLE',
      },
    })
  })

  it('does not cache the absence of an active catalog', async () => {
    const resolveVerifiedActiveCatalog = jest
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        catalog: { snapshot: commercialFixture, checksum: 'a'.repeat(64) },
        fallback: null,
      })
    const service = createCommercialReadService({ resolveVerifiedActiveCatalog })

    await expect(service.getActiveCommercialCatalog()).resolves.toBeNull()
    await expect(service.getActiveCommercialCatalog()).resolves.toMatchObject({ snapshot: commercialFixture })
    expect(resolveVerifiedActiveCatalog).toHaveBeenCalledTimes(2)
  })
})
