import { ConflictError } from '@/errors/AppError'
import type { VerifiedStoredCommercialOfferV3 } from '@/types/commercialOfferV3'

import {
  CommercialOfferEligibilityError,
  assertCommercialOfferEligibilitySnapshotUnchangedV3,
  prepareEligibleCommercialOffersV3,
  type CommercialOfferEligibilityQueryV3,
} from './commercialOfferEligibility.service'

export interface CommercialEligibleOfferWriterSnapshotDependencies<TTransaction extends CommercialOfferEligibilityQueryV3> {
  reader: CommercialOfferEligibilityQueryV3
  runSerialized<T>(operation: (transaction: TTransaction) => Promise<T>): Promise<T>
}

export interface CommercialEligibleOfferWriterSnapshotRunner<TTransaction extends CommercialOfferEligibilityQueryV3> {
  run<T>(
    now: Date,
    operation: (transaction: TTransaction, offers: readonly VerifiedStoredCommercialOfferV3[]) => Promise<T>,
  ): Promise<T>
}

function isPreparedSnapshotDrift(error: unknown): error is CommercialOfferEligibilityError {
  return (
    error instanceof CommercialOfferEligibilityError &&
    error.code === 'COMMERCIAL_OFFER_ELIGIBILITY_SNAPSHOT_CHANGED'
  )
}

export function createCommercialEligibleOfferWriterSnapshotRunner<
  TTransaction extends CommercialOfferEligibilityQueryV3,
>(
  dependencies: CommercialEligibleOfferWriterSnapshotDependencies<TTransaction>,
): CommercialEligibleOfferWriterSnapshotRunner<TTransaction> {
  return {
    async run(now, operation) {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        // Full materialization, checksum and AJV verification deliberately happen before the
        // shared writer lock. CommercialCampaignVersion rows are immutable after publication.
        const prepared = await prepareEligibleCommercialOffersV3(dependencies.reader, now)
        try {
          return await dependencies.runSerialized(async transaction => {
            // The lightweight fingerprint closes the race with another serialized publisher. If
            // any eligible immutable row changed while we waited, no domain work runs.
            await assertCommercialOfferEligibilitySnapshotUnchangedV3(transaction, prepared)
            return operation(transaction, prepared.offers)
          })
        } catch (error) {
          if (!isPreparedSnapshotDrift(error)) throw error
          if (attempt < 2) continue
          throw new ConflictError(
            'Las ofertas elegibles cambiaron mientras se preparaba la operación. Intenta de nuevo.',
            'COMMERCIAL_OFFER_ELIGIBILITY_CHANGED',
            { retryable: true, attempts: 2 },
          )
        }
      }
      throw new Error('COMMERCIAL_OFFER_ELIGIBILITY_PREPARATION_UNREACHABLE')
    },
  }
}
