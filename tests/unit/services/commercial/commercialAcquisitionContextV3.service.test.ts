import { createHash } from 'node:crypto'
import { Prisma } from '@prisma/client'

import catalogFixture from '@/contracts/commercial/fixtures/v2/catalog-base.json'
import offerFixture from '@/contracts/commercial/fixtures/v3/commercial-offer-v3.json'
import { emitCommercialArtifactV2 } from '@/services/commercial/commercialArtifactCodecRegistry.service'
import { emitCommercialOfferV3 } from '@/services/commercial/offers/commercialOfferV3.service'
import {
  createCommercialAcquisitionContextV3Service,
  type CommercialAcquisitionContextV3Transaction,
} from '@/services/commercial/quotes-v3/commercialAcquisitionContextV3.service'
import type { CommercialCatalogSnapshotV2 } from '@/types/commercialV2'
import type { CommercialOfferSnapshotV3 } from '@/types/commercialOfferV3'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

const offer = emitCommercialOfferV3(clone(offerFixture) as CommercialOfferSnapshotV3)
const catalog = emitCommercialArtifactV2({
  kind: 'CATALOG',
  schemaVersion: 2,
  domainValue: clone(catalogFixture) as CommercialCatalogSnapshotV2,
})
const claimBytes = Buffer.alloc(32, 0x43)
const offerClaim = claimBytes.toString('base64url')
const contextBytes = Buffer.alloc(32, 0x41)
const contextToken = contextBytes.toString('base64url')
const databaseNow = new Date('2026-08-15T12:34:56.789Z')

function offerRow() {
  return {
    id: offer.snapshot.campaignVersionId,
    campaignCode: offer.snapshot.campaignCode,
    sourceRevision: offer.snapshot.version,
    schemaVersion: 3,
    snapshot: offer.snapshot,
    checksum: offer.checksum,
    publishedAt: new Date(offer.snapshot.publishedAt),
  }
}

function catalogRow() {
  return {
    id: catalog.snapshot.publicationId,
    schemaVersion: 2,
    snapshot: catalog.snapshot,
    checksum: catalog.checksum,
    publishedAt: new Date(catalog.snapshot.publishedAt),
  }
}

function offerClaimHash(): string {
  return createHash('sha256')
    .update(Buffer.concat([Buffer.from('avoqado.commercial.offer-claim@3\0', 'ascii'), claimBytes]))
    .digest('hex')
}

function acquisitionContextHash(): string {
  return createHash('sha256')
    .update(Buffer.concat([Buffer.from('avoqado.commercial.acquisition-context@3\0', 'ascii'), contextBytes]))
    .digest('hex')
}

function harness() {
  const calls: string[] = []
  const contexts = new Map<string, any>()
  const claim = {
    id: 'offer-claim-v3-1',
    tokenHash: offerClaimHash(),
    campaignVersionId: null,
    campaignCode: null,
    offerVersionId: offer.snapshot.campaignVersionId,
    offerSchemaVersion: 3 as const,
    channel: 'PAID_META' as const,
    sourceRef: 'meta:cdmx:restaurants',
    issuedById: 'publisher-v3',
    reason: 'Campaña aprobada',
    createdAt: new Date('2026-08-10T12:00:00.000Z'),
    expiresAt: new Date('2026-08-20T12:00:00.000Z'),
  }
  const tx: CommercialAcquisitionContextV3Transaction = {
    setLocalLockTimeout: jest.fn(async milliseconds => {
      calls.push(`timeout:${milliseconds}`)
    }),
    findClaimByTokenHash: jest.fn(async hash => {
      calls.push(`claim:${hash}`)
      return hash === claim.tokenHash ? claim : null
    }),
    lockOffer: jest.fn(async id => {
      calls.push(`offer:${id}`)
      return id === offer.snapshot.campaignVersionId ? offerRow() : null
    }),
    readLatestOfferControl: jest.fn(async id => {
      calls.push(`control:${id}`)
      return null
    }),
    lockActiveCatalog: jest.fn(async () => {
      calls.push('catalog')
      return catalogRow()
    }),
    readDatabaseClock: jest.fn(async () => {
      calls.push('clock')
      return databaseNow
    }),
    createContext: jest.fn(async record => {
      calls.push('context')
      contexts.set(record.tokenHash, record)
    }),
    findContextByTokenHash: jest.fn(async hash => {
      calls.push(`find-context:${hash}`)
      const record = contexts.get(hash)
      return record
        ? { ...record, offerVersion: offerRow(), reservedCatalogPublication: catalogRow() }
        : null
    }),
    lockReservedCatalog: jest.fn(async id => {
      calls.push(`reserved-catalog:${id}`)
      return id === catalog.snapshot.publicationId ? catalogRow() : null
    }),
  }
  const runInTransaction = jest.fn(async operation => operation(tx))
  const service = createCommercialAcquisitionContextV3Service({
    runInTransaction,
    randomBytes: () => contextBytes,
    randomId: () => 'acquisition-context-v3-1',
    sleep: async () => undefined,
    retryDelayMilliseconds: () => 31,
  })
  return { calls, claim, contexts, runInTransaction, service, tx }
}

