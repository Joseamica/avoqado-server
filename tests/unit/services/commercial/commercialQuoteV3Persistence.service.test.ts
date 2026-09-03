import catalogFixture from '@/contracts/commercial/fixtures/v2/catalog-base.json'
import bridgedFixture from '@/contracts/commercial/fixtures/v3/commercial-quote-v3-bridged.json'
import directFixture from '@/contracts/commercial/fixtures/v3/commercial-quote-v3-direct.json'
import offerFixture from '@/contracts/commercial/fixtures/v3/commercial-offer-v3.json'
import { emitCommercialArtifactV2 } from '@/services/commercial/commercialArtifactCodecRegistry.service'
import { decodeAndVerifyStoredCommercialOfferV3, emitCommercialOfferV3 } from '@/services/commercial/offers/commercialOfferV3.service'
import {
  persistBridgedCommercialQuoteV3,
  persistCommercialQuoteV3,
  type CommercialQuoteV3BridgePersistenceContext,
  type CommercialQuoteV3PersistenceTransaction,
} from '@/services/commercial/quotes-v3/commercialQuoteV3Persistence.service'
import { emitCommercialQuoteV3 } from '@/services/commercial/quotes-v3/commercialQuoteV3Contract.service'
import type { CommercialCatalogSnapshotV2 } from '@/types/commercialV2'
import type { CommercialOfferSnapshotV3 } from '@/types/commercialOfferV3'
import type { CommercialQuoteSnapshotV3, CommercialQuoteV3Authorities, EmittedCommercialQuoteV3 } from '@/types/commercialQuoteV3'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function stackedOfferSource(): CommercialOfferSnapshotV3 {
  const source = clone(offerFixture) as CommercialOfferSnapshotV3
  const saas = source.benefits.find(benefit => benefit.kind === 'SAAS_PRICE')
  if (saas?.kind !== 'SAAS_PRICE') throw new Error('Expected SaaS benefit')
  saas.rules = [
    {
      code: 'A_TEN_PERCENT',
      type: 'PERCENT_OFF',
      priority: 90,
      target: { productCodes: ['POS'] },
      cycles: 3,
      percentBasisPoints: 1000,
    },
    {
      code: 'Z_FIXED_200',
      type: 'FIXED_PRICE',
      priority: 100,
      target: { productCodes: ['POS'] },
      cycles: 3,
      amount: '200.00',
    },
  ]
  saas.stackingGroups = [
    {
      code: 'POS_STACK',
      steps: [
        { position: 1, ruleCode: 'Z_FIXED_200' },
        { position: 2, ruleCode: 'A_TEN_PERCENT' },
      ],
    },
  ]
  return source
}

const catalog = emitCommercialArtifactV2({
  kind: 'CATALOG',
  schemaVersion: 2,
  domainValue: clone(catalogFixture) as CommercialCatalogSnapshotV2,
})
const emittedOffer = emitCommercialOfferV3(stackedOfferSource())
const offer: CommercialQuoteV3Authorities['offer'] = {
  rowSchemaVersion: 3,
  snapshot: emittedOffer.snapshot,
  checksum: emittedOffer.checksum,
  rowContext: {
    id: emittedOffer.snapshot.campaignVersionId,
    campaignCode: emittedOffer.snapshot.campaignCode,
    sourceRevision: emittedOffer.snapshot.version,
    schemaVersion: 3,
    publishedAt: new Date(emittedOffer.snapshot.publishedAt),
  },
}
decodeAndVerifyStoredCommercialOfferV3(offer)
const authorities: CommercialQuoteV3Authorities = { catalog, offer, acquisitionContext: null }

function emittedVenueQuote(): EmittedCommercialQuoteV3 {
  return emitCommercialQuoteV3(clone(directFixture) as CommercialQuoteSnapshotV3, authorities)
}

const bridgeContext: CommercialQuoteV3BridgePersistenceContext = {
  actorId: 'staff-bridged-v3',
  acquisitionContext: {
    id: 'acquisition-context-summer-2026',
    createdAt: new Date('2026-08-15T11:55:00.000Z'),
  },
  preview: {
    quoteId: 'commercial-quote-v3-anonymous-preview',
    checksum: '8c84f1add220c17d72d3dbf5196db734558d1cf96ed475bde786efc2f0c6d63b',
    selectionFingerprint: '934a31d9b6495822a10bb8d4d07b17920982dcf13583eea0b1f8e9e6184d9eea',
  },
}

function emittedBridgedVenueQuote(): EmittedCommercialQuoteV3 {
  return emitCommercialQuoteV3(clone(bridgedFixture) as CommercialQuoteSnapshotV3, {
    ...authorities,
    acquisitionContext: bridgeContext.acquisitionContext,
  })
}

