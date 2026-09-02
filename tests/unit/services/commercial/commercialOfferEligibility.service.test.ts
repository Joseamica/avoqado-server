import offerFixture from '@/contracts/commercial/fixtures/v3/commercial-offer-v3.json'
import {
  COMMERCIAL_OFFER_V3_ELIGIBILITY_FINGERPRINT_SQL,
  COMMERCIAL_OFFER_V3_ELIGIBILITY_SQL,
  CommercialOfferEligibilityError,
  assertCommercialOfferEligibilitySnapshotUnchangedV3,
  loadEligibleCommercialOffersV3,
  prepareEligibleCommercialOffersV3,
} from '@/services/commercial/offers/commercialOfferEligibility.service'
import { emitCommercialOfferV3 } from '@/services/commercial/offers/commercialOfferV3.service'
import type { CommercialOfferSnapshotV3 } from '@/types/commercialOfferV3'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function row(index: number, mutate?: (snapshot: CommercialOfferSnapshotV3) => void) {
  const snapshot = clone(offerFixture) as CommercialOfferSnapshotV3
  snapshot.campaignVersionId = `eligible-offer-${String(index).padStart(2, '0')}`
  snapshot.campaignCode = `ELIGIBLE_OFFER_${String(index).padStart(2, '0')}`
  snapshot.version = index + 1
  mutate?.(snapshot)
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

describe('Commercial Offer v3 eligibility query', () => {
  describe('behavior', () => {
    it('loads at most 32 active non-expired verified offers through the bounded SQL adapter', async () => {
      const rows = Array.from({ length: 32 }, (_, index) => row(index))
      const query = jest.fn().mockResolvedValue(rows)
      const result = await loadEligibleCommercialOffersV3({ $queryRawUnsafe: query }, new Date('2026-08-15T12:00:00.000Z'))

      expect(result).toHaveLength(32)
      expect(result.every((offer: { verified?: boolean }) => offer.verified === true)).toBe(true)
      expect(query).toHaveBeenCalledTimes(1)
      expect(query.mock.calls[0][1]).toBe('2026-08-15T12:00:00.000Z')
      expect(query.mock.calls[0][0]).toBe(COMMERCIAL_OFFER_V3_ELIGIBILITY_SQL)
      expect(Object.isFrozen(result)).toBe(true)
    })

    it('prepares verified immutable offers before the writer lock and checks only their lightweight fingerprint under it', async () => {
      const rows = [row(0), row(1)]
      const prepareQuery = jest.fn().mockResolvedValue(rows)
      const prepared = await prepareEligibleCommercialOffersV3(
        { $queryRawUnsafe: prepareQuery },
        new Date('2026-08-15T12:00:00.000Z'),
      )
      const fingerprintQuery = jest.fn().mockResolvedValue(
        rows.map(item => ({
          id: item.id,
          checksum: item.checksum,
          sourceRevision: item.sourceRevision,
          schemaVersion: item.schemaVersion,
          publishedAt: item.publishedAt,
          status: item.snapshot.status,
          claimEndsAt: item.snapshot.claimEndsAt,
        })),
      )

      await expect(
        assertCommercialOfferEligibilitySnapshotUnchangedV3(
          { $queryRawUnsafe: fingerprintQuery },
          prepared,
        ),
      ).resolves.toBeUndefined()

      expect(prepared.offers).toHaveLength(2)
      expect(fingerprintQuery).toHaveBeenCalledWith(
        COMMERCIAL_OFFER_V3_ELIGIBILITY_FINGERPRINT_SQL,
        '2026-08-15T12:00:00.000Z',
      )
      expect(COMMERCIAL_OFFER_V3_ELIGIBILITY_FINGERPRINT_SQL).not.toContain(' snapshot,')
    })
  })

  describe('regression', () => {
    it('fails with a stable capacity error instead of silently truncating the 33rd eligible offer', async () => {
      const query = jest.fn().mockResolvedValue(Array.from({ length: 33 }, (_, index) => row(index)))

      await expect(loadEligibleCommercialOffersV3({ $queryRawUnsafe: query }, new Date('2026-08-15T12:00:00.000Z'))).rejects.toEqual(
        expect.objectContaining({
          code: 'COMMERCIAL_OFFER_ELIGIBILITY_CAPACITY_EXCEEDED',
          message: 'Hay demasiadas ofertas elegibles para validar esta operación.',
          statusCode: 409,
          details: { retryable: false },
        }) as CommercialOfferEligibilityError,
      )
    })

    it.each([
      ['inactive', (snapshot: CommercialOfferSnapshotV3): void => void (snapshot.status = 'INACTIVE')],
      ['expired', (snapshot: CommercialOfferSnapshotV3): void => void (snapshot.claimEndsAt = '2026-08-15T12:00:00.000Z')],
    ] as const)('fails closed if the SQL adapter returns an %s Offer', async (_label, mutate) => {
      const query = jest.fn().mockResolvedValue([row(0, mutate)])

      await expect(loadEligibleCommercialOffersV3({ $queryRawUnsafe: query }, new Date('2026-08-15T12:00:00.000Z'))).rejects.toEqual(
        expect.objectContaining({ code: 'COMMERCIAL_OFFER_ELIGIBILITY_INTEGRITY_INVALID' }) as CommercialOfferEligibilityError,
      )
    })

    it('binds a canonical UTC now value to the exact eligibility query', () => {
      expect(COMMERCIAL_OFFER_V3_ELIGIBILITY_SQL).toBe(`SELECT id, "campaignCode", "sourceRevision", "schemaVersion", snapshot,
       checksum, "publishedAt"
FROM "CommercialCampaignVersion"
WHERE "schemaVersion" = 3
  AND snapshot->>'status' = 'ACTIVE'
  AND snapshot->>'claimEndsAt' > $1
ORDER BY snapshot->>'claimEndsAt', id
LIMIT 33;`)
    })

    it('fails retryably when the eligible set changes between preparation and the serialized writer', async () => {
      const rows = [row(0)]
      const prepared = await prepareEligibleCommercialOffersV3(
        { $queryRawUnsafe: jest.fn().mockResolvedValue(rows) },
        new Date('2026-08-15T12:00:00.000Z'),
      )
      const changedFingerprint = rows.map(item => ({
        id: item.id,
        checksum: `${item.checksum.slice(0, -1)}${item.checksum.endsWith('0') ? '1' : '0'}`,
        sourceRevision: item.sourceRevision,
        schemaVersion: item.schemaVersion,
        publishedAt: item.publishedAt,
        status: item.snapshot.status,
        claimEndsAt: item.snapshot.claimEndsAt,
      }))

      await expect(
        assertCommercialOfferEligibilitySnapshotUnchangedV3(
          { $queryRawUnsafe: jest.fn().mockResolvedValue(changedFingerprint) },
          prepared,
        ),
      ).rejects.toMatchObject({
        code: 'COMMERCIAL_OFFER_ELIGIBILITY_SNAPSHOT_CHANGED',
        retryable: true,
        statusCode: 409,
        details: { retryable: true },
      })
    })
  })
})
