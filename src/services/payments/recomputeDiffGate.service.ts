import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { OriginSystem, PaymentMethod } from '@prisma/client'
import { resolveRosterCostContext, computeCostAmounts, determineTransactionCardType } from './transactionCost.service'

/**
 * Recompute-diff gate (PR-2 · T5)
 *
 * READ-ONLY. Before a venue's `rosterRolloutEnabled` flag is flipped to true, this
 * recomputes — for every eligible payment — what the NEW roster-based cost engine
 * WOULD produce (via the exact same resolver + math the live engine uses) and diffs
 * it against the stored TransactionCost. It NEVER writes.
 *
 * Use it as the safety gate: a venue is `safeToEnable` only when there are zero
 * hard STOPs. Non-zero diffs are EXPECTED and explainable (e.g. amaena's historical
 * under-charge gets corrected by the new resolver) — the operator reviews the rows;
 * STOPs (an account with no pricing / no cost / not attributable) block the flip
 * because they would drop or mis-cost a payment.
 */

export type DiffStatus = 'MATCH' | 'DIFF' | 'STOP'

export interface DiffRow {
  paymentId: string
  createdAt: Date
  merchantAccountId: string | null
  status: DiffStatus
  reason?: string
  storedVenueCharge: number | null
  recomputedVenueCharge: number | null
  deltaVenueCharge: number | null
  storedProviderCost: number | null
  recomputedProviderCost: number | null
  providerCostFallbackUsed: boolean
  venuePricingFallbackUsed: boolean
}

export interface RecomputeDiffResult {
  venueId: string
  total: number
  matched: number
  diffs: number
  stops: number
  /** True only when there are no hard STOPs — the precondition to flip the flag. */
  safeToEnable: boolean
  /** Net peso change in what the venue is charged (sum of recomputed − stored). */
  netVenueChargeDelta: number
  stopReasons: string[]
  fallbackCount: number
  rows: DiffRow[]
}

interface RecomputeDiffOptions {
  tolerance?: number // peso tolerance for "MATCH" (default 0.01 = 1 centavo)
  dateFrom?: Date
  dateTo?: Date
  limit?: number // safety cap on payments scanned (default 5000)
}

const num = (v: any): number | null => (v === null || v === undefined ? null : parseFloat(v.toString()))

export async function recomputeTransactionCostDiff(venueId: string, opts: RecomputeDiffOptions = {}): Promise<RecomputeDiffResult> {
  const tolerance = opts.tolerance ?? 0.01
  const limit = opts.limit ?? 5000

  // Eligibility mirrors createTransactionCost: Avoqado-originated, non-cash.
  const payments = await prisma.payment.findMany({
    where: {
      venueId,
      originSystem: OriginSystem.AVOQADO,
      method: { not: PaymentMethod.CASH },
      ...(opts.dateFrom || opts.dateTo
        ? { createdAt: { ...(opts.dateFrom ? { gte: opts.dateFrom } : {}), ...(opts.dateTo ? { lte: opts.dateTo } : {}) } }
        : {}),
    },
    include: { transactionCost: true },
    orderBy: { createdAt: 'desc' },
    take: limit,
  })

  if (payments.length === limit) {
    logger.warn('recomputeTransactionCostDiff hit the scan limit; results are partial', { venueId, limit })
  }

  const rows: DiffRow[] = []
  const stopReasons = new Set<string>()
  let matched = 0
  let diffs = 0
  let stops = 0
  let netVenueChargeDelta = 0
  let fallbackCount = 0

  for (const payment of payments) {
    const isTest = payment.type === 'TEST'
    const stored = (payment as any).transactionCost
    const storedVenueCharge = stored ? num(stored.venueChargeAmount) : null
    const storedProviderCost = stored ? num(stored.providerCostAmount) : null

    const base: DiffRow = {
      paymentId: payment.id,
      createdAt: payment.createdAt,
      merchantAccountId: payment.merchantAccountId,
      status: 'MATCH',
      storedVenueCharge,
      recomputedVenueCharge: null,
      deltaVenueCharge: null,
      storedProviderCost,
      recomputedProviderCost: null,
      providerCostFallbackUsed: false,
      venuePricingFallbackUsed: false,
    }

    // Resolve the roster-path context (the same code the ON resolver would run).
    const ctx = await resolveRosterCostContext(payment)

    // Hard STOPs — the new engine could not produce a correct cost for this payment.
    let stopReason: string | null = null
    if (!ctx.merchantAccount) stopReason = 'no_merchant_account'
    else if (!ctx.providerCostStructure && !isTest) stopReason = 'no_provider_cost'
    else if (!ctx.venuePricingStructure && !isTest) stopReason = 'no_venue_pricing'

    if (stopReason) {
      stops++
      stopReasons.add(stopReason)
      rows.push({ ...base, status: 'STOP', reason: stopReason })
      continue
    }

    base.providerCostFallbackUsed = ctx.providerCostFallbackUsed
    base.venuePricingFallbackUsed = ctx.venuePricingFallbackUsed
    if (ctx.providerCostFallbackUsed || ctx.venuePricingFallbackUsed) fallbackCount++

    const amounts = computeCostAmounts({
      baseAmount: num(payment.amount) ?? 0,
      tipAmount: num(payment.tipAmount) ?? 0,
      isTest,
      transactionType: determineTransactionCardType(payment.method, payment.cardBrand, (payment.processorData as any)?.isInternational),
      providerCostStructure: ctx.providerCostStructure,
      venuePricingStructure: ctx.venuePricingStructure,
    })

    base.recomputedVenueCharge = amounts.venueChargeAmount
    base.recomputedProviderCost = amounts.providerCostAmount

    // Compare against the stored venue charge (what the legacy engine produced). A
    // missing stored cost means the new engine would CREATE one (always a diff).
    const delta = storedVenueCharge === null ? amounts.venueChargeAmount : amounts.venueChargeAmount - storedVenueCharge
    base.deltaVenueCharge = delta
    netVenueChargeDelta += delta

    if (storedVenueCharge !== null && Math.abs(delta) <= tolerance) {
      matched++
      base.status = 'MATCH'
    } else {
      diffs++
      base.status = 'DIFF'
      base.reason =
        storedVenueCharge === null
          ? 'no_stored_cost'
          : ctx.venuePricingFallbackUsed
            ? 'pricing_fallback_to_primary'
            : 'rate_change'
    }

    rows.push(base)
  }

  const result: RecomputeDiffResult = {
    venueId,
    total: payments.length,
    matched,
    diffs,
    stops,
    safeToEnable: stops === 0,
    netVenueChargeDelta,
    stopReasons: [...stopReasons],
    fallbackCount,
    rows,
  }

  logger.info('recomputeTransactionCostDiff complete', {
    venueId,
    total: result.total,
    matched,
    diffs,
    stops,
    safeToEnable: result.safeToEnable,
    netVenueChargeDelta,
    fallbackCount,
  })

  return result
}
