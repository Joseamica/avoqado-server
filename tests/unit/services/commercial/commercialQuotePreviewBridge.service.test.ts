import catalogFixtureJson from '@/contracts/commercial/fixtures/v2/catalog-base.json'
import campaignFixtureJson from '@/contracts/commercial/fixtures/v2/campaign-pos-50.json'
import { emitCommercialArtifactV2, type QuoteV2Result } from '@/services/commercial/commercialArtifactCodecRegistry.service'
import { evaluateCommercialQuoteV2 } from '@/services/commercial/commercialQuoteEngineV2.service'
import { buildCommercialQuoteV2 } from '@/services/commercial/commercialQuoteV2Builder.service'
import type { CommercialCampaignSnapshotV2, CommercialCatalogSnapshotV2 } from '@/types/commercialV2'

const mockLoggerInfo = jest.fn()
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: (...args: unknown[]) => mockLoggerInfo(...args) },
}))

type BridgeModule = {
  PREVIEW_QUOTE_UNIQUE_CONSTRAINT: string
  isPreviewQuoteBindingUniqueConflict(error: unknown): boolean
  recordCommercialPreviewBridgeEvent(event: { eventName: string; schemaVersion: 2; artifactKind: 'QUOTE'; code: string }): void
  createCommercialQuotePreviewBridgeService(dependencies: Record<string, unknown>): {
    bridge(input: {
      organizationId: string
      venueId: string
      actorId: string
      acquisitionBearer: string
      previewToken: string
      normalizedLines: Array<{ targetType: 'PRODUCT'; targetCode: string; priceCode: string; quantity: number }>
    }): Promise<{ outcome: 'CREATED' | 'REPLAYED'; quote: { snapshot: QuoteV2Result['snapshot']; checksum: string } }>
  }
}

function loadBridge(): BridgeModule {
  return require('@/services/commercial/commercialQuotePreviewBridge.service') as BridgeModule
}

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
const lines = [{ targetType: 'PRODUCT' as const, targetCode: 'POS', priceCode: 'POS_MONTHLY', quantity: 1 }]
const previewEvaluation = evaluateCommercialQuoteV2({
  catalog: catalog.snapshot,
  campaign: campaign.snapshot,
  lines,
  now: new Date('2026-08-24T12:00:00.000Z'),
})
const preview = buildCommercialQuoteV2({
  quoteId: 'preview-bridge-v2',
  subject: { kind: 'ACQUISITION_CONTEXT', acquisitionContextId: 'acquisition-pos-50-v2' },
  acquisitionContextId: 'acquisition-pos-50-v2',
  derivedFromPreview: null,
  quotedAt: new Date('2026-08-24T12:00:00.000Z'),
  expiresAt: new Date('2026-08-24T12:15:00.000Z'),
  evaluation: previewEvaluation,
  authorities: { catalog, campaign },
})
const selectionFingerprint = '934a31d9b6495822a10bb8d4d07b17920982dcf13583eea0b1f8e9e6184d9eea'
const payload = {
  version: 2 as const,
  previewQuoteId: preview.snapshot.quoteId,
  previewChecksum: preview.checksum,
  acquisitionContextId: 'acquisition-pos-50-v2',
  publicationId: catalog.snapshot.publicationId,
  campaignVersionId: campaign.snapshot.campaignVersionId,
  selectionFingerprint,
  issuedAt: preview.snapshot.quotedAt,
  expiresAt: preview.snapshot.expiresAt,
}
const acquisition = {
  id: 'acquisition-pos-50-v2',
  campaignVersionId: campaign.snapshot.campaignVersionId,
  channel: 'PAID_META' as const,
  attribution: { campaignCode: campaign.snapshot.campaignCode },
  createdAt: new Date('2026-08-24T11:50:00.000Z'),
  expiresAt: new Date('2026-08-31T11:50:00.000Z'),
}
const input = {
  organizationId: 'organization-bridge',
  venueId: 'venue-bridge',
  actorId: 'staff-bridge',
  acquisitionBearer: 'A'.repeat(43),
  previewToken: 'sealed-preview-token',
  normalizedLines: lines,
}

