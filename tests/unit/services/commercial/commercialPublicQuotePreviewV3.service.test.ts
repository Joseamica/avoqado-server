import catalogFixture from '@/contracts/commercial/fixtures/v2/catalog-base.json'
import offerFixture from '@/contracts/commercial/fixtures/v3/commercial-offer-v3.json'
import { emitCommercialArtifactV2 } from '@/services/commercial/commercialArtifactCodecRegistry.service'
import { emitCommercialOfferV3 } from '@/services/commercial/offers/commercialOfferV3.service'
import { buildCommercialQuoteV3 } from '@/services/commercial/quotes-v3/commercialQuoteV3Builder.service'
import { evaluateCommercialQuoteV3 } from '@/services/commercial/quotes-v3/commercialQuoteV3Engine.service'
import {
  createCommercialPublicQuotePreviewV3Service,
  fingerprintCommercialQuoteV3Selections,
  type CommercialPublicQuotePreviewV3Dependencies,
} from '@/services/commercial/quotes-v3/commercialPublicQuotePreviewV3.service'
import { verifyCommercialQuotePreviewTokenV3 } from '@/services/commercial/quotes-v3/commercialQuotePreviewTokenV3.service'
import type { CommercialCatalogSnapshotV2 } from '@/types/commercialV2'
import type { CommercialOfferSnapshotV3 } from '@/types/commercialOfferV3'
import type { CommercialQuoteV3Authorities } from '@/types/commercialQuoteV3'
import AppError from '@/errors/AppError'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

const catalog = emitCommercialArtifactV2({
  kind: 'CATALOG',
  schemaVersion: 2,
  domainValue: clone(catalogFixture) as CommercialCatalogSnapshotV2,
})
const offer = emitCommercialOfferV3(clone(offerFixture) as CommercialOfferSnapshotV3)
const contextCreatedAt = new Date('2026-08-15T12:34:56.789Z')
const contextExpiresAt = new Date('2026-08-22T12:34:56.789Z')
const quotedAt = new Date('2026-08-16T08:00:00.123Z')
const secrets = {
  publicationPreviewSigningSecret: 'p'.repeat(48),
  quotePreviewSigningSecret: 'q'.repeat(48),
}
const input = {
  acquisitionToken: Buffer.alloc(32, 0x41).toString('base64url'),
  saasSelections: [{ targetType: 'PRODUCT' as const, targetCode: 'POS', priceCode: 'POS_MONTHLY', quantity: 1 }],
  hardwareSelections: [] as const,
  rateBlockers: [] as const,
}

function authorities(): CommercialQuoteV3Authorities {
  return {
    catalog,
    offer: {
      rowSchemaVersion: 3,
      rowContext: {
        id: offer.snapshot.campaignVersionId,
        campaignCode: offer.snapshot.campaignCode,
        sourceRevision: offer.snapshot.version,
        schemaVersion: 3,
        publishedAt: new Date(offer.snapshot.publishedAt),
      },
      snapshot: offer.snapshot,
      checksum: offer.checksum,
    },
    acquisitionContext: { id: 'acquisition-context-v3-1', createdAt: contextCreatedAt },
  }
}

function harness() {
  const ids = ['preview-quote-v3-1', 'preview-quote-v3-2']
  const evaluate = jest.fn(evaluateCommercialQuoteV3)
  const build = jest.fn(buildCommercialQuoteV3)
  const withPinnedAuthorities = jest.fn(async (_token, operation) =>
    operation({
      acquisition: {
        id: 'acquisition-context-v3-1',
        createdAt: contextCreatedAt,
        expiresAt: contextExpiresAt,
      },
      authorities: authorities(),
      quotedAt,
    }),
  )
  const dependencies: CommercialPublicQuotePreviewV3Dependencies = {
    withPinnedAuthorities,
    evaluate,
    build,
    issuePreviewToken: jest.requireActual(
      '@/services/commercial/quotes-v3/commercialQuotePreviewTokenV3.service',
    ).issueCommercialQuotePreviewTokenV3,
    randomId: () => ids.shift() ?? 'preview-quote-v3-extra',
    secrets,
  }
  return { build, dependencies, evaluate, service: createCommercialPublicQuotePreviewV3Service(dependencies), withPinnedAuthorities }
}

