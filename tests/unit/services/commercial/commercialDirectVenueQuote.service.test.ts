import catalogFixtureJson from '@/contracts/commercial/fixtures/v2/catalog-base.json'
import { emitCommercialArtifactV2, type QuoteV2Result } from '@/services/commercial/commercialArtifactCodecRegistry.service'
import type { CommercialCatalogSnapshotV2 } from '@/types/commercialV2'

type DirectModule = {
  createCommercialDirectVenueQuoteService(dependencies: Record<string, unknown>): {
    create(input: {
      organizationId: string
      venueId: string
      actorId: string
      lines: Array<{ targetType: 'PRODUCT'; targetCode: string; priceCode: string; quantity: number }>
    }): Promise<{ id: string; snapshot: QuoteV2Result['snapshot']; checksum: string }>
  }
}

function loadDirect(): DirectModule {
  return require('@/services/commercial/commercialDirectVenueQuote.service') as DirectModule
}

const catalog = emitCommercialArtifactV2({
  kind: 'CATALOG',
  schemaVersion: 2,
  domainValue: JSON.parse(JSON.stringify(catalogFixtureJson)) as CommercialCatalogSnapshotV2,
})

function harness() {
  const tx = { name: 'tx-direct' }
  const dependencies = {
    randomId: jest.fn(() => 'quote-direct-v2'),
    withVerifiedActiveCatalogV2: jest.fn(async (operation: (context: { catalog: typeof catalog }) => Promise<unknown>) =>
      operation({ catalog }),
    ),
    runInReadCommitted: jest.fn(async (operation: (value: typeof tx) => Promise<unknown>) => operation(tx)),
    loadLockedAuthority: jest.fn(async () => ({
      now: new Date('2026-08-28T18:00:00.123Z'),
      publicationId: catalog.snapshot.publicationId,
      catalogChecksum: catalog.checksum,
      venueOrganizationId: 'organization-direct',
    })),
    persistQuote: jest.fn(async (result: QuoteV2Result, receivedTx: unknown) => ({
      id: result.snapshot.quoteId,
      snapshot: result.snapshot,
      checksum: result.checksum,
      receivedTx,
    })),
  }
  return { dependencies, tx }
}

const input = {
  organizationId: 'organization-direct',
  venueId: 'venue-direct',
  actorId: 'staff-direct',
  lines: [{ targetType: 'PRODUCT' as const, targetCode: 'POS', priceCode: 'POS_MONTHLY', quantity: 1 }],
}

describe('direct VENUE quote v2', () => {
  it('uses one locked database clock, never a campaign, and the shared v2 persistor', async () => {
    const { createCommercialDirectVenueQuoteService } = loadDirect()
    const { dependencies, tx } = harness()
    const service = createCommercialDirectVenueQuoteService(dependencies)

    const result = await service.create(input)

    expect(dependencies.withVerifiedActiveCatalogV2).toHaveBeenCalledTimes(1)
    expect(dependencies.runInReadCommitted).toHaveBeenCalledTimes(1)
    expect(dependencies.loadLockedAuthority).toHaveBeenCalledWith(tx, {
      organizationId: 'organization-direct',
      venueId: 'venue-direct',
      expectedPublicationId: catalog.snapshot.publicationId,
    })
    expect(dependencies.persistQuote).toHaveBeenCalledWith(expect.objectContaining({ kind: 'QUOTE', schemaVersion: 2 }), tx)
    expect(result.snapshot).toMatchObject({
      quoteId: 'quote-direct-v2',
      subject: { kind: 'VENUE', organizationId: 'organization-direct', venueId: 'venue-direct', actorId: 'staff-direct' },
      acquisitionContextId: null,
      derivedFromPreview: null,
      campaignVersionId: null,
      campaignCode: null,
      quotedAt: '2026-08-28T18:00:00.123Z',
      expiresAt: '2026-08-28T18:15:00.123Z',
      totals: { total: '288.84' },
    })
  })

  it.each([
    [
      'moved catalog pointer',
      { publicationId: 'publication-moved', catalogChecksum: catalog.checksum, venueOrganizationId: 'organization-direct' },
    ],
    [
      'changed catalog bytes',
      { publicationId: catalog.snapshot.publicationId, catalogChecksum: 'f'.repeat(64), venueOrganizationId: 'organization-direct' },
    ],
    [
      'cross-organization venue',
      { publicationId: catalog.snapshot.publicationId, catalogChecksum: catalog.checksum, venueOrganizationId: 'organization-other' },
    ],
  ])('fails closed after the transactional authority recheck: %s', async (_label, locked) => {
    const { createCommercialDirectVenueQuoteService } = loadDirect()
    const { dependencies } = harness()
    dependencies.loadLockedAuthority.mockResolvedValue({ now: new Date('2026-08-28T18:00:00.123Z'), ...locked })
    const service = createCommercialDirectVenueQuoteService(dependencies)

    await expect(service.create(input)).rejects.toMatchObject({
      code:
        locked.publicationId === catalog.snapshot.publicationId && locked.catalogChecksum === catalog.checksum
          ? 'COMMERCIAL_QUOTE_SCOPE_MISMATCH'
          : 'COMMERCIAL_PREVIEW_SUPERSEDED',
    })
    expect(dependencies.persistQuote).not.toHaveBeenCalled()
  })
})