describe('Commercial acquisition context v3 reservation', () => {
  it('pins exact Offer v3 and active Catalog v2 for exactly seven days from the stored DB clock', async () => {
    const { calls, runInTransaction, service, tx } = harness()

    await expect(
      service.issue({
        offerClaim,
        channel: 'SELLER',
        utmSource: 'facebook',
        utmCampaign: 'pos-agosto',
        fbclid: 'fbclid-123',
      }),
    ).resolves.toEqual({
      token: contextToken,
      acquisitionContextId: 'acquisition-context-v3-1',
      createdAt: '2026-08-15T12:34:56.789Z',
      expiresAt: '2026-08-22T12:34:56.789Z',
    })

    expect(tx.createContext).toHaveBeenCalledWith({
      id: 'acquisition-context-v3-1',
      tokenHash: acquisitionContextHash(),
      campaignVersionId: null,
      offerVersionId: offer.snapshot.campaignVersionId,
      offerSchemaVersion: 3,
      reservedCatalogPublicationId: catalog.snapshot.publicationId,
      reservedCatalogSchemaVersion: 2,
      channel: 'PAID_META',
      attribution: {
        offerCode: offer.snapshot.campaignCode,
        sourceRef: 'meta:cdmx:restaurants',
        utmSource: 'facebook',
        utmCampaign: 'pos-agosto',
        fbclid: 'fbclid-123',
      },
      createdAt: databaseNow,
      expiresAt: new Date('2026-08-22T12:34:56.789Z'),
    })
    expect(calls).toEqual([
      'timeout:1000',
      `claim:${offerClaimHash()}`,
      `offer:${offer.snapshot.campaignVersionId}`,
      `control:${offer.snapshot.campaignVersionId}`,
      'catalog',
      'clock',
      'context',
    ])
    expect(runInTransaction).toHaveBeenCalledWith(expect.any(Function), {
      maxWait: 5_000,
      timeout: 5_000,
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    })
    expect(JSON.stringify(jest.mocked(tx.createContext).mock.calls)).not.toContain(contextToken)
    expect(JSON.stringify(jest.mocked(tx.createContext).mock.calls)).not.toMatch(/amount|price|discount/i)
  })

  it('resolves pinned authorities even after active pointers could have changed', async () => {
    const { service, tx } = harness()
    await service.issue({ offerClaim, utmMedium: 'paid-social' })
    jest.mocked(tx.lockActiveCatalog).mockResolvedValueOnce(null)

    await expect(service.resolve(contextToken, new Date('2026-08-16T00:00:00.000Z'))).resolves.toMatchObject({
      acquisitionContextId: 'acquisition-context-v3-1',
      offerVersionId: offer.snapshot.campaignVersionId,
      offerChecksum: offer.checksum,
      reservedCatalogPublicationId: catalog.snapshot.publicationId,
      reservedCatalogChecksum: catalog.checksum,
      channel: 'PAID_META',
      attribution: { offerCode: offer.snapshot.campaignCode, utmMedium: 'paid-social' },
      createdAt: databaseNow,
      expiresAt: new Date('2026-08-22T12:34:56.789Z'),
    })
    expect(tx.lockActiveCatalog).toHaveBeenCalledTimes(1)
    expect(tx.lockReservedCatalog).toHaveBeenCalledWith(catalog.snapshot.publicationId)
  })

  it('rejects browser money and unknown fields before opening a transaction', async () => {
    const { runInTransaction, service } = harness()
    await expect(service.issue({ offerClaim, amountMinor: 2200 } as never)).rejects.toMatchObject({
      code: 'COMMERCIAL_ACQUISITION_V3_INVALID',
    })
    await expect(service.issue({ offerClaim, utmSource: 'x'.repeat(256) })).rejects.toMatchObject({
      code: 'COMMERCIAL_ACQUISITION_V3_INVALID',
    })
    expect(runInTransaction).not.toHaveBeenCalled()
  })

  it('fails closed for malformed, unknown, expired or mixed-lineage Offer claims', async () => {
    const { claim, service, tx } = harness()
    await expect(service.issue({ offerClaim: 'short' })).rejects.toMatchObject({ code: 'COMMERCIAL_ACQUISITION_V3_INVALID' })
    await expect(service.issue({ offerClaim: Buffer.alloc(32, 0x44).toString('base64url') })).rejects.toMatchObject({
      code: 'COMMERCIAL_OFFER_CLAIM_NOT_FOUND',
    })
    jest.mocked(tx.findClaimByTokenHash).mockResolvedValueOnce({ ...claim, expiresAt: databaseNow })
    await expect(service.issue({ offerClaim })).rejects.toMatchObject({ code: 'COMMERCIAL_OFFER_CLAIM_EXPIRED' })
    jest.mocked(tx.findClaimByTokenHash).mockResolvedValueOnce({ ...claim, campaignVersionId: 'legacy', campaignCode: 'LEGACY' } as never)
    await expect(service.issue({ offerClaim })).rejects.toMatchObject({ code: 'COMMERCIAL_OFFER_CLAIM_NOT_FOUND' })
  })

  it('rejects invalid authorities and both suspension states without persisting', async () => {
    const { service, tx } = harness()
    jest.mocked(tx.lockOffer).mockResolvedValueOnce({ ...offerRow(), checksum: '0'.repeat(64) })
    await expect(service.issue({ offerClaim })).rejects.toMatchObject({ code: 'COMMERCIAL_ACQUISITION_V3_OFFER_INVALID' })

    jest.mocked(tx.lockActiveCatalog).mockResolvedValueOnce({ ...catalogRow(), schemaVersion: 1 })
    await expect(service.issue({ offerClaim })).rejects.toMatchObject({ code: 'COMMERCIAL_ACQUISITION_V3_CATALOG_INVALID' })

    jest.mocked(tx.readLatestOfferControl).mockResolvedValueOnce({ revision: 1, action: 'SUSPEND_NEW_CLAIMS' })
    await expect(service.issue({ offerClaim })).rejects.toMatchObject({ code: 'COMMERCIAL_OFFER_NEW_ACQUISITION_SUSPENDED' })
    jest.mocked(tx.readLatestOfferControl).mockResolvedValueOnce({ revision: 2, action: 'SUSPEND_ALL_PENDING' })
    await expect(service.issue({ offerClaim })).rejects.toMatchObject({ code: 'COMMERCIAL_OFFER_NEW_ACQUISITION_SUSPENDED' })
    expect(tx.createContext).not.toHaveBeenCalled()
  })

  it('rejects malformed, unknown and boundary-expired context tokens', async () => {
    const { service } = harness()
    await service.issue({ offerClaim })
    await expect(service.resolve('short', databaseNow)).rejects.toMatchObject({ code: 'COMMERCIAL_ACQUISITION_TOKEN_INVALID' })
    await expect(service.resolve(Buffer.alloc(32, 0x42).toString('base64url'), databaseNow)).rejects.toMatchObject({
      code: 'COMMERCIAL_ACQUISITION_NOT_FOUND',
    })
    await expect(service.resolve(contextToken, new Date('2026-08-22T12:34:56.789Z'))).rejects.toMatchObject({
      code: 'COMMERCIAL_ACQUISITION_EXPIRED',
    })
  })

  it('retries one serialization conflict without changing the generated bearer', async () => {
    const { runInTransaction, service, tx } = harness()
    runInTransaction.mockRejectedValueOnce(Object.assign(new Error('deadlock'), { code: '40P01' }))
    await expect(service.issue({ offerClaim })).resolves.toMatchObject({ token: contextToken })
    expect(runInTransaction).toHaveBeenCalledTimes(2)
    expect(tx.createContext).toHaveBeenCalledTimes(1)
  })
})
