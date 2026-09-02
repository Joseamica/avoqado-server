import offerFixture from '@/contracts/commercial/fixtures/v3/commercial-offer-v3.json'
import { createCommercialEligibleOfferWriterSnapshotRunner } from '@/services/commercial/offers/commercialEligibleOfferWriterSnapshot.service'
import { COMMERCIAL_OFFER_V3_ELIGIBILITY_FINGERPRINT_SQL } from '@/services/commercial/offers/commercialOfferEligibility.service'
import { emitCommercialOfferV3 } from '@/services/commercial/offers/commercialOfferV3.service'
import type { CommercialOfferSnapshotV3 } from '@/types/commercialOfferV3'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function row(index = 0) {
  const snapshot = clone(offerFixture) as CommercialOfferSnapshotV3
  snapshot.campaignVersionId = `writer-snapshot-offer-${index}`
  snapshot.campaignCode = `WRITER_SNAPSHOT_OFFER_${index}`
  snapshot.version = index + 1
  const emitted = emitCommercialOfferV3(snapshot)
  return {
    id: snapshot.campaignVersionId,
    campaignCode: snapshot.campaignCode,
    sourceRevision: snapshot.version,
    schemaVersion: 3,
    snapshot: emitted.snapshot,
    checksum: emitted.checksum,
    publishedAt: new Date(snapshot.publishedAt),
  }
}

function fingerprint(item: ReturnType<typeof row>) {
  return {
    id: item.id,
    checksum: item.checksum,
    sourceRevision: item.sourceRevision,
    schemaVersion: item.schemaVersion,
    publishedAt: item.publishedAt,
    status: item.snapshot.status,
    claimEndsAt: item.snapshot.claimEndsAt,
  }
}

describe('Commercial prepared eligible-offer writer snapshot', () => {
  it('does full verification before serialization and only fingerprint verification under the lock', async () => {
    const source = row()
    const reader = { $queryRawUnsafe: jest.fn().mockResolvedValue([source]) }
    const tx = { $queryRawUnsafe: jest.fn().mockResolvedValue([fingerprint(source)]) }
    const runSerialized = jest.fn(async operation => operation(tx))
    const operation = jest.fn(async (_lockedTx, offers) => offers[0].snapshot.campaignVersionId)
    const runner = createCommercialEligibleOfferWriterSnapshotRunner({ reader, runSerialized })

    await expect(runner.run(new Date('2026-08-15T12:00:00.000Z'), operation)).resolves.toBe(source.id)

    expect(reader.$queryRawUnsafe).toHaveBeenCalledTimes(1)
    expect(runSerialized).toHaveBeenCalledTimes(1)
    expect(tx.$queryRawUnsafe).toHaveBeenCalledWith(
      COMMERCIAL_OFFER_V3_ELIGIBILITY_FINGERPRINT_SQL,
      '2026-08-15T12:00:00.000Z',
    )
    expect(operation).toHaveBeenCalledTimes(1)
  })

  it('re-prepares once when a serialized writer changed the eligible set before lock acquisition', async () => {
    const first = row()
    const second = row(1)
    const reader = { $queryRawUnsafe: jest.fn().mockResolvedValueOnce([first]).mockResolvedValueOnce([second]) }
    const tx = {
      $queryRawUnsafe: jest.fn().mockResolvedValueOnce([fingerprint(second)]).mockResolvedValueOnce([fingerprint(second)]),
    }
    const runSerialized = jest.fn(async operation => operation(tx))
    const operation = jest.fn(async () => 'committed')
    const runner = createCommercialEligibleOfferWriterSnapshotRunner({ reader, runSerialized })

    await expect(runner.run(new Date('2026-08-15T12:00:00.000Z'), operation)).resolves.toBe('committed')

    expect(reader.$queryRawUnsafe).toHaveBeenCalledTimes(2)
    expect(runSerialized).toHaveBeenCalledTimes(2)
    expect(operation).toHaveBeenCalledTimes(1)
  })

  it('returns a stable retryable 409 without executing domain work after two consecutive drifts', async () => {
    const first = row()
    const changed = row(1)
    const reader = { $queryRawUnsafe: jest.fn().mockResolvedValue([first]) }
    const tx = { $queryRawUnsafe: jest.fn().mockResolvedValue([fingerprint(changed)]) }
    const runSerialized = jest.fn(async operation => operation(tx))
    const operation = jest.fn()
    const runner = createCommercialEligibleOfferWriterSnapshotRunner({ reader, runSerialized })

    await expect(runner.run(new Date('2026-08-15T12:00:00.000Z'), operation)).rejects.toMatchObject({
      statusCode: 409,
      code: 'COMMERCIAL_OFFER_ELIGIBILITY_CHANGED',
      details: { retryable: true, attempts: 2 },
    })
    expect(reader.$queryRawUnsafe).toHaveBeenCalledTimes(2)
    expect(runSerialized).toHaveBeenCalledTimes(2)
    expect(operation).not.toHaveBeenCalled()
  })
})