function harness() {
  const txInitial = { name: 'initial' }
  const locked = {
    now: new Date('2026-08-24T12:10:00.321Z'),
    catalog,
    campaign,
    acquisition,
    binding: null as null | Record<string, unknown>,
  }
  const dependencies = {
    secrets: { quotePreviewSigningSecret: 'q'.repeat(48), publicationPreviewSigningSecret: 'p'.repeat(48) },
    randomId: jest.fn(() => 'venue-quote-bridge-v2'),
    now: jest.fn(() => new Date('2026-08-24T12:10:00.000Z')),
    withVerifiedActiveCatalogV2: jest.fn(async (operation: (context: { catalog: typeof catalog }) => Promise<unknown>) =>
      operation({ catalog }),
    ),
    preflightAuthority: jest.fn(async () => true),
    verifyToken: jest.fn(() => payload),
    fingerprintSelection: jest.fn(() => selectionFingerprint),
    resolveAcquisition: jest.fn(async () => acquisition),
    loadCampaign: jest.fn(async () => campaign),
    reconstruct: jest.fn(() => ({ quote: preview, selectionFingerprint })),
    runInReadCommitted: jest.fn(async (operation: (tx: typeof txInitial) => Promise<unknown>) => operation(txInitial)),
    loadLockedAuthorityAndBinding: jest.fn(async () => locked),
    persistQuote: jest.fn(async (quote: QuoteV2Result) => ({
      id: quote.snapshot.quoteId,
      snapshot: quote.snapshot,
      checksum: quote.checksum,
    })),
    insertBinding: jest.fn(async () => undefined),
    recordEvent: jest.fn(),
  }
  return { dependencies, locked, txInitial }
}

