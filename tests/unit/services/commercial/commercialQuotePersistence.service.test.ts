import catalogFixtureJson from '@/contracts/commercial/fixtures/v2/catalog-base.json'
import campaignFixtureJson from '@/contracts/commercial/fixtures/v2/campaign-pos-50.json'
import { emitCommercialArtifactV2, type QuoteV2Result } from '@/services/commercial/commercialArtifactCodecRegistry.service'
import { evaluateCommercialQuoteV2 } from '@/services/commercial/commercialQuoteEngineV2.service'
import { buildCommercialQuoteV2 } from '@/services/commercial/commercialQuoteV2Builder.service'
import type { CommercialCampaignSnapshotV2, CommercialCatalogSnapshotV2 } from '@/types/commercialV2'

type PersistenceModule = {
  persistCommercialQuoteV2(
    result: QuoteV2Result,
    tx: {
      commercialQuote: { create(input: unknown): Promise<{ id: string }> }
      activityLog: { create(input: unknown): Promise<unknown> }
    },
  ): Promise<{ id: string; snapshot: QuoteV2Result['snapshot']; checksum: string }>
}

function loadPersistence(): PersistenceModule {
  return require('@/services/commercial/commercialQuotePersistence.service') as PersistenceModule
}

function emittedVenueQuote(): QuoteV2Result {
  const catalog = emitCommercialArtifactV2({
    kind: 'CATALOG',
    schemaVersion: 2,
    domainValue: JSON.parse(JSON.stringify(catalogFixtureJson)) as CommercialCatalogSnapshotV2,
  })
  const campaign = emitCommercialArtifactV2({
    kind: 'CAMPAIGN',
    schemaVersion: 2,
    domainValue: JSON.parse(JSON.stringify(campaignFixtureJson)) as CommercialCampaignSnapshotV2,
  })
  const evaluation = evaluateCommercialQuoteV2({
    catalog: catalog.snapshot,
    campaign: campaign.snapshot,
    lines: [{ targetType: 'PRODUCT', targetCode: 'POS', priceCode: 'POS_MONTHLY', quantity: 1 }],
    now: new Date('2026-08-24T12:00:00.000Z'),
  })
  return buildCommercialQuoteV2({
    quoteId: 'quote-persist-v2',
    subject: { kind: 'VENUE', organizationId: 'organization-persist', venueId: 'venue-persist', actorId: 'staff-persist' },
    acquisitionContextId: 'acquisition-pos-50-v2',
    derivedFromPreview: {
      previewQuoteId: 'preview-persist-v2',
      previewChecksum: 'a'.repeat(64),
      selectionFingerprint: 'b'.repeat(64),
    },
    quotedAt: new Date('2026-08-24T12:10:00.000Z'),
    expiresAt: new Date('2026-08-24T12:25:00.000Z'),
    evaluation,
    authorities: { catalog, campaign },
  })
}

function harness() {
  const commercialQuote = { create: jest.fn(async ({ data }: { data: { id: string } }) => ({ id: data.id })) }
  const activityLog = { create: jest.fn(async () => ({ id: 'audit-1' })) }
  return { tx: { commercialQuote, activityLog }, commercialQuote, activityLog }
}

describe('commercial quote v2 persistence boundary', () => {
  it('persists all identity, canonical money and timestamps only from an emitted VENUE quote', async () => {
    const emitted = emittedVenueQuote()
    const { persistCommercialQuoteV2 } = loadPersistence()
    const { tx, commercialQuote, activityLog } = harness()

    const persisted = await persistCommercialQuoteV2(emitted, tx)

    expect(persisted).toEqual({ id: 'quote-persist-v2', snapshot: emitted.snapshot, checksum: emitted.checksum })
    expect(persisted.snapshot).toBe(emitted.snapshot)
    expect(commercialQuote.create).toHaveBeenCalledWith({
      data: {
        id: 'quote-persist-v2',
        catalogPublicationId: emitted.snapshot.catalogPublicationId,
        campaignVersionId: emitted.snapshot.campaignVersionId,
        acquisitionContextId: emitted.snapshot.acquisitionContextId,
        organizationId: 'organization-persist',
        venueId: 'venue-persist',
        createdById: 'staff-persist',
        schemaVersion: 2,
        market: 'MX',
        currency: 'MXN',
        snapshot: expect.objectContaining({ quoteId: 'quote-persist-v2' }),
        checksum: emitted.checksum,
        listSubtotalMinor: 24900n,
        discountMinor: 19900n,
        subtotalMinor: 5000n,
        taxMinor: 800n,
        totalMinor: 5800n,
        renewalSubtotalMinor: 24900n,
        renewalTaxMinor: 3984n,
        renewalTotalMinor: 28884n,
        quotedAt: new Date('2026-08-24T12:10:00.000Z'),
        expiresAt: new Date('2026-08-24T12:25:00.000Z'),
      },
    })
    expect(activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: 'organization-persist',
        venueId: 'venue-persist',
        actorType: 'HUMAN',
        staffId: 'staff-persist',
        actorStaffId: 'staff-persist',
        action: 'COMMERCIAL_QUOTE_CREATED',
        entity: 'CommercialQuote',
        entityId: 'quote-persist-v2',
        data: expect.objectContaining({
          total: '58.00',
          renewalTotal: '288.84',
          expiresAt: '2026-08-24T12:25:00.000Z',
        }),
      }),
    })
    expect(JSON.stringify(activityLog.create.mock.calls)).not.toMatch(/token|bearer|secret|5800n/i)
  })

  it('rejects an unbranded lookalike before either write', async () => {
    const emitted = emittedVenueQuote()
    const counterfeit = { ...emitted }
    const { persistCommercialQuoteV2 } = loadPersistence()
    const { tx, commercialQuote, activityLog } = harness()

    await expect(persistCommercialQuoteV2(counterfeit, tx)).rejects.toMatchObject({
      code: 'COMMERCIAL_ARTIFACT_VERIFICATION_REQUIRED',
    })
    expect(commercialQuote.create).not.toHaveBeenCalled()
    expect(activityLog.create).not.toHaveBeenCalled()
  })
})