function harness(authorityValue: CommercialQuoteV3Authorities | null = authorities) {
  const loadAuthorities = jest.fn(async () => authorityValue)
  const commercialQuote = {
    create: jest.fn(async ({ data }: { data: { id: string } }) => ({ id: data.id })),
  }
  const activityLog = { create: jest.fn(async () => ({ id: 'activity-quote-v3' })) }
  const tx = { loadAuthorities, commercialQuote, activityLog } as unknown as CommercialQuoteV3PersistenceTransaction
  return { tx, loadAuthorities, commercialQuote, activityLog }
}

describe('Commercial Quote v3 persistence', () => {
  it('persists the exact verified venue snapshot, eight bigint aggregates and explicit timestamps', async () => {
    const emitted = emittedVenueQuote()
    const { tx, loadAuthorities, commercialQuote, activityLog } = harness()

    const persisted = await persistCommercialQuoteV3(emitted, tx)

    expect(persisted).toEqual({ id: emitted.snapshot.quoteId, snapshot: emitted.snapshot, checksum: emitted.checksum })
    expect(loadAuthorities).toHaveBeenCalledWith({
      catalogPublicationId: emitted.snapshot.catalogPublicationId,
      offerVersionId: emitted.snapshot.offerVersionId,
      organizationId: emitted.snapshot.subject.kind === 'VENUE' ? emitted.snapshot.subject.organizationId : '',
      venueId: emitted.snapshot.subject.kind === 'VENUE' ? emitted.snapshot.subject.venueId : '',
    })
    expect(commercialQuote.create).toHaveBeenCalledWith({
      data: {
        id: emitted.snapshot.quoteId,
        catalogPublicationId: emitted.snapshot.catalogPublicationId,
        campaignVersionId: null,
        offerVersionId: emitted.snapshot.offerVersionId,
        offerSchemaVersion: 3,
        acquisitionContextId: null,
        organizationId: 'organization-direct-v3',
        venueId: 'venue-direct-v3',
        createdById: 'staff-direct-v3',
        schemaVersion: 3,
        market: 'MX',
        currency: 'MXN',
        snapshot: emitted.snapshot,
        checksum: emitted.checksum,
        listSubtotalMinor: 924900n,
        discountMinor: 66900n,
        subtotalMinor: 858000n,
        taxMinor: 137280n,
        totalMinor: 995280n,
        renewalSubtotalMinor: 24900n,
        renewalTaxMinor: 3984n,
        renewalTotalMinor: 28884n,
        quotedAt: new Date('2026-08-15T12:00:00.000Z'),
        expiresAt: new Date('2026-08-15T12:15:00.000Z'),
      },
    })
    expect(activityLog.create).toHaveBeenCalledWith({
      data: {
        organizationId: 'organization-direct-v3',
        venueId: 'venue-direct-v3',
        actorType: 'HUMAN',
        staffId: 'staff-direct-v3',
        actorStaffId: 'staff-direct-v3',
        action: 'COMMERCIAL_QUOTE_CREATED',
        entity: 'CommercialQuote',
        entityId: emitted.snapshot.quoteId,
        data: {
          schemaVersion: 3,
          catalogPublicationId: emitted.snapshot.catalogPublicationId,
          offerVersionId: emitted.snapshot.offerVersionId,
          totalMinor: emitted.snapshot.totals.dueNow.totalMinor,
          renewalTotalMinor: emitted.snapshot.renewal.totalMinor,
          expiresAt: emitted.snapshot.expiresAt,
        },
      },
    })
    const serializedAudit = JSON.stringify(activityLog.create.mock.calls)
    expect(serializedAudit).not.toMatch(/utm|gclid|fbclid|bearer|token|customer|email/i)
  })

  it('rejects non-venue, anonymous lineage before loading authority or writing', async () => {
    const emitted = emittedVenueQuote()
    const counterfeit = clone(emitted) as EmittedCommercialQuoteV3
    counterfeit.snapshot.subject = {
      kind: 'ACQUISITION_CONTEXT',
      acquisitionContextId: 'acquisition-anonymous',
    }
    const { tx, loadAuthorities, commercialQuote, activityLog } = harness()

    await expect(persistCommercialQuoteV3(counterfeit, tx)).rejects.toMatchObject({
      statusCode: 422,
      code: 'COMMERCIAL_QUOTE_V3_SCOPE_MISMATCH',
    })
    expect(loadAuthorities).not.toHaveBeenCalled()
    expect(commercialQuote.create).not.toHaveBeenCalled()
    expect(activityLog.create).not.toHaveBeenCalled()
  })

  it('rejects a counterfeit checksum or unavailable source authority before either write', async () => {
    const counterfeit = { ...emittedVenueQuote(), checksum: '0'.repeat(64) }
    const first = harness()
    await expect(persistCommercialQuoteV3(counterfeit, first.tx)).rejects.toMatchObject({
      statusCode: 409,
      code: 'COMMERCIAL_QUOTE_V3_CHECKSUM_MISMATCH',
    })
    expect(first.commercialQuote.create).not.toHaveBeenCalled()
    expect(first.activityLog.create).not.toHaveBeenCalled()

    const missing = harness(null)
    await expect(persistCommercialQuoteV3(emittedVenueQuote(), missing.tx)).rejects.toMatchObject({
      statusCode: 409,
      code: 'COMMERCIAL_QUOTE_V3_AUTHORITY_UNAVAILABLE',
    })
    expect(missing.commercialQuote.create).not.toHaveBeenCalled()
    expect(missing.activityLog.create).not.toHaveBeenCalled()
  })

  it('does not compensate inside the service when the same transaction rejects its ActivityLog', async () => {
    const rollback = new Error('EXPECTED_TRANSACTION_ROLLBACK')
    const { tx, commercialQuote, activityLog } = harness()
    activityLog.create.mockRejectedValue(rollback as never)

    await expect(persistCommercialQuoteV3(emittedVenueQuote(), tx)).rejects.toBe(rollback)
    expect(commercialQuote.create).toHaveBeenCalledTimes(1)
    expect(activityLog.create).toHaveBeenCalledTimes(1)
  })

  it('persists acquisition lineage only through the separate bridged entry point', async () => {
    const emitted = emittedBridgedVenueQuote()
    const acquisitionAuthorities: CommercialQuoteV3Authorities = {
      ...authorities,
      acquisitionContext: bridgeContext.acquisitionContext,
    }
    const { tx, commercialQuote } = harness(acquisitionAuthorities)

    const persisted = await persistBridgedCommercialQuoteV3(emitted, tx, bridgeContext)

    expect(persisted).toEqual({ id: emitted.snapshot.quoteId, snapshot: emitted.snapshot, checksum: emitted.checksum })
    expect(commercialQuote.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: 'commercial-quote-v3-bridged',
        acquisitionContextId: 'acquisition-context-summer-2026',
        organizationId: 'organization-bridged-v3',
        venueId: 'venue-bridged-v3',
        createdById: 'staff-bridged-v3',
        schemaVersion: 3,
      }),
    })
  })

  it.each([
    ['missing acquisition context', { acquisitionContextId: null }],
    ['missing preview provenance', { derivedFromPreview: null }],
    ['different bridge actor', { subject: { kind: 'VENUE', organizationId: 'organization-bridged-v3', venueId: 'venue-bridged-v3', actorId: 'staff-other' } }],
    [
      'different preview provenance',
      {
        derivedFromPreview: {
          previewQuoteId: 'preview-other',
          previewChecksum: bridgeContext.preview.checksum,
          selectionFingerprint: bridgeContext.preview.selectionFingerprint,
        },
      },
    ],
  ])('rejects bridged persistence with %s before loading authority or writing', async (_label, mutation) => {
    const emitted = emittedBridgedVenueQuote()
    const counterfeit = clone(emitted) as EmittedCommercialQuoteV3
    Object.assign(counterfeit.snapshot, mutation)
    const { tx, loadAuthorities, commercialQuote, activityLog } = harness({
      ...authorities,
      acquisitionContext: bridgeContext.acquisitionContext,
    })

    await expect(persistBridgedCommercialQuoteV3(counterfeit, tx, bridgeContext)).rejects.toMatchObject({
      code: 'COMMERCIAL_QUOTE_V3_LINEAGE_MISMATCH',
    })
    expect(loadAuthorities).not.toHaveBeenCalled()
    expect(commercialQuote.create).not.toHaveBeenCalled()
    expect(activityLog.create).not.toHaveBeenCalled()
  })

  it('rejects bridged persistence when the verified acquisition authority is absent or changed', async () => {
    const emitted = emittedBridgedVenueQuote()
    const { tx, commercialQuote, activityLog } = harness(authorities)

    await expect(persistBridgedCommercialQuoteV3(emitted, tx, bridgeContext)).rejects.toMatchObject({
      code: 'COMMERCIAL_QUOTE_V3_AUTHORITY_UNAVAILABLE',
    })
    expect(commercialQuote.create).not.toHaveBeenCalled()
    expect(activityLog.create).not.toHaveBeenCalled()
  })
})
