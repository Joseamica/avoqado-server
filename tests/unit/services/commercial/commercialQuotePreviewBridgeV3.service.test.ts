import { Prisma, StaffRole } from '@prisma/client'

import catalogFixture from '@/contracts/commercial/fixtures/v2/catalog-base.json'
import offerFixture from '@/contracts/commercial/fixtures/v3/commercial-offer-v3.json'
import { emitCommercialArtifactV2 } from '@/services/commercial/commercialArtifactCodecRegistry.service'
import { emitCommercialOfferV3 } from '@/services/commercial/offers/commercialOfferV3.service'
import {
  createCommercialQuotePreviewBridgeV3Service,
  PREVIEW_QUOTE_V3_UNIQUE_CONSTRAINT,
  type CommercialQuotePreviewBridgeV3BindingRow,
  type CommercialQuotePreviewBridgeV3Dependencies,
  type CommercialQuotePreviewBridgeV3Transaction,
} from '@/services/commercial/quotes-v3/commercialQuotePreviewBridgeV3.service'
import { buildCommercialQuoteV3 } from '@/services/commercial/quotes-v3/commercialQuoteV3Builder.service'
import { evaluateCommercialQuoteV3 } from '@/services/commercial/quotes-v3/commercialQuoteV3Engine.service'
import { fingerprintCommercialQuoteV3Selections } from '@/services/commercial/quotes-v3/commercialPublicQuotePreviewV3.service'
import {
  issueCommercialQuotePreviewTokenV3,
  verifyCommercialQuotePreviewTokenV3,
} from '@/services/commercial/quotes-v3/commercialQuotePreviewTokenV3.service'
import type { PersistedCommercialQuoteV3 } from '@/services/commercial/quotes-v3/commercialQuoteV3Persistence.service'
import type { CommercialCatalogSnapshotV2 } from '@/types/commercialV2'
import type { CommercialOfferSnapshotV3 } from '@/types/commercialOfferV3'
import type { CommercialQuoteV3Authorities } from '@/types/commercialQuoteV3'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

const catalog = emitCommercialArtifactV2({
  kind: 'CATALOG',
  schemaVersion: 2,
  domainValue: clone(catalogFixture) as CommercialCatalogSnapshotV2,
})
const emittedOffer = emitCommercialOfferV3(clone(offerFixture) as CommercialOfferSnapshotV3)
const offer: CommercialQuoteV3Authorities['offer'] = {
  rowSchemaVersion: 3,
  rowContext: {
    id: emittedOffer.snapshot.campaignVersionId,
    campaignCode: emittedOffer.snapshot.campaignCode,
    sourceRevision: emittedOffer.snapshot.version,
    schemaVersion: 3,
    publishedAt: new Date(emittedOffer.snapshot.publishedAt),
  },
  snapshot: emittedOffer.snapshot,
  checksum: emittedOffer.checksum,
}
const context = {
  id: 'acquisition-context-bridge-v3',
  campaignVersionId: null,
  offerVersionId: offer.snapshot.campaignVersionId,
  offerSchemaVersion: 3,
  reservedCatalogPublicationId: catalog.snapshot.publicationId,
  reservedCatalogSchemaVersion: 2,
  createdAt: new Date('2026-08-15T11:55:00.000Z'),
  expiresAt: new Date('2026-08-22T11:55:00.000Z'),
}
const authorities: CommercialQuoteV3Authorities = {
  catalog,
  offer,
  acquisitionContext: { id: context.id, createdAt: context.createdAt },
}
const selections = {
  saasSelections: [{ targetType: 'PRODUCT' as const, targetCode: 'POS', priceCode: 'POS_MONTHLY', quantity: 1 }],
  hardwareSelections: [] as const,
  rateBlockers: [] as const,
}
const previewEvaluation = evaluateCommercialQuoteV3({
  authorities: { catalog, offer },
  ...selections,
  resolvedAt: context.createdAt,
})
const preview = buildCommercialQuoteV3({
  quoteId: 'preview-quote-bridge-v3',
  subject: { kind: 'ACQUISITION_CONTEXT', acquisitionContextId: context.id },
  acquisitionContextId: context.id,
  derivedFromPreview: null,
  quotedAt: new Date('2026-08-15T12:00:00.000Z'),
  expiresAt: new Date('2026-08-15T12:15:00.000Z'),
  evaluation: previewEvaluation,
  authorities,
})
const selectionFingerprint = fingerprintCommercialQuoteV3Selections(selections)
const secrets = {
  publicationPreviewSigningSecret: 'p'.repeat(48),
  quotePreviewSigningSecret: 'q'.repeat(48),
}
const previewToken = issueCommercialQuotePreviewTokenV3(
  {
    version: 3,
    previewQuoteId: preview.snapshot.quoteId,
    previewChecksum: preview.checksum,
    acquisitionContextId: context.id,
    offerVersionId: offer.snapshot.campaignVersionId,
    offerChecksum: offer.checksum,
    catalogPublicationId: catalog.snapshot.publicationId,
    catalogChecksum: catalog.checksum,
    selectionFingerprint,
    issuedAt: preview.snapshot.quotedAt,
    expiresAt: preview.snapshot.expiresAt,
  },
  secrets,
)

