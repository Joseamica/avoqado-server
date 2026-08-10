import { Prisma } from '@prisma/client'
import type { CatalogPublicationOperation } from '../../types/master-catalog'

const SUPPORTED_OPERATIONS = new Set<CatalogPublicationOperation>([
  'CATALOG_FIELDS_PUBLISH',
  'CATALOG_PRODUCT_ACTIVATION',
  'CATALOG_FIELDS_REVERSION',
])

export const CATALOG_PUBLICATION_TRANSACTION_OPTIONS = {
  maxWait: 5_000,
  timeout: 90_000,
  isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
} as const

export function isSupportedCatalogPublicationOperation(value: unknown): value is CatalogPublicationOperation {
  return typeof value === 'string' && SUPPORTED_OPERATIONS.has(value as CatalogPublicationOperation)
}

export async function acquireCatalogPublicationAttemptLockTx(
  tx: Prisma.TransactionClient,
  organizationId: string,
  batchId: string,
): Promise<void> {
  // WHY: Confirmation and watchdog share this versioned lock so an expired-attempt CAS and a live APPLIED CAS cannot both win.
  await tx.$executeRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${`h1a:catalog-publication-attempt:v1:${organizationId}:${batchId}`}, 0))
  `)
}

export async function retryCatalogPublicationReservationOnce<T>(reserve: () => Promise<T>): Promise<T> {
  try {
    return await reserve()
  } catch (error) {
    if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'P2034') throw error
    // WHY: Only the pre-write reservation is retried. A fresh Serializable snapshot can observe the winner without replaying Product writes.
    return reserve()
  }
}
