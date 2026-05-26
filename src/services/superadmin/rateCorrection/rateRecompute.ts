import { TransactionCardType } from '@prisma/client'

/** Minimal shape of a VenuePricingStructure / ProviderCostStructure row (Decimal-or-number tolerant). */
export interface RateStructureLike {
  debitRate: number | string
  creditRate: number | string
  amexRate: number | string
  internationalRate: number | string
  includesTax?: boolean | null
  taxRate?: number | string | null
  fixedFeePerTransaction?: number | string | null // venue side
  fixedCostPerTransaction?: number | string | null // provider side
}

export interface RecomputeInput {
  /** base + tip — processors charge commission on the full amount that crosses the terminal */
  amount: number
  transactionType: TransactionCardType
  venuePricing: RateStructureLike
  providerCost?: RateStructureLike | null
}

export interface RecomputeResult {
  venueRate: number
  venueChargeAmount: number
  venueFixedFee: number
  feeAmount: number
  netAmount: number
  providerRate: number
  providerCostAmount: number
  providerFixedFee: number
  grossProfit: number
  profitMargin: number
}

// ---- forked from transactionCost.service.ts (keep in sync; guarded by parity test) ----
export function getRateForTransactionType(structure: RateStructureLike, t: TransactionCardType): number {
  switch (t) {
    case TransactionCardType.DEBIT:
      return parseFloat(structure.debitRate.toString())
    case TransactionCardType.CREDIT:
      return parseFloat(structure.creditRate.toString())
    case TransactionCardType.AMEX:
      return parseFloat(structure.amexRate.toString())
    case TransactionCardType.INTERNATIONAL:
      return parseFloat(structure.internationalRate.toString())
    default:
      return parseFloat(structure.creditRate.toString())
  }
}

export function applyTaxIfNeeded(structure: RateStructureLike | null | undefined, baseRate: number): number {
  if (structure?.includesTax === false) {
    let tax = 0.16
    if (structure.taxRate !== null && structure.taxRate !== undefined) {
      const parsed = parseFloat(structure.taxRate.toString())
      if (Number.isFinite(parsed)) tax = parsed
    }
    return baseRate * (1 + tax)
  }
  return baseRate
}

export function recomputeEconomics(input: RecomputeInput): RecomputeResult {
  const { amount, transactionType, venuePricing, providerCost } = input

  const venueRate = applyTaxIfNeeded(venuePricing, getRateForTransactionType(venuePricing, transactionType))
  const venueFixedFee = venuePricing.fixedFeePerTransaction ? parseFloat(venuePricing.fixedFeePerTransaction.toString()) : 0
  const venueChargeAmount = amount * venueRate

  let providerRate = 0
  let providerFixedFee = 0
  if (providerCost) {
    providerRate = applyTaxIfNeeded(providerCost, getRateForTransactionType(providerCost, transactionType))
    providerFixedFee = providerCost.fixedCostPerTransaction ? parseFloat(providerCost.fixedCostPerTransaction.toString()) : 0
  }
  const providerCostAmount = amount * providerRate

  const feeAmount = venueChargeAmount + venueFixedFee
  const netAmount = amount - feeAmount
  const totalProviderCost = providerCostAmount + providerFixedFee
  const grossProfit = feeAmount - totalProviderCost
  const profitMargin = feeAmount > 0 ? grossProfit / feeAmount : 0

  return {
    venueRate,
    venueChargeAmount,
    venueFixedFee,
    feeAmount,
    netAmount,
    providerRate,
    providerCostAmount,
    providerFixedFee,
    grossProfit,
    profitMargin,
  }
}
