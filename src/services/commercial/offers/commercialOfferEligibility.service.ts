import type { CommercialOfferV3RowContext, VerifiedStoredCommercialOfferV3 } from '@/types/commercialOfferV3'
import { ConflictError } from '@/errors/AppError'

import { decodeAndVerifyStoredCommercialOfferV3 } from './commercialOfferV3.service'

export const COMMERCIAL_OFFER_V3_ELIGIBILITY_LIMIT = 32

export const COMMERCIAL_OFFER_V3_ELIGIBILITY_SQL = `SELECT id, "campaignCode", "sourceRevision", "schemaVersion", snapshot,
       checksum, "publishedAt"
FROM "CommercialCampaignVersion"
WHERE "schemaVersion" = 3
  AND snapshot->>'status' = 'ACTIVE'
  AND snapshot->>'claimEndsAt' > $1
ORDER BY snapshot->>'claimEndsAt', id
LIMIT 33;`

export const COMMERCIAL_OFFER_V3_ELIGIBILITY_FINGERPRINT_SQL = `SELECT id, checksum, "sourceRevision", "schemaVersion", "publishedAt",
       snapshot->>'status' AS status,
       snapshot->>'claimEndsAt' AS "claimEndsAt"
FROM "CommercialCampaignVersion"
WHERE "schemaVersion" = 3
  AND snapshot->>'status' = 'ACTIVE'
  AND snapshot->>'claimEndsAt' > $1
ORDER BY snapshot->>'claimEndsAt', id
LIMIT 33;`

export interface CommercialOfferEligibilityRowV3 extends CommercialOfferV3RowContext {
  snapshot: unknown
  checksum: unknown
}

export interface CommercialOfferEligibilityQueryV3 {
  $queryRawUnsafe<T>(query: string, ...values: unknown[]): Promise<T>
}

export class CommercialOfferEligibilityError extends ConflictError {
  readonly retryable: boolean

  constructor(
    readonly code:
      | 'COMMERCIAL_OFFER_ELIGIBILITY_CAPACITY_EXCEEDED'
      | 'COMMERCIAL_OFFER_ELIGIBILITY_INTEGRITY_INVALID'
      | 'COMMERCIAL_OFFER_ELIGIBILITY_SNAPSHOT_CHANGED',
  ) {
    const messages = {
      COMMERCIAL_OFFER_ELIGIBILITY_CAPACITY_EXCEEDED:
        'Hay demasiadas ofertas elegibles para validar esta operación.',
      COMMERCIAL_OFFER_ELIGIBILITY_INTEGRITY_INVALID:
        'No se pudo comprobar la integridad de las ofertas elegibles.',
      COMMERCIAL_OFFER_ELIGIBILITY_SNAPSHOT_CHANGED:
        'Las ofertas elegibles cambiaron mientras se validaba la operación.',
    } as const
    super(messages[code], code, { retryable: code === 'COMMERCIAL_OFFER_ELIGIBILITY_SNAPSHOT_CHANGED' })
    this.name = 'CommercialOfferEligibilityError'
    this.retryable = code === 'COMMERCIAL_OFFER_ELIGIBILITY_SNAPSHOT_CHANGED'
  }
}

interface CommercialOfferEligibilityFingerprintRowV3 {
  id: unknown
  checksum: unknown
  sourceRevision: unknown
  schemaVersion: unknown
  publishedAt: unknown
  status: unknown
  claimEndsAt: unknown
}

interface CommercialOfferEligibilityFingerprintV3 {
  id: string
  checksum: string
  sourceRevision: number
  schemaVersion: 3
  publishedAt: string
  status: 'ACTIVE'
  claimEndsAt: string
}

export interface PreparedCommercialEligibleOffersV3 {
  nowIso: string
  offers: readonly VerifiedStoredCommercialOfferV3[]
  fingerprint: readonly CommercialOfferEligibilityFingerprintV3[]
}

function canonicalNow(value: Date): string {
  const time = Date.prototype.getTime.call(value)
  if (!Number.isFinite(time)) throw new CommercialOfferEligibilityError('COMMERCIAL_OFFER_ELIGIBILITY_INTEGRITY_INVALID')
  return Date.prototype.toISOString.call(value)
}

function canonicalPublishedAt(value: unknown): string {
  if (!(value instanceof Date)) throw new CommercialOfferEligibilityError('COMMERCIAL_OFFER_ELIGIBILITY_INTEGRITY_INVALID')
  return canonicalNow(value)
}

function fingerprintRow(row: CommercialOfferEligibilityFingerprintRowV3): Readonly<CommercialOfferEligibilityFingerprintV3> {
  if (
    typeof row.id !== 'string' ||
    typeof row.checksum !== 'string' ||
    !/^[0-9a-f]{64}$/.test(row.checksum) ||
    !Number.isInteger(row.sourceRevision) ||
    (row.sourceRevision as number) < 1 ||
    row.schemaVersion !== 3 ||
    row.status !== 'ACTIVE' ||
    typeof row.claimEndsAt !== 'string'
  ) {
    throw new CommercialOfferEligibilityError('COMMERCIAL_OFFER_ELIGIBILITY_INTEGRITY_INVALID')
  }
  return Object.freeze({
    id: row.id,
    checksum: row.checksum,
    sourceRevision: row.sourceRevision as number,
    schemaVersion: 3,
    publishedAt: canonicalPublishedAt(row.publishedAt),
    status: 'ACTIVE',
    claimEndsAt: row.claimEndsAt,
  })
}

