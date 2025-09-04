import prisma from '../../utils/prismaClient'
import { TransactionCardType, AccountType } from '@prisma/client'
import { NotFoundError } from '../../errors/AppError'

export interface CostCalculationInput {
  venueId: string
  amount: number
  cardType: TransactionCardType // DEBIT, CREDIT, AMEX, INTERNATIONAL
  accountType: AccountType // PRIMARY, SECONDARY, TERTIARY
  merchantAccountId: string
}

export interface CostCalculationResult {
  // Provider costs (what you pay)
  providerRate: number
  providerCostAmount: number
  providerFixedFee: number

  // Venue pricing (what you charge)
  venueRate: number
  venueChargeAmount: number
  venueFixedFee: number

  // Profit calculation
  grossProfit: number
  profitMargin: number
  netProfit: number
}

/**
 * Calculate costs and pricing for a transaction
 * This shows Avoqado's profit on each transaction
 */
export async function calculateTransactionCost(input: CostCalculationInput): Promise<CostCalculationResult> {
  const { venueId, amount, cardType, accountType, merchantAccountId } = input

  // Get current provider cost structure
  const providerCost = await prisma.providerCostStructure.findFirst({
    where: {
      merchantAccountId,
      active: true,
      effectiveFrom: { lte: new Date() },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: new Date() } }],
    },
    orderBy: { effectiveFrom: 'desc' },
  })

  if (!providerCost) {
    throw new NotFoundError(`No provider cost structure found for merchant ${merchantAccountId}`)
  }

  // Get current venue pricing structure
  const venuePricing = await prisma.venuePricingStructure.findFirst({
    where: {
      venueId,
      accountType,
      active: true,
      effectiveFrom: { lte: new Date() },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: new Date() } }],
    },
    orderBy: { effectiveFrom: 'desc' },
  })

  if (!venuePricing) {
    throw new NotFoundError(`No venue pricing found for venue ${venueId} and account type ${accountType}`)
  }

  // Get rates based on card type
  const providerRate = getProviderRate(providerCost, cardType)
  const venueRate = getVenueRate(venuePricing, cardType)

  // Calculate amounts
  const providerCostAmount = amount * providerRate
  const providerFixedFee = Number(providerCost.fixedCostPerTransaction || 0)

  const venueChargeAmount = amount * venueRate
  const venueFixedFee = Number(venuePricing.fixedFeePerTransaction || 0)

  // Calculate profit
  const totalProviderCost = providerCostAmount + providerFixedFee
  const totalVenueCharge = venueChargeAmount + venueFixedFee
  const grossProfit = totalVenueCharge - totalProviderCost
  const profitMargin = totalVenueCharge > 0 ? grossProfit / totalVenueCharge : 0

  return {
    providerRate,
    providerCostAmount,
    providerFixedFee,
    venueRate,
    venueChargeAmount,
    venueFixedFee,
    grossProfit,
    profitMargin,
    netProfit: grossProfit,
  }
}

/**
 * Record transaction cost for profit tracking
 */
export async function recordTransactionCost(
  paymentId: string,
  calculation: CostCalculationResult,
  input: CostCalculationInput,
): Promise<void> {
  await prisma.transactionCost.create({
    data: {
      paymentId,
      merchantAccountId: input.merchantAccountId,
      transactionType: input.cardType,
      amount: input.amount,
      providerRate: calculation.providerRate,
      providerCostAmount: calculation.providerCostAmount,
      providerFixedFee: calculation.providerFixedFee,
      venueRate: calculation.venueRate,
      venueChargeAmount: calculation.venueChargeAmount,
      venueFixedFee: calculation.venueFixedFee,
      grossProfit: calculation.grossProfit,
      profitMargin: calculation.profitMargin,
    },
  })
}

// Helper functions to get rates by card type
function getProviderRate(cost: any, cardType: TransactionCardType): number {
  switch (cardType) {
    case 'DEBIT':
      return Number(cost.debitRate)
    case 'CREDIT':
      return Number(cost.creditRate)
    case 'AMEX':
      return Number(cost.amexRate)
    case 'INTERNATIONAL':
      return Number(cost.internationalRate)
    default:
      return Number(cost.creditRate)
  }
}

function getVenueRate(pricing: any, cardType: TransactionCardType): number {
  switch (cardType) {
    case 'DEBIT':
      return Number(pricing.debitRate)
    case 'CREDIT':
      return Number(pricing.creditRate)
    case 'AMEX':
      return Number(pricing.amexRate)
    case 'INTERNATIONAL':
      return Number(pricing.internationalRate)
    default:
      return Number(pricing.creditRate)
  }
}

/**
 * Example: Update costs when Menta sends new proposal
 */
export async function updateProviderCosts(
  merchantAccountId: string,
  newCosts: {
    debitRate: number
    creditRate: number
    amexRate: number
    internationalRate: number
    fixedCostPerTransaction?: number
    monthlyFee?: number
    proposalReference?: string
  },
): Promise<void> {
  // Deactivate current cost structure
  await prisma.providerCostStructure.updateMany({
    where: { merchantAccountId, active: true },
    data: { active: false, effectiveTo: new Date() },
  })

  // Create new cost structure
  await prisma.providerCostStructure.create({
    data: {
      merchantAccountId,
      providerId: (
        await prisma.merchantAccount.findUniqueOrThrow({
          where: { id: merchantAccountId },
          select: { providerId: true },
        })
      ).providerId,
      debitRate: newCosts.debitRate,
      creditRate: newCosts.creditRate,
      amexRate: newCosts.amexRate,
      internationalRate: newCosts.internationalRate,
      fixedCostPerTransaction: newCosts.fixedCostPerTransaction,
      monthlyFee: newCosts.monthlyFee,
      proposalReference: newCosts.proposalReference,
      effectiveFrom: new Date(),
      active: true,
    },
  })
}
