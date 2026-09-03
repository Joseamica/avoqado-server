import catalogFixture from '@/contracts/commercial/fixtures/v2/catalog-base.json'
import offerFixture from '@/contracts/commercial/fixtures/v3/commercial-offer-v3.json'
import { emitCommercialArtifactV2 } from '@/services/commercial/commercialArtifactCodecRegistry.service'
import {
  createCommercialConfiguratorDashboardService,
  type CommercialConfiguratorDashboardDependencies,
} from '@/services/commercial/configurator/commercialConfiguratorDashboard.service'
import { emitCommercialOfferV3 } from '@/services/commercial/offers/commercialOfferV3.service'
import type { CommercialCatalogSnapshotV2 } from '@/types/commercialV2'
import type { CommercialOfferSnapshotV3 } from '@/types/commercialOfferV3'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function catalogRow() {
  const emitted = emitCommercialArtifactV2({
    kind: 'CATALOG',
    schemaVersion: 2,
    domainValue: clone(catalogFixture) as CommercialCatalogSnapshotV2,
  })
  return {
    id: emitted.snapshot.publicationId,
    schemaVersion: 2,
    snapshot: emitted.snapshot,
    checksum: emitted.checksum,
    publishedAt: new Date(emitted.snapshot.publishedAt),
  }
}

function offerRow(overrides: Partial<CommercialOfferSnapshotV3> = {}) {
  const source = { ...(clone(offerFixture) as CommercialOfferSnapshotV3), ...overrides }
  const emitted = emitCommercialOfferV3(source)
  return {
    id: emitted.snapshot.campaignVersionId,
    campaignCode: emitted.snapshot.campaignCode,
    sourceRevision: emitted.snapshot.version,
    schemaVersion: 3,
    snapshot: emitted.snapshot,
    checksum: emitted.checksum,
    publishedAt: new Date(emitted.snapshot.publishedAt),
  }
}

function dependencies(overrides: Partial<CommercialConfiguratorDashboardDependencies> = {}) {
  const tx = {
    readDatabaseClock: jest.fn().mockResolvedValue(new Date('2026-08-15T12:00:00.000Z')),
    findVenue: jest.fn().mockResolvedValue({ id: 'venue-1', organizationId: 'org-1' }),
    findActiveCatalog: jest.fn().mockResolvedValue(catalogRow()),
    findLatestContractOffer: jest.fn().mockResolvedValue({
      offerVersionId: (offerFixture as CommercialOfferSnapshotV3).campaignVersionId,
      offerCode: (offerFixture as CommercialOfferSnapshotV3).campaignCode,
      contractStatus: 'ACTIVE',
    }),
    findOffer: jest.fn().mockResolvedValue(offerRow()),
    findLatestOfferControl: jest.fn().mockResolvedValue(null),
  }
  const deps: CommercialConfiguratorDashboardDependencies = {
    runInRepeatableRead: jest.fn(async operation => operation(tx)),
    ...overrides,
  }
  return { deps, tx }
}

const customSelection = {
  mode: 'CUSTOM' as const,
  billingUnit: 'VENUE_MONTH' as const,
  moduleCodes: ['CFDI_MODULE'],
}