describe('Commercial public Quote preview v3', () => {
  it('evaluates pinned authorities at context creation and emits an ephemeral acquisition-context Quote', async () => {
    const { build, evaluate, service, withPinnedAuthorities } = harness()
    const result = await service.preview(input)

    expect(result.quote).toMatchObject({
      schemaVersion: 3,
      quoteId: 'preview-quote-v3-1',
      subject: { kind: 'ACQUISITION_CONTEXT', acquisitionContextId: 'acquisition-context-v3-1' },
      acquisitionContextId: 'acquisition-context-v3-1',
      derivedFromPreview: null,
      catalogPublicationId: catalog.snapshot.publicationId,
      catalogChecksum: catalog.checksum,
      offerVersionId: offer.snapshot.campaignVersionId,
      offerChecksum: offer.checksum,
      quotedAt: '2026-08-16T08:00:00.123Z',
      expiresAt: '2026-08-16T08:15:00.123Z',
    })
    expect(evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        authorities: expect.objectContaining({ catalog, offer: expect.objectContaining({ checksum: offer.checksum }) }),
        resolvedAt: contextCreatedAt,
      }),
    )
    expect(build).toHaveBeenCalledWith(
      expect.objectContaining({
        acquisitionContextId: 'acquisition-context-v3-1',
        quotedAt,
        expiresAt: new Date('2026-08-16T08:15:00.123Z'),
      }),
    )
    expect(withPinnedAuthorities).toHaveBeenCalledTimes(1)
  })

  it('signs exact source checksums, selection fingerprint and quote timestamps with no money authority', async () => {
    const { service } = harness()
    const result = await service.preview(input)
    const token = verifyCommercialQuotePreviewTokenV3(result.previewToken, secrets, quotedAt)
    expect(token).toEqual({
      version: 3,
      previewQuoteId: result.quote.quoteId,
      previewChecksum: result.checksum,
      acquisitionContextId: 'acquisition-context-v3-1',
      offerVersionId: offer.snapshot.campaignVersionId,
      offerChecksum: offer.checksum,
      catalogPublicationId: catalog.snapshot.publicationId,
      catalogChecksum: catalog.checksum,
      selectionFingerprint: fingerprintCommercialQuoteV3Selections(input),
      issuedAt: result.quote.quotedAt,
      expiresAt: result.quote.expiresAt,
    })
    const decoded = Buffer.from(result.previewToken.split('.')[1], 'base64url').toString('utf8')
    expect(decoded).not.toMatch(/amount|subtotal|total|tax|renewal|price/iu)
  })

  it('materializes selections before authority access and rejects browser money', async () => {
    const { service, withPinnedAuthorities } = harness()
    await expect(service.preview({ ...input, totalMinor: '2200' } as never)).rejects.toMatchObject({
      code: 'COMMERCIAL_QUOTE_V3_INPUT_INVALID',
    })
    expect(withPinnedAuthorities).not.toHaveBeenCalled()
  })

  it('never persists a preview and regenerates it after token expiry from the same live context', async () => {
    const { service } = harness()
    const first = await service.preview(input)
    expect(() => verifyCommercialQuotePreviewTokenV3(first.previewToken, secrets, new Date(first.quote.expiresAt))).toThrow(
      expect.objectContaining({ code: 'COMMERCIAL_PREVIEW_TOKEN_EXPIRED' }),
    )
    const second = await service.preview(input)
    expect(second.quote.quoteId).toBe('preview-quote-v3-2')
    expect(second.quote.totals).toEqual(first.quote.totals)
    expect(second.quote.renewal).toEqual(first.quote.renewal)
  })

  it.each([
    ['expired context', new AppError('expired', 410, true, 'COMMERCIAL_ACQUISITION_EXPIRED')],
    ['emergency suspension', new AppError('suspended', 409, true, 'COMMERCIAL_OFFER_PENDING_SUSPENDED')],
  ])('fails closed when pinned authority loading reports %s', async (_label, failure) => {
    const { dependencies } = harness()
    dependencies.withPinnedAuthorities = jest.fn(async () => {
      throw failure
    })
    const service = createCommercialPublicQuotePreviewV3Service(dependencies)
    await expect(service.preview(input)).rejects.toBe(failure)
    expect(dependencies.evaluate).not.toHaveBeenCalled()
  })

  it('keeps the reserved Offer terms after its public claim window ends', async () => {
    const source = clone(offer.snapshot)
    source.claimEndsAt = '2026-08-16T00:00:00.000Z'
    const expiredPublicWindowOffer = emitCommercialOfferV3(source)
    const { dependencies } = harness()
    dependencies.withPinnedAuthorities = jest.fn(async (_token, operation) =>
      operation({
        acquisition: { id: 'acquisition-context-v3-1', createdAt: contextCreatedAt, expiresAt: contextExpiresAt },
        authorities: {
          ...authorities(),
          offer: {
            rowSchemaVersion: 3,
            rowContext: {
              id: expiredPublicWindowOffer.snapshot.campaignVersionId,
              campaignCode: expiredPublicWindowOffer.snapshot.campaignCode,
              sourceRevision: expiredPublicWindowOffer.snapshot.version,
              schemaVersion: 3,
              publishedAt: new Date(expiredPublicWindowOffer.snapshot.publishedAt),
            },
            snapshot: expiredPublicWindowOffer.snapshot,
            checksum: expiredPublicWindowOffer.checksum,
          },
        },
        quotedAt,
      }),
    )
    await expect(createCommercialPublicQuotePreviewV3Service(dependencies).preview(input)).resolves.toMatchObject({
      quote: { offerChecksum: expiredPublicWindowOffer.checksum },
    })
  })
})