const input = {
  organizationId: 'organization-bridge-v3',
  venueId: 'venue-bridge-v3',
  actorId: 'staff-bridge-v3',
  acquisitionContextId: context.id,
  previewToken,
  normalizedSaasLines: selections.saasSelections,
  normalizedHardwareSelections: selections.hardwareSelections,
  rateBlockers: selections.rateBlockers,
}

function harness() {
  const locked = {
    offer,
    control: null,
    catalog,
    context: { ...context },
    binding: {
      id: 'binding-bridge-v3',
      acquisitionContextId: context.id,
      staffId: input.actorId,
      organizationId: input.organizationId,
      purpose: 'NEW_ACCOUNT' as const,
      staffCreatedAt: new Date('2026-08-15T11:56:00.000Z'),
      organizationCreatedAt: new Date('2026-08-15T11:57:00.000Z'),
      boundAt: new Date('2026-08-15T11:58:00.000Z'),
    } as CommercialQuotePreviewBridgeV3BindingRow | null,
    organization: { id: input.organizationId, createdAt: new Date('2026-08-15T11:57:00.000Z') },
    venue: { id: input.venueId, organizationId: input.organizationId, createdAt: new Date('2026-08-15T11:59:00.000Z') },
    staff: {
      id: input.actorId,
      active: true,
      commercialCreatedAt: new Date('2026-08-15T11:56:00.000Z'),
    },
    membership: {
      staffId: input.actorId,
      venueId: input.venueId,
      active: true,
      role: StaffRole.OWNER as StaffRole,
      permissionSetId: null,
    },
    permissionSet: null,
    roleOverride: null,
    now: new Date('2026-08-15T12:05:00.000Z'),
    bridge: null as null | {
      previewQuoteId: string
      previewChecksum: string
      acquisitionContextId: string
      organizationId: string
      venueId: string
      actorId: string
      selectionFingerprint: string
      venueQuoteId: string
      quote: PersistedCommercialQuoteV3
    },
  }
  const commercialQuote = {
    create: jest.fn(async ({ data }: { data: Prisma.CommercialQuoteUncheckedCreateInput }) => ({ id: data.id as string })),
  }
  const activityLog = { create: jest.fn(async () => ({ id: 'bridge-audit-v3' })) }
  const tx: CommercialQuotePreviewBridgeV3Transaction = {
    setLocalLockTimeout: jest.fn(async () => undefined),
    lockOffer: jest.fn(async () => locked.offer),
    readLatestOfferControl: jest.fn(async () => locked.control),
    lockReservedCatalog: jest.fn(async () => locked.catalog),
    lockContext: jest.fn(async () => locked.context),
    lockBinding: jest.fn(async () => locked.binding),
    lockOrganization: jest.fn(async () => locked.organization),
    lockVenue: jest.fn(async () => locked.venue),
    lockStaff: jest.fn(async () => locked.staff),
    lockMembership: jest.fn(async () => locked.membership),
    lockPermissionSet: jest.fn(async () => locked.permissionSet),
    lockRoleOverride: jest.fn(async () => locked.roleOverride),
    findVerifiedBridgeByPreviewQuoteId: jest.fn(async previewQuoteId =>
      locked.bridge?.previewQuoteId === previewQuoteId ? locked.bridge : null,
    ),
    readDatabaseClock: jest.fn(async () => locked.now),
    createBridge: jest.fn(async record => {
      locked.bridge = { ...record, quote: undefined as never }
    }),
    commercialQuote,
    activityLog,
  }
  const ids = ['venue-quote-bridge-v3', 'bridge-record-v3', 'venue-quote-regenerated-v3', 'bridge-record-regenerated-v3']
  const dependencies: CommercialQuotePreviewBridgeV3Dependencies = {
    secrets,
    now: () => new Date('2026-08-15T12:05:00.000Z'),
    verifyPreviewToken: verifyCommercialQuotePreviewTokenV3,
    fingerprintSelections: fingerprintCommercialQuoteV3Selections,
    evaluate: evaluateCommercialQuoteV3,
    build: buildCommercialQuoteV3,
    runInTransaction: jest.fn(async operation => operation(tx)),
    randomId: jest.fn(() => ids.shift() ?? 'venue-quote-extra-v3'),
    sleep: jest.fn(async () => undefined),
    retryDelayMilliseconds: () => 25,
  }
  return { activityLog, commercialQuote, dependencies, locked, tx }
}