describe('commercial configurator Dashboard authority', () => {
  it('applies only the offer already bound to this venue contract', async () => {
    const { deps, tx } = dependencies()
    const service = createCommercialConfiguratorDashboardService(deps)

    const result = await service.preview({ organizationId: 'org-1', venueId: 'venue-1', selection: customSelection })

    expect(result).toMatchObject({
      schemaVersion: 1,
      state: 'READY',
      pricing: {
        state: 'BOUND_OFFER_APPLIED',
        offerVersionId: 'commercial-offer-version-summer-2026-v3',
        offerCode: 'SUMMER_2026',
      },
      preview: {
        offer: { offerCode: 'SUMMER_2026' },
        quote: { today: { totalMinor: '26564' }, renewal: { totalMinor: '49648' } },
      },
    })
    expect(tx.findOffer).toHaveBeenCalledWith('commercial-offer-version-summer-2026-v3')
  })

  it('fails closed when the requested venue is outside the authenticated organization', async () => {
    const { deps } = dependencies()
    const service = createCommercialConfiguratorDashboardService(deps)

    await expect(
      service.preview({ organizationId: 'org-other', venueId: 'venue-1', selection: customSelection }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'COMMERCIAL_CONFIGURATOR_VENUE_NOT_FOUND' })
  })

  it('shows list pricing explicitly when a formerly bound offer can no longer be claimed', async () => {
    const { deps } = dependencies()
    const service = createCommercialConfiguratorDashboardService(deps)
    const result = await service.preview(
      { organizationId: 'org-1', venueId: 'venue-1', selection: customSelection },
      { now: new Date('2026-09-02T12:00:00.000Z') },
    )

    expect(result).toMatchObject({
      state: 'READY',
      pricing: {
        state: 'BOUND_OFFER_UNAVAILABLE',
        offerVersionId: 'commercial-offer-version-summer-2026-v3',
        offerCode: 'SUMMER_2026',
        reason: 'CLAIM_WINDOW_ENDED',
      },
      preview: {
        offer: null,
        quote: { today: { totalMinor: '49648' }, renewal: { totalMinor: '49648' } },
      },
    })
  })

  it.each([
    {
      label: 'missing',
      configure: (tx: ReturnType<typeof dependencies>['tx']) => tx.findOffer.mockResolvedValue(null),
      now: new Date('2026-08-15T12:00:00.000Z'),
      reason: 'OFFER_NOT_FOUND',
    },
    {
      label: 'inactive',
      configure: (tx: ReturnType<typeof dependencies>['tx']) => tx.findOffer.mockResolvedValue(offerRow({ status: 'INACTIVE' })),
      now: new Date('2026-08-15T12:00:00.000Z'),
      reason: 'OFFER_NOT_ACTIVE',
    },
    {
      label: 'not started',
      configure: (_tx: ReturnType<typeof dependencies>['tx']) => undefined,
      now: new Date('2026-07-15T12:00:00.000Z'),
      reason: 'CLAIM_WINDOW_NOT_STARTED',
    },
    {
      label: 'suspended',
      configure: (tx: ReturnType<typeof dependencies>['tx']) =>
        tx.findLatestOfferControl.mockResolvedValue({ revision: 1, action: 'SUSPEND_ALL_PENDING' }),
      now: new Date('2026-08-15T12:00:00.000Z'),
      reason: 'OFFER_SUSPENDED',
    },
  ])('degrades an unavailable $label bound offer explicitly to list price', async ({ configure, now, reason }) => {
    const { deps, tx } = dependencies()
    configure(tx)
    const service = createCommercialConfiguratorDashboardService(deps)

    const result = await service.preview(
      { organizationId: 'org-1', venueId: 'venue-1', selection: customSelection },
      { now },
    )

    expect(result.pricing).toMatchObject({ state: 'BOUND_OFFER_UNAVAILABLE', reason })
    expect(result.preview.offer).toBeNull()
    expect(result.preview.quote.today.totalMinor).toBe('49648')
  })

  it('fails closed when the database clock or active catalog authority is unavailable', async () => {
    const clock = dependencies()
    clock.tx.readDatabaseClock.mockResolvedValue(new Date(Number.NaN))
    await expect(
      createCommercialConfiguratorDashboardService(clock.deps).preview({
        organizationId: 'org-1',
        venueId: 'venue-1',
        selection: customSelection,
      }),
    ).rejects.toMatchObject({ code: 'COMMERCIAL_CONFIGURATOR_CLOCK_INVALID' })

    const catalog = dependencies()
    catalog.tx.findActiveCatalog.mockResolvedValue(null)
    await expect(
      createCommercialConfiguratorDashboardService(catalog.deps).preview({
        organizationId: 'org-1',
        venueId: 'venue-1',
        selection: customSelection,
      }),
    ).rejects.toMatchObject({ code: 'COMMERCIAL_CONFIGURATOR_CATALOG_UNAVAILABLE' })
  })

  it('fails closed when the contract-bound offer identity differs from its immutable publication', async () => {
    const { deps, tx } = dependencies()
    tx.findLatestContractOffer.mockResolvedValue({
      offerVersionId: (offerFixture as CommercialOfferSnapshotV3).campaignVersionId,
      offerCode: 'DIFFERENT_OFFER',
      contractStatus: 'ACTIVE',
    })

    await expect(
      createCommercialConfiguratorDashboardService(deps).preview({
        organizationId: 'org-1',
        venueId: 'venue-1',
        selection: customSelection,
      }),
    ).rejects.toMatchObject({ code: 'COMMERCIAL_CONFIGURATOR_AUTHORITY_INVALID' })
  })

  it('never carries a promotion forward from a canceled contract', async () => {
    const { deps, tx } = dependencies()
    tx.findLatestContractOffer.mockResolvedValue({
      offerVersionId: (offerFixture as CommercialOfferSnapshotV3).campaignVersionId,
      offerCode: (offerFixture as CommercialOfferSnapshotV3).campaignCode,
      contractStatus: 'CANCELED',
    })
    const service = createCommercialConfiguratorDashboardService(deps)

    const result = await service.preview({ organizationId: 'org-1', venueId: 'venue-1', selection: customSelection })

    expect(result.pricing).toEqual({ state: 'LIST_PRICE' })
    expect(result.preview.offer).toBeNull()
    expect(tx.findOffer).not.toHaveBeenCalled()
  })

  it('does not downgrade silently to list price when catalog or offer integrity is invalid', async () => {
    const broken = offerRow()
    broken.checksum = '0'.repeat(64)
    const { deps } = dependencies()
    const service = createCommercialConfiguratorDashboardService({
      ...deps,
      runInRepeatableRead: operation =>
        deps.runInRepeatableRead(async tx => operation({ ...tx, findOffer: jest.fn().mockResolvedValue(broken) })),
    })

    await expect(
      service.preview({ organizationId: 'org-1', venueId: 'venue-1', selection: customSelection }),
    ).rejects.toMatchObject({ code: 'COMMERCIAL_CONFIGURATOR_AUTHORITY_INVALID' })
  })
})
