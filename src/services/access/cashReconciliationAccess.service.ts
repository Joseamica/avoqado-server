import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import { venueHasFeatureAccess } from './basePlan.service'

export const CASH_RECONCILIATION_FEATURE = 'CASH_RECONCILIATION' as const

/**
 * Runtime-safe effective gate: paid entitlement AND explicit venue opt-in.
 *
 * This helper is used only in non-blocking terminal/shift paths, so any lookup failure disables the
 * additive capability without preventing existing operations. Mutations that turn the setting on
 * call the strict entitlement resolver directly and let infrastructure failures remain retryable.
 */
export async function isCashReconciliationEnabled(venueId: string): Promise<boolean> {
  try {
    const settings = await prisma.venueSettings.findUnique({
      where: { venueId },
      select: { cashReconciliationEnabled: true },
    })
    if (settings?.cashReconciliationEnabled !== true) return false
    return await venueHasFeatureAccess(venueId, CASH_RECONCILIATION_FEATURE)
  } catch (error) {
    logger.warn('[Cash Reconciliation] Effective access lookup failed closed', {
      venueId,
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}
