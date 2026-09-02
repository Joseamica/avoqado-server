import { createHash } from 'node:crypto'
import { Prisma } from '@prisma/client'

import offerFixture from '@/contracts/commercial/fixtures/v3/commercial-offer-v3.json'
import { emitCommercialOfferV3 } from '@/services/commercial/offers/commercialOfferV3.service'
import {
  createCommercialOfferClaimV3Service,
  type CommercialOfferClaimV3Transaction,
} from '@/services/commercial/quotes-v3/commercialOfferClaimV3.service'
import type { CommercialOfferSnapshotV3 } from '@/types/commercialOfferV3'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

const emittedOffer = emitCommercialOfferV3(clone(offerFixture) as CommercialOfferSnapshotV3)
const databaseNow = new Date('2026-08-15T12:00:00.000Z')
const rawTokenBytes = Buffer.alloc(32, 0x43)
const rawClaim = rawTokenBytes.toString('base64url')
const actor = {
  staffId: 'staff-publisher-v3',
  permissions: ['commercial:publish'],
  ipAddress: '127.0.0.1',
  userAgent: 'jest',
}
const input = {
  offerVersionId: emittedOffer.snapshot.campaignVersionId,
  channel: 'PAID_META' as const,
  sourceRef: 'meta:cdmx:restaurants',
  expiresAt: new Date('2026-08-30T06:00:00.000Z'),
  reason: 'Campaña aprobada para restaurantes CDMX',
  confirm: true as const,
}

function offerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: emittedOffer.snapshot.campaignVersionId,
    campaignCode: emittedOffer.snapshot.campaignCode,
    sourceRevision: emittedOffer.snapshot.version,
    schemaVersion: 3,
    snapshot: emittedOffer.snapshot,
    checksum: emittedOffer.checksum,
    publishedAt: new Date(emittedOffer.snapshot.publishedAt),
    ...overrides,
  }
}

function harness() {
  const calls: string[] = []
  const rows = new Map<string, any>()
  const tx: CommercialOfferClaimV3Transaction = {
    setLocalLockTimeout: jest.fn(async milliseconds => calls.push(`timeout:${milliseconds}`)),
    readDatabaseClock: jest.fn(async () => {
      calls.push('clock')
      return databaseNow
    }),
    lockOffer: jest.fn(async offerVersionId => {
      calls.push(`offer:${offerVersionId}`)
      return offerRow()
    }),
    readLatestOfferControl: jest.fn(async offerVersionId => {
      calls.push(`control:${offerVersionId}`)
      return null
    }),
    createClaim: jest.fn(async record => {
      calls.push('claim')
      rows.set(record.tokenHash, record)
    }),
    writeAudit: jest.fn(async () => {
      calls.push('audit')
    }),
    findClaimByTokenHash: jest.fn(async tokenHash => {
      calls.push(`find:${tokenHash}`)
      const row = rows.get(tokenHash)
      return row ? { ...row, offerVersion: offerRow() } : null
    }),
  }
  const runInTransaction = jest.fn(async operation => operation(tx))
  const service = createCommercialOfferClaimV3Service({
    runInTransaction,
    randomBytes: () => rawTokenBytes,
    randomId: () => 'offer-claim-v3-1',
    sleep: async () => undefined,
    retryDelayMilliseconds: () => 37,
  })
  return { calls, rows, runInTransaction, service, tx }
}