function fingerprintFromFullRow(row: CommercialOfferEligibilityRowV3): Readonly<CommercialOfferEligibilityFingerprintV3> {
  if (typeof row.snapshot !== 'object' || row.snapshot === null || Array.isArray(row.snapshot)) {
    throw new CommercialOfferEligibilityError('COMMERCIAL_OFFER_ELIGIBILITY_INTEGRITY_INVALID')
  }
  const snapshot = row.snapshot as Record<string, unknown>
  return fingerprintRow({
    id: row.id,
    checksum: row.checksum,
    sourceRevision: row.sourceRevision,
    schemaVersion: row.schemaVersion,
    publishedAt: row.publishedAt,
    status: snapshot.status,
    claimEndsAt: snapshot.claimEndsAt,
  })
}

function sameFingerprint(
  left: readonly CommercialOfferEligibilityFingerprintV3[],
  right: readonly CommercialOfferEligibilityFingerprintV3[],
): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => {
      const candidate = right[index]
      return (
        candidate !== undefined &&
        entry.id === candidate.id &&
        entry.checksum === candidate.checksum &&
        entry.sourceRevision === candidate.sourceRevision &&
        entry.schemaVersion === candidate.schemaVersion &&
        entry.publishedAt === candidate.publishedAt &&
        entry.status === candidate.status &&
        entry.claimEndsAt === candidate.claimEndsAt
      )
    })
  )
}

export async function prepareEligibleCommercialOffersV3(
  query: CommercialOfferEligibilityQueryV3,
  now: Date,
): Promise<Readonly<PreparedCommercialEligibleOffersV3>> {
  const nowIso = canonicalNow(now)
  const rows = await query.$queryRawUnsafe<CommercialOfferEligibilityRowV3[]>(COMMERCIAL_OFFER_V3_ELIGIBILITY_SQL, nowIso)
  if (rows.length > COMMERCIAL_OFFER_V3_ELIGIBILITY_LIMIT) {
    throw new CommercialOfferEligibilityError('COMMERCIAL_OFFER_ELIGIBILITY_CAPACITY_EXCEEDED')
  }

  try {
    const offers = rows.map(row => {
      const offer = decodeAndVerifyStoredCommercialOfferV3({
        rowSchemaVersion: row.schemaVersion,
        snapshot: row.snapshot,
        checksum: row.checksum,
        rowContext: {
          id: row.id,
          campaignCode: row.campaignCode,
          sourceRevision: row.sourceRevision,
          schemaVersion: row.schemaVersion,
          publishedAt: row.publishedAt,
        },
      })
      if (offer.snapshot.status !== 'ACTIVE' || offer.snapshot.claimEndsAt <= nowIso) {
        throw new CommercialOfferEligibilityError('COMMERCIAL_OFFER_ELIGIBILITY_INTEGRITY_INVALID')
      }
      return offer
    })
    const fingerprint = rows.map(fingerprintFromFullRow)
    return Object.freeze({ nowIso, offers: Object.freeze(offers), fingerprint: Object.freeze(fingerprint) })
  } catch (error) {
    if (error instanceof CommercialOfferEligibilityError) throw error
    throw new CommercialOfferEligibilityError('COMMERCIAL_OFFER_ELIGIBILITY_INTEGRITY_INVALID')
  }
}

export async function assertCommercialOfferEligibilitySnapshotUnchangedV3(
  query: CommercialOfferEligibilityQueryV3,
  prepared: Readonly<PreparedCommercialEligibleOffersV3>,
): Promise<void> {
  const rows = await query.$queryRawUnsafe<CommercialOfferEligibilityFingerprintRowV3[]>(
    COMMERCIAL_OFFER_V3_ELIGIBILITY_FINGERPRINT_SQL,
    prepared.nowIso,
  )
  if (rows.length > COMMERCIAL_OFFER_V3_ELIGIBILITY_LIMIT) {
    throw new CommercialOfferEligibilityError('COMMERCIAL_OFFER_ELIGIBILITY_CAPACITY_EXCEEDED')
  }
  let current: readonly CommercialOfferEligibilityFingerprintV3[]
  try {
    current = rows.map(fingerprintRow)
  } catch (error) {
    if (error instanceof CommercialOfferEligibilityError) throw error
    throw new CommercialOfferEligibilityError('COMMERCIAL_OFFER_ELIGIBILITY_INTEGRITY_INVALID')
  }
  if (!sameFingerprint(prepared.fingerprint, current)) {
    throw new CommercialOfferEligibilityError('COMMERCIAL_OFFER_ELIGIBILITY_SNAPSHOT_CHANGED')
  }
}

export async function loadEligibleCommercialOffersV3(
  query: CommercialOfferEligibilityQueryV3,
  now: Date,
): Promise<readonly VerifiedStoredCommercialOfferV3[]> {
  return (await prepareEligibleCommercialOffersV3(query, now)).offers
}