describe('durable commercial preview bridge', () => {
  it('emits production telemetry with the identity-free allowlist only', () => {
    const { recordCommercialPreviewBridgeEvent } = loadBridge()
    mockLoggerInfo.mockClear()

    recordCommercialPreviewBridgeEvent({
      eventName: 'COMMERCIAL_PREVIEW_BRIDGE_CREATED',
      schemaVersion: 2,
      artifactKind: 'QUOTE',
      code: 'CREATED',
      previewToken: 'must-not-log',
      actorId: 'must-not-log',
    } as never)

    expect(mockLoggerInfo).toHaveBeenCalledWith('Commercial preview bridge outcome', {
      event: 'COMMERCIAL_PREVIEW_BRIDGE_CREATED',
      schemaVersion: 2,
      artifactKind: 'QUOTE',
      code: 'CREATED',
    })
  })

  it('reconstructs the signed preview and atomically emits one equivalent VENUE quote plus binding', async () => {
    const { createCommercialQuotePreviewBridgeService } = loadBridge()
    const { dependencies, txInitial } = harness()
    const service = createCommercialQuotePreviewBridgeService(dependencies)

    const result = await service.bridge(input)

    expect(result.outcome).toBe('CREATED')
    expect(result.quote.snapshot).toMatchObject({
      quoteId: 'venue-quote-bridge-v2',
      subject: { kind: 'VENUE', organizationId: 'organization-bridge', venueId: 'venue-bridge', actorId: 'staff-bridge' },
      acquisitionContextId: 'acquisition-pos-50-v2',
      derivedFromPreview: {
        previewQuoteId: 'preview-bridge-v2',
        previewChecksum: preview.checksum,
        selectionFingerprint,
      },
      quotedAt: '2026-08-24T12:10:00.321Z',
      expiresAt: '2026-08-24T12:25:00.321Z',
      totals: preview.snapshot.totals,
      renewal: preview.snapshot.renewal,
    })
    expect(dependencies.persistQuote).toHaveBeenCalledWith(expect.objectContaining({ kind: 'QUOTE', schemaVersion: 2 }), txInitial)
    expect(dependencies.loadLockedAuthorityAndBinding).toHaveBeenCalledWith(
      txInitial,
      expect.objectContaining({
        expectedCatalogPublicationId: catalog.snapshot.publicationId,
        expectedCatalogChecksum: catalog.checksum,
        expectedCampaignChecksum: campaign.checksum,
      }),
    )
    expect(dependencies.insertBinding).toHaveBeenCalledWith(
      txInitial,
      expect.objectContaining({
        previewQuoteId: 'preview-bridge-v2',
        venueQuoteId: 'venue-quote-bridge-v2',
        actorId: 'staff-bridge',
      }),
    )
    expect(dependencies.recordEvent).toHaveBeenCalledWith({
      eventName: 'COMMERCIAL_PREVIEW_BRIDGE_CREATED',
      schemaVersion: 2,
      artifactKind: 'QUOTE',
      code: 'CREATED',
    })
  })

  it('returns an exact verified replay without emitting, persisting or auditing again', async () => {
    const { createCommercialQuotePreviewBridgeService } = loadBridge()
    const { dependencies, locked } = harness()
    const firstService = createCommercialQuotePreviewBridgeService(dependencies)
    const created = await firstService.bridge(input)
    jest.clearAllMocks()
    locked.binding = {
      previewQuoteId: payload.previewQuoteId,
      previewChecksum: payload.previewChecksum,
      acquisitionContextId: payload.acquisitionContextId,
      organizationId: input.organizationId,
      venueId: input.venueId,
      actorId: input.actorId,
      selectionFingerprint,
      venueQuoteId: created.quote.snapshot.quoteId,
      quote: created.quote,
    }

    const replayed = await createCommercialQuotePreviewBridgeService(dependencies).bridge(input)

    expect(replayed).toEqual({ outcome: 'REPLAYED', quote: created.quote })
    expect(dependencies.randomId).not.toHaveBeenCalled()
    expect(dependencies.persistQuote).not.toHaveBeenCalled()
    expect(dependencies.insertBinding).not.toHaveBeenCalled()
    expect(dependencies.recordEvent).toHaveBeenCalledWith({
      eventName: 'COMMERCIAL_PREVIEW_BRIDGE_REPLAYED',
      schemaVersion: 2,
      artifactKind: 'QUOTE',
      code: 'REPLAYED',
    })
  })

  it('retries only the exact preview unique race and returns the winning binding', async () => {
    const { createCommercialQuotePreviewBridgeService, PREVIEW_QUOTE_UNIQUE_CONSTRAINT } = loadBridge()
    const { dependencies, locked } = harness()
    const winningQuote = {
      id: 'winner-quote',
      snapshot: buildCommercialQuoteV2({
        quoteId: 'winner-quote',
        subject: { kind: 'VENUE', organizationId: input.organizationId, venueId: input.venueId, actorId: input.actorId },
        acquisitionContextId: acquisition.id,
        derivedFromPreview: {
          previewQuoteId: payload.previewQuoteId,
          previewChecksum: payload.previewChecksum,
          selectionFingerprint,
        },
        quotedAt: new Date('2026-08-24T12:10:00.321Z'),
        expiresAt: new Date('2026-08-24T12:25:00.321Z'),
        evaluation: previewEvaluation,
        authorities: { catalog, campaign },
      }).snapshot,
      checksum: 'c'.repeat(64),
    }
    dependencies.insertBinding.mockRejectedValueOnce({ code: '23505', constraint: PREVIEW_QUOTE_UNIQUE_CONSTRAINT })
    dependencies.loadLockedAuthorityAndBinding.mockResolvedValueOnce(locked).mockResolvedValueOnce({
      ...locked,
      binding: {
        previewQuoteId: payload.previewQuoteId,
        previewChecksum: payload.previewChecksum,
        acquisitionContextId: payload.acquisitionContextId,
        organizationId: input.organizationId,
        venueId: input.venueId,
        actorId: input.actorId,
        selectionFingerprint,
        venueQuoteId: winningQuote.snapshot.quoteId,
        quote: winningQuote,
      },
    })

    const result = await createCommercialQuotePreviewBridgeService(dependencies).bridge(input)

    expect(result).toEqual({ outcome: 'REPLAYED', quote: winningQuote })
    expect(dependencies.runInReadCommitted).toHaveBeenCalledTimes(2)
  })

  it('never retries checksum or ambiguous unique failures', async () => {
    const { createCommercialQuotePreviewBridgeService, isPreviewQuoteBindingUniqueConflict } = loadBridge()
    expect(isPreviewQuoteBindingUniqueConflict({ code: '23505', constraint: 'CommercialQuote_checksum_key' })).toBe(false)
    expect(isPreviewQuoteBindingUniqueConflict({ code: 'P2002', meta: { target: ['previewQuoteId'] } })).toBe(false)
    expect(
      isPreviewQuoteBindingUniqueConflict({
        code: 'P2002',
        meta: { modelName: 'CommercialQuotePreviewBridge', target: ['previewQuoteId'] },
      }),
    ).toBe(true)
    expect(
      isPreviewQuoteBindingUniqueConflict({
        code: 'P2002',
        meta: { modelName: 'CommercialQuote', target: ['previewQuoteId'] },
      }),
    ).toBe(false)
    expect(
      isPreviewQuoteBindingUniqueConflict({
        code: 'P2002',
        meta: { modelName: 'CommercialQuotePreviewBridge', target: ['previewQuoteId', 'venueQuoteId'] },
      }),
    ).toBe(false)

    const { dependencies } = harness()
    const failure = { code: '23505', constraint: 'CommercialQuote_checksum_key' }
    dependencies.insertBinding.mockRejectedValueOnce(failure)
    await expect(createCommercialQuotePreviewBridgeService(dependencies).bridge(input)).rejects.toBe(failure)
    expect(dependencies.runInReadCommitted).toHaveBeenCalledTimes(1)
  })

  it('rejects target authority before token or engine work', async () => {
    const { createCommercialQuotePreviewBridgeService } = loadBridge()
    const { dependencies } = harness()
    dependencies.preflightAuthority.mockResolvedValue(false)

    await expect(createCommercialQuotePreviewBridgeService(dependencies).bridge(input)).rejects.toMatchObject({
      statusCode: 403,
      code: 'COMMERCIAL_PREVIEW_BRIDGE_AUTHORITY_REQUIRED',
    })
    expect(dependencies.verifyToken).not.toHaveBeenCalled()
    expect(dependencies.runInReadCommitted).not.toHaveBeenCalled()
    expect(dependencies.recordEvent).toHaveBeenCalledWith({
      eventName: 'COMMERCIAL_PREVIEW_BRIDGE_REJECTED',
      schemaVersion: 2,
      artifactKind: 'QUOTE',
      code: 'COMMERCIAL_PREVIEW_BRIDGE_AUTHORITY_REQUIRED',
    })
  })

  it('rechecks token expiry against the locked PostgreSQL clock before either binding branch', async () => {
    const { createCommercialQuotePreviewBridgeService } = loadBridge()
    const { dependencies, locked } = harness()
    locked.now = new Date('2026-08-24T12:15:00.001Z')

    await expect(createCommercialQuotePreviewBridgeService(dependencies).bridge(input)).rejects.toMatchObject({
      statusCode: 409,
      code: 'COMMERCIAL_PREVIEW_SUPERSEDED',
    })
    expect(dependencies.persistQuote).not.toHaveBeenCalled()
    expect(dependencies.insertBinding).not.toHaveBeenCalled()
  })

  it('maps a campaign that expires at the locked database clock to the stable superseded response', async () => {
    const { createCommercialQuotePreviewBridgeService } = loadBridge()
    const { dependencies, locked } = harness()
    locked.campaign = {
      ...campaign,
      snapshot: {
        ...campaign.snapshot,
        startsAt: '2026-08-24T11:00:00.000Z',
        endsAt: '2026-08-24T12:10:00.321Z',
      },
    }

    await expect(createCommercialQuotePreviewBridgeService(dependencies).bridge(input)).rejects.toMatchObject({
      statusCode: 409,
      code: 'COMMERCIAL_PREVIEW_SUPERSEDED',
    })
    expect(dependencies.persistQuote).not.toHaveBeenCalled()
    expect(dependencies.insertBinding).not.toHaveBeenCalled()
  })

  it('rejects an existing binding whose immutable preview tuple belongs to another target', async () => {
    const { createCommercialQuotePreviewBridgeService } = loadBridge()
    const { dependencies, locked } = harness()
    const created = await createCommercialQuotePreviewBridgeService(dependencies).bridge(input)
    jest.clearAllMocks()
    locked.binding = {
      previewQuoteId: payload.previewQuoteId,
      previewChecksum: payload.previewChecksum,
      acquisitionContextId: payload.acquisitionContextId,
      organizationId: 'another-organization',
      venueId: input.venueId,
      actorId: input.actorId,
      selectionFingerprint,
      venueQuoteId: created.quote.snapshot.quoteId,
      quote: created.quote,
    }

    await expect(createCommercialQuotePreviewBridgeService(dependencies).bridge(input)).rejects.toMatchObject({
      statusCode: 409,
      code: 'COMMERCIAL_PREVIEW_BRIDGE_CONFLICT',
    })
    expect(dependencies.persistQuote).not.toHaveBeenCalled()
  })

  it('rejects an existing binding whose verified quote lineage no longer matches the binding', async () => {
    const { createCommercialQuotePreviewBridgeService } = loadBridge()
    const { dependencies, locked } = harness()
    const created = await createCommercialQuotePreviewBridgeService(dependencies).bridge(input)
    jest.clearAllMocks()
    locked.binding = {
      previewQuoteId: payload.previewQuoteId,
      previewChecksum: payload.previewChecksum,
      acquisitionContextId: payload.acquisitionContextId,
      organizationId: input.organizationId,
      venueId: input.venueId,
      actorId: input.actorId,
      selectionFingerprint,
      venueQuoteId: 'different-venue-quote',
      quote: created.quote,
    }

    await expect(createCommercialQuotePreviewBridgeService(dependencies).bridge(input)).rejects.toMatchObject({
      statusCode: 409,
      code: 'COMMERCIAL_PREVIEW_BRIDGE_QUOTE_INVALID',
    })
    expect(dependencies.persistQuote).not.toHaveBeenCalled()
  })

  it('fails closed when a v3 bridge receipt is presented to the v2 reader', async () => {
    const { createCommercialQuotePreviewBridgeService } = loadBridge()
    const { dependencies, locked } = harness()
    const created = await createCommercialQuotePreviewBridgeService(dependencies).bridge(input)
    jest.clearAllMocks()
    locked.binding = {
      previewQuoteId: payload.previewQuoteId,
      previewChecksum: payload.previewChecksum,
      acquisitionContextId: payload.acquisitionContextId,
      organizationId: input.organizationId,
      venueId: input.venueId,
      actorId: input.actorId,
      selectionFingerprint,
      venueQuoteId: created.quote.snapshot.quoteId,
      quote: {
        ...created.quote,
        snapshot: { ...created.quote.snapshot, schemaVersion: 3 } as never,
      },
    }

    await expect(createCommercialQuotePreviewBridgeService(dependencies).bridge(input)).rejects.toMatchObject({
      code: 'COMMERCIAL_PREVIEW_BRIDGE_QUOTE_INVALID',
    })
  })

  it('returns the stable retry-missing response when the exact unique loser cannot load the winner', async () => {
    const { createCommercialQuotePreviewBridgeService, PREVIEW_QUOTE_UNIQUE_CONSTRAINT } = loadBridge()
    const { dependencies, locked } = harness()
    dependencies.insertBinding.mockRejectedValueOnce({ code: '23505', constraint: PREVIEW_QUOTE_UNIQUE_CONSTRAINT })
    dependencies.loadLockedAuthorityAndBinding.mockResolvedValueOnce(locked).mockResolvedValueOnce({ ...locked, binding: null })

    await expect(createCommercialQuotePreviewBridgeService(dependencies).bridge(input)).rejects.toMatchObject({
      statusCode: 409,
      code: 'COMMERCIAL_PREVIEW_BRIDGE_RETRY_MISSING',
    })
    expect(dependencies.runInReadCommitted).toHaveBeenCalledTimes(2)
  })

  it('rejects any economic drift between the sealed preview and the locked venue evaluation', async () => {
    const { createCommercialQuotePreviewBridgeService } = loadBridge()
    const { dependencies } = harness()
    dependencies.reconstruct.mockReturnValue({
      quote: {
        ...preview,
        snapshot: {
          ...preview.snapshot,
          totals: { ...preview.snapshot.totals, total: '999.00' },
        },
      },
      selectionFingerprint,
    })

    await expect(createCommercialQuotePreviewBridgeService(dependencies).bridge(input)).rejects.toMatchObject({
      statusCode: 409,
      code: 'COMMERCIAL_PREVIEW_SUPERSEDED',
    })
    expect(dependencies.persistQuote).not.toHaveBeenCalled()
    expect(dependencies.insertBinding).not.toHaveBeenCalled()
  })

  it('keeps quote creation successful when best-effort telemetry throws', async () => {
    const { createCommercialQuotePreviewBridgeService } = loadBridge()
    const { dependencies } = harness()
    dependencies.recordEvent.mockImplementation(() => {
      throw new Error('telemetry unavailable')
    })

    await expect(createCommercialQuotePreviewBridgeService(dependencies).bridge(input)).resolves.toMatchObject({ outcome: 'CREATED' })
    expect(dependencies.persistQuote).toHaveBeenCalledTimes(1)
    expect(dependencies.insertBinding).toHaveBeenCalledTimes(1)
  })
})