describe('Commercial Quote preview bridge v3', () => {
  it('rebuilds pinned economics and atomically creates one Venue Quote plus immutable bridge', async () => {
    const { activityLog, dependencies, tx } = harness()
    const result = await createCommercialQuotePreviewBridgeV3Service(dependencies).bridge(input)

    expect(result.outcome).toBe('CREATED')
    expect(result.quote.snapshot).toMatchObject({
      quoteId: 'venue-quote-bridge-v3',
      subject: {
        kind: 'VENUE',
        organizationId: input.organizationId,
        venueId: input.venueId,
        actorId: input.actorId,
      },
      acquisitionContextId: context.id,
      derivedFromPreview: {
        previewQuoteId: preview.snapshot.quoteId,
        previewChecksum: preview.checksum,
        selectionFingerprint,
      },
      catalogPublicationId: catalog.snapshot.publicationId,
      catalogChecksum: catalog.checksum,
      offerVersionId: offer.snapshot.campaignVersionId,
      offerChecksum: offer.checksum,
      totals: preview.snapshot.totals,
      renewal: preview.snapshot.renewal,
      quotedAt: '2026-08-15T12:05:00.000Z',
      expiresAt: '2026-08-15T12:20:00.000Z',
    })
    expect(tx.createBridge).toHaveBeenCalledWith({
      id: expect.any(String),
      previewQuoteId: preview.snapshot.quoteId,
      previewChecksum: preview.checksum,
      acquisitionContextId: context.id,
      organizationId: input.organizationId,
      venueId: input.venueId,
      actorId: input.actorId,
      selectionFingerprint,
      venueQuoteId: result.quote.id,
    })
    expect(activityLog.create).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['unbound context', (state: ReturnType<typeof harness>['locked']) => (state.binding = null), 'COMMERCIAL_ACQUISITION_BINDING_REQUIRED'],
    ['different bound actor', (state: ReturnType<typeof harness>['locked']) => (state.binding!.staffId = 'staff-other'), 'COMMERCIAL_ACQUISITION_BINDING_CONFLICT'],
    ['different bound organization', (state: ReturnType<typeof harness>['locked']) => (state.binding!.organizationId = 'org-other'), 'COMMERCIAL_ACQUISITION_BINDING_CONFLICT'],
    ['old organization', (state: ReturnType<typeof harness>['locked']) => (state.organization.createdAt = new Date('2026-08-15T11:54:59.999Z')), 'COMMERCIAL_ACQUISITION_NEW_ACCOUNT_INELIGIBLE'],
    ['old venue', (state: ReturnType<typeof harness>['locked']) => (state.venue.createdAt = new Date('2026-08-15T11:54:59.999Z')), 'COMMERCIAL_ACQUISITION_NEW_ACCOUNT_INELIGIBLE'],
    ['cross-tenant venue', (state: ReturnType<typeof harness>['locked']) => (state.venue.organizationId = 'org-other'), 'COMMERCIAL_QUOTE_V3_TENANT_MISMATCH'],
    ['inactive membership', (state: ReturnType<typeof harness>['locked']) => (state.membership.active = false), 'COMMERCIAL_QUOTE_V3_MEMBERSHIP_INACTIVE'],
    ['missing permission', (state: ReturnType<typeof harness>['locked']) => (state.membership.role = StaffRole.VIEWER), 'COMMERCIAL_QUOTE_V3_PERMISSION_REQUIRED'],
    ['expired context', (state: ReturnType<typeof harness>['locked']) => (state.context.expiresAt = state.now), 'COMMERCIAL_ACQUISITION_EXPIRED'],
    [
      'emergency suspension',
      (state: ReturnType<typeof harness>['locked']) =>
        (state.control = { revision: 1, action: 'SUSPEND_ALL_PENDING' } as never),
      'COMMERCIAL_OFFER_PENDING_SUSPENDED',
    ],
  ])('fails closed for %s before quote and bridge writes', async (_label, mutate, code) => {
    const { dependencies, locked, tx } = harness()
    mutate(locked)

    await expect(createCommercialQuotePreviewBridgeV3Service(dependencies).bridge(input)).rejects.toMatchObject({ code })
    expect(tx.commercialQuote.create).not.toHaveBeenCalled()
    expect(tx.createBridge).not.toHaveBeenCalled()
  })

  it('rejects explicit context mismatch, stale selections and a token with different source provenance', async () => {
    const first = harness()
    await expect(
      createCommercialQuotePreviewBridgeV3Service(first.dependencies).bridge({
        ...input,
        acquisitionContextId: 'acquisition-context-other',
      }),
    ).rejects.toMatchObject({ code: 'COMMERCIAL_PREVIEW_V3_CONTEXT_MISMATCH' })
    expect(first.dependencies.runInTransaction).not.toHaveBeenCalled()

    const second = harness()
    await expect(
      createCommercialQuotePreviewBridgeV3Service(second.dependencies).bridge({
        ...input,
        normalizedSaasLines: [{ ...input.normalizedSaasLines[0], quantity: 2 }],
      }),
    ).rejects.toMatchObject({ code: 'COMMERCIAL_PREVIEW_V3_SELECTION_MISMATCH' })
    expect(second.tx.commercialQuote.create).not.toHaveBeenCalled()

    const third = harness()
    third.locked.catalog = { ...catalog, checksum: 'f'.repeat(64) }
    await expect(createCommercialQuotePreviewBridgeV3Service(third.dependencies).bridge(input)).rejects.toMatchObject({
      code: 'COMMERCIAL_PREVIEW_V3_SOURCE_MISMATCH',
    })
    expect(third.tx.commercialQuote.create).not.toHaveBeenCalled()
  })

  it('rejects a preview checksum that cannot be reproduced from pinned authorities and token timestamps', async () => {
    const { dependencies, tx } = harness()
    dependencies.build = jest.fn(inputValue => ({ ...buildCommercialQuoteV3(inputValue), checksum: '0'.repeat(64) }))

    await expect(createCommercialQuotePreviewBridgeV3Service(dependencies).bridge(input)).rejects.toMatchObject({
      code: 'COMMERCIAL_PREVIEW_V3_CHECKSUM_MISMATCH',
    })
    expect(tx.commercialQuote.create).not.toHaveBeenCalled()
    expect(tx.createBridge).not.toHaveBeenCalled()
  })

  it('uses the reserved Catalog and Offer even when active pointers have moved', async () => {
    const { dependencies, tx } = harness()
    const result = await createCommercialQuotePreviewBridgeV3Service(dependencies).bridge(input)
    expect(result.quote.snapshot.catalogChecksum).toBe(catalog.checksum)
    expect(result.quote.snapshot.offerChecksum).toBe(offer.checksum)
    expect(tx.lockReservedCatalog).toHaveBeenCalledWith(catalog.snapshot.publicationId)
    expect(tx.lockOffer).toHaveBeenCalledWith(offer.snapshot.campaignVersionId)
  })

  it('returns an exact verified replay without creating another quote, bridge or audit', async () => {
    const { dependencies, locked, tx } = harness()
    const first = await createCommercialQuotePreviewBridgeV3Service(dependencies).bridge(input)
    jest.clearAllMocks()
    locked.bridge = {
      previewQuoteId: preview.snapshot.quoteId,
      previewChecksum: preview.checksum,
      acquisitionContextId: context.id,
      organizationId: input.organizationId,
      venueId: input.venueId,
      actorId: input.actorId,
      selectionFingerprint,
      venueQuoteId: first.quote.id,
      quote: first.quote,
    }

    await expect(createCommercialQuotePreviewBridgeV3Service(dependencies).bridge(input)).resolves.toEqual({
      outcome: 'REPLAYED',
      quote: first.quote,
    })
    expect(tx.commercialQuote.create).not.toHaveBeenCalled()
    expect(tx.createBridge).not.toHaveBeenCalled()
    expect(tx.activityLog.create).not.toHaveBeenCalled()
  })

  it('fails closed when a v2 bridge receipt is presented to the v3 reader', async () => {
    const { dependencies, locked } = harness()
    const first = await createCommercialQuotePreviewBridgeV3Service(dependencies).bridge(input)
    const crossVersion = clone(first.quote) as PersistedCommercialQuoteV3
    ;(crossVersion.snapshot as { schemaVersion: number }).schemaVersion = 2
    locked.bridge = {
      previewQuoteId: preview.snapshot.quoteId,
      previewChecksum: preview.checksum,
      acquisitionContextId: context.id,
      organizationId: input.organizationId,
      venueId: input.venueId,
      actorId: input.actorId,
      selectionFingerprint,
      venueQuoteId: crossVersion.id,
      quote: crossVersion,
    }

    await expect(createCommercialQuotePreviewBridgeV3Service(dependencies).bridge(input)).rejects.toMatchObject({
      code: 'COMMERCIAL_PREVIEW_BRIDGE_V3_CONFLICT',
    })
  })

  it('allows a regenerated signed preview to create a replacement unaccepted Quote', async () => {
    const { dependencies, tx } = harness()
    await createCommercialQuotePreviewBridgeV3Service(dependencies).bridge(input)
    jest.clearAllMocks()
    const regeneratedPreview = buildCommercialQuoteV3({
      ...{
        quoteId: 'preview-quote-regenerated-v3',
        subject: { kind: 'ACQUISITION_CONTEXT' as const, acquisitionContextId: context.id },
        acquisitionContextId: context.id,
        derivedFromPreview: null,
        quotedAt: new Date('2026-08-15T12:04:00.000Z'),
        expiresAt: new Date('2026-08-15T12:19:00.000Z'),
        evaluation: previewEvaluation,
        authorities,
      },
    })
    const token = issueCommercialQuotePreviewTokenV3(
      {
        version: 3,
        previewQuoteId: regeneratedPreview.snapshot.quoteId,
        previewChecksum: regeneratedPreview.checksum,
        acquisitionContextId: context.id,
        offerVersionId: offer.snapshot.campaignVersionId,
        offerChecksum: offer.checksum,
        catalogPublicationId: catalog.snapshot.publicationId,
        catalogChecksum: catalog.checksum,
        selectionFingerprint,
        issuedAt: regeneratedPreview.snapshot.quotedAt,
        expiresAt: regeneratedPreview.snapshot.expiresAt,
      },
      secrets,
    )

    await expect(createCommercialQuotePreviewBridgeV3Service(dependencies).bridge({ ...input, previewToken: token })).resolves.toMatchObject({
      outcome: 'CREATED',
      quote: { id: 'venue-quote-regenerated-v3' },
    })
    expect(tx.commercialQuote.create).toHaveBeenCalledTimes(1)
    expect(tx.createBridge).toHaveBeenCalledTimes(1)
  })

  it('recovers only the named preview unique race and propagates an unknown unique failure', async () => {
    const exact = harness()
    const winner = await createCommercialQuotePreviewBridgeV3Service(exact.dependencies).bridge(input)
    jest.clearAllMocks()
    exact.locked.bridge = null
    exact.tx.createBridge = jest
      .fn()
      .mockRejectedValueOnce({ code: '23505', constraint: PREVIEW_QUOTE_V3_UNIQUE_CONSTRAINT })
    exact.tx.findVerifiedBridgeByPreviewQuoteId = jest.fn(async () => exact.locked.bridge)
    exact.dependencies.runInTransaction = jest
      .fn()
      .mockImplementationOnce(async operation => operation(exact.tx))
      .mockImplementationOnce(async operation => {
        exact.locked.bridge = {
          previewQuoteId: preview.snapshot.quoteId,
          previewChecksum: preview.checksum,
          acquisitionContextId: context.id,
          organizationId: input.organizationId,
          venueId: input.venueId,
          actorId: input.actorId,
          selectionFingerprint,
          venueQuoteId: winner.quote.id,
          quote: winner.quote,
        }
        return operation(exact.tx)
      })
    await expect(createCommercialQuotePreviewBridgeV3Service(exact.dependencies).bridge(input)).resolves.toEqual({
      outcome: 'REPLAYED',
      quote: winner.quote,
    })

    const unknown = harness()
    const failure = { code: '23505', constraint: 'CommercialQuote_checksum_key' }
    unknown.tx.createBridge = jest.fn(async () => {
      throw failure
    })
    await expect(createCommercialQuotePreviewBridgeV3Service(unknown.dependencies).bridge(input)).rejects.toBe(failure)
  })

  it('relies on the outer transaction to roll back quote and audit if bridge insertion fails', async () => {
    const { dependencies, tx } = harness()
    const failure = new Error('EXPECTED_BRIDGE_TRANSACTION_ROLLBACK')
    tx.createBridge = jest.fn(async () => {
      throw failure
    })

    await expect(createCommercialQuotePreviewBridgeV3Service(dependencies).bridge(input)).rejects.toBe(failure)
    expect(tx.commercialQuote.create).toHaveBeenCalledTimes(1)
    expect(tx.activityLog.create).toHaveBeenCalledTimes(1)
  })
})
