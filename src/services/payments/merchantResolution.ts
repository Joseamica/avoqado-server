import { MerchantResolutionStatus } from '@prisma/client'

/**
 * Durable merchant-resolution mark for a Payment (PR-2 · T3).
 *
 * The TPV ingestion path already resolves the processing account through a 3-tier
 * strategy (use-provided → recover-from-serial → null-for-reconciliation). This
 * captures the OUTCOME of that resolution as durable Payment columns so back-office
 * reconciliation can find and repair mis-attributed payments — instead of the
 * outcome living only in transient logs. It does NOT change which account is used.
 */
export interface MerchantResolutionMark {
  merchantResolutionStatus: MerchantResolutionStatus | null
  merchantResolutionReason: string | null
  originalMerchantAccountId: string | null
}

/**
 * Classify how a payment's merchant account was resolved, from the account the TPV
 * PROVIDED vs the FINAL account after the 3-tier resolution.
 *
 *   - no provided account (manual/QR/legacy)      → no mark (nothing to resolve)
 *   - final === provided                          → RESOLVED (clean)
 *   - final present but ≠ provided                → RESOLVED, recovered via serial
 *                                                   (originalMerchantAccountId kept)
 *   - provided present, final null (nulled/TIER3) → UNRESOLVED (reconciliation needed)
 */
export function classifyMerchantResolution(params: {
  provided: string | null | undefined
  final: string | null | undefined
}): MerchantResolutionMark {
  const provided = params.provided ?? null
  const final = params.final ?? null

  if (!provided) {
    return { merchantResolutionStatus: null, merchantResolutionReason: null, originalMerchantAccountId: null }
  }

  if (final === provided) {
    return { merchantResolutionStatus: MerchantResolutionStatus.RESOLVED, merchantResolutionReason: null, originalMerchantAccountId: null }
  }

  if (final) {
    return {
      merchantResolutionStatus: MerchantResolutionStatus.RESOLVED,
      merchantResolutionReason: 'recovered_via_serial',
      originalMerchantAccountId: provided,
    }
  }

  return {
    merchantResolutionStatus: MerchantResolutionStatus.UNRESOLVED,
    merchantResolutionReason: 'unresolved_nulled',
    originalMerchantAccountId: provided,
  }
}