describe('Commercial Offer v3 acquisition claims', () => {
  it('issues one exact active Offer claim with domain-separated hash and minimal audit', async () => {
    const { calls, runInTransaction, service, tx } = harness()

    await expect(service.issue(input, actor)).resolves.toEqual({
      claim: rawClaim,
      expiresAt: input.expiresAt.toISOString(),
    })

    const expectedHash = createHash('sha256')
      .update(Buffer.concat([Buffer.from('avoqado.commercial.offer-claim@3\0', 'ascii'), rawTokenBytes]))
      .digest('hex')
    expect(tx.createClaim).toHaveBeenCalledWith({
      id: 'offer-claim-v3-1',
      tokenHash: expectedHash,
      campaignVersionId: null,
      campaignCode: null,
      offerVersionId: emittedOffer.snapshot.campaignVersionId,
      offerSchemaVersion: 3,
      channel: 'PAID_META',
      sourceRef: input.sourceRef,
      issuedById: actor.staffId,
      reason: input.reason,
      createdAt: databaseNow,
      expiresAt: input.expiresAt,
    })
    expect(tx.writeAudit).toHaveBeenCalledWith({
      staffId: actor.staffId,
      actorType: null,
      organizationId: null,
      venueId: null,
      action: 'COMMERCIAL_OFFER_CLAIM_ISSUED',
      entity: 'CommercialCampaignClaim',
      entityId: 'offer-claim-v3-1',
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
      data: {
        offerVersionId: emittedOffer.snapshot.campaignVersionId,
        offerSchemaVersion: 3,
        offerCode: emittedOffer.snapshot.campaignCode,
        channel: input.channel,
        sourceRef: input.sourceRef,
        expiresAt: input.expiresAt.toISOString(),
        reason: input.reason,
      },
    })
    expect(calls).toEqual([
      'timeout:1000',
      'clock',
      `offer:${input.offerVersionId}`,
      `control:${input.offerVersionId}`,
      'claim',
      'audit',
    ])
    expect(runInTransaction).toHaveBeenCalledWith(expect.any(Function), {
      maxWait: 5_000,
      timeout: 5_000,
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    })
    expect(JSON.stringify(jest.mocked(tx.createClaim).mock.calls)).not.toContain(rawClaim)
  })

  it('resolves only the exact dedicated-lineage claim and verified Offer', async () => {
    const { service } = harness()
    await service.issue(input, actor)

    await expect(service.resolve(rawClaim, new Date('2026-08-16T12:00:00.000Z'))).resolves.toEqual({
      claimId: 'offer-claim-v3-1',
      offerVersionId: emittedOffer.snapshot.campaignVersionId,
      offerCode: emittedOffer.snapshot.campaignCode,
      offerChecksum: emittedOffer.checksum,
      channel: input.channel,
      sourceRef: input.sourceRef,
      createdAt: databaseNow,
      expiresAt: input.expiresAt,
    })
  })

  it('rejects publisher, confirmation, bounds and entropy before writing', async () => {
    const { runInTransaction, service, tx } = harness()
    await expect(service.issue(input, { ...actor, permissions: [] })).rejects.toMatchObject({
      code: 'COMMERCIAL_OFFER_CLAIM_FORBIDDEN',
    })
    await expect(service.issue({ ...input, confirm: false as true }, actor)).rejects.toMatchObject({
      code: 'COMMERCIAL_OFFER_CLAIM_INVALID',
    })
    await expect(service.issue({ ...input, sourceRef: 'x'.repeat(256) }, actor)).rejects.toMatchObject({
      code: 'COMMERCIAL_OFFER_CLAIM_INVALID',
    })
    await expect(service.issue({ ...input, reason: ' x ' }, actor)).rejects.toMatchObject({
      code: 'COMMERCIAL_OFFER_CLAIM_INVALID',
    })
    expect(runInTransaction).not.toHaveBeenCalled()
    expect(tx.createClaim).not.toHaveBeenCalled()

    const invalidEntropy = createCommercialOfferClaimV3Service({
      runInTransaction,
      randomBytes: () => Buffer.alloc(31),
      randomId: () => 'offer-claim-v3-invalid',
      sleep: async () => undefined,
      retryDelayMilliseconds: () => 1,
    })
    await expect(invalidEntropy.issue(input, actor)).rejects.toMatchObject({
      code: 'COMMERCIAL_OFFER_CLAIM_ENTROPY_INVALID',
    })
    expect(tx.createClaim).not.toHaveBeenCalled()
  })

  it('rejects inactive, tampered, unknown-schema and out-of-window Offers', async () => {
    const cases = [
      offerRow({ snapshot: { ...emittedOffer.snapshot, status: 'INACTIVE' } }),
      offerRow({ checksum: '0'.repeat(64) }),
      offerRow({ schemaVersion: 4 }),
    ]
    for (const row of cases) {
      const { service, tx } = harness()
      jest.mocked(tx.lockOffer).mockResolvedValueOnce(row as never)
      await expect(service.issue(input, actor)).rejects.toMatchObject({ code: 'COMMERCIAL_OFFER_CLAIM_OFFER_INVALID' })
      expect(tx.createClaim).not.toHaveBeenCalled()
    }

    const { service, tx } = harness()
    jest.mocked(tx.readDatabaseClock).mockResolvedValueOnce(new Date(emittedOffer.snapshot.claimEndsAt))
    await expect(service.issue(input, actor)).rejects.toMatchObject({ code: 'COMMERCIAL_OFFER_CLAIM_WINDOW_CLOSED' })
    expect(tx.createClaim).not.toHaveBeenCalled()
  })

  it('rejects expiry beyond the claim window and both acquisition suspension states', async () => {
    const { service, tx } = harness()
    await expect(
      service.issue({ ...input, expiresAt: new Date('2026-09-01T06:00:00.001Z') }, actor),
    ).rejects.toMatchObject({ code: 'COMMERCIAL_OFFER_CLAIM_EXPIRY_INVALID' })

    jest.mocked(tx.readLatestOfferControl).mockResolvedValueOnce({ revision: 1, action: 'SUSPEND_NEW_CLAIMS' })
    await expect(service.issue(input, actor)).rejects.toMatchObject({
      code: 'COMMERCIAL_OFFER_NEW_ACQUISITION_SUSPENDED',
    })
    jest.mocked(tx.readLatestOfferControl).mockResolvedValueOnce({ revision: 2, action: 'SUSPEND_ALL_PENDING' })
    await expect(service.issue(input, actor)).rejects.toMatchObject({
      code: 'COMMERCIAL_OFFER_NEW_ACQUISITION_SUSPENDED',
    })
  })

  it('fails closed for malformed, unknown, expired or mixed-lineage resolution', async () => {
    const { service, tx } = harness()
    await expect(service.resolve('short', databaseNow)).rejects.toMatchObject({ code: 'COMMERCIAL_OFFER_CLAIM_INVALID' })
    await expect(service.resolve(Buffer.alloc(32, 0x44).toString('base64url'), databaseNow)).rejects.toMatchObject({
      code: 'COMMERCIAL_OFFER_CLAIM_NOT_FOUND',
    })

    await service.issue(input, actor)
    await expect(service.resolve(rawClaim, input.expiresAt)).rejects.toMatchObject({ code: 'COMMERCIAL_OFFER_CLAIM_EXPIRED' })
    jest.mocked(tx.findClaimByTokenHash).mockResolvedValueOnce({
      ...(jest.mocked(tx.createClaim).mock.calls[0][0] as any),
      campaignVersionId: 'legacy-version',
      campaignCode: 'LEGACY',
      offerVersion: offerRow(),
    })
    await expect(service.resolve(rawClaim, databaseNow)).rejects.toMatchObject({ code: 'COMMERCIAL_OFFER_CLAIM_NOT_FOUND' })
  })

  it('retries one serialization conflict and keeps claim plus audit atomic', async () => {
    const { runInTransaction, service, tx } = harness()
    runInTransaction.mockRejectedValueOnce(Object.assign(new Error('serialization'), { code: '40001' }))
    await expect(service.issue(input, actor)).resolves.toEqual({ claim: rawClaim, expiresAt: input.expiresAt.toISOString() })
    expect(runInTransaction).toHaveBeenCalledTimes(2)
    expect(tx.createClaim).toHaveBeenCalledTimes(1)
    expect(tx.writeAudit).toHaveBeenCalledTimes(1)

    const rollbackHarness = harness()
    jest.mocked(rollbackHarness.tx.writeAudit).mockRejectedValueOnce(new Error('audit unavailable'))
    await expect(rollbackHarness.service.issue(input, actor)).rejects.toThrow('audit unavailable')
  })
})
